//! src-tauri\src\rules\import\codex_home.rs — what a Codex home (`CODEX_HOME`, else `~\.codex`) offers the
//! Bare Runes tab beside Claude's files (run 2026-10-19-codex-primary, plan-p2 D1-D3 and Revisions).
//! Read-only, and an allow-list: only these names are touched, nothing else in the home is opened.
//! Hook discovery reads hooks.json with a size cap and serializes only event, matcher, program and an opaque pick reference.
//! - `AGENTS.override.md` / `AGENTS.md`: stat only here (`sources::list` offers the one Codex reads); with an
//!   override present, `AGENTS.md` is listed unpickable (`shadowed`); an override over 256 KB is `tooLarge`.
//! - `config.toml`: read capped at `MAX_BYTES`, BOM stripped, parsed by `codex_config::parse`; only each
//!   `mcp_servers` table's name, transport, url and `enabled` are used. URLs are matched inside this module;
//!   `command`, `args`, env, headers and bearer values never leave
//!   here. Same-url tables list once; `enabled = false` starts unticked. A bad config offers no MCP rows.
//! - `memories\memory_summary.md`: stat only, library `codex-memory`, unticked. `memories\MEMORY.md`: a stat
//!   (never read), listed unpickable (`tooLarge` over 256 KB, else `summaryOnly`).
//! - `skills\<name>\SKILL.md` and `memories\skills\<name>\SKILL.md`: stat only; `.system` and other dot
//!   folders are skipped; a memory skill whose name a home skill already has starts unticked.
//! - `agents\*.toml`: stat only (dot files skipped), kind `agent` with `agent: "codex"`, ticked and pickable
//!   as Codex skills are; the layer write checks the content (`copies::check_codex_agent`).
//! - A home under the Bare agent homes root offers nothing.

use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::local::{file, listed, readable_md, Guard, LocalEnv, LocalFile};
use super::sources::{self, AGENTS_OVERRIDE, MAX_BYTES};
use crate::bare::bundles::{Bundles, Mcp};

/// The Codex home's offer, grouped by where each group sits in `local::discover`.
#[derive(Default)]
pub struct Found {
    pub rules: Vec<LocalFile>,
    pub memory: Vec<LocalFile>,
    pub skills: Vec<LocalFile>,
    pub agents: Vec<LocalFile>,
    pub mcp: Vec<LocalFile>,
}

/// The Codex home to read, or `None` when there is none or it sits under the agent homes root.
pub(super) fn usable<'a>(env: &LocalEnv<'a>) -> Option<&'a Path> {
    env.codex_home.filter(|c| !env.homes.is_some_and(|h| sources::under_root(c, h)))
}

fn codex(f: LocalFile) -> LocalFile {
    LocalFile { agent: Some("codex"), ..f }
}

fn over_cap(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES)
}

fn rules(env: &LocalEnv, home: &Path) -> Vec<LocalFile> {
    let (over, agents) = (home.join(AGENTS_OVERRIDE), home.join("AGENTS.md"));
    let mut out = Vec::new();
    if !over.is_file() {
        return out;
    }
    if !readable_md(&over) {
        out.push(codex(LocalFile { ticked: false, pickable: false, reason: Some("tooLarge"), ..file(env, &over, "rules") }));
    }
    if agents.is_file() {
        out.push(codex(LocalFile { ticked: false, pickable: false, reason: Some("shadowed"), ..file(env, &agents, "rules") }));
    }
    out
}

fn memory(env: &LocalEnv, home: &Path) -> Vec<LocalFile> {
    let dir = home.join("memories");
    let mut out = Vec::new();
    let summary = dir.join("memory_summary.md");
    if summary.is_file() {
        let base = LocalFile { ticked: false, ..file(env, &summary, "memory") };
        out.push(codex(if readable_md(&summary) {
            let library = sources::library_of_in(env.imports, &summary, env.home, Some(home), Some(env.cwd), env.primary);
            LocalFile { library: Some(library), ..base }
        } else {
            LocalFile { pickable: false, reason: Some("tooLarge"), ..base }
        }));
    }
    let index = dir.join("MEMORY.md");
    if index.is_file() {
        let reason = if over_cap(&index) { "tooLarge" } else { "summaryOnly" };
        out.push(codex(LocalFile { ticked: false, pickable: false, reason: Some(reason), ..file(env, &index, "memory") }));
    }
    out
}

