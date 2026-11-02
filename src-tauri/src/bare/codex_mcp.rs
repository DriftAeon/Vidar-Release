//! src-tauri\src\bare\codex_mcp.rs — MCP servers on a Codex Bare launch.
//! A launch's MCP names come from the Rune Vault. Catalog-backed servers are written into
//! this vault's Codex config.toml as exact-checked tables, vidar_drive included: its row carries
//! name-only `env_vars` (`envPass`) and no approval pin. No server URL or token rides in argv.
//! A server whose `agents` leaves Codex out (Slack) never rides.

use super::bundles::{self, Mcp};
use super::home::TomlDoc;
use crate::agent_spec::Agent;

/// The servers a launch carries: each of `names` (a loadout's `mcp`, pick order) as the first catalog
/// bundle server of that name whose `agents` is empty or names Codex; a name no bundle serves to Codex
/// is left out.
pub(super) fn for_launch(names: &[String], catalog: &bundles::Bundles) -> Vec<Mcp> {
    let mut out: Vec<Mcp> = Vec::new();
    for n in names {
        if out.iter().any(|o| o.name.eq_ignore_ascii_case(n)) {
            continue;
        }
        if let Some(m) = catalog.bundles.values().flat_map(|b| b.mcp.iter()).find(|m| m.name.eq_ignore_ascii_case(n) && bundles::serves(m, Agent::Codex)) {
            out.push(m.clone());
        }
    }
    out
}

/// The `-c` overrides for `servers`: the args the line runs, the same with env values replaced by
/// their names (for the manifest), and the warnings for servers left off.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct LaunchArgs {
    pub args: Vec<String>,
    pub recorded: Vec<String>,
    pub warnings: Vec<String>,
}

/// A TOML basic string (JSON's escapes are a subset TOML reads).
fn toml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// One server a launch carries: its scalar keys as TOML values (`url`, or `command` and `args`, then
/// the approval mode) and its `env` pairs (name, value read from the spawning process).
struct Entry {
    name: String,
    keys: Vec<(&'static str, String)>,
    env: Vec<(String, String)>,
}

/// The servers that ride, and the warnings for those left off. HTTP: `url`; stdio: `command`, `args`,
/// and `env` from `env_from` names read through `env`, the spawning process's own env (the Bare
/// allowlist would drop a token); a missing one leaves the server off with a warning. Every server
/// pins the approval mode. A server or env name that is not a bare TOML key is left off.
fn entries(servers: &[Mcp], env: &dyn Fn(&str) -> Option<String>) -> (Vec<Entry>, Vec<String>) {
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let mut out = Vec::new();
    let mut warnings = Vec::new();
    for m in servers {
        let n = &m.name;
        if !plain(n) {
            warnings.push(format!("MCP server {n:?}: not a plain name; left off"));
            continue;
        }
        let mut keys: Vec<(&'static str, String)> = Vec::new();
        let mut pairs: Vec<(String, String)> = Vec::new();
        match (&m.http, &m.stdio) {
            (Some(h), _) => keys.push(("url", toml_str(&h.url))),
            (None, Some(s)) => {
                keys.push(("command", toml_str(&s.command)));
                keys.push(("args", format!("[{}]", s.args.iter().map(|a| toml_str(a)).collect::<Vec<_>>().join(","))));
                for k in &s.env_from {
                    let Some(v) = env(k).filter(|_| plain(k)) else { break };
                    pairs.push((k.clone(), v));
                }
                if pairs.len() != s.env_from.len() {
                    warnings.push(format!("MCP server {n:?}: an env value it reads is not set; left off"));
                    continue;
                }
                if s.env_pass.iter().any(|k| !plain(k)) {
                    warnings.push(format!("MCP server {n:?}: an env name it forwards is not a plain name; left off"));
                    continue;
                }
                if !s.env_pass.is_empty() {
                    keys.push(("env_vars", format!("[{}]", s.env_pass.iter().map(|k| toml_str(k)).collect::<Vec<_>>().join(","))));
                }
            }
            (None, None) => {
                warnings.push(format!("MCP server {n:?}: no url or command; left off"));
                continue;
            }
        }
        if let Some(t) = m.timeout_sec {
            keys.push(("tool_timeout_sec", t.to_string()));
        }
        if m.approval != Some(bundles::Approval::None) {
            keys.push((APPROVAL_KEY, toml_str(APPROVAL_MODE)));
        }
        out.push(Entry { name: n.clone(), keys, env: pairs });
    }
    (out, warnings)
}

/// The `[mcp_servers.*]` tables a config.toml carries: the text appended to it and the dotted keys
/// and values that text parses back to, which `check` holds the file to exactly. Empty: no table.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Tables {
    pub text: String,
    pub doc: TomlDoc,
    /// The servers' names, in table order (the launch record's `items.mcp`).
    pub names: Vec<String>,
}

impl Tables {
    /// The enabled `bareCodexMcp` servers' tables (`tables`); tests only, launches use `servers`.
    #[cfg(test)]
    pub fn hosted(enabled: &[&Hosted]) -> Self {
        let text = tables(enabled);
        let doc = super::home::parse_toml_lite(&text).unwrap_or_default();
        Tables { text, doc, names: enabled.iter().map(|h| h.name.to_string()).collect() }
    }

