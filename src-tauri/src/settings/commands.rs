//! src-tauri\src\settings\commands.rs — `patch_settings`: one command
//! for the vidar.json keys the settings modal edits directly, replacing the
//! pattern where every new field needs its own `save_*` command
//! (`config.rs`). A server-side allowlist plus one validator per key means
//! the webview can never write a key this build doesn't know how to check,
//! and a bad value is refused before it ever reaches disk. Every successful
//! patch emits `settings-changed` so `src/config.ts` (batch B) can refresh
//! its cache instead of re-invoking `read_config` on a poll.
//!
//! Twelve keys today (the original five plus `agents`, `macros`, `editor`,
//! `flowGridOpacity`, `primaryAgent`, `jira`, `moduleNames`); a thirteenth key is one `KeySpec` entry, not a new command.

use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

struct KeySpec {
    key: &'static str,
    validate: fn(&Value) -> Result<(), String>,
    /// An empty string clears the key by removing it from vidar.json rather
    /// than writing `""`. `config::default_cwd()` treats blank as unset, but
    /// riderPath's readers only fall through on a missing key, so a written
    /// `""` would reach them as a real value.
    clear_on_empty: bool,
}

fn validate_font_size(v: &Value) -> Result<(), String> {
    let n = v.as_u64().ok_or("fontSize must be a whole number")?;
    if !(8..=48).contains(&n) {
        return Err("fontSize must be between 8 and 48".into());
    }
    Ok(())
}

/// Empty clears the override (the default cwd falls back to whatever spawned
/// Vidar); anything else must already exist as a directory — the same check
/// `config::save_locations` runs on `LocationCfg::cwd`.
fn validate_default_cwd(v: &Value) -> Result<(), String> {
    let s = v.as_str().ok_or("defaultCwd must be a string")?;
    if !s.trim().is_empty() && !Path::new(s).is_dir() {
        return Err(format!("not a directory: {s}"));
    }
    Ok(())
}

/// Empty clears the override; anything else must be an existing `.exe` file
/// — matching the check `editor.rs` (`open_in_editor`) runs on this same value at click time,
/// so a bad path is refused here instead of surfacing there.
fn validate_rider_path(v: &Value) -> Result<(), String> {
    let s = v.as_str().ok_or("riderPath must be a string")?;
    if s.trim().is_empty() {
        return Ok(());
    }
    let p = Path::new(s);
    if !p.is_file() || !p.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false) {
        return Err(format!("not an existing .exe: {s}"));
    }
    Ok(())
}

/// Blank clears the key (the Windows default app opens documents); anything else passes the
/// same `check_exe` the open runs (existing `.exe`, never `.cmd`/`.bat`).
fn validate_document_app(v: &Value) -> Result<(), String> {
    let s = v.as_str().ok_or("documentApp must be a string")?;
    if s.trim().is_empty() {
        return Ok(());
    }
    let p = Path::new(s.trim());
    // a relative path would resolve against whatever cwd the open runs in
    if !p.is_absolute() {
        return Err("documentApp must be an absolute path".into());
    }
    crate::editor::check_exe(p, "documentApp")
}

fn blank(s: Option<&str>) -> bool {
    s.map(|s| s.trim().is_empty()).unwrap_or(true)
}

/// Whole-list replace of the ＋ menu overlay. It must parse as the same typed list
/// `read_config` uses, so a save can never break the parse of the whole file.
/// Shape only: no cwd existence check. Key uniqueness is NOT enforced here: the
/// overlay's own operations can produce two entries with one key on the way to a
/// resolved state, and TS guards uniqueness where it generates `user-*` keys.
fn validate_agents(v: &Value) -> Result<(), String> {
    if !v.is_array() {
        return Err("agents must be an array".into());
    }
    let list: Vec<crate::settings::schema::AgentCfg> =
        serde_json::from_value(v.clone()).map_err(|e| format!("agents: {e}"))?;
    for (i, a) in list.iter().enumerate() {
        if a.id.trim().is_empty() && blank(a.key.as_deref()) {
            return Err(format!("agents[{i}] needs a non-blank id or key"));
        }
    }
    Ok(())
}

