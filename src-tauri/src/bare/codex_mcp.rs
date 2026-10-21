//! src-tauri\src\bare\codex_mcp.rs — opt-in hosted MCP servers in the Codex Bare config.
//! `bareCodexMcp` in vidar.json (`["notion", "atlassian"]`) names the hosted servers a Codex Bare tab
//! carries, read raw on every spawn like `bareGuards`. No key (or no file) means none. Each enabled
//! server becomes `[mcp_servers.<name>]` with its pinned `url` and `default_tools_approval_mode =
//! "writes"` (reads run, writes ask), nothing else. Refusals: an unreadable vidar.json, a value that
//! is not a list of strings, an unknown name, a duplicate, and slack (manual only).

use std::path::Path;

use serde_json::Value;

use super::home::{Toml, TomlDoc};

/// A hosted server Codex Bare may carry: the table name and its pinned URL.
#[derive(Debug)]
pub struct Hosted {
    pub name: &'static str,
    pub url: &'static str,
}

/// The servers `bareCodexMcp` may name (urls as `tools/mcp/hosted-add.ps1`).
pub const HOSTED: &[Hosted] = &[
    Hosted { name: "notion", url: "https://mcp.notion.com/mcp" },
    Hosted { name: "atlassian", url: "https://mcp.atlassian.com/v2/mcp" },
];

/// The approval mode every hosted table pins: reads run, writes card.
pub const APPROVAL_KEY: &str = "default_tools_approval_mode";
pub const APPROVAL_MODE: &str = "writes";

const L: &str = "Bare Codex config";

/// The enabled servers from vidar.json at `config`, in `HOSTED` order.
pub fn read_enabled(config: &Path) -> Result<Vec<&'static Hosted>, String> {
    let text = match crate::fsx::read_text(config) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("vidar.json {} is unreadable ({e}); Bare spawn refused", config.display())),
    };
    let root: Value = serde_json::from_str(crate::fsx::strip_bom(&text))
        .map_err(|e| format!("vidar.json {} is unreadable ({e}); Bare spawn refused", config.display()))?;
    parse_enabled(root.get("bareCodexMcp"))
}

fn parse_enabled(v: Option<&Value>) -> Result<Vec<&'static Hosted>, String> {
    let bad = || "vidar.json `bareCodexMcp` is not a list of server names; Bare spawn refused".to_string();
    let list = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(bad()),
    };
    let mut names: Vec<&str> = Vec::new();
    for item in list {
        let name = item.as_str().ok_or_else(bad)?;
        if names.contains(&name) {
            return Err(format!("vidar.json `bareCodexMcp` names {name:?} twice; Bare spawn refused"));
        }
        names.push(name);
    }
    for name in &names {
        if *name == "slack" {
            return Err("vidar.json `bareCodexMcp`: slack is manual only, see hosted-mcp.md; Bare spawn refused".into());
        }
        if !HOSTED.iter().any(|h| h.name == *name) {
            let known: Vec<&str> = HOSTED.iter().map(|h| h.name).collect();
            return Err(format!("vidar.json `bareCodexMcp`: unknown server {name:?} (known: {}); Bare spawn refused", known.join(", ")));
        }
    }
    Ok(HOSTED.iter().filter(|h| names.contains(&h.name)).collect())
}

/// Checks a `bareCodexMcp` list a layer write would store: every name hosted (url-only), none twice, slack
/// refused. Same rules as `parse_enabled`, without its "Bare spawn refused" suffix.
pub fn validate_names(names: &[String]) -> Result<(), String> {
    parse_enabled(Some(&Value::from(names.to_vec()))).map(|_| ()).map_err(|e| e.trim_end_matches("; Bare spawn refused").to_string())
}

/// The `[mcp_servers.<n>]` tables for `enabled`, each ending in a newline, blank line between.
pub fn tables(enabled: &[&Hosted]) -> String {
    enabled
        .iter()
        .map(|h| format!("[mcp_servers.{}]\nurl = \"{}\"\n{APPROVAL_KEY} = \"{APPROVAL_MODE}\"\n", h.name, h.url))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The dotted doc keys the enabled tables add.
pub fn keys(enabled: &[&Hosted]) -> Vec<String> {
    enabled.iter().flat_map(|h| [format!("mcp_servers.{}.url", h.name), format!("mcp_servers.{}.{APPROVAL_KEY}", h.name)]).collect()
}

/// Every `mcp_servers.*` key outside `vidar_drive` must be exactly one of the enabled servers' two
/// keys with its pinned value, and every enabled server must hold both.
pub fn check(doc: &TomlDoc, enabled: &[&Hosted]) -> Result<(), String> {
    for (k, _) in doc.iter().filter(|(k, _)| k.starts_with("mcp_servers.") && !k.starts_with("mcp_servers.vidar_drive.")) {
        let ok = enabled.iter().any(|h| *k == format!("mcp_servers.{}.url", h.name) || *k == format!("mcp_servers.{}.{APPROVAL_KEY}", h.name));
        if !ok {
            return Err(format!("{L}: {k} is not an enabled hosted server key; spawn refused"));
        }
    }
    for h in enabled {
        for (f, want) in [("url", h.url), (APPROVAL_KEY, APPROVAL_MODE)] {
            let k = format!("mcp_servers.{}.{f}", h.name);
            let got = doc.iter().find(|(n, _)| *n == k).map(|(_, v)| v);
            if got != Some(&Toml::Str(want.into())) {
                return Err(format!("{L}: {k} must be \"{want}\"; spawn refused"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table(names: &[&str]) -> (Vec<&'static Hosted>, TomlDoc) {
        let enabled: Vec<&'static Hosted> = HOSTED.iter().filter(|h| names.contains(&h.name)).collect();
        let doc = super::super::home::parse_toml_lite(&tables(&enabled)).unwrap();
        (enabled, doc)
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
        let enabled: Vec<&'static Hosted> = HOSTED.iter().filter(|h| h.name == "notion").collect();
        assert!(check(&doc, &enabled).unwrap_err().contains("mcp_servers.atlassian"));
        let (enabled, _) = table(&["notion"]);
        assert!(check(&Vec::new(), &enabled).unwrap_err().contains("must be"));
    }

    #[test]
    fn read_enabled_refuses_slack_unknown_and_bad_values_and_none_is_empty() {
        assert!(parse_enabled(None).unwrap().is_empty());
        assert!(parse_enabled(Some(&json!([]))).unwrap().is_empty());
        assert_eq!(parse_enabled(Some(&json!(["atlassian", "notion"]))).unwrap().iter().map(|h| h.name).collect::<Vec<_>>(), ["notion", "atlassian"]);
        assert!(parse_enabled(Some(&json!(["slack"]))).unwrap_err().contains("manual only"));
        assert!(parse_enabled(Some(&json!(["figma"]))).unwrap_err().contains("unknown server"));
        assert!(parse_enabled(Some(&json!(["notion", "notion"]))).unwrap_err().contains("twice"));
        assert!(parse_enabled(Some(&json!("notion"))).unwrap_err().contains("not a list"));
        assert!(parse_enabled(Some(&json!([1]))).unwrap_err().contains("not a list"));
        assert!(read_enabled(Path::new(r"Z:\no\such\vidar.json")).unwrap().is_empty());
    }
}
