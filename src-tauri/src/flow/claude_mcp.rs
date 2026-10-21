//! A Flow Claude stage's extras on the Bare home (run 2026-10-19-codex-primary, W3e2): the Bare
//! profile's static payload and the user's own URL-only MCP servers, as sidecar argv.
//!
//! Argv shape, appended after the sidecar's fixed args (gateway-model nodes get none of it):
//!   `--flow-payload bare --root <abs Vidar root> [--mcp-servers <json>]`
//! `--flow-payload` makes the sidecar read the profile's `payload` file and send its text as
//! `systemPrompt.append` (tools/claude-sidecar-bare.mjs `flowPayload`); the CLI never sees a path.
//! `--mcp-servers` is a JSON object `{"<name>":{"type":"http"|"sse","url":"<url>"}}`, the SDK's
//! `mcpServers` option as-is (`flowMcpServers`).
//!
//! The servers are the user-scope `mcpServers` of the user's own `~\.claude.json` (the file
//! mcp.rs reads with no profile), through a URL-only filter, the JSON twin of
//! `codex_config::url_only_servers`: only `type` and `url` are read and carried. A server with
//! `headers`, `headersHelper`, `env`, `command`, `args` or `oauth` (stdio servers among them), a URL
//! with a login, a type other than http/sse, or a name the sidecar refuses stays out with one
//! warning naming it; no header, env or token value is ever read into a string, printed or logged.
//! A name the Bare config dir's own `.claude.json` defines is not carried (the Bare one wins).
//! `plugin_*` names are refused: plugin servers live in that namespace (`mcp__plugin_vidar_drive`
//! is auto-allowed), so a user server there could shadow one. An unparsable `~\.claude.json`
//! carries nothing and warns once; the run continues. The JSON is capped at `MAX_JSON` bytes
//! (Windows' command line is 32,767 characters in all); servers past the cap stay out with a warning.

use std::path::Path;

use serde_json::{Map, Value};

use super::bare::{Need, PROFILE};

/// Byte cap on the `--mcp-servers` JSON, well inside the 32,767-character command line.
pub(super) const MAX_JSON: usize = 8 * 1024;
/// Entry keys that carry a secret or make a server stdio: any of them keeps it out.
const SECRET_KEYS: [&str; 6] = ["headers", "headersHelper", "env", "command", "args", "oauth"];

#[derive(Debug, Default, PartialEq)]
pub(super) struct Carry {
    pub(super) servers: Map<String, Value>,
    pub(super) warnings: Vec<String>,
}

fn left_out(name: &str, reason: &str) -> String {
    format!("MCP server \"{name}\" left out of Flow: {reason}")
}

/// The name rule the sidecar enforces (`flowMcpServers`).
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `http(s)://` with no `user:pass@` in the authority.
fn url_kind(url: &str) -> Result<(), &'static str> {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or("it is not an http or sse server")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("its URL carries a login");
    }
    Ok(())
}