fn skill_dirs(dir: &Path) -> Vec<std::path::PathBuf> {
    listed(dir, |p| {
        p.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.')) && p.is_dir() && p.join("SKILL.md").is_file()
    })
}

fn skills(env: &LocalEnv, home: &Path) -> Vec<LocalFile> {
    let own = skill_dirs(&home.join("skills"));
    let names: Vec<String> = own.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().to_lowercase()).collect();
    let mut out: Vec<LocalFile> = own.iter().map(|p| codex(file(env, p, "skill"))).collect();
    for p in skill_dirs(&home.join("memories").join("skills")) {
        let clash = p.file_name().is_some_and(|n| names.contains(&n.to_string_lossy().to_lowercase()));
        out.push(codex(LocalFile { ticked: !clash, ..file(env, &p, "skill") }));
    }
    out
}

/// `agents\*.toml` of the home: stat only, dot files skipped; the layer write checks each file's content.
fn agents(env: &LocalEnv, home: &Path) -> Vec<LocalFile> {
    listed(&home.join("agents"), |p| {
        p.is_file()
            && p.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.'))
            && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("toml"))
    })
    .iter()
    .map(|p| codex(file(env, p, "agent")))
    .collect()
}

/// The catalog server whose http url equals `url` and that Codex may load.
fn catalog_match<'a>(catalog: &'a Bundles, url: &str) -> Option<&'a Mcp> {
    let codex = |m: &Mcp| m.agents.is_empty() || m.agents.iter().any(|a| a.eq_ignore_ascii_case("codex"));
    catalog.bundles.values().flat_map(|b| b.mcp.iter()).find(|m| codex(m) && m.http.as_ref().is_some_and(|h| h.url == url))
}

/// The MCP rows of `<home>\config.toml`; any read or parse failure gives none.
fn mcp(env: &LocalEnv, home: &Path) -> Vec<LocalFile> {
    let path = home.join("config.toml");
    let Ok(text) = crate::fsx::read_text_capped(&path, MAX_BYTES) else { return Vec::new() };
    let Ok(config) = crate::codex_config::parse(crate::fsx::strip_bom(&text), None) else { return Vec::new() };
    let mut out: Vec<LocalFile> = Vec::new();
    let mut urls: Vec<(String, usize)> = Vec::new();
    for server in &config.mcp_servers {
        let http = server.transport == "http";
        if http {
            if let Some(&(_, at)) = urls.iter().find(|(u, _)| *u == server.target) {
                // A second table naming the same url lists once; either enabled ticks a hosted row.
                if out[at].pickable && server.enabled {
                    out[at].ticked = true;
                }
                continue;
            }
            urls.push((server.target.clone(), out.len()));
        }
        let hosted = if http { env.catalog.and_then(|c| catalog_match(c, &server.target)) } else { None };
        let base = LocalFile {
            path: format!("{}#{}", path.to_string_lossy(), server.name),
            shown: server.name.clone(),
            ticked: false,
            ..file(env, &path, "mcp")
        };
        out.push(codex(match hosted {
            Some(h) => LocalFile { ticked: server.enabled, hosted: Some(h.name.clone()), url: h.http.as_ref().map(|v| v.url.clone()), ..base },
            None => LocalFile { pickable: false, reason: Some(if http { "notModule" } else { "stdio" }), ..base },
        }));
    }
    out
}

/// Every file the Codex home of `env` offers, grouped for `local::discover`.
pub fn discover(env: &LocalEnv) -> Found {
    let Some(home) = usable(env) else { return Found::default() };
    Found { rules: rules(env, home), memory: memory(env, home), skills: skills(env, home), agents: agents(env, home), mcp: mcp(env, home) }
}

