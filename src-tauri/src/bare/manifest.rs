//! src-tauri\src\bare\manifest.rs — one immutable JSON per bare launch (plan Design 8) in
//! `<home>\manifests\<utc>-<tab>-<pid>.json`, created with create-new and never rewritten.
//! Env values are redacted: the manifest names what the agent got, never a value.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Binary {
    pub path: String,
    pub version: Option<String>,
    pub verified_version: String,
    /// Set when the version differs from the verified one or could not be read (D7: warn, not refuse).
    pub warning: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub path: String,
    pub sha256: String,
    pub marker: String,
    /// The row's rune sets built into this payload, in order (Bare slice 1); none on a plain one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sets: Vec<String>,
    /// The rune build's warnings for those sets (a disabled set skipped, ...); a Raw tab also
    /// prints them, a hosted one has only this record.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Homes {
    pub home: String,
    /// The agent's own home: one of these two per profile (Claude's config dir or `CODEX_HOME`).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub claude_config: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub codex_home: String,
    pub user_home: String,
    /// The generated file (`settings.json` or `config.toml`).
    pub settings: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub path: String,
    pub present: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub profile: String,
    pub agent: String,
    pub tab: String,
    pub created_utc: String,
    pub vidar_pid: u32,
    pub binary: Binary,
    pub program: String,
    pub args: Vec<String>,
    pub env_names: Vec<String>,
    pub homes: Homes,
    pub payload: Payload,
    pub plugins: Vec<String>,
    /// Claude Bare: the guard scripts copied into `<home>\layer\hooks\` (file names, sorted);
    /// empty when none. Codex: the `bareCodexGuards` copies (the shim included) its hooks.json
    /// runs, set only once Codex trusts them.
    pub guards: Vec<String>,
    /// The skills the spawn's copy sync placed (Claude: folder names the ledger holds; Codex: the
    /// `$name`s listed in its instructions), in `bareSkills` order; empty when none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    /// The git config keys carried into `<home>\user-home\.gitconfig` (names only, never values;
    /// `identity.rs`); empty when none were carried.
    pub git_keys: Vec<String>,
    /// Launch warnings beyond the binary's and the payload's (a plugin or copy left out, no Git identity, ...).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub managed_policy: Policy,
    /// Codex only: the `.rules` files in `<CODEX_HOME>\rules` at launch. Codex loads that folder
    /// and no config key turns it off (P6 probe rules); only the bare tab's own approvals write it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_rules: Option<Vec<String>>,
    /// Falcon-hosted Rendered Bare only: the host's session id, whose spawn reply supplied
    /// `env_names` (the env is built in Falcon, not here).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub falcon_session: Option<String>,
}

/// Claude Code's machine-wide managed settings (levers: 4 hook groups on the trial machine);
/// presence only, the file is never read.
pub fn managed_policy() -> Policy {
    let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let path = pf.join("ClaudeCode").join("managed-settings.json");
    Policy { present: path.is_file(), path: path.to_string_lossy().into_owned() }
}

/// A tab id reduced to filename-safe characters.
fn safe_tab(tab: &str) -> String {
    let s: String = tab.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(64).collect();
    if s.is_empty() { "tab".into() } else { s }
}

/// `yyyy-MM-ddTHHmmss.mmmZ`-style stamp for the file name (no colons) and the ISO field.
pub fn stamps() -> (String, String) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let iso = crate::driver_mode::utc_stamp(now.as_secs());
    let file = format!("{}{:03}Z", iso.trim_end_matches('Z').replace(':', ""), now.subsec_millis());
    (iso, file)
}

/// Writes the manifest with create-new; an existing file of the same name is an error, never
/// overwritten.
pub fn write(dir: &Path, file_stamp: &str, m: &Manifest) -> Result<PathBuf, String> {
    let path = dir.join(format!("{file_stamp}-{}-{}.json", safe_tab(&m.tab), m.vidar_pid));
    let bytes = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Bare manifest {}: {e}", path.display()))?;
    f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(|e| format!("Bare manifest {}: {e}", path.display()))?;
    Ok(path)
}

/// What a tab's newest Bare launch carried, for the Runes trace (a Bare tab reads no instruction
/// files, so its transcript records no loads).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRecord {
    pub created_utc: String,
    pub agent: String,
    pub sets: Vec<String>,
    pub skills: Vec<String>,
    pub guards: Vec<String>,
    /// The binary's warning, then the payload's, then the manifest's own.
    pub warnings: Vec<String>,
}

fn strs(v: &serde_json::Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect()
}

fn record(v: &serde_json::Value) -> LaunchRecord {
    let mut warnings: Vec<String> = v.pointer("/binary/warning").and_then(|w| w.as_str()).map(str::to_string).into_iter().collect();
    warnings.extend(strs(&v["payload"]["warnings"]));
    warnings.extend(strs(&v["warnings"]));
    LaunchRecord {
        created_utc: v["createdUtc"].as_str().unwrap_or_default().to_string(),
        agent: v["agent"].as_str().unwrap_or_default().to_string(),
        sets: strs(&v["payload"]["sets"]),
        skills: strs(&v["skills"]),
        guards: strs(&v["guards"]),
        warnings,
    }
}

