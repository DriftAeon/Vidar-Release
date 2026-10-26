//! src-tauri\src\config.rs — vidar.json's typed load and the `save_*`
//! commands. The struct lives in `settings::schema`, with the generic-tree
//! read-modify-write (`settings::store::with_config_root`) out of this file;
//! what's left is `load()` and the five `#[tauri::command]`
//! entry points, each now a validation block plus one call to
//! `with_config_root` — kept here (not in `settings::commands`, which is a
//! later unit) so their command path and TS-visible name don't move in this
//! batch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::settings::store::{strip_bom, with_config_root};

// Re-exported at their original crate::config:: path even though nothing outside
// schema.rs names them directly today — they were public here before the move.
#[allow(unused_imports)] // re-export kept for the old config:: paths; not every name has an in-crate user
pub use crate::settings::schema::{AgentCfg, ConfigResult, LocationCfg, MacroCfg, VidarConfig};

/// The one default working directory, the PTY fallback cwd (pty.rs): vidar.json `defaultCwd` when set and an existing
/// directory, else the user's home. Re-read per call, so an edit takes
/// effect without a restart. `None` only when neither resolves (no USERPROFILE).
pub fn default_cwd() -> Option<PathBuf> {
    resolve_default_cwd(load().config.default_cwd.as_deref(), crate::paths::home())
}

/// `default_cwd`'s fallback order over explicit inputs — the seam its test uses so the live
/// vidar.json and environment are never touched.
fn resolve_default_cwd(setting: Option<&str>, home: Option<PathBuf>) -> Option<PathBuf> {
    setting
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or(home)
}

/// Typed parse that survives a wrong-typed field: when the whole tree fails, each top-level key is
/// tried alone, a failing one is dropped (its field takes its default) and named as `key (error)`.
/// A root that is not an object stays a hard error.
fn typed_lenient(root: Value) -> Result<(VidarConfig, Vec<String>), String> {
    let whole_err = match serde_json::from_value::<VidarConfig>(root.clone()) {
        Ok(c) => return Ok((c, Vec::new())),
        Err(e) => e,
    };
    let Value::Object(map) = root else { return Err(whole_err.to_string()) };
    let mut kept = serde_json::Map::new();
    let mut bad = Vec::new();
    for (k, v) in map {
        let mut one = serde_json::Map::new();
        one.insert(k.clone(), v.clone());
        match serde_json::from_value::<VidarConfig>(Value::Object(one)) {
            Ok(_) => { kept.insert(k, v); }
            Err(e) => match v {
                // An array of entries is filtered per entry: one bad entry must not drop the list.
                Value::Array(items) if matches!(k.as_str(), "agents" | "locations" | "macros") => {
                    let mut good = Vec::new();
                    for (i, item) in items.into_iter().enumerate() {
                        let mut one = serde_json::Map::new();
                        one.insert(k.clone(), Value::Array(vec![item.clone()]));
                        match serde_json::from_value::<VidarConfig>(Value::Object(one)) {
                            Ok(_) => good.push(item),
                            Err(e) => {
                                let id = item.get("id").and_then(Value::as_str).filter(|s| !s.is_empty());
                                match id {
                                    Some(id) => bad.push(format!("{k}[{i}] id {id} ({e})")),
                                    None => bad.push(format!("{k}[{i}] ({e})")),
                                }
                            }
                        }
                    }
                    kept.insert(k, Value::Array(good));
                }
                _ => bad.push(format!("{k} ({e})")),
            },
        }
    }
    match serde_json::from_value::<VidarConfig>(Value::Object(kept)) {
        Ok(c) => Ok((c, bad)),
        Err(_) => Err(whole_err.to_string()),
    }
}

/// Wire contract with `PARTIAL_MARK_KEYS` / `PARTIAL_MARK_ENTRIES` in `src/settings/save-refusal.ts`:
/// the TS side finds the list of ignored items by these exact substrings (pinned by a test below).
pub(crate) const PARTIAL_KEYS_PREFIX: &str = "vidar.json: ignored wrong-typed key(s), defaults used for them: ";
pub(crate) const PARTIAL_ENTRIES_PREFIX: &str = "vidar.json: skipped entries: ";

