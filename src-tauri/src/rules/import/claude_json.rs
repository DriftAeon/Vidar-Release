//! src-tauri\src\rules\import\claude_json.rs — the user-scope MCP servers of the real home's `~/.claude.json`
//! (`paths::home()`), offered by the Bare Runes tab as Claude `mcp` rows (run 2026-10-25-kit-from-config, W1).
//! Read-only, and a secrets boundary:
//! - a typed serde parse of top-level `mcpServers` only (project scope is never read); `type` binds as a
//!   string and `url` as an optional string; `command` and `headers` are presence checks (`IgnoredAny`);
//!   `env`, `args` and every other key are never bound;
//! - the read is capped at 4 MiB; a parse failure is retried once, then offers no rows, and its reason is a
//!   fixed string, never serde's message (that embeds values);
//! - a row is pickable only when its url exactly equals the url of a catalog server Claude may load, and
//!   then carries that catalog server's name (`hosted`) and url, cloned from the catalog entry. Every other
//!   server is unpickable (`notModule`) and carries no url; command and args never leave here.

use std::collections::BTreeMap;
use std::path::Path;

use serde::de::IgnoredAny;
use serde::Deserialize;

use super::local::{file, LocalEnv, LocalFile};
use crate::bare::bundles::{Bundles, Mcp};

/// The read cap: `~/.claude.json` holds history and project state as well (93,501 B on the planner's machine).
pub const CAP: u64 = 4 * 1024 * 1024;
/// Fixed reasons; none carries a value from the file.
pub const PARSE_FAILED: &str = "~/.claude.json is not valid JSON of the expected shape; no Claude MCP servers offered";
pub const TOO_LARGE: &str = "~/.claude.json is over 4 MiB; no Claude MCP servers offered";
pub const UNREADABLE: &str = "~/.claude.json could not be read; no Claude MCP servers offered";

#[derive(Deserialize)]
struct Root {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, Entry>,
}

#[derive(Deserialize)]
struct Entry {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    command: Option<IgnoredAny>,
    #[serde(default)]
    headers: Option<IgnoredAny>,
}

/// One user-scope server, as far as this module binds it. `url` stays in Rust: it is only compared.
pub struct Server {
    pub name: String,
    pub kind: String,
    pub url: Option<String>,
    pub command: bool,
    pub headers: bool,
}

fn parse(text: &str) -> Result<Vec<Server>, &'static str> {
    let root: Root = serde_json::from_str(text).map_err(|_| PARSE_FAILED)?;
    Ok(root
        .mcp_servers
        .into_iter()
        .map(|(name, e)| Server { name, kind: e.kind, url: e.url, command: e.command.is_some(), headers: e.headers.is_some() })
        .collect())
}

fn read_once(path: &Path) -> Result<Vec<Server>, &'static str> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > CAP) {
        return Err(TOO_LARGE);
    }
    let text = crate::fsx::read_text_capped(path, CAP).map_err(|_| UNREADABLE)?;
    parse(&text)
}

/// The user-scope servers of `path`; a missing file has none. A parse failure (Claude Code may be mid-write)
/// is retried once.
pub fn servers(path: &Path) -> Result<Vec<Server>, &'static str> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    match read_once(path) {
        Err(PARSE_FAILED) => read_once(path),
        other => other,
    }
}

/// The catalog server whose http url equals `url` exactly and that Claude loads (no `agents`, or `claude`).
fn catalog_match<'a>(catalog: &'a Bundles, url: &str) -> Option<&'a Mcp> {
    let claude = |m: &Mcp| m.agents.is_empty() || m.agents.iter().any(|a| a.eq_ignore_ascii_case("claude"));
    catalog.bundles.values().flat_map(|b| b.mcp.iter()).find(|m| claude(m) && m.http.as_ref().is_some_and(|h| h.url == url))
}