/// Parsed command entries, retaining their original string only inside this module.
fn hook_entries(home: &Path) -> Vec<(String, Option<String>, String, String)> {
    let Ok(text) = crate::fsx::read_text_capped(&home.join("hooks.json"), MAX_BYTES) else { return Vec::new() };
    let Ok(root) = serde_json::from_str::<Value>(crate::fsx::strip_bom(&text)) else { return Vec::new() };
    let Some(events) = root.get("hooks").and_then(Value::as_object) else { return Vec::new() };
    let mut out = Vec::new();
    for (event, groups) in events {
        for (group_index, group) in groups.as_array().into_iter().flatten().enumerate() {
            let matcher = group.get("matcher").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
            for (hook_index, hook) in group.get("hooks").and_then(Value::as_array).into_iter().flatten().enumerate() {
                if hook.get("type").and_then(Value::as_str) != Some("command") { continue }
                let Some(command) = hook.get("command").and_then(Value::as_str) else { continue };
                let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&json!([event, matcher, command])).unwrap_or_default()));
                let id = crate::bare::guards::raw_id(event, matcher.as_deref(), command);
                out.push((event.clone(), matcher.clone(), command.to_string(), format!("{group_index}:{hook_index}:{digest}:{id}")));
            }
        }
    }
    out
}

/// The Codex home's hooks are shared rows. Their source digest is checked again when picked.
pub fn hooks(env: &LocalEnv) -> Vec<LocalFile> {
    let Some(home) = usable(env) else { return Vec::new() };
    let path = home.join("hooks.json");
    hook_entries(home).into_iter().map(|(event, matcher, _command, source)| {
        let shown = format!("{} · {} · Command Hook", event, matcher.as_deref().unwrap_or("*"));
        let supported = crate::bare::guards::codex_unsupported(&event, matcher.as_deref()).is_none();
        let guard = Guard { event: event.clone(), matcher, run: Vec::new(), source: Some(source.clone()) };
        LocalFile { path: format!("{}#{event}:{source}", path.display()), shown, ticked: false, guard: Some(guard), codex_supported: Some(supported), ..file(env, &path, "hook") }
    }).collect()
}

