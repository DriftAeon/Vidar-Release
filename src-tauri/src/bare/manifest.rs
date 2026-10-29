//! src-tauri\src\bare\manifest.rs — one immutable JSON per bare launch in
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
    /// The row's rune sets built into this payload, in order; none on a plain one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sets: Vec<String>,
    /// The rune build's warnings for those sets (a disabled set skipped, ...); a Raw tab also
    /// prints them, a hosted one has only this record.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// The resolved items a launch loaded from the home-wide lists (W6): the source paths of the skills and agents the
/// copy plan took (as `bareSkills` / `bareAgents` hold them), the shared guards as `{ event, matcher?, run }`, and
/// Codex's hosted MCP names. The Runes tab matches these to its Inherited Runes rows; older manifests carry none.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct LaunchItems {
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    pub guards: Vec<serde_json::Value>,
    pub mcp: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shadow: Vec<String>,
}

impl LaunchItems {
    /// A guard-carrying launch's: the plan's skill and agent sources, the guards it carries and the module
    /// servers in its `--mcp-config` file.
    pub fn with_guards(plan: &super::copies::Plan, guards: &[super::guards::BareGuard], mcp: Vec<String>, shadow: Vec<String>) -> LaunchItems {
        let (skills, agents) = plan.item_sources();
        LaunchItems { skills, agents, guards: guards.iter().filter_map(|g| serde_json::to_value(g).ok()).collect(), mcp, shadow }
    }

    /// A launch that carries no guard list: the plan's sources and the module servers.
    pub fn without_guards(plan: &super::copies::Plan, mcp: Vec<String>, shadow: Vec<String>) -> LaunchItems {
        let (skills, agents) = plan.item_sources();
        LaunchItems { skills, agents, guards: Vec::new(), mcp, shadow }
    }

    /// A launch resolved through `set_loadout::resolve`: the loadout's skill and agent sources, its guard
    /// objects and its MCP server names.
    #[allow(dead_code)] // W2's launch paths adopt it.
    pub fn from_loadout(l: &super::set_loadout::Loadout) -> LaunchItems {
        LaunchItems { skills: l.skills.clone(), agents: l.agents.clone(), guards: l.guard_items.clone(), mcp: l.mcp.clone(), shadow: l.shadow.clone() }
    }
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
    /// Claude Bare: the guard scripts copied into `<claude config dir>\hooks\` (file names, sorted);
    /// empty when none. Codex: the `bareCodexGuards` copies (the shim included) its hooks.json
    /// runs, set only once Codex trusts them.
    pub guards: Vec<String>,
    /// The skills the spawn's copy sync placed (Claude: folder names the ledger holds; Codex: the
    /// `$name`s listed in its instructions), in `bareSkills` order; empty when none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    /// The resolved item paths this launch loaded (`LaunchItems`); absent on a manifest written before W6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<LaunchItems>,
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
    /// The `Loadout.hash` this launch resolved (`set_loadout.rs`); absent before the fold's W2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loadout_hash: Option<String>,
    /// The thread or conversation id once known, so a resume can compare its pick; absent when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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
    let bytes = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    write_bytes(dir, file_stamp, m, &bytes)
}

/// Hosted Claude's admitted MCP config is recorded alongside the payload. Raw and Codex
/// manifests keep their existing shape; only a hosted launch can supply this path.
pub fn write_hosted(dir: &Path, file_stamp: &str, m: &Manifest, mcp_file: Option<&Path>) -> Result<PathBuf, String> {
    let mut value = serde_json::to_value(m).map_err(|e| e.to_string())?;
    if let Some(path) = mcp_file {
        value["mcpFile"] = serde_json::Value::String(path.to_string_lossy().into_owned());
    }
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    write_bytes(dir, file_stamp, m, &bytes)
}

fn write_bytes(dir: &Path, file_stamp: &str, m: &Manifest, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = dir.join(format!("{file_stamp}-{}-{}.json", safe_tab(&m.tab), m.vidar_pid));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Bare manifest {}: {e}", path.display()))?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| format!("Bare manifest {}: {e}", path.display()))?;
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
    /// The resolved item paths the launch loaded; `None` for a manifest that predates them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<LaunchItems>,
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
        items: v.get("items").filter(|i| i.is_object()).map(|i| LaunchItems {
            skills: strs(&i["skills"]),
            agents: strs(&i["agents"]),
            guards: i["guards"].as_array().cloned().unwrap_or_default(),
            mcp: strs(&i["mcp"]),
            shadow: strs(&i["shadow"]),
        }),
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
    Ok(newest_in(dir, tab, false, |v| v["tab"].as_str() == Some(tab)).map(|v| record(&v)))
}