/// The Claude `mcp` rows of `env.claude_json`, matched against `env.catalog`; any failure offers none.
pub fn rows(env: &LocalEnv) -> Vec<LocalFile> {
    let Some(path) = env.claude_json else { return Vec::new() };
    let Ok(servers) = servers(path) else { return Vec::new() };
    let empty = Bundles::default();
    let catalog = env.catalog.unwrap_or(&empty);
    servers
        .into_iter()
        .map(|s| {
            let base = LocalFile {
                path: format!("{}#{}", path.to_string_lossy(), s.name),
                shown: s.name.clone(),
                scope: "global",
                ..file(env, path, "mcp")
            };
            let http = s.kind.is_empty() || s.kind.eq_ignore_ascii_case("http");
            match s.url.as_deref().filter(|_| http).and_then(|u| catalog_match(catalog, u)) {
                Some(m) => LocalFile { hosted: Some(m.name.clone()), url: m.http.as_ref().map(|h| h.url.clone()), ..base },
                None => LocalFile { ticked: false, pickable: false, reason: Some("notModule"), ..base },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::super::local::{discover, LocalEnv, LocalSources};
    use super::*;

    const SECRETS: [&str; 4] = ["sk-secret-1", "sk-secret-2", "sk-secret-3", "sk-secret-4"];

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-import-claude-json-{tag}-{}", std::process::id()));
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
                "slack": { "mcp": [{ "name": "slack", "http": { "url": "https://mcp.slack.com/mcp" }, "agents": ["claude"], "reads": [] }], "skills": [], "agents": [], "guards": [] },
                "cx": { "mcp": [{ "name": "cx-only", "http": { "url": "https://cx.example.com/mcp" }, "agents": ["codex"], "reads": [] }], "skills": [], "agents": [], "guards": [] }
            }
        }))
        .unwrap()
    }

    fn run(root: &Path, home: &Path, homes: Option<&Path>, cat: &Bundles) -> LocalSources {
        let (imports, config, cwd) = (root.join("imports"), root.join("config-under-test.json"), root.join("cwd"));
        let (settings, claude_json) = (home.join(".claude").join("settings.json"), home.join(".claude.json"));
        let env = LocalEnv {
            imports: &imports,
            config: &config,
            home: Some(home),
            cwd: &cwd,
            primary: "",
            settings: Some(&settings),
            codex_home: None,
            homes,
            claude_json: Some(&claude_json),
            catalog: Some(cat),
        };
        discover(&env)
    }

    fn mcp_rows(s: &LocalSources) -> Vec<(String, bool, bool, Option<&str>, Option<String>, Option<String>)> {
        s.files.iter().filter(|f| f.kind == "mcp").map(|f| (f.shown.clone(), f.ticked, f.pickable, f.reason, f.hosted.clone(), f.url.clone())).collect()
    }

    #[test]
    fn claude_mcp_rows_never_echo_a_secret_and_a_catalog_url_is_pickable() {
        let root = temp("secrets");
        let home = root.join("home");
        let config = json!({
            "numStartups": 3,
            "mcpServers": {
                "envy": { "type": "stdio", "command": "srv", "args": [], "env": { "TOKEN": "sk-secret-1" } },
                "headed": { "type": "http", "url": "https://private.example.com/mcp", "headers": { "Authorization": "Bearer sk-secret-2" } },
                "query": { "type": "http", "url": "https://mcp.notion.com/mcp?key=sk-secret-3" },
                "argv": { "command": "npx", "args": ["--token", "sk-secret-4"] },
                "slack": { "type": "http", "url": "https://mcp.slack.com/mcp" },
                "codex-side": { "type": "http", "url": "https://cx.example.com/mcp" },
                "sse-notion": { "type": "sse", "url": "https://mcp.notion.com/mcp" }
            },
            "projects": { "C:/p": { "mcpServers": { "proj": { "type": "http", "url": "https://mcp.notion.com/mcp" } } } }
        });
        put(&home.join(".claude.json"), &config.to_string());
        let got = run(&root, &home, None, &catalog());
        let slack = Some("https://mcp.slack.com/mcp".to_string());
        let off = |n: &str| (n.to_string(), false, false, Some("notModule"), None, None);
        assert_eq!(
            mcp_rows(&got),
            vec![
                off("argv"),
                off("codex-side"),
                off("envy"),
                off("headed"),
                off("query"),
                ("slack".to_string(), true, true, None, Some("slack".to_string()), slack),
                off("sse-notion"),
            ]
        );
        assert!(got.files.iter().filter(|f| f.kind == "mcp").all(|f| f.agent.is_none() && f.scope == "global"));
        let json = serde_json::to_string(&got).unwrap();
        for s in SECRETS {
            assert!(!json.contains(s), "serialized {s}: {json}");
        }
        assert_eq!(json.matches("https://").count(), 1, "{json}");
        assert!(!json.contains("npx") && !json.contains("--token") && !json.contains("private.example.com"), "{json}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pickable_url_is_the_catalog_entry() {
        let root = temp("clone");
        let home = root.join("home");
        put(&home.join(".claude.json"), r#"{"mcpServers":{"n":{"url":"https://mcp.notion.com/mcp"}}}"#);
        let cat = catalog();
        let got = run(&root, &home, None, &cat);
        let row = got.files.iter().find(|f| f.kind == "mcp").unwrap();
        assert_eq!((row.pickable, row.hosted.as_deref(), row.url.as_deref()), (true, Some("notion"), Some("https://mcp.notion.com/mcp")));
        // No catalog: nothing is pickable.
        let none = run(&root, &home, None, &Bundles::default());
        assert!(none.files.iter().filter(|f| f.kind == "mcp").all(|f| !f.pickable && f.url.is_none()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_claude_home_under_the_agent_homes_offers_nothing() {
        let root = temp("homes");
        let homes = root.join("Vidar").join("homes");
        let home = homes.join("0123456789abcdef").join("claude");
        put(&home.join(".claude.json"), r#"{"mcpServers":{"slack":{"type":"http","url":"https://mcp.slack.com/mcp"}}}"#);
        put(&home.join(".claude/CLAUDE.md"), "- A Bare home's own rule line.\n");
        put(&home.join(".claude/rules/style.md"), "- A Bare home's own rules file.\n");
        put(&home.join(".claude/skills/demo/SKILL.md"), "---\nname: demo\n---\nDemo.\n");
        put(&home.join(".claude/agents/helper.md"), "---\nname: helper\n---\nHelps.\n");
        put(&home.join(".claude/settings.json"), r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node C:/h/guard-install.mjs"}]}]}}"#);
        let mem = super::super::memory::memory_dir(&home, &root.join("cwd"));
        put(&mem.join("a.md"), "---\nname: A\n---\n\nA memory line in a Bare home.\n");
        let cat = catalog();
        let inside = run(&root, &home, Some(&homes), &cat);
        assert!(inside.files.is_empty() && inside.memory_dir.is_none(), "{:#?}", inside.files);
        // The same home outside the root offers every kind.
        let outside = run(&root, &home, Some(&root.join("elsewhere")), &cat);
        let mut kinds: Vec<&str> = outside.files.iter().map(|f| f.kind).collect();
        kinds.dedup();
        assert_eq!(kinds, vec!["rules", "memory", "skill", "agent", "hook", "mcp"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_parse_error_offers_no_rows_and_no_serde_text() {
        let root = temp("parse");
        let home = root.join("home");
        let path = home.join(".claude.json");
        // A type error serde would quote; a syntax error too.
        for body in [r#"{"mcpServers":{"x":{"url":"sk-secret-1","type":7}}}"#, r#"{"mcpServers":{"x":{"url":"sk-secret-2""#] {
            put(&path, body);
            let err = servers(&path).err().unwrap();
            assert_eq!(err, PARSE_FAILED);
            assert!(!err.contains("sk-secret") && !err.contains("invalid type") && !err.contains("line"), "{err}");
            let got = run(&root, &home, None, &catalog());
            assert!(got.files.iter().all(|f| f.kind != "mcp"));
            assert!(SECRETS.iter().all(|s| !serde_json::to_string(&got).unwrap().contains(s)));
        }
        // Over the cap is refused before a parse; a missing file is no servers.
        put(&path, &format!("{{\"pad\":\"{}\"}}", "x".repeat(CAP as usize)));
        assert_eq!(servers(&path).err(), Some(TOO_LARGE));
        assert!(servers(&home.join("missing.json")).unwrap().is_empty());
        // Presence checks only: command and headers are seen, never kept.
        put(&path, r#"{"mcpServers":{"a":{"command":"x","headers":{"k":"v"}},"b":{"type":"http","url":"u"}}}"#);
        let s = servers(&path).unwrap();
        assert_eq!(s.iter().map(|s| (s.name.as_str(), s.kind.as_str(), s.command, s.headers)).collect::<Vec<_>>(), vec![("a", "", true, true), ("b", "http", false, false)]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