/// The partial-load error text. `bad` holds `key (err)` items (key defaulted) and
/// `key[i] ... (err)` items (one list entry skipped, `i` its position in the file).
fn partial_error(bad: &[String]) -> String {
    let (entries, keys): (Vec<&String>, Vec<&String>) =
        bad.iter().partition(|b| b.split_once(" (").is_some_and(|(head, _)| head.contains('[')));
    let join = |v: &[&String]| v.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("; ");
    let mut out = String::new();
    if !keys.is_empty() {
        out.push_str(PARTIAL_KEYS_PREFIX);
        out.push_str(&join(&keys));
    }
    if !entries.is_empty() {
        if !out.is_empty() {
            out.push_str(" | ");
        }
        out.push_str(PARTIAL_ENTRIES_PREFIX);
        out.push_str(&join(&entries));
    }
    out
}

pub fn load() -> ConfigResult {
    let mut r = load_from(&crate::paths::config_path());
    // A failed Rune Vault migration run names its plan.txt here; main.ts shows `notice` as the config notice.
    if let Some(n) = crate::bare::vault::migrate::notice() {
        r.notice = Some(match r.notice.take() {
            Some(o) => format!("{o}; {n}"),
            None => n,
        });
    }
    r
}

/// `load()`'s body over an explicit path — the seam its tests use so a v0
/// fixture or an unparsable file never touches the real vidar.json.
fn load_from(path: &Path) -> ConfigResult {
    load_from_with(path, || {})
}

/// `load_from` with a hook that runs after the first (unlocked) read and
/// before the migration persist — the seam the interleaving test uses to land
/// a concurrent save in exactly that window.
fn load_from_with(path: &Path, before_persist: impl FnOnce()) -> ConfigResult {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(strip_bom(&text)) {
            Ok(mut root) => {
                // Absent/stale/malformed configVersion is migrated up to current
                // on every read, over the untyped tree so a step can rename or
                // restructure a key the typed schema doesn't model under its old name.
                // Only a real (non-no-op) migration step produces a log line, surfaced
                // as `notice` (info), never `error`. When configVersion came out
                // different from how it went in — a real step ran, or an on-disk string/
                // garbage value just needed normalising — persist the whole migrated
                // tree once so this doesn't repeat on every future boot.
                //
                // The persist re-reads the file under the store lock and migrates
                // THAT tree (not the snapshot above), so a save that landed between
                // the first read and here survives; the migrated latest tree is then
                // what this load returns.
                let before = root.get("configVersion").cloned();
                let mut log = crate::settings::migrate::migrate(&mut root);
                let after = root.get("configVersion").cloned();
                if after != before {
                    before_persist();
                    let mut latest: Option<(Value, Vec<String>)> = None;
                    let persisted = crate::settings::store::with_config_root_at(path, |target| {
                        let mut tree = Value::Object(std::mem::take(target));
                        let latest_log = crate::settings::migrate::migrate(&mut tree);
                        // A migration that leaves a non-object root refuses the persist
                        // (Err skips the write) rather than writing the emptied `{}`.
                        let Value::Object(obj) = &tree else {
                            return Err("migrated vidar.json root is not an object".into());
                        };
                        *target = obj.clone();
                        latest = Some((tree, latest_log));
                        Ok(())
                    });
                    match persisted {
                        Ok(()) => {
                            if let Some((tree, latest_log)) = latest {
                                root = tree;
                                log = latest_log;
                            }
                        }
                        Err(e) => eprintln!("config: failed to persist migrated config: {e}"),
                    }
                }
                let notice = if log.is_empty() { None } else { Some(log.join("; ")) };
                match typed_lenient(root) {
                    Ok((config, bad)) if bad.is_empty() => ConfigResult { config, error: None, notice },
                    Ok((config, bad)) => ConfigResult { config, error: Some(partial_error(&bad)), notice },
                    Err(e) => ConfigResult {
                        config: VidarConfig::default(),
                        error: Some(format!("vidar.json parse error: {e}")),
                        notice: None,
                    },
                }
            }
            Err(e) => ConfigResult {
                config: VidarConfig::default(),
                error: Some(format!("vidar.json parse error: {e}")),
                notice: None,
            },
        },
        // absent file = silent defaults
        Err(_) => ConfigResult { config: VidarConfig::default(), error: None, notice: None },
    }
}

