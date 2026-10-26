//! Read the Codex home config for the Rack and Loadout readers.
//! Keep parsing separate from Tauri state and expose only selected, safe fields.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use toml::{Table, Value};

pub(crate) enum Home {
    Live(PathBuf),
    NotRunning,
    Profile(PathBuf),
    /// `None` means no user home is available, never an empty path.
    Default(Option<PathBuf>),
}

/// The Codex home a tab reads: its Rune Vault session record, then its live session's; with
/// neither, a Bare profile reads its own legacy home.
pub(crate) fn home_for_row(app: &AppHandle, tab: Option<&str>, profile: Option<&str>, _row: Option<&str>) -> Home {
    resolve(
        tab.and_then(|id| recorded_home(&crate::paths::root(), id))
            .or_else(|| tab.and_then(|id| app.state::<crate::agent::AgentManager>().codex_home(id))),
        profile,
        crate::bare::codex_home_for_profile,
        crate::rules::codex::codex_home(),
    )
}

fn recorded_home(root: &Path, tab: &str) -> Option<PathBuf> {
    crate::bare::vault::session::find(root, tab, None, None).ok().flatten()
        .filter(|r| r.agent == "codex")
        .map(|r| PathBuf::from(r.home))
}

/// Live session first; else a set Bare profile resolves its own home (Err means not
/// running, never the user's home); else the user's default home.
pub(crate) fn resolve(
    live: Option<PathBuf>,
    profile: Option<&str>,
    lookup: impl Fn(&str) -> Result<PathBuf, String>,
    default_home: Option<PathBuf>,
) -> Home {
    resolve_row(live, profile, None, lookup, |_, _| Err(String::new()), default_home)
}

/// D1: The row branch has no session or vault id; production reaches this only through `resolve`
/// (no row), and only tests pass a row.
/// `resolve` with a row: a named row's picked home replaces the profile's legacy one. A row that
/// cannot be picked (unreadable vidar.json) falls back to the legacy home, never the user's.
pub(crate) fn resolve_row(
    live: Option<PathBuf>,
    profile: Option<&str>,
    row: Option<&str>,
    lookup: impl Fn(&str) -> Result<PathBuf, String>,
    pick_row: impl Fn(&str, &str) -> Result<PathBuf, String>,
    default_home: Option<PathBuf>,
) -> Home {
    if let Some(path) = live {
        return Home::Live(path);
    }
    if let Some(id) = profile {
        let row = row.map(str::trim).filter(|r| !r.is_empty());
        let picked = row.and_then(|r| pick_row(id, r).ok());
        return match picked.map(Ok).unwrap_or_else(|| lookup(id)) {
            Ok(path) => Home::Profile(path),
            Err(_) => Home::NotRunning,
        };
    }
    Home::Default(default_home)
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexConfig {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) sandbox_mode: Option<String>,
    pub(crate) approval_policy: Option<String>,
    pub(crate) approvals_reviewer: Option<String>,
    pub(crate) network_access: Option<bool>,
    pub(crate) project_doc_max_bytes: Option<u64>,
    pub(crate) project_root_markers: Option<Vec<String>>,
    pub(crate) developer_instructions_len: Option<usize>,
    pub(crate) notify: Vec<String>,
    pub(crate) mcp_servers: Vec<CodexMcp>,
    /// Each listed server's `startup_timeout_sec`; read by Flow's MCP readiness timeout, not
    /// sent to the UI. Kept beside `CodexMcp` so its struct literals stay unchanged.
    #[serde(skip)]
    pub(crate) mcp_startup_timeout_sec: std::collections::HashMap<String, f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexMcp {
    pub(crate) name: String,
    pub(crate) transport: String,
    pub(crate) target: String,
    pub(crate) args: Vec<String>,
    pub(crate) env_keys: Vec<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) enabled: bool,
}

pub(crate) fn read(home: &Path) -> Result<Option<CodexConfig>, String> {
    if home.as_os_str().is_empty() {
        return Err("Codex home is unavailable".into());
    }
    let text = match fs::read_to_string(home.join("config.toml")) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read Codex config.toml: {error}")),
    };
    parse(&text, None).map(Some)
}