/// Whole-list replace of the macros; each entry needs a label and a command.
fn validate_macros(v: &Value) -> Result<(), String> {
    if !v.is_array() {
        return Err("macros must be an array".into());
    }
    let list: Vec<crate::settings::schema::MacroCfg> =
        serde_json::from_value(v.clone()).map_err(|e| format!("macros: {e}"))?;
    for (i, m) in list.iter().enumerate() {
        if m.label.trim().is_empty() {
            return Err(format!("macros[{i}] needs a non-blank label"));
        }
        if m.command.is_empty() {
            return Err(format!("macros[{i}] needs a command"));
        }
    }
    Ok(())
}

/// `""` clears the key. Otherwise `{ exe, args }` only (a bare path string is
/// refused so there is one written shape): `exe` passes the same `check_exe` the
/// click runs (existing `.exe`, never `.cmd`/`.bat`), and `args` is an array of
/// strings with at least one element containing `{file}`.
fn validate_editor(v: &Value) -> Result<(), String> {
    if let Some(s) = v.as_str() {
        if s.trim().is_empty() {
            return Ok(());
        }
        return Err("editor must be an object { exe, args }, not a path string".into());
    }
    let obj = v.as_object().ok_or("editor must be an object { exe, args }")?;
    let exe = obj.get("exe").and_then(Value::as_str).ok_or("editor.exe must be a string")?;
    crate::editor::check_exe(Path::new(exe), "editor.exe")?;
    let args = obj.get("args").and_then(Value::as_array).ok_or("editor.args must be an array of strings")?;
    let mut has_file = false;
    for a in args {
        let s = a.as_str().ok_or("editor.args must be an array of strings")?;
        has_file |= s.contains("{file}");
    }
    if !has_file {
        return Err("editor.args has no element containing {file}; add one, e.g. [\"{file}\"]".into());
    }
    Ok(())
}

/// Whole percent; `src/flow/grid-opacity.ts` treats absent as 55.
fn validate_flow_grid_opacity(v: &Value) -> Result<(), String> {
    let n = v.as_u64().ok_or("flowGridOpacity must be a whole number")?;
    if n > 100 {
        return Err("flowGridOpacity must be between 0 and 100".into());
    }
    Ok(())
}

/// The primary agent pick: exactly "codex" or "claude"; `""` clears the key (no pick, so
/// `src/agents/primary.ts` falls back to setup order). Whether that agent is installed is
/// the webview's call at use time, never refused here: an uninstalled pick falls back.
fn validate_primary_agent(v: &Value) -> Result<(), String> {
    let s = v.as_str().ok_or("primaryAgent must be a string")?;
    match s {
        "codex" | "claude" | "" => Ok(()),
        other => Err(format!("primaryAgent must be \"codex\", \"claude\" or \"\" (got \"{other}\")")),
    }
}

/// Unicode general category Cf (format characters: bidi controls, zero-width, BOM, tags). Std has
/// no category lookup, so the list is spelled out (Unicode 15); `tests/fixtures/module-names.json`
/// pins the common members and the TS twin uses `\p{Cf}`.
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// One module name: no surrounding Unicode White_Space, 1..=`limits.nameChars` code points, no
/// Cc (`is_control`) and no Cf characters.
fn validate_module_name(name: &str) -> Result<(), String> {
    if name.trim() != name {
        return Err("must not start or end with whitespace".into());
    }
    let n = name.chars().count();
    let max = crate::modules::name_chars();
    if n == 0 || n > max {
        return Err(format!("must be 1 to {max} characters"));
    }
    if name.chars().any(|c| c.is_control() || is_format_char(c)) {
        return Err("must not contain control or invisible formatting characters".into());
    }
    Ok(())
}

/// `{ "<module id>": "<name>" }`: keys match the module id pattern and are not `relay` (fixed),
/// values pass `validate_module_name`. An empty object is fine (no names).
fn validate_module_names(v: &Value) -> Result<(), String> {
    let map = v.as_object().ok_or("moduleNames must be an object")?;
    for (id, name) in map {
        if id == "relay" || !crate::modules::id_ok(id) {
            return Err(format!("moduleNames key \"{id}\" is not a renamable module id"));
        }
        let s = name.as_str().ok_or_else(|| format!("moduleNames.{id} must be a string"))?;
        validate_module_name(s).map_err(|e| format!("moduleNames.{id} {e}"))?;
    }
    Ok(())
}