#[tauri::command]
pub fn read_config() -> ConfigResult {
    load()
}

/// `default_cwd()` for the webview, so a tab opened with no location shows and passes the
/// same folder pty.rs resolves; the frontend never invents one.
#[tauri::command]
pub fn read_default_cwd() -> Option<String> {
    default_cwd().map(|p| p.to_string_lossy().into_owned())
}

/// The launcher menu's "Add new…" row. The webview owns the merged list (built-ins
/// plus the new entry when the file had none), Rust validates and writes.
#[tauri::command]
pub fn save_locations(locations: Vec<LocationCfg>) -> Result<(), String> {
    for l in &locations {
        if l.label.trim().is_empty() {
            return Err("a location needs a label".into());
        }
        if !Path::new(&l.cwd).is_dir() {
            return Err(format!("not a directory: {}", l.cwd));
        }
    }
    with_config_root(|obj| {
        obj.insert("locations".into(), serde_json::to_value(&locations).map_err(|e| e.to_string())?);
        Ok(())
    })
}

/// Shortcut overrides (id -> chord). The frontend sends only non-default
/// bindings, so an empty map is the "all defaults" state and is still written
/// — a reset must land on disk, not just in memory.
#[tauri::command]
pub fn save_shortcuts(shortcuts: HashMap<String, String>) -> Result<(), String> {
    for (id, chord) in &shortcuts {
        if id.trim().is_empty() || chord.trim().is_empty() {
            return Err("a shortcut needs both an id and a chord".into());
        }
    }
    with_config_root(|obj| {
        obj.insert("shortcuts".into(), serde_json::to_value(&shortcuts).map_err(|e| e.to_string())?);
        Ok(())
    })
}

/// Settings-modal edits to voice input. Only the four user-facing keys are written,
/// merged into whatever `voice` object exists — the transcriber block stays whatever the
/// file says (or absent, so code defaults keep applying).
#[tauri::command]
pub fn save_voice(hotkey: String, mode: String, device: String, prompt: String, model: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "hold" | "toggle") {
        return Err(format!("unknown voice mode \"{mode}\""));
    }
    with_config_root(|obj| {
        let voice = obj.entry("voice").or_insert_with(|| Value::Object(Default::default()));
        let voice = voice.as_object_mut().ok_or("vidar.json `voice` is not an object")?;
        voice.insert("hotkey".into(), Value::String(hotkey));
        voice.insert("mode".into(), Value::String(mode));
        voice.insert("device".into(), Value::String(device));
        voice.insert("prompt".into(), Value::String(prompt));
        voice.insert("model".into(), Value::String(model));
        Ok(())
    })
}

/// Settings-modal edits to wake-word listening. Whole-struct save (unlike `save_voice`'s
/// field list) since `WakewordCfg` has no server-side-only sub-block to preserve — every key
/// in it is user-facing.
#[tauri::command]
pub fn save_wakeword(cfg: crate::listen::WakewordCfg) -> Result<(), String> {
    with_config_root(|obj| {
        obj.insert("wakeword".into(), serde_json::to_value(&cfg).map_err(|e| e.to_string())?);
        Ok(())
    })
}