/// The newest manifest in `dir` that `hit` accepts. File names lead with a fixed-width stamp, so
/// sort order is age order; only names carrying `tab` are read, every name when `all` is set.
fn newest_in(dir: &Path, tab: &str, all: bool, hit: impl Fn(&serde_json::Value) -> bool) -> Option<serde_json::Value> {
    let needle = format!("-{}-", safe_tab(tab));
    let entries = std::fs::read_dir(dir).ok()?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json") && (all || n.contains(&needle)))
        .collect();
    names.sort();
    names.iter().rev().find_map(|name| {
        let text = crate::fsx::read_text(&dir.join(name)).ok()?;
        let v = serde_json::from_str::<serde_json::Value>(crate::fsx::strip_bom(&text)).ok()?;
        hit(&v).then_some(v)
    })
}

/// A record's agent id parsed once; an unknown id is no Claude launch, never a Claude one.
fn is_agent(record: Option<&str>, want: crate::agent_spec::Agent) -> bool {
    record.and_then(crate::agent_spec::parse) == Some(want)
}

/// The home (`AgentSpec.owner_field`) the newest `agent` launch of `tab` recorded, else (a re-adopted tab
/// under a new id) of the launch whose Falcon session is `session`; `None` when none did.
pub fn recorded_home_in(agent: crate::agent_spec::Agent, dir: &Path, tab: &str, session: Option<&str>) -> Option<PathBuf> {
    let field = crate::agent_spec::spec(agent).owner_field;
    let config = |v: &serde_json::Value| v.pointer(field).and_then(|c| c.as_str()).filter(|c| !c.is_empty()).map(PathBuf::from);
    let mine = |v: &serde_json::Value| is_agent(v["agent"].as_str(), agent) && config(v).is_some();
    if crate::rules::loaded::plain_id(tab, &['_']) {
        if let Some(v) = newest_in(dir, tab, false, |v| mine(v) && v["tab"].as_str() == Some(tab)) {
            return config(&v);
        }
    }
    let session = session.filter(|s| !s.is_empty())?;
    newest_in(dir, tab, true, |v| mine(v) && v["falconSession"].as_str() == Some(session)).and_then(|v| config(&v))
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
    fn both_launch_item_paths_report_shadow_and_keep_it_out_of_loadout_json() {
        let mut loadout = super::super::set_loadout::Loadout::default();
        loadout.shadow.push("lib/memo".into());
        let plan = super::super::copies::Plan::default();
        let guarded = LaunchItems::with_guards(&plan, &[], Vec::new(), loadout.shadow.clone());
        let plain = LaunchItems::without_guards(&plan, Vec::new(), loadout.shadow.clone());
        let from = LaunchItems::from_loadout(&loadout);
        for items in [guarded, plain, from] {
            assert_eq!(serde_json::to_value(items).unwrap()["shadow"], serde_json::json!(["lib/memo"]));
        }
        assert!(serde_json::to_value(loadout).unwrap().get("shadow").is_none());
    }

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
            items: None,
            git_keys: vec!["user.name".into()],
            warnings: Vec::new(),
            managed_policy: Policy { path: "q".into(), present: false },
            codex_rules: None,
            falcon_session: None,
            loadout_hash: None,
            thread_id: None,
        };
        let p = write(&dir, "2026-10-13T193000000Z", &m).unwrap();
        assert!(p.file_name().unwrap().to_string_lossy().ends_with("-s1_ab-7.json"));
        assert!(write(&dir, "2026-10-13T193000000Z", &m).is_err(), "rewrote an existing manifest");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["envNames"], serde_json::json!(["Path"]));
        assert_eq!(v["gitKeys"], serde_json::json!(["user.name"]));
        assert!(v["homes"].get("codexHome").is_none() && v.get("codexRules").is_none(), "Claude manifests carry no Codex fields");
        assert!(v.get("falconSession").is_none(), "a Raw manifest names no Falcon session");
        let hosted = write_hosted(&dir, "2026-10-13T194000000Z", &m, Some(Path::new("mcp.json"))).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(hosted).unwrap()).unwrap();
        assert_eq!(v["mcpFile"], "mcp.json");
        assert_eq!(v["payload"]["path"], "p");
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
                items: None,
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
    fn a_launch_record_carries_the_resolved_items_and_an_old_manifest_has_none() {
        let dir = std::env::temp_dir().join(format!("vidar-bare-launch-items-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        put(&dir, "2026-10-24T100000000Z-t-1-7.json", serde_json::json!({ "tab": "t-1", "agent": "claude", "createdUtc": "old", "skills": ["tidy"] }));
        let old = launch_in(&dir, "t-1").unwrap().unwrap();
        assert_eq!(old.items, None, "a manifest without items still parses, with none");
        assert_eq!(old.skills, vec!["tidy".to_string()]);
        put(
            &dir,
            "2026-10-24T110000000Z-t-1-7.json",
            serde_json::json!({
                "tab": "t-1", "agent": "claude", "createdUtc": "new",
                "items": { "skills": ["C:\\s\\tidy"], "agents": ["C:\\a\\x.md"], "guards": [{ "event": "Stop", "run": ["g.mjs"] }] }
            }),
        );
        let got = launch_in(&dir, "t-1").unwrap().unwrap();
        let items = got.items.clone().unwrap();
        assert_eq!((items.skills, items.agents, items.mcp), (vec!["C:\\s\\tidy".to_string()], vec!["C:\\a\\x.md".to_string()], Vec::<String>::new()));
        assert_eq!(items.guards, vec![serde_json::json!({ "event": "Stop", "run": ["g.mjs"] })]);
        assert_eq!(serde_json::to_value(&got).unwrap()["items"]["skills"], serde_json::json!(["C:\\s\\tidy"]));
        assert!(serde_json::to_value(&old).unwrap().get("items").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_agent_record_is_no_claude_launch() {
        let dir = std::env::temp_dir().join(format!("vidar-bare-manifest-grok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rec = |agent: &str| serde_json::json!({ "tab": "t-1", "agent": agent, "homes": { "claudeConfig": "C:\\h\\c" } });
        std::fs::write(dir.join("2026-10-24T100000000Z-t-1-1.json"), rec("grok").to_string()).unwrap();
        assert_eq!(recorded_home_in(crate::agent_spec::Agent::Claude, &dir, "t-1", None), None);
        std::fs::write(dir.join("2026-10-24T090000000Z-t-1-0.json"), rec("claude").to_string()).unwrap();
        assert_eq!(recorded_home_in(crate::agent_spec::Agent::Claude, &dir, "t-1", None), Some(PathBuf::from("C:\\h\\c")));
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
    fn claude_config_follows_the_tab_then_its_falcon_session() {
        let dir = std::env::temp_dir().join(format!("vidar-bare-manifest-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let put = |name: &str, v: serde_json::Value| std::fs::write(dir.join(name), v.to_string()).unwrap();
        put("2026-10-24T100000000Z-t-1-1.json", serde_json::json!({ "tab": "t-1", "agent": "claude", "falconSession": "fs-1", "homes": { "claudeConfig": "C:\\h\\old" } }));
        put("2026-10-24T110000000Z-t-1-2.json", serde_json::json!({ "tab": "t-1", "agent": "claude", "falconSession": "fs-1", "homes": { "claudeConfig": "C:\\h\\new" } }));
        put("2026-10-24T120000000Z-t-1-3.json", serde_json::json!({ "tab": "t-1", "agent": "codex", "homes": { "codexHome": "C:\\h\\codex" } }));
        assert_eq!(recorded_home_in(crate::agent_spec::Agent::Claude, &dir, "t-1", None), Some(PathBuf::from("C:\\h\\new")), "newest Claude launch of the tab");
        assert_eq!(recorded_home_in(crate::agent_spec::Agent::Claude, &dir, "t-9", Some("fs-1")), Some(PathBuf::from("C:\\h\\new")), "a re-adopted tab by its session");
        assert_eq!(recorded_home_in(crate::agent_spec::Agent::Claude, &dir, "t-9", None), None);
        assert_eq!(recorded_home_in(crate::agent_spec::Agent::Claude, &dir, "t-9", Some("fs-0")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_stamps_carry_no_colon() {
        let (iso, file) = stamps();
        assert!(iso.ends_with('Z') && !file.contains(':'), "{iso} {file}");
    }
}