/// Pure: the user's URL-only servers from the text of `~\.claude.json` (`None`: no file), less
/// the names in `bare_names`.
pub(super) fn url_only_servers(user_json: Option<&str>, bare_names: &[String]) -> Carry {
    let mut carry = Carry::default();
    let Some(text) = user_json else { return carry };
    let Ok(root) = serde_json::from_str::<Value>(text.trim_start_matches('\u{FEFF}')) else {
        carry.warnings.push("MCP servers left out of Flow: Invalid .claude.json".to_string());
        return carry;
    };
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else { return carry };
    let mut size = 2; // "{}"
    for (name, entry) in servers {
        if bare_names.iter().any(|b| b == name) {
            continue;
        }
        let reason = if !valid_name(name) {
            Some("its name is not valid for the Flow sidecar")
        } else if name.starts_with("plugin_") {
            Some("its name is reserved for plugin servers")
        } else if let Some(obj) = entry.as_object() {
            if SECRET_KEYS.iter().any(|k| obj.contains_key(*k)) {
                Some("it carries headers, a token, env or a command")
            } else {
                match (obj.get("type").and_then(Value::as_str), obj.get("url").and_then(Value::as_str)) {
                    (Some("http" | "sse"), Some(url)) => url_kind(url).err(),
                    _ => Some("it is not an http or sse server"),
                }
            }
        } else {
            Some("it is not an http or sse server")
        };
        if let Some(why) = reason {
            carry.warnings.push(left_out(name, why));
            continue;
        }
        let kind = entry["type"].clone();
        let url = entry["url"].clone();
        let one = serde_json::json!({ "type": kind, "url": url });
        // "name":{...} plus a comma.
        let add = Value::from(name.as_str()).to_string().len() + 1 + one.to_string().len() + 1;
        if size + add > MAX_JSON {
            carry.warnings.push(left_out(name, "the server list is too long for the command line"));
            continue;
        }
        size += add;
        carry.servers.insert(name.clone(), one);
    }
    carry
}

/// Pure: the sidecar argv a stage on `need` gets, and its warnings. Gateway (and Codex) nodes get
/// nothing, so their spawn stays as before.
pub(super) fn stage_args(need: Need, root: &Path, carry: Carry) -> (Vec<String>, Vec<String>) {
    if need != Need::Claude {
        return (Vec::new(), Vec::new());
    }
    let mut args = vec![
        "--flow-payload".to_string(),
        PROFILE.to_string(),
        "--root".to_string(),
        root.display().to_string(),
    ];
    if !carry.servers.is_empty() {
        args.push("--mcp-servers".to_string());
        args.push(Value::Object(carry.servers).to_string());
    }
    (args, carry.warnings)
}

/// User-scope server names in a `.claude.json` (the Bare config dir's), or none.
pub(super) fn defined_names(json: Option<&str>) -> Vec<String> {
    json.and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{FEFF}')).ok())
        .and_then(|v| v.get("mcpServers").and_then(Value::as_object).map(|m| m.keys().cloned().collect()))
        .unwrap_or_default()
}