/// The newest manifest in `dir` whose `tab` is `tab` (any agent), reduced; `None` when there is
/// none. The id is checked before any path work. File names lead with a fixed-width stamp, so the
/// last name in sort order is the newest launch; the name only pre-filters, `tab` decides.
pub fn launch_in(dir: &Path, tab: &str) -> Result<Option<LaunchRecord>, String> {
    if !crate::rules::loaded::plain_id(tab, &['_']) {
        return Err(format!("invalid tab id `{tab}`"));
    }
    let needle = format!("-{}-", safe_tab(tab));
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(None) };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json") && n.contains(&needle))
        .collect();
    names.sort();
    for name in names.iter().rev() {
        let Ok(text) = crate::fsx::read_text(&dir.join(name)) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(crate::fsx::strip_bom(&text)) else { continue };
        if v["tab"].as_str() == Some(tab) {
            return Ok(Some(record(&v)));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn bare_launch(tab: String) -> Result<Option<LaunchRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::rules::loaded::plain_id(&tab, &['_']) {
            return Err(format!("invalid tab id `{tab}`"));
        }
        launch_in(&super::home::resolve()?.join("manifests"), &tab)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_is_created_once_and_never_rewritten() {
        let dir = std::env::temp_dir().join(format!("vidar-bare-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let m = Manifest {
            profile: "bare".into(),
            agent: "claude".into(),
            tab: "s1/ab".into(),
            created_utc: "2026-10-13T19:30:00Z".into(),
            vidar_pid: 7,
            binary: Binary { path: "claude.exe".into(), version: None, verified_version: "1.0.0".into(), warning: None },
            program: "pwsh.exe".into(),
            args: vec![],
            env_names: vec!["Path".into()],
            homes: Homes { home: "h".into(), claude_config: "c".into(), codex_home: String::new(), user_home: "u".into(), settings: "s".into() },
            payload: Payload { path: "p".into(), sha256: "x".into(), marker: "m".into(), sets: Vec::new(), warnings: Vec::new() },
            plugins: vec!["vidar-app".into()],
            guards: Vec::new(),
            skills: Vec::new(),
            git_keys: vec!["user.name".into()],
            warnings: Vec::new(),
            managed_policy: Policy { path: "q".into(), present: false },
            codex_rules: None,
            falcon_session: None,
        };
        let p = write(&dir, "2026-10-13T193000000Z", &m).unwrap();
        assert!(p.file_name().unwrap().to_string_lossy().ends_with("-s1_ab-7.json"));
        assert!(write(&dir, "2026-10-13T193000000Z", &m).is_err(), "rewrote an existing manifest");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["envNames"], serde_json::json!(["Path"]));
        assert_eq!(v["gitKeys"], serde_json::json!(["user.name"]));
        assert!(v["homes"].get("codexHome").is_none() && v.get("codexRules").is_none(), "Claude manifests carry no Codex fields");
        assert!(v.get("falconSession").is_none(), "a Raw manifest names no Falcon session");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn put(dir: &Path, file: &str, v: serde_json::Value) {
        std::fs::write(dir.join(file), serde_json::to_vec(&v).unwrap()).unwrap();
    }

    #[test]
    fn bare_launch_picks_the_newest_manifest_of_the_tab() {
        let dir = std::env::temp_dir().join(format!("vidar-bare-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(launch_in(&dir, "t-1").unwrap(), None, "no manifests is no launch");
        assert_eq!(launch_in(&dir.join("missing"), "t-1").unwrap(), None);
        put(&dir, "2026-10-17T100000000Z-t-1-7.json", serde_json::json!({ "tab": "t-1", "agent": "claude", "createdUtc": "old", "payload": { "sets": ["Old"] } }));
        put(
            &dir,
            "2026-10-17T110000000Z-t-1-7.json",
            serde_json::json!({
                "tab": "t-1", "agent": "codex", "createdUtc": "2026-10-17T11:00:00Z",
                "binary": { "warning": "Codex 9 differs" },
                "payload": { "sets": ["Core", "UI"], "warnings": ["Set X disabled"] },
                "skills": ["tidy"], "guards": [], "warnings": ["No bareGuards"]
            }),
        );
        // another tab, newer, and one whose file name matches but whose `tab` differs
        put(&dir, "2026-10-17T120000000Z-t-2-7.json", serde_json::json!({ "tab": "t-2", "agent": "claude", "createdUtc": "x" }));
        put(&dir, "2026-10-17T130000000Z-t-1-8.json", serde_json::json!({ "tab": "t/1", "agent": "claude", "createdUtc": "y" }));
        let got = launch_in(&dir, "t-1").unwrap().unwrap();
        assert_eq!(
            got,
            LaunchRecord {
                created_utc: "2026-10-17T11:00:00Z".into(),
                agent: "codex".into(),
                sets: vec!["Core".into(), "UI".into()],
                skills: vec!["tidy".into()],
                guards: Vec::new(),
                warnings: vec!["Codex 9 differs".into(), "Set X disabled".into(), "No bareGuards".into()],
            }
        );
        assert_eq!(launch_in(&dir, "t-2").unwrap().unwrap().created_utc, "x");
        assert_eq!(launch_in(&dir, "t-3").unwrap(), None);
        let json = serde_json::to_value(&got).unwrap();
        assert_eq!(json["createdUtc"], "2026-10-17T11:00:00Z");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bare_launch_refuses_bad_tab_ids() {
        let dir = std::env::temp_dir();
        for tab in ["", "../x", "a/b", "a\\b", "t.json", "a b", &"x".repeat(129)] {
            assert!(launch_in(&dir, tab).is_err(), "tab {tab}");
        }
    }

    #[test]
    fn file_stamps_carry_no_colon() {
        let (iso, file) = stamps();
        assert!(iso.ends_with('Z') && !file.contains(':'), "{iso} {file}");
    }
}