/// The whole `{ closeToTray: bool, summonHotkey: string }` object (the shape `tray_config`
/// reads once at start): a wrong type is refused by the typed parse, and `summonHotkey` must pass
/// the tray's own `parse_chord` (`""` = unbound).
fn validate_window(v: &Value) -> Result<(), String> {
    if !v.is_object() {
        return Err("window must be an object { closeToTray, summonHotkey }".into());
    }
    let cfg: crate::tray_config::WindowTrayCfg =
        serde_json::from_value(v.clone()).map_err(|e| format!("window is not valid: {e}"))?;
    crate::tray_config::parse_chord(&cfg.summon_hotkey).map(|_| ())
}

const KEYS: &[KeySpec] = &[
    KeySpec { key: "fontSize", validate: validate_font_size, clear_on_empty: false },
    KeySpec { key: "defaultCwd", validate: validate_default_cwd, clear_on_empty: true },
    KeySpec { key: "riderPath", validate: validate_rider_path, clear_on_empty: true },
    KeySpec { key: "documentApp", validate: validate_document_app, clear_on_empty: true },
    KeySpec { key: "agents", validate: validate_agents, clear_on_empty: false },
    KeySpec { key: "macros", validate: validate_macros, clear_on_empty: false },
    KeySpec { key: "editor", validate: validate_editor, clear_on_empty: true },
    KeySpec { key: "flowGridOpacity", validate: validate_flow_grid_opacity, clear_on_empty: false },
    KeySpec { key: "primaryAgent", validate: validate_primary_agent, clear_on_empty: true },
    KeySpec { key: "jira", validate: crate::jira::config::validate_settings, clear_on_empty: true },
    KeySpec { key: "moduleNames", validate: validate_module_names, clear_on_empty: false },
    KeySpec { key: "window", validate: validate_window, clear_on_empty: false },
];

fn find(key: &str) -> Option<&'static KeySpec> {
    KEYS.iter().find(|k| k.key == key)
}

fn patch_settings_impl(key: &str, value: &Value) -> Result<(), String> {
    patch_settings_at(&crate::paths::config_path(), key, value)
}