/// Character panel context menu: "Reframe Default" saves the current camera view keyed by
/// character id, "Reset Default" sends `view: None` to delete it. Edited as a generic tree
/// like `save_voice` so unmodeled keys survive; the value itself is opaque JSON, validated by
/// the frontend before it is ever applied.
#[tauri::command]
pub fn save_character_view(id: String, view: Option<Value>) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("a character id is required".into());
    }
    with_config_root(|obj| {
        let views = obj.entry("characterViews").or_insert_with(|| Value::Object(Default::default()));
        let views = views.as_object_mut().ok_or("vidar.json `characterViews` is not an object")?;
        match view {
            Some(v) => { views.insert(id, v); }
            None => { views.remove(&id); }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn default_cwd_uses_the_setting_only_when_it_is_an_existing_dir_else_home() {
        let dir = temp_path(&format!("vidar-config-test-default-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing");
        let home = Some(PathBuf::from("H:\\home"));
        let s = dir.to_string_lossy().into_owned();
        let m = missing.to_string_lossy().into_owned();

        assert_eq!(resolve_default_cwd(Some(&s), home.clone()), Some(dir.clone()));
        assert_eq!(resolve_default_cwd(None, home.clone()), home);
        assert_eq!(resolve_default_cwd(Some(""), home.clone()), home);
        assert_eq!(resolve_default_cwd(Some(&m), home.clone()), home);
        assert_eq!(resolve_default_cwd(Some(&m), None), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_v0_file_gets_its_version_persisted_with_no_error_or_notice() {
        let path = temp_path("vidar-config-test-v0.json");
        std::fs::write(&path, b"{\"fontSize\":14}").unwrap();

        let result = load_from(&path);

        assert!(result.error.is_none());
        // v0 -> v1 is a no-op migration: nothing to tell the user about.
        assert!(result.notice.is_none());
        assert_eq!(result.config.config_version, Some(crate::settings::migrate::CURRENT_VERSION));

        // Persisted once via with_config_root_at: the version lands on disk,
        // every other key (fontSize) is untouched.
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["configVersion"], Value::from(crate::settings::migrate::CURRENT_VERSION));
        assert_eq!(on_disk["fontSize"], Value::from(14));

        let _ = std::fs::remove_file(&path);
    }

    // Review finding 2: a save that lands after load's first read but before the
    // migration persist must survive; the old `*target = migrated` put the stale
    // snapshot back over it.
    #[test]
    fn a_save_between_read_and_migration_persist_is_not_clobbered() {
        let path = temp_path("vidar-config-test-migrate-interleave.json");
        std::fs::write(&path, b"{\"fontSize\":14}").unwrap();

        let result = load_from_with(&path, || {
            crate::settings::store::with_config_root_at(&path, |obj| {
                obj.insert("fontSize".into(), Value::from(20));
                obj.insert("theme".into(), Value::from("dark"));
                Ok(())
            })
            .expect("concurrent save");
        });

        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(result.error.is_none(), "{:?}", result.error);
        assert_eq!(on_disk["fontSize"], Value::from(20), "the newer save must survive migration");
        assert_eq!(on_disk["theme"], Value::from("dark"));
        assert_eq!(on_disk["configVersion"], Value::from(crate::settings::migrate::CURRENT_VERSION));
        assert_eq!(result.config.font_size, Some(20), "load returns the migrated latest tree");
    }

    #[test]
    fn a_string_config_version_loads_instead_of_failing_the_typed_parse() {
        let path = temp_path("vidar-config-test-string-version.json");
        std::fs::write(&path, br#"{"fontSize":14,"configVersion":"1"}"#).unwrap();

        let result = load_from(&path);

        assert!(result.error.is_none());
        assert_eq!(result.config.config_version, Some(crate::settings::migrate::CURRENT_VERSION));
        assert_eq!(result.config.font_size, Some(14));

        // The on-disk string is normalised to a number so a future typed read
        // never has to re-tolerate it.
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["configVersion"], Value::from(crate::settings::migrate::CURRENT_VERSION));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn one_wrong_typed_key_keeps_the_others_and_is_named() {
        let path = temp_path("vidar-config-test-wrong-typed.json");
        std::fs::write(
            &path,
            br#"{"configVersion":1,"fontSize":"14","defaultCwd":"C:\\x","agents":[{"id":"codex"}]}"#,
        )
        .unwrap();

        let result = load_from(&path);
        let _ = std::fs::remove_file(&path);

        assert_eq!(result.config.font_size, None, "bad field falls back to its default");
        assert_eq!(result.config.default_cwd.as_deref(), Some("C:\\x"));
        assert_eq!(result.config.agents.as_ref().map(|a| a.len()), Some(1));
        let err = result.error.expect("error names the bad key");
        assert!(err.contains("fontSize"), "{err}");
        assert!(!err.contains("defaultCwd"), "{err}");
    }

    #[test]
    fn one_bad_agent_entry_is_dropped_and_named_the_good_ones_load() {
        let path = temp_path("vidar-config-test-bad-entry.json");
        std::fs::write(
            &path,
            br#"{"configVersion":1,"agents":[{"id":"codex"},{"id":"broken","args":"x"},{"args":7},{"id":"claude-rendered","key":"k"}],"macros":[{"label":"ok"}]}"#,
        )
        .unwrap();

        let result = load_from(&path);
        let _ = std::fs::remove_file(&path);

        let agents = result.config.agents.as_ref().expect("good entries load");
        let ids: Vec<_> = agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["codex", "claude-rendered"]);
        assert_eq!(result.config.macros.as_ref().map(|m| m.len()), Some(1));
        let err = result.error.expect("bad entries are named");
        assert!(err.starts_with(PARTIAL_ENTRIES_PREFIX), "{err}");
        assert!(!err.contains("defaults used"), "skipped entries are not defaulted: {err}");
        assert!(err.contains("agents[1] id broken"), "{err}");
        assert!(err.contains("agents[2]"), "{err}");
        assert!(!err.contains("macros"), "{err}");
    }

    // Cross-language contract: `PARTIAL_MARK_*` in src/settings/save-refusal.ts finds the ignored
    // list by these exact substrings. Change either side only together with the other.
    #[test]
    fn partial_error_prefixes_are_the_exact_wire_strings() {
        assert_eq!(PARTIAL_KEYS_PREFIX, "vidar.json: ignored wrong-typed key(s), defaults used for them: ");
        assert_eq!(PARTIAL_ENTRIES_PREFIX, "vidar.json: skipped entries: ");
        let keys = partial_error(&["fontSize (bad)".into()]);
        assert_eq!(keys, format!("{PARTIAL_KEYS_PREFIX}fontSize (bad)"));
        let both = partial_error(&["agents[1] id x (bad)".into(), "fontSize (bad)".into()]);
        assert_eq!(both, format!("{PARTIAL_KEYS_PREFIX}fontSize (bad) | {PARTIAL_ENTRIES_PREFIX}agents[1] id x (bad)"));
    }

    #[test]
    fn an_unparsable_file_is_reported_as_an_error_and_left_untouched() {
        let path = temp_path("vidar-config-test-unparsable.json");
        let original = b"not json".to_vec();
        std::fs::write(&path, &original).unwrap();

        let result = load_from(&path);

        assert!(result.error.is_some());
        assert!(result.notice.is_none());

        let on_disk = std::fs::read(&path).unwrap();
        assert_eq!(on_disk, original, "an unparsable file must not be rewritten");

        let _ = std::fs::remove_file(&path);
    }

    // The flat `launchers` list is gone from the schema; a file that still has one
    // must load with no error, the rest of the config intact. The `disabled` and `key`
    // survive the typed read so the frontend overlay sees them.
    #[test]
    fn a_stale_launchers_key_is_ignored_and_agent_disabled_round_trips() {
        let path = temp_path("vidar-config-test-stale-launchers.json");
        std::fs::write(
            &path,
            br#"{"configVersion":1,"fontSize":13,"launchers":[{"label":"pwsh"}],"agents":[{"id":"codex","label":"Codex","disabled":true},{"id":"codex","key":"astra","label":"Reviewer"}]}"#,
        )
        .unwrap();

        let result = load_from(&path);

        assert!(result.error.is_none(), "{:?}", result.error);
        assert_eq!(result.config.font_size, Some(13));
        let agents = result.config.agents.as_ref().expect("agents parsed");
        assert_eq!(agents[0].disabled, Some(true));
        assert_eq!(agents[0].key, None);
        assert_eq!(agents[1].key.as_deref(), Some("astra"));
        let json = serde_json::to_value(&result.config).unwrap();
        assert!(json.get("launchers").is_none());

        let _ = std::fs::remove_file(&path);
    }
}