/// Production: reads `~\.claude.json` and the Bare config dir's `.claude.json` (absent: none).
pub(super) fn for_stage(need: Need, bare_config_dir: Option<&Path>) -> (Vec<String>, Vec<String>) {
    if need != Need::Claude {
        return (Vec::new(), Vec::new());
    }
    let read = |p: Option<std::path::PathBuf>| p.filter(|p| p.is_file()).and_then(|p| crate::fsx::read_text(&p).ok());
    let user = read(crate::bare::claude_dir::claude_json_for(None));
    let bare = read(bare_config_dir.map(|d| d.join(".claude.json")));
    let carry = url_only_servers(user.as_deref(), &defined_names(bare.as_deref()));
    stage_args(need, &crate::paths::root(), carry)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = r#"{
      "numStartups": 3,
      "mcpServers": {
        "proxy": { "type": "http", "url": "http://127.0.0.1:8765/mcp" },
        "events": { "type": "sse", "url": "https://events.example/sse" },
        "local": { "type": "stdio", "command": "node", "args": ["srv.js"], "env": { "K": "secret-env" } },
        "bare-stdio": { "command": "npx", "args": ["x"] },
        "authed": { "type": "http", "url": "https://api.example/mcp", "headers": { "Authorization": "Bearer secret-token" } },
        "login": { "type": "http", "url": "https://u:p@host.example/mcp" },
        "ws": { "type": "ws", "url": "wss://x.example" },
        "plugin_vidar_drive": { "type": "http", "url": "http://127.0.0.1:1/mcp" },
        "vidar_drive": { "type": "http", "url": "http://127.0.0.1:2/mcp" }
      },
      "projects": { "C:/p": { "mcpServers": { "proj": { "type": "http", "url": "http://p" } } } }
    }"#;

    /// http and sse are kept with exactly type and url; stdio and header servers stay out with a
    /// warning that names them and no value; the Bare config's own name is not carried.
    #[test]
    fn url_only_filter_keeps_http_and_sse_and_drops_the_rest() {
        let carry = url_only_servers(Some(USER), &["vidar_drive".to_string()]);
        assert_eq!(
            Value::Object(carry.servers.clone()),
            serde_json::json!({
                "proxy": { "type": "http", "url": "http://127.0.0.1:8765/mcp" },
                "events": { "type": "sse", "url": "https://events.example/sse" }
            })
        );
        assert_eq!(
            carry.warnings,
            [
                "MCP server \"local\" left out of Flow: it carries headers, a token, env or a command",
                "MCP server \"bare-stdio\" left out of Flow: it carries headers, a token, env or a command",
                "MCP server \"authed\" left out of Flow: it carries headers, a token, env or a command",
                "MCP server \"login\" left out of Flow: its URL carries a login",
                "MCP server \"ws\" left out of Flow: it is not an http or sse server",
                "MCP server \"plugin_vidar_drive\" left out of Flow: its name is reserved for plugin servers",
            ]
        );
        let all = format!("{:?}", carry);
        assert!(!all.contains("secret"), "no header or env value is carried: {all}");
        assert!(!all.contains("proj"), "only user scope is read");
    }

    /// A malformed file carries nothing and warns once; no file or no servers is silent.
    #[test]
    fn malformed_or_absent_claude_json() {
        let bad = url_only_servers(Some("{ not json"), &[]);
        assert!(bad.servers.is_empty());
        assert_eq!(bad.warnings, ["MCP servers left out of Flow: Invalid .claude.json"]);
        assert_eq!(url_only_servers(None, &[]), Carry::default());
        assert_eq!(url_only_servers(Some("{}"), &[]), Carry::default());
        assert_eq!(defined_names(Some(USER)).len(), 9);
        assert!(defined_names(Some("nope")).is_empty());
    }

    /// Past the byte cap the rest stay out with a warning; the JSON stays under it.
    #[test]
    fn the_json_is_capped() {
        let mut servers = Map::new();
        for i in 0..200 {
            servers.insert(format!("s{i:03}"), serde_json::json!({ "type": "http", "url": format!("https://host.example/{}", "x".repeat(40)) }));
        }
        let text = serde_json::json!({ "mcpServers": servers }).to_string();
        let carry = url_only_servers(Some(&text), &[]);
        assert!(!carry.servers.is_empty() && carry.servers.len() < 200);
        assert_eq!(carry.servers.len() + carry.warnings.len(), 200);
        assert!(Value::Object(carry.servers).to_string().len() <= MAX_JSON);
        assert!(carry.warnings[0].ends_with("the server list is too long for the command line"));
    }

    /// A Claude stage gets the payload and the servers; a gateway stage gets nothing.
    #[test]
    fn stage_args_for_claude_vs_gateway() {
        let root = Path::new(r"C:\Vidar");
        let (args, warnings) = stage_args(Need::Claude, root, url_only_servers(Some(USER), &["vidar_drive".to_string()]));
        assert_eq!(
            args,
            [
                "--flow-payload",
                "bare",
                "--root",
                r"C:\Vidar",
                "--mcp-servers",
                r#"{"proxy":{"type":"http","url":"http://127.0.0.1:8765/mcp"},"events":{"type":"sse","url":"https://events.example/sse"}}"#,
            ]
        );
        assert_eq!(warnings.len(), 6);
        let (args, _) = stage_args(Need::Claude, root, Carry::default());
        assert_eq!(args, ["--flow-payload", "bare", "--root", r"C:\Vidar"]);
        assert_eq!(stage_args(Need::Gateway, root, url_only_servers(Some(USER), &[])), (Vec::new(), Vec::new()));
        assert_eq!(for_stage(Need::Gateway, None), (Vec::new(), Vec::new()));
    }
}