/// Same logic as `patch_settings_impl`, over an explicit path — the seam the
/// tests use so the empty-string-clears-the-key behavior is verified against
/// a temp file instead of the real vidar.json.
fn patch_settings_at(path: &Path, key: &str, value: &Value) -> Result<(), String> {
    let spec = find(key).ok_or_else(|| format!("unknown settings key \"{key}\""))?;
    (spec.validate)(value)?;
    let clear = spec.clear_on_empty && value.as_str().map(|s| s.trim().is_empty()).unwrap_or(false);
    crate::settings::store::with_config_root_at(path, |obj| {
        if clear {
            obj.remove(key);
        } else {
            obj.insert(key.to_string(), value.clone());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn patch_settings(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    patch_settings_impl(&key, &value)?;
    // Best-effort: a dropped event means a stale in-memory cache until the
    // next natural read, not a wrong write — the file is already correct.
    let _ = app.emit("settings-changed", serde_json::json!({ "keys": [key], "tier": "config" }));
    Ok(())
}

/// `src/config.ts`'s (batch B) explicit refresh hook — same body as
/// `config::read_config`, kept here so the settings module owns its own
/// read-after-write path without a cross-module call back into `config.rs`.
#[tauri::command]
pub fn reload_config() -> crate::settings::schema::ConfigResult {
    crate::config::load()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_size_accepts_the_in_range_values() {
        assert!(validate_font_size(&Value::from(8)).is_ok());
        assert!(validate_font_size(&Value::from(14)).is_ok());
        assert!(validate_font_size(&Value::from(48)).is_ok());
    }

    #[test]
    fn font_size_rejects_out_of_range_and_wrong_type() {
        assert!(validate_font_size(&Value::from(7)).is_err());
        assert!(validate_font_size(&Value::from(49)).is_err());
        assert!(validate_font_size(&Value::from("14")).is_err());
    }

    #[test]
    fn default_cwd_accepts_empty_and_an_existing_dir() {
        assert!(validate_default_cwd(&Value::from("")).is_ok());
        let dir = std::env::temp_dir();
        assert!(validate_default_cwd(&Value::from(dir.to_string_lossy().into_owned())).is_ok());
    }

    #[test]
    fn default_cwd_rejects_a_nonexistent_path() {
        let missing = std::env::temp_dir().join("vidar-settings-commands-test-missing-dir");
        assert!(validate_default_cwd(&Value::from(missing.to_string_lossy().into_owned())).is_err());
    }

    #[test]
    fn rider_path_accepts_empty_and_rejects_a_missing_file() {
        assert!(validate_rider_path(&Value::from("")).is_ok());
        let missing = std::env::temp_dir().join("vidar-settings-commands-test-missing.exe");
        assert!(validate_rider_path(&Value::from(missing.to_string_lossy().into_owned())).is_err());
    }

    #[test]
    fn rider_path_rejects_an_existing_file_that_is_not_an_exe() {
        let path = std::env::temp_dir().join("vidar-settings-commands-test-rider.txt");
        std::fs::write(&path, b"not an exe").unwrap();
        let result = validate_rider_path(&Value::from(path.to_string_lossy().into_owned()));
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err());
    }

    #[test]
    fn primary_agent_accepts_codex_claude_and_empty_only() {
        assert!(validate_primary_agent(&Value::from("codex")).is_ok());
        assert!(validate_primary_agent(&Value::from("claude")).is_ok());
        assert!(validate_primary_agent(&Value::from("")).is_ok());
        let err = validate_primary_agent(&Value::from("Claude")).unwrap_err();
        assert!(err.contains("primaryAgent"), "{err}");
        assert!(validate_primary_agent(&Value::from("gemini")).is_err());
        assert!(validate_primary_agent(&Value::from(" ")).is_err());
        assert!(validate_primary_agent(&Value::from(1)).is_err());
    }

    #[test]
    fn primary_agent_writes_a_pick_and_an_empty_value_removes_the_key() {
        let path = std::env::temp_dir().join("vidar-settings-commands-test-primary-agent.json");
        std::fs::write(&path, br#"{"fontSize":14}"#).unwrap();

        patch_settings_at(&path, "primaryAgent", &Value::from("codex")).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        patch_settings_at(&path, "primaryAgent", &Value::from("")).unwrap();
        let cleared: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let refused = patch_settings_at(&path, "primaryAgent", &Value::from("both"));
        let _ = std::fs::remove_file(&path);

        assert_eq!(written.get("primaryAgent"), Some(&Value::from("codex")));
        assert!(cleared.get("primaryAgent").is_none(), "empty primaryAgent must be absent: {cleared}");
        assert_eq!(cleared.get("fontSize"), Some(&Value::from(14)));
        assert!(refused.is_err());
    }

    #[test]
    fn a_leftover_eject_profile_still_loads_and_survives_a_patch_of_another_key() {
        let text = r#"{"ejectProfile":"Vidar","fontSize":14}"#;
        assert!(serde_json::from_str::<crate::settings::schema::VidarConfig>(text).is_ok());
        let path = std::env::temp_dir().join("vidar-settings-commands-test-leftover-eject.json");
        std::fs::write(&path, text).unwrap();
        patch_settings_at(&path, "fontSize", &Value::from(16)).unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(root.get("ejectProfile"), Some(&Value::from("Vidar")));
        assert_eq!(root.get("fontSize"), Some(&Value::from(16)));
    }

    #[test]
    fn an_unknown_key_is_rejected_by_the_allowlist_before_any_write() {
        let err = patch_settings_impl("notARealKey", &Value::from(true)).unwrap_err();
        assert!(err.contains("unknown settings key"), "{err}");
    }

    #[test]
    fn an_empty_default_cwd_removes_the_key_instead_of_writing_an_empty_string() {
        let path = std::env::temp_dir().join("vidar-settings-commands-test-clear-default-cwd.json");
        std::fs::write(&path, br#"{"defaultCwd":"C:\\Main","fontSize":14}"#).unwrap();

        patch_settings_at(&path, "defaultCwd", &Value::from("")).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let root: Value = serde_json::from_str(&text).unwrap();
        assert!(root.get("defaultCwd").is_none(), "empty defaultCwd must be absent, not \"\": {root}");
        assert_eq!(root.get("fontSize"), Some(&Value::from(14)));
    }

    #[test]
    fn an_empty_rider_path_removes_the_key_instead_of_writing_an_empty_string() {
        let path = std::env::temp_dir().join("vidar-settings-commands-test-clear-rider-path.json");
        std::fs::write(&path, br#"{"riderPath":"C:\\rider.exe"}"#).unwrap();

        patch_settings_at(&path, "riderPath", &Value::from("")).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let root: Value = serde_json::from_str(&text).unwrap();
        assert!(root.get("riderPath").is_none(), "empty riderPath must be absent, not \"\": {root}");
    }

    #[test]
    fn document_app_validates_and_reads_back_through_read_config() {
        use crate::settings::schema::VidarConfig;
        let dir = std::env::temp_dir().join(format!("vidar-settings-commands-test-document-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("viewer.exe");
        let cmd = dir.join("viewer.cmd");
        let txt = dir.join("viewer.txt");
        for p in [&exe, &cmd, &txt] {
            std::fs::write(p, b"x").unwrap();
        }
        let s = |p: &Path| Value::from(p.to_string_lossy().into_owned());
        let path = dir.join("doc-app.json");
        std::fs::write(&path, br#"{"fontSize":14}"#).unwrap();

        assert!(validate_document_app(&Value::from("")).is_ok());
        assert!(validate_document_app(&Value::from(3)).is_err());
        assert!(validate_document_app(&s(&cmd)).is_err());
        assert!(validate_document_app(&s(&txt)).is_err());
        assert!(validate_document_app(&s(&dir.join("absent.exe"))).is_err());
        assert!(validate_document_app(&Value::from("viewer.exe")).is_err(), "relative path refused");

        patch_settings_at(&path, "documentApp", &s(&exe)).unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let back = serde_json::to_value(serde_json::from_value::<VidarConfig>(root).unwrap()).unwrap();
        assert_eq!(back.get("documentApp"), Some(&s(&exe)));

        patch_settings_at(&path, "documentApp", &Value::from("")).unwrap();
        let cleared: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(cleared.get("documentApp").is_none(), "blank must remove the key: {cleared}");
    }

    #[test]
    fn a_non_empty_default_cwd_still_writes_the_value() {
        let path = std::env::temp_dir().join("vidar-settings-commands-test-write-default-cwd.json");
        let _ = std::fs::remove_file(&path);
        let dir = std::env::temp_dir();

        patch_settings_at(&path, "defaultCwd", &Value::from(dir.to_string_lossy().into_owned())).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let root: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(root.get("defaultCwd"), Some(&Value::from(dir.to_string_lossy().into_owned())));
    }

    /// Patches `key` with `value` on a temp file seeded with `seed`; returns the
    /// result and whether the file bytes are unchanged afterwards.
    fn patch_seeded(name: &str, seed: &str, key: &str, value: Value) -> (Result<(), String>, bool) {
        let path = std::env::temp_dir().join(format!("vidar-settings-commands-test-{name}.json"));
        std::fs::write(&path, seed).unwrap();
        let result = patch_settings_at(&path, key, &value);
        let after = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        (result, after == seed)
    }

    const AGENTS_SEED: &str = r#"{"agents":[{"id":"claude","key":"claude"}],"fontSize":14}"#;

    #[test]
    fn a_bad_agents_value_is_refused_and_the_file_is_unchanged() {
        let cases = [
            ("not-array", serde_json::json!({ "id": "claude" })),
            ("wrong-type", serde_json::json!([{ "id": "claude", "args": "--x" }])),
            ("no-id-or-key", serde_json::json!([{ "label": "Mine", "id": "  " }])),
        ];
        for (name, value) in cases {
            let (result, unchanged) = patch_seeded(&format!("agents-{name}"), AGENTS_SEED, "agents", value);
            assert!(result.is_err(), "{name} must be refused");
            assert!(unchanged, "{name} must not touch the file");
        }
    }

    #[test]
    fn agents_with_duplicate_keys_are_accepted() {
        let value = serde_json::json!([
            { "id": "claude", "key": "claude", "label": "A" },
            { "id": "claude", "key": "claude", "disabled": true }
        ]);
        let (result, unchanged) = patch_seeded("agents-dup-key", AGENTS_SEED, "agents", value);
        assert!(result.is_ok(), "{result:?}");
        assert!(!unchanged);
    }

    #[test]
    fn window_accepts_a_valid_object_and_an_empty_chord() {
        assert!(validate_window(&serde_json::json!({ "closeToTray": true, "summonHotkey": "Ctrl+Alt+V" })).is_ok());
        assert!(validate_window(&serde_json::json!({ "closeToTray": false, "summonHotkey": "" })).is_ok());
    }

    #[test]
    fn window_refuses_a_bad_chord_a_non_bool_and_a_non_object() {
        assert!(validate_window(&serde_json::json!({ "closeToTray": false, "summonHotkey": "V" })).is_err());
        assert!(validate_window(&serde_json::json!({ "closeToTray": false, "summonHotkey": "Ctrl+Mouse1" })).is_err());
        assert!(validate_window(&serde_json::json!({ "closeToTray": "yes", "summonHotkey": "" })).is_err());
        assert!(validate_window(&serde_json::json!({ "closeToTray": false, "summonHotkey": 3 })).is_err());
        assert!(validate_window(&Value::from("Ctrl+Alt+V")).is_err());
    }

    #[test]
    fn macros_need_a_label_and_a_command() {
        assert!(validate_macros(&serde_json::json!([{ "label": "Go", "command": "go" }])).is_ok());
        assert!(validate_macros(&serde_json::json!([{ "label": " ", "command": "go" }])).is_err());
        assert!(validate_macros(&serde_json::json!([{ "label": "Go", "command": "" }])).is_err());
        assert!(validate_macros(&serde_json::json!({ "label": "Go" })).is_err());
    }

    /// A non-default value `validate` accepts for each `KEYS` entry. A new key
    /// with no arm here fails the round-trip test below, on purpose: the author
    /// must add a sample, which is the moment to also add the `VidarConfig` field.
    fn sample_for(key: &str, dir: &Path) -> Option<Value> {
        let s = |p: &Path| p.to_string_lossy().into_owned();
        Some(match key {
            "fontSize" => Value::from(17),
            "defaultCwd" => Value::from(s(dir)),
            "riderPath" => Value::from(s(&dir.join("rider.exe"))),
            "documentApp" => Value::from(s(&dir.join("rider.exe"))),
            "agents" => serde_json::json!([{ "id": "probe", "key": "probe", "label": "Probe" }]),
            "macros" => serde_json::json!([{ "label": "Probe", "command": "echo probe" }]),
            "editor" => serde_json::json!({ "exe": s(&dir.join("rider.exe")), "args": ["--line", "{line}", "{file}"] }),
            "flowGridOpacity" => Value::from(37),
            "primaryAgent" => Value::from("codex"),
            "jira" => serde_json::json!({ "site": "https://example.atlassian.net", "jql": "project = DEMO" }),
            "moduleNames" => serde_json::json!({ "doc": "Docs" }),
            "window" => serde_json::json!({ "closeToTray": true, "summonHotkey": "Ctrl+Alt+V" }),
            _ => return None,
        })
    }

    /// Every field of `expected` is present and equal in `actual`; `actual` may
    /// carry extra (defaulted) members the typed struct adds.
    fn contains(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Object(a), Value::Object(e)) => e.iter().all(|(k, v)| a.get(k).is_some_and(|av| contains(av, v))),
            (Value::Array(a), Value::Array(e)) => a.len() == e.len() && a.iter().zip(e).all(|(av, ev)| contains(av, ev)),
            _ => actual == expected,
        }
    }

    /// Guard for "key accepted by patch_settings but missing from VidarConfig"
    /// (the Flow grid-opacity bug): the typed read behind `read_config` would
    /// drop the saved value.
    #[test]
    fn every_patch_key_survives_a_config_round_trip() {
        use crate::settings::schema::VidarConfig;
        let dir = std::env::temp_dir().join("vidar-settings-commands-test-round-trip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rider.exe"), b"x").unwrap();
        let defaults = serde_json::to_value(VidarConfig::default()).unwrap();

        let mut failures = Vec::new();
        for spec in KEYS {
            let Some(sample) = sample_for(spec.key, &dir) else {
                failures.push(format!("{}: no sample value in sample_for", spec.key));
                continue;
            };
            if defaults.get(spec.key) == Some(&sample) {
                failures.push(format!("{}: sample equals the default", spec.key));
                continue;
            }
            let path = dir.join(format!("{}.json", spec.key));
            if let Err(e) = patch_settings_at(&path, spec.key, &sample) {
                failures.push(format!("{}: patch refused the sample: {e}", spec.key));
                continue;
            }
            let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let config: VidarConfig = serde_json::from_value(root).unwrap();
            let back = serde_json::to_value(&config).unwrap();
            match back.get(spec.key) {
                Some(v) if contains(v, &sample) => {}
                other => failures.push(format!("{}: wrote {sample}, read back {other:?}", spec.key)),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(failures.is_empty(), "keys that do not round-trip through VidarConfig:\n{}", failures.join("\n"));
    }

    /// The shared fixture the TS store test reads too (`tests/fixtures/module-names.json`).
    #[test]
    fn module_names_follow_the_shared_fixture() {
        let fx: Value = serde_json::from_str(include_str!("../../../tests/fixtures/module-names.json")).unwrap();
        let names = fx["names"].as_array().unwrap();
        let keys = fx["keys"].as_array().unwrap();
        assert!(names.len() > 20 && keys.len() > 5, "fixture lists went missing");
        for c in names {
            let (name, ok) = (c["name"].as_str().unwrap(), c["ok"].as_bool().unwrap());
            let got = validate_module_names(&serde_json::json!({ "doc": name }));
            assert_eq!(got.is_ok(), ok, "name case {}: {got:?}", c["case"]);
        }
        for c in keys {
            let (key, ok) = (c["key"].as_str().unwrap(), c["ok"].as_bool().unwrap());
            let got = validate_module_names(&serde_json::json!({ key: "Docs" }));
            assert_eq!(got.is_ok(), ok, "key case {key:?}: {got:?}");
        }
    }

    #[test]
    fn module_names_must_be_an_object_of_strings() {
        assert!(validate_module_names(&serde_json::json!({})).is_ok());
        for bad in [Value::Null, Value::from("Docs"), serde_json::json!([]), serde_json::json!({ "doc": 3 }), serde_json::json!({ "doc": null })] {
            assert!(validate_module_names(&bad).is_err(), "{bad}");
        }
        // One bad entry refuses the whole map.
        assert!(validate_module_names(&serde_json::json!({ "doc": "Docs", "relay": "R" })).is_err());
    }

    #[test]
    fn a_refused_module_names_patch_leaves_the_file_unchanged() {
        let seed = r#"{"fontSize":14}"#;
        let (r, same) = patch_seeded("module-names-bad", seed, "moduleNames", serde_json::json!({ "relay": "R" }));
        assert!(r.is_err() && same);
        let (r, same) = patch_seeded("module-names-ok", seed, "moduleNames", serde_json::json!({ "doc": "Docs" }));
        assert!(r.is_ok() && !same);
    }

    #[test]
    fn a_bad_editor_is_refused_before_any_write() {
        let dir = std::env::temp_dir();
        let cmd = dir.join("vidar-settings-commands-test-editor.cmd");
        let txt = dir.join("vidar-settings-commands-test-editor.txt");
        let exe = dir.join("vidar-settings-commands-test-editor.exe");
        for p in [&cmd, &txt, &exe] {
            std::fs::write(p, b"x").unwrap();
        }
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let seed = r#"{"fontSize":14}"#;
        let cases = [
            ("cmd", serde_json::json!({ "exe": s(&cmd), "args": ["{file}"] })),
            ("not-exe", serde_json::json!({ "exe": s(&txt), "args": ["{file}"] })),
            ("no-file-arg", serde_json::json!({ "exe": s(&exe), "args": ["--line", "{line}"] })),
            ("bare-string", Value::from(s(&exe))),
        ];
        let mut outcomes = Vec::new();
        for (name, value) in cases {
            outcomes.push((name, patch_seeded(&format!("editor-{name}"), seed, "editor", value)));
        }
        let ok = patch_seeded("editor-ok", seed, "editor", serde_json::json!({ "exe": s(&exe), "args": ["{file}"] }));
        for p in [&cmd, &txt, &exe] {
            let _ = std::fs::remove_file(p);
        }
        for (name, (result, unchanged)) in outcomes {
            assert!(result.is_err(), "{name} must be refused");
            assert!(unchanged, "{name} must not touch the file");
        }
        assert!(ok.0.is_ok(), "{:?}", ok.0);
    }
}