/// `codex_profile` is a Codex `[profiles.x]` name, not a Vidar Bare profile id.
pub(crate) fn parse(text: &str, codex_profile: Option<&str>) -> Result<CodexConfig, String> {
    // Do not return the parser's source excerpt: config files may hold credentials.
    let root =
        toml::from_str::<Table>(text).map_err(|_| "Invalid Codex config.toml".to_string())?;
    let selected_profile = codex_profile.or_else(|| string(&root, "profile"));
    let overlay = selected_profile
        .and_then(|name| table(&root, "profiles").and_then(|profiles| table(profiles, name)));
    let effective = |key| {
        overlay
            .and_then(|values| string(values, key))
            .or_else(|| string(&root, key))
    };

    let mut mcp_servers = Vec::new();
    let mut mcp_startup_timeout_sec = std::collections::HashMap::new();
    if let Some(servers) = table(&root, "mcp_servers") {
        for (name, value) in servers {
            let Some(server) = value.as_table() else {
                continue;
            };
            let (transport, target) = if let Some(url) = string(server, "url") {
                ("http", url)
            } else if let Some(command) = string(server, "command") {
                ("stdio", command)
            } else {
                continue;
            };
            // Read map keys alone. Never inspect credential-bearing env/header values.
            let mut env_keys = table(server, "env")
                .map(|env| env.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            env_keys.sort();
            mcp_servers.push(CodexMcp {
                name: name.clone(),
                transport: transport.into(),
                target: target.into(),
                args: strings(server, "args").unwrap_or_default(),
                env_keys,
                cwd: string(server, "cwd").map(str::to_owned),
                enabled: server
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            });
            if let Some(secs) = server
                .get("startup_timeout_sec")
                .and_then(|v| v.as_float().or_else(|| v.as_integer().map(|i| i as f64)))
            {
                mcp_startup_timeout_sec.insert(name.clone(), secs);
            }
        }
    }
    mcp_servers.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(CodexConfig {
        model: effective("model").map(str::to_owned),
        effort: overlay
            .and_then(|values| string(values, "model_reasoning_effort"))
            .or_else(|| string(&root, "model_reasoning_effort"))
            .map(str::to_owned),
        sandbox_mode: effective("sandbox_mode").map(str::to_owned),
        approval_policy: effective("approval_policy").map(str::to_owned),
        approvals_reviewer: string(&root, "approvals_reviewer").map(str::to_owned),
        network_access: table(&root, "sandbox_workspace_write")
            .and_then(|sandbox| sandbox.get("network_access"))
            .and_then(Value::as_bool),
        project_doc_max_bytes: root
            .get("project_doc_max_bytes")
            .and_then(Value::as_integer)
            .and_then(|size| u64::try_from(size).ok()),
        project_root_markers: strings(&root, "project_root_markers"),
        developer_instructions_len: string(&root, "developer_instructions")
            .map(|instructions| instructions.chars().count()),
        notify: strings(&root, "notify")
            .unwrap_or_default()
            .iter()
            .enumerate()
            .filter(|(index, arg)| *index == 0 || is_program_file(arg))
            .map(|(_, arg)| arg.rsplit(['/', '\\']).next().unwrap_or(arg).to_owned())
            .collect(),
        mcp_servers,
        mcp_startup_timeout_sec,
    })
}

/// Notify elements other than argv[0] survive only when they name a program or script
/// file; URLs and payload arguments may carry secrets.
fn is_program_file(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    [".ps1", ".js", ".mjs", ".cjs", ".py", ".exe", ".cmd", ".bat"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// One user MCP server a Flow Codex node may carry per spawn: its name and URL, nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UrlServer {
    pub(crate) name: String,
    pub(crate) url: String,
}

/// Why a user server stays out of a per-spawn carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Dropped {
    /// Headers, a bearer token, env or a command (any key shaped like one).
    Secrets,
    /// The URL names a login (`user:pass@host`).
    UrlLogin,
}

/// The user's MCP servers split for a per-spawn carry (Flow, run 2026-10-19-codex-primary U2).
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct UrlOnly {
    pub(crate) pass: Vec<UrlServer>,
    pub(crate) dropped: Vec<(String, Dropped)>,
}

/// A server key that carries, or points at, a credential or a process: headers
/// (`http_headers`, `env_http_headers`), a bearer token (`bearer_token`, `bearer_token_env_var`),
/// env (`env`, `env_vars`) or a command (`command`, `args`, `cwd`).
fn carries_secrets(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("header") || k.contains("bearer") || k.starts_with("env") || matches!(k.as_str(), "command" | "args" | "cwd")
}

/// True when the URL's authority holds a `user[:pass]@` part.
fn url_has_login(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    authority.contains('@')
}

/// Pure: the root `[mcp_servers]` of a Codex config.toml, split into URL-only servers (passed
/// as name + URL) and servers that stay out (by name and reason). A disabled server, or one with
/// neither a URL nor a command, is skipped silently. Reads key names, the URL and `enabled`
/// only; never a header, token or env value, and the parser's excerpt never leaves here.
pub(crate) fn url_only_servers(text: &str) -> Result<UrlOnly, String> {
    let root = toml::from_str::<Table>(text).map_err(|_| "Invalid Codex config.toml".to_string())?;
    let mut out = UrlOnly::default();
    for (name, value) in table(&root, "mcp_servers").into_iter().flatten() {
        let Some(server) = value.as_table() else { continue };
        if server.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        if server.keys().any(|k| carries_secrets(k)) {
            out.dropped.push((name.clone(), Dropped::Secrets));
            continue;
        }
        let Some(url) = string(server, "url") else { continue };
        if url_has_login(url) {
            out.dropped.push((name.clone(), Dropped::UrlLogin));
            continue;
        }
        out.pass.push(UrlServer { name: name.clone(), url: url.to_owned() });
    }
    out.pass.sort_by(|a, b| a.name.cmp(&b.name));
    out.dropped.sort();
    Ok(out)
}

fn table<'a>(parent: &'a Table, key: &str) -> Option<&'a Table> {
    parent.get(key).and_then(Value::as_table)
}