/// Resolve an opaque discovery reference against the same Codex home at pick time. A changed entry
/// fails closed, so a selection cannot silently import a different command.
pub(crate) fn resolve_hook_at(home: &Path, event: &str, matcher: Option<&str>, source: &str) -> Result<Value, String> {
    let (_, _, command, _) = hook_entries(home).into_iter()
        .find(|(e, m, _, id)| e == event && m.as_deref() == matcher && id == source)
        .ok_or("Codex hook changed since discovery; refresh Local Files")?;
    let mut rune = json!({ "event": event, "command": command });
    if let Some(m) = matcher { rune["matcher"] = json!(m); }
    Ok(rune)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::super::local::{discover as discover_all, LocalEnv, LocalSources};
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/codex-home")
    }

    /// Every value the fixture plants where no import may echo it.
    const SENTINELS: [&str; 12] = [
        "SENTINEL-AUTH-JSON",
        "SENTINEL-BEARER",
        "SENTINEL-HEADER",
        "SENTINEL-ENV-HEADER",
        "SENTINEL-ENV-VALUE",
        "SENTINEL-TRUST-PATH",
        "SENTINEL-NOTIFY",
        "SENTINEL-STDIO-COMMAND",
        "SENTINEL-STDIO-ARG",
        "SENTINEL-PRIVATE-URL",
        "SENTINEL-RAW-MEMORY",
        "SENTINEL-DEFAULT-RULES",
    ];

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-import-codex-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn catalog() -> Bundles {
        serde_json::from_value(json!({
            "version": 1,
            "bundles": {
                "notion": { "mcp": [{ "name": "notion", "http": { "url": "https://mcp.notion.com/mcp" }, "reads": [] }], "skills": [], "agents": [], "guards": [] },
                "atlassian": { "mcp": [{ "name": "atlassian", "http": { "url": "https://mcp.atlassian.com/v2/mcp" }, "agents": ["codex"], "reads": [] }], "skills": [], "agents": [], "guards": [] },
                "claude-only": { "mcp": [{ "name": "claude-only", "http": { "url": "https://claude.example/mcp" }, "agents": ["claude"], "reads": [] }], "skills": [], "agents": [], "guards": [] }
            }
        })).unwrap()
    }

    fn run(root: &Path, codex: &Path, homes: Option<&Path>) -> LocalSources {
        let (imports, config, cwd) = (root.join("imports"), root.join("config-under-test.json"), root.join("cwd"));
        let cat = catalog();
        let env = LocalEnv { imports: &imports, config: &config, home: None, cwd: &cwd, primary: "", settings: None, codex_home: Some(codex), homes, claude_json: None, catalog: Some(&cat) };
        discover_all(&env)
    }

    fn named<'a>(s: &'a LocalSources, kind: &str, end: &str) -> &'a LocalFile {
        s.files.iter().find(|f| f.kind == kind && f.path.ends_with(end)).unwrap_or_else(|| panic!("no {kind} {end}: {:#?}", s.files))
    }

    #[test]
    fn codex_discovery_never_echoes_a_config_value_or_url() {
        // The source export drops every file named AGENTS.md (.gitattributes export-ignore), this fixture included.
        if !fixture().join("AGENTS.md").exists() {
            eprintln!("skipped: tests/fixtures/codex-home/AGENTS.md is not in this tree (export-ignored by name)");
            return;
        }
        let root = temp("echo");
        let got = run(&root, &fixture(), None);
        let rows: Vec<(&str, bool, bool, Option<&str>, Option<&str>, Option<&str>)> = got
            .files
            .iter()
            .filter(|f| f.kind == "mcp")
            .map(|f| (f.shown.as_str(), f.ticked, f.pickable, f.reason, f.hosted.as_deref(), f.url.as_deref()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("atlassian", false, true, None, Some("atlassian"), Some("https://mcp.atlassian.com/v2/mcp")),
                ("local-tools", false, false, Some("stdio"), None, None),
                ("notion", true, true, None, Some("notion"), Some("https://mcp.notion.com/mcp")),
                ("private-wiki", false, false, Some("notModule"), None, None),
            ],
            "{:#?}",
            got.files
        );
        assert!(got.files.iter().filter(|f| f.kind == "mcp").all(|f| f.agent == Some("codex") && f.scope == "global"));
        // Internal matching retains catalog URLs; command IPC strips them.
        let json = serde_json::to_string(&got).unwrap();
        for s in SENTINELS {
            assert!(!json.contains(s), "serialized {s}: {json}");
        }
        assert_eq!(json.matches("https://").count(), 2, "{json}");
        let ipc = serde_json::to_string(&super::super::local::redact_ipc(got.clone())).unwrap();
        assert!(!ipc.contains("https://"), "{ipc}");
        // The override replaces AGENTS.md; AGENTS.md is listed, shadowed.
        let agents = named(&got, "rules", "\\AGENTS.md");
        assert_eq!((agents.pickable, agents.ticked, agents.reason), (false, false, Some("shadowed")));
        let over = named(&got, "rules", AGENTS_OVERRIDE);
        assert_eq!((over.pickable, over.ticked, over.library.as_deref(), over.agent), (true, false, Some("codex-user"), Some("codex")));
        assert_eq!(got.files.iter().filter(|f| f.kind == "rules").count(), 2);
        // memory_summary.md fills `codex-memory`, unticked; MEMORY.md is listed but never picked.
        let summary = named(&got, "memory", "memory_summary.md");
        assert_eq!((summary.library.as_deref(), summary.ticked, summary.pickable), (Some("codex-memory"), false, true));
        let index = named(&got, "memory", "MEMORY.md");
        assert_eq!((index.pickable, index.ticked, index.reason, index.library.is_none()), (false, false, Some("summaryOnly"), true));
        assert_eq!(got.files.iter().filter(|f| f.kind == "memory").count(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_mcp_matches_only_catalog_urls_available_to_codex() {
        let root = temp("catalog-scope");
        let home = root.join("codex");
        put(&home.join("config.toml"), "[mcp_servers.private]\nurl = \"https://private.example/mcp?key=sk-secret-1\"\n\n[mcp_servers.claude_only]\nurl = \"https://claude.example/mcp\"\n\n[mcp_servers.atlassian]\nurl = \"https://mcp.atlassian.com/v2/mcp\"\n");
        let got = run(&root, &home, None);
        let rows: Vec<_> = got.files.iter().filter(|f| f.kind == "mcp").collect();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().filter(|f| f.pickable).all(|f| f.shown == "atlassian" && f.hosted.as_deref() == Some("atlassian")));
        assert!(rows.iter().filter(|f| !f.pickable).all(|f| f.reason == Some("notModule") && f.url.is_none()));
        let json = serde_json::to_string(&got).unwrap();
        assert!(!json.contains("sk-secret-1") && !json.contains("private.example") && !json.contains("claude.example"), "{json}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_hook_discovery_is_opaque_and_the_pick_recovers_the_exact_command() {
        let root = temp("hook-command");
        let home = root.join("codex");
        let command = "pwsh -NoProfile -Command '$token = \"sk-secret-1\"; exit 7'";
        put(&home.join("hooks.json"), &json!({ "hooks": {
            "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": command }] }],
            "Notification": [{ "hooks": [{ "type": "command", "command": "node notice.mjs" }] }]
        }}).to_string());
        let got = run(&root, &home, None);
        let rows: Vec<_> = got.files.iter().filter(|f| f.kind == "hook").collect();
        assert_eq!(rows.len(), 2);
        let selected = rows.iter().find(|f| f.guard.as_ref().is_some_and(|g| g.event == "PreToolUse")).unwrap();
        assert!(selected.pickable && selected.shown == "PreToolUse · Bash · Command Hook");
        assert_eq!(selected.codex_supported, Some(true));
        assert_eq!(rows.iter().find(|f| f.guard.as_ref().is_some_and(|g| g.event == "Notification")).unwrap().codex_supported, Some(false));
        let serialized = serde_json::to_string(&got).unwrap();
        assert!(!serialized.contains("sk-secret-1") && !serialized.contains("exit 7") && !serialized.contains("$token"), "{serialized}");
        let guard = selected.guard.as_ref().unwrap();
        let rune = resolve_hook_at(&home, &guard.event, guard.matcher.as_deref(), guard.source.as_deref().unwrap()).unwrap();
        assert_eq!(rune, json!({ "event": "PreToolUse", "matcher": "Bash", "command": command }));
        put(&home.join("hooks.json"), &json!({ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "pwsh changed" }] }] } }).to_string());
        assert!(resolve_hook_at(&home, &guard.event, guard.matcher.as_deref(), guard.source.as_deref().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hook_label_never_uses_the_command_program() {
        let root = temp("hook-label");
        let home = root.join("codex");
        put(&home.join("hooks.json"), &json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sk-secret-1 --run"}]}]}}).to_string());
        let got = run(&root, &home, None);
        assert!(!serde_json::to_string(&got).unwrap().contains("sk-secret-1"));
        assert_eq!(got.files.iter().find(|f| f.kind == "hook").unwrap().shown, "Stop · * · Command Hook");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn codex_skills_skip_dot_system_and_list_memory_skills() {
        let root = temp("skills");
        let got = run(&root, &fixture(), None);
        let skills: Vec<(String, bool)> = got
            .files
            .iter()
            .filter(|f| f.kind == "skill")
            .map(|f| (Path::new(&f.path).strip_prefix(fixture()).unwrap().to_string_lossy().replace('\\', "/"), f.ticked))
            .collect();
        assert_eq!(
            skills,
            vec![("skills/demo".to_string(), true), ("memories/skills/demo".to_string(), false), ("memories/skills/source-review".to_string(), true)]
        );
        assert!(got.files.iter().all(|f| !f.path.contains(".system")));
        // A home under the agent homes root offers nothing of its own.
        let homes = fixture().parent().unwrap().to_path_buf();
        let none = run(&root, &fixture(), Some(&homes));
        assert!(none.files.iter().all(|f| f.agent.is_none()), "{:#?}", none.files);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_agents_list_toml_files_with_the_codex_agent_tag() {
        let root = temp("agents");
        let home = root.join("codex");
        put(&home.join("agents/reviewer.toml"), "name = \"reviewer\"\ndeveloper_instructions = \"x\"\n");
        put(&home.join("agents/planner.toml"), "name = \"planner\"\n");
        put(&home.join("agents/notes.md"), "not a role\n");
        put(&home.join("agents/.hidden.toml"), "name = \"h\"\n");
        let got = run(&root, &home, None);
        let rows: Vec<(String, bool, bool, Option<&str>)> = got
            .files
            .iter()
            .filter(|f| f.agent == Some("codex") && f.kind == "agent")
            .map(|f| (Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned(), f.ticked, f.pickable, f.agent))
            .collect();
        assert_eq!(rows, vec![("planner.toml".to_string(), true, true, Some("codex")), ("reviewer.toml".to_string(), true, true, Some("codex"))]);
        // The Claude agents listing is not mixed in, and a missing folder offers none.
        assert!(got.files.iter().filter(|f| f.kind == "agent").all(|f| f.agent == Some("codex")));
        let empty = run(&root, &root.join("nowhere"), None);
        assert!(empty.files.iter().all(|f| f.kind != "agent"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bad_codex_config_offers_no_mcp_and_discovery_still_lists_files() {
        let root = temp("bad");
        let home = root.join("codex");
        put(&home.join("AGENTS.md"), "- Keep diffs small.\n");
        put(&home.join("skills/demo/SKILL.md"), "---\nname: demo\n---\nDemo.\n");
        put(&home.join("memories/memory_summary.md"), "- A summary line.\n");
        put(&home.join("config.toml"), "[mcp_servers.notion\nurl = \"https://mcp.notion.com/mcp\"\nbearer_token_env_var = \"SENTINEL-BEARER\"\n");
        let got = run(&root, &home, None);
        assert!(got.files.iter().all(|f| f.kind != "mcp"), "{:#?}", got.files);
        let kinds: Vec<&str> = got.files.iter().map(|f| f.kind).collect();
        assert_eq!(kinds, vec!["rules", "memory", "skill"]);
        assert!(!serde_json::to_string(&got).unwrap().contains("SENTINEL"));
        // A BOM-led config parses; one over the cap offers nothing.
        put(&home.join("config.toml"), "\u{FEFF}[mcp_servers.notion]\nurl = \"https://mcp.notion.com/mcp\"\n");
        assert_eq!(run(&root, &home, None).files.iter().filter(|f| f.kind == "mcp").count(), 1);
        put(&home.join("config.toml"), &format!("[mcp_servers.notion]\nurl = \"https://mcp.notion.com/mcp\"\n#{}\n", "x".repeat(MAX_BYTES as usize)));
        assert!(run(&root, &home, None).files.iter().all(|f| f.kind != "mcp"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_path_under_the_agent_homes_is_refused_and_memory_summary_names_codex_memory() {
        let root = temp("homes");
        let homes = root.join("Vidar").join("homes");
        let inside = homes.join("0123456789abcdef").join("codex").join("AGENTS.md");
        put(&inside, "- A Bare home's own file.\n");
        let err = sources::read_in(&inside, Some(&homes)).unwrap_err();
        assert!(err.contains("Bare agent home"), "{err}");
        assert!(sources::read_in(&root.join("Vidar/homes/../homes/0123456789abcdef/codex/AGENTS.md"), Some(&homes)).is_err());
        assert!(sources::read_in(&inside, Some(&root.join("elsewhere"))).is_ok());
        let codex = root.join("codex");
        let summary = codex.join("memories").join("memory_summary.md");
        let lib = sources::library_of_in(&root.join("imports"), &summary, None, Some(&codex), None, "");
        assert_eq!(lib, "codex-memory");
        let _ = std::fs::remove_dir_all(&root);
    }
}