    /// The tables for catalog-backed vault servers on either Codex surface. Stdio `env` is an
    /// `[mcp_servers.<name>.env]` table in the isolated home, never a command-line override.
    /// Returns the warnings for servers left off.
    pub(super) fn servers(servers: &[Mcp], env: &dyn Fn(&str) -> Option<String>) -> Result<(Self, Vec<String>), String> {
        let (entries, warnings) = entries(servers, env);
        let mut blocks = Vec::new();
        for e in &entries {
            let mut b = format!("[mcp_servers.{}]\n", e.name);
            for (k, v) in &e.keys {
                b.push_str(&format!("{k} = {v}\n"));
            }
            if !e.env.is_empty() {
                b.push_str(&format!("\n[mcp_servers.{}.env]\n", e.name));
                for (k, v) in &e.env {
                    b.push_str(&format!("{k} = {}\n", toml_str(v)));
                }
            }
            blocks.push(b);
        }
        let text = blocks.join("\n");
        let doc = super::home::parse_toml_lite(&text).map_err(|e| format!("{L}: MCP tables do not parse ({e}); spawn refused"))?;
        Ok((Tables { text, doc, names: entries.into_iter().map(|e| e.name).collect() }, warnings))
    }

    /// The dotted doc keys the tables add.
    pub fn keys(&self) -> Vec<String> {
        self.doc.iter().map(|(k, _)| k.clone()).collect()
    }
}

/// A hosted server Codex Bare may carry: the table name and its pinned URL (test fixtures only;
/// importers match the catalog).
#[cfg(test)]
#[derive(Debug)]
pub struct Hosted {
    pub name: &'static str,
    pub url: &'static str,
}

/// The servers `bareCodexMcp` may name (urls as `tools/mcp/hosted-add.ps1`).
#[cfg(test)]
pub const HOSTED: &[Hosted] = &[
    Hosted { name: "notion", url: "https://mcp.notion.com/mcp" },
    Hosted { name: "atlassian", url: "https://mcp.atlassian.com/v2/mcp" },
];

/// The approval mode every hosted table pins: reads run, writes card.
pub const APPROVAL_KEY: &str = "default_tools_approval_mode";
pub const APPROVAL_MODE: &str = "writes";

const L: &str = "Bare Codex config";

/// The `[mcp_servers.<n>]` tables for `enabled`, each ending in a newline, blank line between.
#[cfg(test)]
pub fn tables(enabled: &[&Hosted]) -> String {
    enabled
        .iter()
        .map(|h| format!("[mcp_servers.{}]\nurl = \"{}\"\n{APPROVAL_KEY} = \"{APPROVAL_MODE}\"\n", h.name, h.url))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every `mcp_servers.*` key must be one of the tables' keys, and every one of those must hold
/// exactly the value the tables wrote.
pub fn check(doc: &TomlDoc, tables: &Tables) -> Result<(), String> {
    for (k, _) in doc.iter().filter(|(k, _)| k.starts_with("mcp_servers.")) {
        if !tables.doc.iter().any(|(n, _)| n == k) {
            return Err(format!("{L}: {k} is not an enabled server key; spawn refused"));
        }
    }
    for (k, want) in &tables.doc {
        let got = doc.iter().find(|(n, _)| n == k).map(|(_, v)| v);
        if got != Some(want) {
            return Err(format!("{L}: {k} differs from the launch's MCP table; spawn refused"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::home::Toml;
    use serde_json::json;

    fn table(names: &[&str]) -> (Tables, TomlDoc) {
        let enabled: Vec<&'static Hosted> = HOSTED.iter().filter(|h| names.contains(&h.name)).collect();
        let doc = super::super::home::parse_toml_lite(&tables(&enabled)).unwrap();
        (Tables::hosted(&enabled), doc)
    }

    #[test]
    fn an_enabled_hosted_table_is_accepted() {
        let (enabled, doc) = table(&["notion", "atlassian"]);
        assert_eq!(doc.len(), 4);
        check(&doc, &enabled).unwrap();
    }

    #[test]
    fn a_changed_url_is_refused() {
        let (enabled, mut doc) = table(&["notion"]);
        doc[0].1 = Toml::Str("https://evil.example/mcp".into());
        assert!(check(&doc, &enabled).unwrap_err().contains("mcp_servers.notion.url"));
    }

    #[test]
    fn a_changed_approval_mode_or_extra_key_is_refused() {
        let (enabled, mut doc) = table(&["notion"]);
        doc[1].1 = Toml::Str("approve".into());
        assert!(check(&doc, &enabled).unwrap_err().contains(APPROVAL_KEY));
        let (enabled, mut doc) = table(&["notion"]);
        doc.push(("mcp_servers.notion.bearer_token_env_var".into(), Toml::Str("X".into())));
        assert!(check(&doc, &enabled).unwrap_err().contains("bearer_token_env_var"));
    }

    #[test]
    fn a_table_that_is_not_enabled_is_refused() {
        let (_, doc) = table(&["notion", "atlassian"]);
        let (enabled, _) = table(&["notion"]);
        assert!(check(&doc, &enabled).unwrap_err().contains("mcp_servers.atlassian"));
        let (enabled, _) = table(&["notion"]);
        assert!(check(&Vec::new(), &enabled).unwrap_err().contains("mcp_servers.notion"));
    }

    fn stdio(name: &str, agents: &[&str], env_from: &[&str]) -> Mcp {
        let stdio = bundles::Stdio { command: "node".into(), args: vec!["srv.js".into(), "--x".into()], env_from: env_from.iter().map(|s| s.to_string()).collect(), env_pass: Vec::new() };
        Mcp { name: name.into(), http: None, stdio: Some(stdio), agents: agents.iter().map(|s| s.to_string()).collect(), reads: bundles::Reads::Names(Vec::new()), optional: false, approval: None, timeout_sec: None }
    }

    #[test]
    fn vault_tables_carry_a_selected_server_and_omit_an_unselected_one() {
        let catalog: bundles::Bundles = serde_json::from_value(json!({ "version": 1, "bundles": { "team": {
            "mcp": [
                { "name": "files", "stdio": { "command": "node", "args": ["f.js"], "envFrom": ["FILES_TOKEN"] }, "reads": [] },
                { "name": "chat", "http": { "url": "https://chat.example/mcp" }, "reads": [] },
                { "name": "slack", "http": { "url": "https://slack.example/mcp" }, "agents": ["claude"], "reads": [] }
            ], "skills": [], "agents": [], "guards": [] } } })).unwrap();
        // The loadout names `files` but not `chat`; `slack` leaves Codex out whatever the loadout says.
        let names: Vec<String> = ["notion", "files", "slack"].map(String::from).to_vec();
        let servers = for_launch(&names, &with_notion(catalog));
        assert_eq!(servers.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["notion", "files"]);
        let (tables, warnings) = Tables::servers(&servers, &|k| (k == "FILES_TOKEN").then(|| "fixture-token".to_string())).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(tables.names, ["notion", "files"]);
        assert!(tables.text.contains("[mcp_servers.files.env]"));
        assert!(!tables.text.contains("chat") && !tables.text.contains("slack"));
    }

    #[test]
    fn a_server_missing_an_env_value_or_leaving_codex_out_is_left_off() {
        let catalog = catalog_of(vec![stdio("a", &[], &["NOPE"]), stdio("b", &["claude"], &[]), stdio("bad name", &[], &[])]);
        let names: Vec<String> = ["a", "b", "bad name", "unknown"].map(String::from).to_vec();
        let servers = for_launch(&names, &catalog);
        assert_eq!(servers.len(), 2);
        let (tables, warnings) = Tables::servers(&servers, &|_| None).unwrap();
        assert!(tables.names.is_empty());
        assert_eq!(warnings.len(), 2, "{warnings:?}");
    }

    #[test]
    fn a_config_with_no_mcp_table_is_what_check_accepts_with_nothing_enabled() {
        check(&Vec::new(), &Tables::default()).unwrap();
        let (_, doc) = table(&["notion"]);
        assert!(check(&doc, &Tables::default()).unwrap_err().contains("mcp_servers.notion"));
    }

    #[test]
    fn a_none_approval_server_forwards_names_and_pins_no_approval() {
        let mut m = stdio("drv", &[], &[]);
        m.approval = Some(bundles::Approval::None);
        m.timeout_sec = Some(60);
        m.stdio.as_mut().unwrap().env_pass = vec!["CTL_A".into(), "CTL_B".into()];
        let (t, w) = Tables::servers(&[m, stdio("plain", &[], &[])], &|_| None).unwrap();
        assert!(w.is_empty(), "{w:?}");
        assert!(t.text.contains("env_vars = [\"CTL_A\",\"CTL_B\"]\ntool_timeout_sec = 60\n"), "{}", t.text);
        assert!(!t.doc.iter().any(|(k, _)| k.starts_with("mcp_servers.drv.") && k.ends_with(APPROVAL_KEY)));
        assert!(t.doc.iter().any(|(k, _)| k == &format!("mcp_servers.plain.{APPROVAL_KEY}")));
        let mut bad = stdio("bad", &[], &[]);
        bad.stdio.as_mut().unwrap().env_pass = vec!["A B".into()];
        assert_eq!(Tables::servers(&[bad], &|_| None).unwrap().0.names.len(), 0);
    }

    #[test]
    fn server_tables_hold_the_selected_values_and_check_them_exactly() {
        let http = Mcp { name: "chat".into(), http: Some(bundles::Http { url: "https://chat.example/mcp".into(), oauth: None }), stdio: None, agents: Vec::new(), reads: bundles::Reads::Names(Vec::new()), optional: false, approval: None, timeout_sec: None };
        let catalog = with_notion(catalog_of(vec![http, stdio("files", &[], &["FILES_TOKEN"]), stdio("off", &[], &["NOPE"])]));
        let servers = for_launch(&["notion", "chat", "files", "off"].map(String::from), &catalog);
        let env = |k: &str| (k == "FILES_TOKEN").then(|| "s3\"cret".to_string());
        let (t, warnings) = Tables::servers(&servers, &env).unwrap();
        assert_eq!(t.names, ["notion", "chat", "files"]);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        let get = |k: &str| t.doc.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("mcp_servers.notion.url"), Some(Toml::Str("https://mcp.notion.com/mcp".into())));
        assert_eq!(get("mcp_servers.chat.url"), Some(Toml::Str("https://chat.example/mcp".into())));
        assert_eq!(get("mcp_servers.files.command"), Some(Toml::Str("node".into())));
        assert_eq!(get("mcp_servers.files.args"), Some(Toml::Array(vec![Toml::Str("srv.js".into()), Toml::Str("--x".into())])));
        assert_eq!(get("mcp_servers.files.env.FILES_TOKEN"), Some(Toml::Str("s3\"cret".into())));
        for n in ["notion", "chat", "files"] {
            assert_eq!(get(&format!("mcp_servers.{n}.{APPROVAL_KEY}")), Some(Toml::Str(APPROVAL_MODE.into())), "{n}");
        }
        assert!(get("mcp_servers.off.command").is_none());
        // The file as written passes; a changed value, a dropped key or an extra one is refused.
        let doc = super::super::home::parse_toml_lite(&t.text).unwrap();
        check(&doc, &t).unwrap();
        let mut changed = doc.clone();
        changed.iter_mut().find(|(k, _)| k == "mcp_servers.files.command").unwrap().1 = Toml::Str("evil".into());
        assert!(check(&changed, &t).unwrap_err().contains("mcp_servers.files.command"));
        let dropped: TomlDoc = doc.iter().filter(|(k, _)| k != "mcp_servers.files.env.FILES_TOKEN").cloned().collect();
        assert!(check(&dropped, &t).unwrap_err().contains("FILES_TOKEN"));
        let mut extra = doc.clone();
        extra.push(("mcp_servers.files.env.OTHER".into(), Toml::Str("x".into())));
        assert!(check(&extra, &t).unwrap_err().contains("OTHER"));
    }

    /// A catalog of one bundle `team` serving `mcp`.
    fn catalog_of(mcp: Vec<Mcp>) -> bundles::Bundles {
        let mut c: bundles::Bundles = serde_json::from_value(json!({ "version": 1, "bundles": { "team": { "mcp": [], "skills": [], "agents": [], "guards": [] } } })).unwrap();
        c.bundles.get_mut("team").unwrap().mcp = mcp;
        c
    }

    /// `catalog` plus a `notion` bundle serving the hosted notion url, as the checked-in catalog does.
    fn with_notion(mut catalog: bundles::Bundles) -> bundles::Bundles {
        let notion: bundles::Bundle = serde_json::from_value(json!({ "mcp": [{ "name": "notion", "http": { "url": "https://mcp.notion.com/mcp" }, "reads": [] }], "skills": [], "agents": [], "guards": [] })).unwrap();
        catalog.bundles.insert("notion".into(), notion);
        catalog
    }

    #[test]
    fn for_launch_follows_the_loadout_order_and_dedupes() {
        let catalog = with_notion(catalog_of(vec![stdio("files", &[], &[]), stdio("slack", &["claude"], &[])]));
        let names = ["files", "notion", "FILES", "slack"].map(String::from);
        assert_eq!(for_launch(&names, &catalog).iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["files", "notion"]);
    }

    #[test]
    fn for_launch_never_widens_an_unknown_agent_tag() {
        let catalog = catalog_of(vec![stdio("odd", &["grok"], &[]), stdio("mixed", &["grok", "codex"], &[]), stdio("cased", &["Codex"], &[])]);
        let names = ["odd", "mixed", "cased"].map(String::from);
        assert_eq!(for_launch(&names, &catalog).iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), Vec::<&str>::new());
    }
}