fn string<'a>(parent: &'a Table, key: &str) -> Option<&'a str> {
    parent.get(key).and_then(Value::as_str)
}

fn strings(parent: &Table, key: &str) -> Option<Vec<String>> {
    parent.get(key)?.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_world_shapes_and_profile_overlay() {
        let text = r#"
model = "base"
model_reasoning_effort = "low"
sandbox_mode = "read-only"
approval_policy = "on-request"
profile = "x"
project_doc_max_bytes = 0
project_root_markers = []
developer_instructions = "café"
notify = ["tools\\pwsh.exe", "-File", "hooks\\done.ps1"]
[sandbox_workspace_write]
network_access = false
[projects.'d:\work\app']
trust_level = "trusted"
[mcp_servers.proxy]
command = "node"
args = [
  "proxy.mjs",
  "--verbose",
]
env = { A = "secret" }
enabled = false
[mcp_servers.wiki]
url = "https://example.test/mcp"
[profiles.x]
model = "overlay"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
approval_policy = "never"
[profiles.y]
model = "explicit"
"#;
        let config = parse(text, None).unwrap();
        assert_eq!(config.model.as_deref(), Some("overlay"));
        assert_eq!(config.effort.as_deref(), Some("high"));
        assert_eq!(config.sandbox_mode.as_deref(), Some("workspace-write"));
        assert_eq!(config.approval_policy.as_deref(), Some("never"));
        assert_eq!(config.project_doc_max_bytes, Some(0));
        assert_eq!(config.project_root_markers, Some(vec![]));
        assert_eq!(config.developer_instructions_len, Some(4));
        assert_eq!(config.notify, ["pwsh.exe", "done.ps1"]);
        assert_eq!(config.mcp_servers.len(), 2);
        let proxy = config
            .mcp_servers
            .iter()
            .find(|server| server.name == "proxy")
            .unwrap();
        assert_eq!(proxy.transport, "stdio");
        assert_eq!(proxy.target, "node");
        assert_eq!(proxy.args, ["proxy.mjs", "--verbose"]);
        assert_eq!(proxy.env_keys, ["A"]);
        assert!(!proxy.enabled);
        let wiki = config
            .mcp_servers
            .iter()
            .find(|server| server.name == "wiki")
            .unwrap();
        assert_eq!(wiki.transport, "http");
        assert_eq!(wiki.target, "https://example.test/mcp");
        assert!(wiki.enabled);
        assert_eq!(
            parse(text, Some("y")).unwrap().model.as_deref(),
            Some("explicit")
        );
        assert_eq!(
            parse(text, Some("missing")).unwrap().model.as_deref(),
            Some("base")
        );
    }

    #[test]
    fn serialized_config_excludes_secret_values() {
        let config = parse(
            r#"
developer_instructions = "private-rule-value"
[mcp_servers.proxy]
command = "node"
env = { API_KEY = "env-secret-value" }
env_vars = ["env-vars-secret-value"]
bearer_token_env_var = "bearer-secret-value"
http_headers = { Authorization = "header-secret-value" }
env_http_headers = { Authorization = "env-header-secret-value" }
"#,
            None,
        )
        .unwrap();
        let json = serde_json::to_string(&config).unwrap();
        for secret in [
            "private-rule-value",
            "env-secret-value",
            "env-vars-secret-value",
            "bearer-secret-value",
            "header-secret-value",
            "env-header-secret-value",
        ] {
            assert!(!json.contains(secret), "serialized {secret}");
        }
        assert!(json.contains("API_KEY"));
        assert_eq!(config.developer_instructions_len, Some(18));
    }

    #[test]
    fn notify_drops_urls_and_payload_arguments() {
        let config = parse(
            r#"notify = ["curl", "-d", "{\"token\":\"payload-secret\"}", "https://hooks.slack.com/services/T/B/url-secret", "hooks\\done.ps1"]"#,
            None,
        )
        .unwrap();
        assert_eq!(config.notify, ["curl", "done.ps1"]);
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("url-secret"));
        assert!(!json.contains("payload-secret"));
        assert!(!json.contains("-d"));
    }

    fn lookup_ok(_: &str) -> Result<PathBuf, String> {
        Ok(PathBuf::from("profile-home"))
    }

    fn lookup_err(_: &str) -> Result<PathBuf, String> {
        Err("missing".into())
    }

    #[test]
    fn resolve_orders_live_profile_default() {
        let default = Some(PathBuf::from("user-home"));
        assert!(matches!(
            resolve(Some(PathBuf::from("live")), Some("p"), lookup_ok, default.clone()),
            Home::Live(path) if path == PathBuf::from("live")
        ));
        assert!(matches!(
            resolve(None, Some("p"), lookup_ok, default.clone()),
            Home::Profile(path) if path == PathBuf::from("profile-home")
        ));
        assert!(matches!(
            resolve(None, Some("p"), lookup_err, default.clone()),
            Home::NotRunning
        ));
        assert!(matches!(
            resolve(None, None, lookup_err, default),
            Home::Default(Some(path)) if path == PathBuf::from("user-home")
        ));
        assert!(matches!(
            resolve(None, None, lookup_err, None),
            Home::Default(None)
        ));
    }

    #[test]
    fn a_named_row_reads_its_picked_home_else_the_legacy_one() {
        let pick_ok = |_: &str, r: &str| Ok(PathBuf::from(format!("set-home-{r}")));
        let pick_err = |_: &str, _: &str| Err::<PathBuf, String>("bad config".into());
        let r = |live, row, pick: &dyn Fn(&str, &str) -> Result<PathBuf, String>| resolve_row(live, Some("p"), row, lookup_ok, pick, None);
        assert!(matches!(r(None, Some("codex-raw"), &pick_ok), Home::Profile(p) if p == PathBuf::from("set-home-codex-raw")));
        // A live session still wins; no row, a blank row or an unpickable row stay on the legacy home.
        assert!(matches!(r(Some(PathBuf::from("live")), Some("codex-raw"), &pick_ok), Home::Live(_)));
        for row in [None, Some("  ")] {
            assert!(matches!(r(None, row, &pick_ok), Home::Profile(p) if p == PathBuf::from("profile-home")));
        }
        assert!(matches!(r(None, Some("codex-raw"), &pick_err), Home::Profile(p) if p == PathBuf::from("profile-home")));
        // A profile that does not resolve is not running, whatever the row.
        assert!(matches!(resolve_row(None, Some("p"), Some("x"), lookup_err, pick_err, None), Home::NotRunning));
    }

    #[test]
    fn a_codex_session_record_selects_its_home_without_consulting_a_row() {
        let root = std::env::temp_dir().join(format!("vidar-codex-vault-home-{}-{}", std::process::id(), crate::fsx::now_ms()));
        let home = root.join("chosen-home");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(crate::paths::config_path_in(&root), r#"{"agents":[{"key":"codex-bare","sets":[{"library":"lib","set":"alpha"}]}]}"#).unwrap();
        let vault = crate::bare::vault::store::Store::open(&root).create("Chosen", None, &[], &[]).unwrap();
        let record = crate::bare::vault::session::record(
            "codex", "raw", "tab-vault",
            crate::bare::vault::session::VaultPin { id: vault.id.clone(), hash: vault.hash.clone() },
            &home.to_string_lossy(), "loadout",
        );
        crate::bare::vault::session::write(&root, &record).unwrap();
        assert_eq!(super::recorded_home(&root, "tab-vault"), Some(home));
        assert!(vault.runesets.is_empty() && vault.runes.is_empty(), "the row's alpha did not enter the session vault");
        let _ = std::fs::remove_dir_all(root);
    }

    /// Flow's per-spawn carry: a URL-only server passes; headers, a bearer token, env or a
    /// command keep a server out by name, and no secret value reaches the result.
    #[test]
    fn url_only_servers_pass_and_secret_carriers_stay_out() {
        let text = r#"
[mcp_servers.wiki]
url = "https://example.test/mcp?x=1"
startup_timeout_sec = 20
[mcp_servers.headed]
url = "https://h.test/mcp"
http_headers = { Authorization = "Bearer sk-header-secret" }
[mcp_servers.envheaded]
url = "https://h.test/mcp"
env_http_headers = { X = "SOME_VAR" }
[mcp_servers.bearer]
url = "https://b.test/mcp"
bearer_token_env_var = "TOKEN_VAR"
[mcp_servers.rawbearer]
url = "https://b.test/mcp"
bearer_token = "sk-bearer-secret"
[mcp_servers.stdio]
command = "node"
args = ["s.mjs"]
[mcp_servers.envd]
url = "https://e.test/mcp"
env = { K = "sk-env-secret" }
[mcp_servers.login]
url = "https://user:sk-url-secret@l.test/mcp"
[mcp_servers.off]
url = "https://off.test/mcp"
enabled = false
[mcp_servers.empty]
tool_timeout_sec = 5
"#;
        let got = url_only_servers(text).unwrap();
        assert_eq!(got.pass, vec![UrlServer { name: "wiki".into(), url: "https://example.test/mcp?x=1".into() }]);
        let dropped: Vec<(&str, Dropped)> = got.dropped.iter().map(|(n, d)| (n.as_str(), *d)).collect();
        assert_eq!(
            dropped,
            vec![
                ("bearer", Dropped::Secrets),
                ("envd", Dropped::Secrets),
                ("envheaded", Dropped::Secrets),
                ("headed", Dropped::Secrets),
                ("login", Dropped::UrlLogin),
                ("rawbearer", Dropped::Secrets),
                ("stdio", Dropped::Secrets),
            ]
        );
        let debug = format!("{got:?}");
        for secret in ["sk-header-secret", "sk-bearer-secret", "sk-env-secret", "sk-url-secret", "SOME_VAR", "TOKEN_VAR"] {
            assert!(!debug.contains(secret), "{secret} leaked: {debug}");
        }
        assert!(url_only_servers("[x").unwrap_err() == "Invalid Codex config.toml");
        assert_eq!(url_only_servers("model = \"m\"").unwrap(), UrlOnly::default());
    }

    #[test]
    fn missing_file_is_none_and_malformed_toml_is_error() {
        let home =
            std::env::temp_dir().join(format!("vidar-codex-config-missing-{}", std::process::id()));
        assert!(read(&home).unwrap().is_none());
        assert!(parse("[mcp_servers.proxy\nsecret = 'value'", None).is_err());
    }
}
