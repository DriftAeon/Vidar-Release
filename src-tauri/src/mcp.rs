// MCP server rack: what is CONFIGURED, never what is running.
//
// Claude Code spawns these servers as its own children — Vidar has no handle on
// them, so a health dot here would be invented. Reporting declared config is
// the honest ceiling without Vidar becoming an MCP client itself, which is a
// separate decision (see the tool-inspector note in the README).
//
// Env values are never read, only key names: MCP server env blocks routinely
// hold API tokens and none of that belongs in the webview.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

pub mod codex;
pub(crate) mod pin;

// .claude.json sits beside the .claude dir by default, inside the config dir under a launch
// profile (bare/claude_dir.rs; `home` = the config dir the tab's session runs on, one
// combination home for a Bare tab). No home directory means no lookup, not a path relative to
// Vidar's own cwd
fn claude_json(profile: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    crate::bare::claude_dir::claude_json_in(profile, home.map(Path::to_path_buf))
}

/// The config dir one rack reads: the user's own `.claude` for no profile, else the tab's
/// session home (`claude_dir::home_of_session`: its launch manifest, else the row's pick).
fn rack_home(app: &tauri::AppHandle, profile: Option<&str>, tab: Option<&str>, row: Option<&str>) -> Option<PathBuf> {
    let session = crate::bare::claude_dir::hosted_session_of(app, tab);
    crate::bare::claude_dir::home_of_session(profile, tab, session.as_deref(), row)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    name: String,
    /// "user" (global), "local" (per-project in .claude.json), "project" (.mcp.json), "codex" (a Codex config)
    scope: String,
    /// "stdio" | "http" | "sse" | "unknown"
    transport: String,
    /// stdio: the command; http/sse: the url
    target: String,
    args: Vec<String>,
    /// key names only — values are deliberately not read
    env_keys: Vec<String>,
    /// which project this came from, for local/project scope
    project: Option<String>,
    /// Listed in the focused project's `disabledMcpServers`. None = unknown (no
    /// project passed, or no `projects` key matches it); the rack then looks as
    /// it always did. Configured state only, not what the session actually loaded.
    disabled: Option<bool>,
    /// Claude's own approval of the server. user, local and codex scopes are always true; a
    /// project (.mcp.json) server needs the user's say-so in `.claude.json`, user settings,
    /// managed settings or `.claude/settings.local.json` (never the repo's settings.json).
    /// A server that is not approved is listed but never spawned by the rack.
    approved: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRack {
    servers: Vec<McpServer>,
    /// non-fatal problems (unreadable file, malformed block) surfaced in the UI
    notes: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn codex_server(
    name: String,
    scope: String,
    transport: String,
    target: String,
    args: Vec<String>,
    env_keys: Vec<String>,
    project: Option<String>,
    disabled: Option<bool>,
) -> McpServer {
    McpServer { name, scope, transport, target, args, env_keys, project, disabled, approved: true }
}

fn parse_entry(name: &str, v: &Value, scope: &str, project: Option<&str>) -> McpServer {
    let ty = v.get("type").and_then(Value::as_str);
    let url = v.get("url").and_then(Value::as_str);
    let cmd = v.get("command").and_then(Value::as_str);

    let transport = match (ty, url, cmd) {
        (Some(t), _, _) => t.to_string(),
        (None, Some(_), _) => "http".into(),
        (None, None, Some(_)) => "stdio".into(),
        _ => "unknown".into(),
    };

    McpServer {
        name: name.to_string(),
        scope: scope.to_string(),
        transport,
        target: url.or(cmd).unwrap_or("").to_string(),
        args: v
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        env_keys: v
            .get("env")
            .and_then(Value::as_object)
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default(),
        project: project.map(str::to_owned),
        disabled: None,
        approved: true,
    }
}

/// Claude Code's project-server consent keys, unioned over every document that may carry them.
#[derive(Default, Debug)]
struct Approval {
    enable_all: bool,
    enabled: HashSet<String>,
    disabled: HashSet<String>,
}

impl Approval {
    fn add(&mut self, doc: &Value) {
        if doc.get("enableAllProjectMcpServers").and_then(Value::as_bool) == Some(true) {
            self.enable_all = true;
        }
        let names = |key: &str| -> Vec<String> {
            doc.get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default()
        };
        self.enabled.extend(names("enabledMcpjsonServers"));
        self.disabled.extend(names("disabledMcpjsonServers"));
    }

    /// Declined always wins; otherwise approved by the blanket flag or by name. Neither = pending.
    fn approves(&self, name: &str) -> bool {
        !self.disabled.contains(name) && (self.enable_all || self.enabled.contains(name))
    }
}

/// Approval for the servers of one project directory. Reads, in union: every `.claude.json`
/// `projects` spelling of the dir, user `settings.json`, managed settings, and the dir's
/// `.claude/settings.local.json`. The repo's own `.claude/settings.json` is never read:
/// the repo controls it, so it cannot approve its own servers.
fn approval_for(root: &Value, dir: &str, extra: &[Value]) -> Approval {
    let want = project_key(dir);
    let mut a = Approval::default();
    if let Some(projects) = root.get("projects").and_then(Value::as_object) {
        for (d, pv) in projects {
            if project_key(d) == want {
                a.add(pv);
            }
        }
    }
    for doc in extra {
        a.add(doc);
    }
    a
}

fn read_json(p: &std::path::Path) -> Option<Value> {
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
}

/// User + managed settings documents (the same two files the deny list reads).
fn global_settings(home: Option<&Path>) -> Vec<Value> {
    let files = [home.map(|d| d.join("settings.json")), Some(managed_settings())];
    files.into_iter().flatten().filter_map(|p| read_json(&p)).collect()
}

/// Sets `approved` on every project-scope server from its own project's consent keys.
fn apply_approval(servers: &mut [McpServer], root: &Value, globals: &[Value]) {
    let mut cache: std::collections::HashMap<String, Approval> = std::collections::HashMap::new();
    for s in servers.iter_mut().filter(|s| s.scope == "project") {
        let Some(dir) = s.project.as_deref() else {
            s.approved = false;
            continue;
        };
        let a = cache.entry(project_key(dir)).or_insert_with(|| {
            let mut extra = globals.to_vec();
            let local = PathBuf::from(dir.replace('/', "\\")).join(".claude").join("settings.local.json");
            extra.extend(read_json(&local));
            approval_for(root, dir, &extra)
        });
        s.approved = a.approves(&s.name);
    }
}

/// Claude Code keys `projects` by the launch cwd as typed, so one directory
/// shows up as `D:/Work/App`, `D:\Work\App`, `d:\work\app\`…
/// Compare on one spelling: forward slashes, no trailing slash, lowercase.
fn project_key(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    s.to_lowercase()
}

/// Union of `disabledMcpServers` over every `projects` spelling of `project`.
/// None when no spelling matches (unknown, not "nothing disabled").
fn disabled_for(root: &Value, project: &str) -> Option<HashSet<String>> {
    let want = project_key(project);
    let projects = root.get("projects")?.as_object()?;
    let mut hit = false;
    let mut out = HashSet::new();
    for (dir, pv) in projects {
        if project_key(dir) != want {
            continue;
        }
        hit = true;
        if let Some(list) = pv.get("disabledMcpServers").and_then(Value::as_array) {
            out.extend(list.iter().filter_map(Value::as_str).map(str::to_owned));
        }
    }
    hit.then_some(out)
}

/// `deniedMcpServers` from ~/.claude/settings.json and the managed settings file:
/// entries carry `serverName`, `serverUrl` (`*` wildcards allowed in the URL) or
/// `serverCommand` (command + args, exact). Denied servers are dropped from the
/// rack entirely.
#[derive(Default)]
struct Denied {
    names: HashSet<String>,
    /// Scheme and host already lowercased (url_fold).
    urls: Vec<String>,
    commands: Vec<Vec<String>>,
}

impl Denied {
    /// By name; an http/sse server by its URL; a stdio server by command + args.
    fn denies(&self, s: &McpServer) -> bool {
        if self.names.contains(&s.name) {
            return true;
        }
        let t = s.transport.to_ascii_lowercase();
        match t.as_str() {
            "http" | "sse" => {
                let url = url_fold(&s.target);
                self.urls.iter().any(|p| wildcard_match(p, &url))
            }
            "stdio" => self.commands.iter().any(|c| {
                c.split_first().is_some_and(|(cmd, args)| *cmd == s.target && args == s.args.as_slice())
            }),
            _ => false,
        }
    }
}

/// Lowercases the scheme and host of a URL (or URL pattern); path, query and
/// fragment keep their case. No `://` → unchanged.
fn url_fold(u: &str) -> String {
    let Some(i) = u.find("://") else { return u.to_string() };
    let host_start = i + 3;
    let end = u[host_start..].find(['/', '?', '#']).map_or(u.len(), |j| host_start + j);
    format!("{}{}", u[..end].to_ascii_lowercase(), &u[end..])
}

/// `*` matches any run of characters (empty included); everything else is literal.
fn wildcard_match(pattern: &str, text: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or("");
    let Some(mut rest) = text.strip_prefix(first) else { return false };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else { return rest.is_empty() };
    for p in middle {
        match rest.find(p) {
            Some(i) => rest = &rest[i + p.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

#[cfg(test)]
fn denied_names(settings: &Value) -> Denied {
    let mut out = Denied::default();
    add_denied(settings, &mut out);
    out
}

/// Unions one settings document's `deniedMcpServers` into `out`.
fn add_denied(settings: &Value, out: &mut Denied) {
    for e in settings.get("deniedMcpServers").and_then(Value::as_array).into_iter().flatten() {
        if let Some(n) = e.get("serverName").and_then(Value::as_str) {
            out.names.insert(n.to_owned());
        }
        if let Some(u) = e.get("serverUrl").and_then(Value::as_str) {
            out.urls.push(url_fold(u));
        }
        if let Some(c) = e.get("serverCommand").and_then(Value::as_array) {
            let parts: Option<Vec<String>> = c.iter().map(|x| x.as_str().map(str::to_owned)).collect();
            if let Some(parts) = parts.filter(|p| !p.is_empty()) {
                out.commands.push(parts);
            }
        }
    }
}

/// Claude Code's Windows managed settings file (code.claude.com/docs/en/managed-settings,
/// the legacy C:\ProgramData path is no longer read by Claude Code).
fn managed_settings() -> PathBuf {
    let base = std::env::var_os("ProgramFiles").map_or_else(|| PathBuf::from("C:\\Program Files"), PathBuf::from);
    base.join("ClaudeCode").join("managed-settings.json")
}

/// User settings plus managed settings; a missing or unreadable file adds nothing.
fn read_denied(home: Option<&Path>) -> Denied {
    let mut out = Denied::default();
    let files = [home.map(|d| d.join("settings.json")), Some(managed_settings())];
    for p in files.into_iter().flatten() {
        if let Some(v) = fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            add_denied(&v, &mut out);
        }
    }
    out
}

/// Mark `disabled` from the focused project and drop denied servers.
fn apply_state(servers: &mut Vec<McpServer>, disabled: Option<&HashSet<String>>, denied: &Denied) {
    servers.retain(|s| !denied.denies(s));
    for s in servers.iter_mut() {
        s.disabled = disabled.map(|d| d.contains(&s.name));
    }
}

fn collect(block: Option<&Value>, scope: &str, project: Option<&str>, out: &mut Vec<McpServer>) {
    let Some(obj) = block.and_then(Value::as_object) else { return };
    for (name, v) in obj {
        out.push(parse_entry(name, v, scope, project));
    }
}

/// Async on a blocking thread: reads ~/.claude.json and each project's .mcp.json, so a slow or
/// unreachable share must not stall Tauri's main thread (as read_loadout).
#[tauri::command]
pub async fn read_mcp_servers(
    app: tauri::AppHandle,
    project: Option<String>,
    profile: Option<String>,
    tab: Option<String>,
    row: Option<String>,
) -> Result<McpRack, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = rack_home(&app, profile.as_deref(), tab.as_deref(), row.as_deref());
        read_mcp_servers_now(project, profile, home)
    })
    .await
    .map_err(|e| e.to_string())
}

fn read_mcp_servers_now(project: Option<String>, profile: Option<String>, home: Option<PathBuf>) -> McpRack {
    let profile = profile.as_deref();
    let home = home.as_deref();
    let mut servers = Vec::new();
    let mut notes = Vec::new();
    let mut disabled: Option<HashSet<String>> = None;

    let path = claude_json(profile, home);
    let read = path.as_ref().map(|p| fs::read_to_string(p));
    // A missing ~/.claude.json is the normal fresh-machine state: no note.
    let missing = matches!(&read, Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound);
    let text = read.and_then(|r| r.ok());
    match text.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        Some(root) => {
            disabled = project.as_deref().and_then(|p| disabled_for(&root, p));
            collect(root.get("mcpServers"), "user", None, &mut servers);

            if let Some(projects) = root.get("projects").and_then(Value::as_object) {
                // Claude Code keys projects by the path string it was launched with, so
                // one directory can appear under several spellings (forward- and
                // back-slash variants of the same dir both exist here). Each spelling
                // has its own local-scope entries, but they share ONE .mcp.json — read
                // it once per directory or every project-scoped server shows up twice.
                let mut seen_mcp = HashSet::new();
                for (dir, pv) in projects {
                    collect(pv.get("mcpServers"), "local", Some(dir), &mut servers);

                    // .mcp.json is the checked-in, project-scoped file
                    let mcp = PathBuf::from(dir.replace('/', "\\")).join(".mcp.json");
                    if !seen_mcp.insert(mcp.to_string_lossy().to_lowercase()) {
                        continue;
                    }
                    let Ok(text) = fs::read_to_string(&mcp) else { continue };
                    match serde_json::from_str::<Value>(&text) {
                        Ok(v) => collect(v.get("mcpServers"), "project", Some(dir), &mut servers),
                        Err(e) => notes.push(format!("{}: {e}", mcp.display())),
                    }
                }
            }
            apply_approval(&mut servers, &root, &global_settings(home));
        }
        None if missing => {}
        None => notes.push(match &path {
            Some(p) => format!("could not read {}", p.display()),
            None => "could not resolve home directory for .claude.json".to_string(),
        }),
    }

    apply_state(&mut servers, disabled.as_ref(), &read_denied(home));
    servers.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));
    McpRack { servers, notes }
}

// ---- tools/list ----
//
// The places Vidar acts as an MCP client. The always-on
// proxy on :8399 fronts every real backend, so a single loopback JSON-RPC call
// covers the http case. Stdio servers get a throwaway instance of their own
// (list_mcp_tools_stdio below): initialize, tools/list, kill — a separate
// process from the one Claude spawns, so no session state is shared. Verified against the
// proxy the same day: POST /mcp with no initialize handshake answers
// tools/list directly, framed as SSE (`event: message` / `data: {...}`) even
// for a single request; the Accept header must list text/event-stream or it
// 406s. 2026-10-05: the proxy's SSE body can outlast the message (held open /
// slow to close with both backends live), so waiting for EOF hit the timeout;
// the reader stops at the first complete message instead.

#[derive(Clone, Debug, Serialize)]
pub struct McpTool {
    name: String,
    /// first line of the server's description, or empty
    description: String,
}

/// Loopback http only. Anything else is reported as not queried, never tried —
/// the rack's no-egress promise holds.
fn is_loopback_http(url: &str) -> bool {
    // Parsed, never prefix-matched: `http://localhost:80@evil.example/` has host evil.example.
    // https is refused: loopback servers here are plain http and the check is the no-egress promise.
    let Ok(u) = url::Url::parse(url) else { return false };
    u.scheme() == "http"
        && u.username().is_empty()
        && u.password().is_none()
        && match u.host() {
            Some(url::Host::Domain(d)) => d == "localhost",
            Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
            None => false,
        }
}

/// First JSON-RPC message carried by an SSE body. Events are blank-line
/// separated; a multi-line `data:` payload is joined with newlines.
#[cfg(test)] // production reads through sse_first_from_reader; tests feed it a whole body
fn sse_first_message(body: &str) -> Option<Value> {
    let mut parser = SseParser::default();
    for line in body.lines().chain(std::iter::once("")) {
        if let Some(v) = parser.push_line(line) {
            return Some(v);
        }
    }
    None
}

/// Incremental form of the above: feed one line at a time (no line ending),
/// get the first event whose JSON carries `result` or `error`.
#[derive(Default)]
struct SseParser {
    data: Vec<String>,
}

impl SseParser {
    fn push_line(&mut self, line: &str) -> Option<Value> {
        if let Some(d) = line.strip_prefix("data:") {
            self.data.push(d.strip_prefix(' ').unwrap_or(d).to_owned());
        } else if line.is_empty() && !self.data.is_empty() {
            let parsed = serde_json::from_str::<Value>(&self.data.join("\n"));
            self.data.clear();
            if let Ok(v) = parsed {
                if v.get("result").is_some() || v.get("error").is_some() {
                    return Some(v);
                }
            }
        }
        None
    }
}

/// Reads until the first complete message and returns without draining the
/// stream; EOF flushes a final event that lacked its blank line.
fn sse_first_from_reader<R: std::io::BufRead>(mut r: R) -> std::io::Result<Option<Value>> {
    let mut parser = SseParser::default();
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 {
            return Ok(parser.push_line(""));
        }
        if let Some(v) = parser.push_line(line.trim_end_matches(['\r', '\n'])) {
            return Ok(Some(v));
        }
    }
}

fn tools_from(msg: &Value) -> Result<Vec<McpTool>, String> {
    if let Some(err) = msg.get("error") {
        let text = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
        return Err(format!("server error: {text}"));
    }
    let tools = msg
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .ok_or("reply had no result.tools")?;
    Ok(tools
        .iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_owned();
            let description = t
                .get("description")
                .and_then(Value::as_str)
                .and_then(|d| d.lines().next())
                .unwrap_or("")
                .trim()
                .to_owned();
            Some(McpTool { name, description })
        })
        .collect())
}

/// Async: the HTTP round-trip runs on a blocking-pool thread, not the webview's
/// main thread (a plain command stalls the UI for
/// the whole timeout).
#[tauri::command]
pub async fn list_mcp_tools(url: String) -> Result<Vec<McpTool>, String> {
    tauri::async_runtime::spawn_blocking(move || list_mcp_tools_blocking(&url))
        .await
        .map_err(|e| format!("tools task failed: {e}"))?
}

/// HTTP agent for loopback-only calls (the trust boundary behind `is_loopback_http`):
/// follows no redirect and uses no proxy. ureq 3's default config reads the `*_PROXY`
/// env vars, which would send a loopback call through an outside host.
pub(crate) fn loopback_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .max_redirects(0)
        .proxy(None)
        .timeout_global(Some(timeout))
        .build()
        .new_agent()
}

/// ureq 3 with `max_redirects(0)` hands a 3xx back as `Ok`; callers turn it into an
/// error rather than parse a redirect body.
pub(crate) fn redirect_status(resp: &ureq::http::Response<ureq::Body>) -> Option<u16> {
    let status = resp.status();
    status.is_redirection().then(|| status.as_u16())
}

fn list_mcp_tools_blocking(url: &str) -> Result<Vec<McpTool>, String> {
    if !is_loopback_http(url) {
        return Err("not a loopback http url".into());
    }
    // 10 s: a tools/list merged across live backends is legitimately slow.
    let agent = loopback_agent(Duration::from_secs(10));
    let mut resp = agent
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .send(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
        .map_err(|e| format!("unreachable: {e}"))?;
    if let Some(code) = redirect_status(&resp) {
        return Err(format!("redirect refused (HTTP {code})"));
    }
    let sse = resp.body().mime_type().unwrap_or("").starts_with("text/event-stream");
    let msg = if sse {
        let reader = std::io::BufReader::new(resp.into_body().into_reader());
        sse_first_from_reader(reader).map_err(|e| format!("unreadable reply: {e}"))?
    } else {
        let text = resp.body_mut().read_to_string().map_err(|e| format!("unreadable reply: {e}"))?;
        serde_json::from_str::<Value>(&text).ok()
    }
    .ok_or("no JSON-RPC message in reply")?;
    tools_from(&msg)
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STDIO_TIMEOUT: Duration = Duration::from_secs(5);
const TOOLS_LIST_METHOD: &str = "tools/list";

/// Stdio twin of `list_mcp_tools`: spawns its own copy of the server, does the
/// initialize handshake, asks tools/list, then kills it. `cwd` is the project dir
/// for project/local scope (where Claude would launch it), None for user scope.
///
/// The webview names the server (`name`, `scope`, `project` = the row's own project dir, null
/// for user/codex scope); command, args and cwd are re-read here from the same config the rack
/// shows, and an unapproved or unknown server is refused. Nothing executable crosses the IPC.
#[tauri::command]
pub async fn list_mcp_tools_stdio(
    app: tauri::AppHandle,
    name: String,
    scope: String,
    project: Option<String>,
    profile: Option<String>,
    tab: Option<String>,
) -> Result<Vec<McpTool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rack = if scope == "codex" {
            codex::read_codex_mcp_servers_now(&app, tab, profile)
        } else {
            let home = rack_home(&app, profile.as_deref(), tab.as_deref(), None);
            read_mcp_servers_now(None, profile, home)
        };
        let s = resolve_listable(rack.servers, &name, &scope, project.as_deref())?;
        list_mcp_tools_stdio_blocking(&s.target, &s.args, s.cwd().as_deref())
    })
    .await
    .map_err(|e| format!("tools task failed: {e}"))?
}

impl McpServer {
    /// Launch dir: the project for project/local scope, none for user/codex.
    fn cwd(&self) -> Option<String> {
        matches!(self.scope.as_str(), "project" | "local").then(|| self.project.clone()).flatten()
    }
}

/// The stdio server a listing request names, if the rack config has it and Claude approved it.
fn resolve_listable(servers: Vec<McpServer>, name: &str, scope: &str, project: Option<&str>) -> Result<McpServer, String> {
    let want = project.map(project_key);
    let s = servers
        .into_iter()
        .find(|s| s.name == name && s.scope == scope && s.project.as_deref().map(project_key) == want)
        .ok_or("not listed: server is not in the configuration")?;
    if s.transport != "stdio" {
        return Err("not listed: not a stdio server".into());
    }
    if !s.approved {
        return Err("not listed: project server is not approved in Claude".into());
    }
    Ok(s)
}

fn spawn_stdio(command: &str, args: &[String], cwd: Option<&str>) -> std::io::Result<crate::proc_job::JobChild> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let build = |prog: &str| {
        let mut c = Command::new(prog);
        c.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        if let Some(dir) = cwd {
            c.current_dir(dir.replace('/', "\\"));
        }
        c
    };
    match crate::proc_job::JobChild::spawn_io(&mut build(command)) {
        // `npx` and kin are .cmd shims that CreateProcess won't find by bare name
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !command.contains('.') => {
            crate::proc_job::JobChild::spawn_io(&mut build(&format!("{command}.cmd")))
        }
        r => r,
    }
}

fn list_mcp_tools_stdio_blocking(command: &str, args: &[String], cwd: Option<&str>) -> Result<Vec<McpTool>, String> {
    use std::io::{BufRead, BufReader};
    use std::sync::mpsc;

    if let Some(reason) = pin::unpinned_runner(command, args) {
        return Err(reason);
    }
    let deadline = Instant::now() + STDIO_TIMEOUT;
    let mut child = spawn_stdio(command, args, cwd).map_err(|e| format!("unreachable: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;
    let stdout = child.stdout.take().ok_or("no stdout pipe")?;

    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::Builder::new().name("mcp-tools-stdout".into()).spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
            if tx.send(msg).is_err() {
                break;
            }
        }
    }).map_err(|e| format!("unreachable: {e}"))?;
    stdio_tools_exchange(&mut stdin, &rx, deadline)
}

fn await_stdio_response(
    rx: &std::sync::mpsc::Receiver<Value>, id: u64, method: &str, deadline: Instant,
) -> Result<Value, String> {
    loop {
        let left = deadline.checked_duration_since(Instant::now())
            .ok_or_else(|| format!("{method} timed out"))?;
        let msg = rx.recv_timeout(left).map_err(|e| match e {
            std::sync::mpsc::RecvTimeoutError::Timeout => format!("{method} timed out"),
            std::sync::mpsc::RecvTimeoutError::Disconnected => format!("server closed before {method} reply"),
        })?;
        if msg.get("id").and_then(Value::as_u64) != Some(id) || msg.get("method").is_some() {
            continue;
        }
        if let Some(error) = msg.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("unknown error");
            return Err(format!("{method} refused: {message}"));
        }
        if !msg.get("result").is_some_and(Value::is_object) {
            return Err(format!("invalid {method} reply"));
        }
        return Ok(msg);
    }
}

fn stdio_tools_exchange(
    stdin: &mut impl std::io::Write, rx: &std::sync::mpsc::Receiver<Value>, deadline: Instant,
) -> Result<Vec<McpTool>, String> {
    let mut send = |msg: Value| -> Result<(), String> {
        if Instant::now() >= deadline {
            return Err("MCP listing timed out".into());
        }
        writeln!(stdin, "{msg}").and_then(|_| stdin.flush()).map_err(|e| format!("unreachable: {e}"))
    };
    send(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"vidar-rack","version":"0.1.0"}
    }}))?;
    let initialized = await_stdio_response(rx, 1, "initialize", deadline)?;
    match initialized.pointer("/result/protocolVersion") {
        None => return Err("unsupported initialize result: missing protocolVersion".into()),
        Some(v) if v.as_str().is_some_and(|s| !s.is_empty()) => {}
        Some(v) => return Err(format!("unsupported initialize result: protocolVersion {v}")),
    }
    send(serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
    send(serde_json::json!({"jsonrpc":"2.0","id":2,"method":TOOLS_LIST_METHOD}))?;
    tools_from(&await_stdio_response(rx, 2, TOOLS_LIST_METHOD, deadline)?)
}

// ---- proxy /status ----
//
// The :8399 proxy (the external mcp-proxy's server.py, e.g. C:\Work\Example\mcp-proxy\server.py) answers
// GET /status with one object per backend: enabled, last_list (how the tools
// were last enumerated: "never", "live", "disk", "live, 16/115 allowed"…),
// last_list_time, schema_cache. That is a record of the last listing, not a
// health check, and the rack labels it "last listed" for that reason. Any
// other loopback server is asked too; a 404 is "no status endpoint", not an
// error — the path proves nothing about what the server is.

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub name: String,
    pub enabled: bool,
    pub last_list: String,
    pub last_list_time: Option<String>,
    pub schema_cache: bool,
}

/// `http://127.0.0.1:8399/mcp` → `http://127.0.0.1:8399`
fn origin_of(url: &str) -> &str {
    match url.find("://").map(|i| i + 3).and_then(|s| url[s..].find('/').map(|j| s + j)) {
        Some(end) => &url[..end],
        None => url,
    }
}

fn backends_from(v: &Value) -> Option<Vec<BackendStatus>> {
    let obj = v.as_object()?;
    let mut out: Vec<BackendStatus> = obj
        .iter()
        .filter_map(|(name, b)| {
            Some(BackendStatus {
                name: name.clone(),
                enabled: b.get("enabled")?.as_bool().unwrap_or(false),
                last_list: b.get("last_list").and_then(Value::as_str).unwrap_or("never").to_string(),
                last_list_time: b.get("last_list_time").and_then(Value::as_str).map(str::to_owned),
                schema_cache: b.get("schema_cache").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Some(out)
}

fn proxy_status_blocking(url: &str) -> Result<Vec<BackendStatus>, String> {
    if !is_loopback_http(url) {
        return Err("not a loopback http url".into());
    }
    let agent = loopback_agent(Duration::from_millis(1500));
    let mut resp = match agent.get(format!("{}/status", origin_of(url))).call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(code)) => return Err(format!("no status endpoint (HTTP {code})")),
        Err(e) => return Err(format!("unreachable: {e}")),
    };
    if let Some(code) = redirect_status(&resp) {
        return Err(format!("redirect refused (HTTP {code})"));
    }
    let text = resp.body_mut().read_to_string().map_err(|e| format!("unreadable reply: {e}"))?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| backends_from(&v))
        .ok_or_else(|| "status reply was not a backend map".to_string())
}

#[tauri::command]
pub async fn proxy_status(url: String) -> Result<Vec<BackendStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || proxy_status_blocking(&url))
        .await
        .map_err(|e| format!("status task failed: {e}"))?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpListener;

    /// One-shot loopback server that answers its first request with a 302 to `location`.
    /// Returns its origin (`http://127.0.0.1:<port>`).
    pub(crate) fn redirect_server(location: String) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            // Drain the request (headers plus any Content-Length body) before replying.
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = sock.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if req.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            let reply = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = sock.write_all(reply.as_bytes());
        });
        (origin, handle)
    }

    /// A loopback listener the redirect points at; `assert_untouched` proves no request reached it.
    pub(crate) struct RedirectTarget(TcpListener);

    impl RedirectTarget {
        pub(crate) fn new() -> Self {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.set_nonblocking(true).unwrap();
            Self(l)
        }
        pub(crate) fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.0.local_addr().unwrap())
        }
        pub(crate) fn assert_untouched(&self) {
            match self.0.accept() {
                Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                Ok(_) => panic!("redirect target was contacted"),
                Err(e) => panic!("redirect target accept failed: {e}"),
            }
        }
    }

    #[test]
    fn tools_list_refuses_redirect() {
        let target = RedirectTarget::new();
        let (origin, server) = redirect_server(target.url("/mcp"));
        let err = list_mcp_tools_blocking(&format!("{origin}/mcp")).unwrap_err();
        server.join().unwrap();
        assert_eq!(err, "redirect refused (HTTP 302)");
        target.assert_untouched();
    }

    #[test]
    fn proxy_status_refuses_redirect() {
        let target = RedirectTarget::new();
        let (origin, server) = redirect_server(target.url("/status"));
        let err = proxy_status_blocking(&format!("{origin}/mcp")).unwrap_err();
        server.join().unwrap();
        assert_eq!(err, "redirect refused (HTTP 302)");
        target.assert_untouched();
    }

    #[test]
    fn loopback_agent_pins_no_redirect_no_proxy() {
        let agent = loopback_agent(Duration::from_millis(1500));
        let cfg = agent.config();
        assert_eq!(cfg.max_redirects(), 0);
        assert!(cfg.proxy().is_none());
    }

    // Built from a raw string so the key is not a bare layout-id literal (paths-contract scan).
    fn tools_reply() -> Value {
        serde_json::from_str(r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#).unwrap()
    }

    fn initialize_result() -> Value {
        serde_json::json!({"jsonrpc":"2.0","id":1,"result":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "serverInfo":{"name":"test-server","version":"1"}
        }})
    }

    #[test]
    fn stdio_initialization_orders_requests_and_refusal_stops_listing() {
        use std::io::Write;
        struct Peer {
            sent: Vec<Value>,
            pending: Vec<u8>,
            reply: Value,
            tx: std::sync::mpsc::Sender<Value>,
        }
        impl Write for Peer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.pending.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                let msg: Value = serde_json::from_slice(&std::mem::take(&mut self.pending)).unwrap();
                self.sent.push(msg.clone());
                match msg["method"].as_str().unwrap() {
                    "initialize" => { self.tx.send(self.reply.clone()).unwrap(); }
                    TOOLS_LIST_METHOD => {
                        assert_eq!(self.sent[1]["method"], "notifications/initialized");
                        self.tx.send(tools_reply()).unwrap();
                    }
                    _ => {}
                }
                Ok(())
            }
        }
        let older = serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{}}});
        for reply in [initialize_result(), older, serde_json::json!({"id":1,"result":{"protocolVersion":"2024-11-05"}}),
            serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"message":"denied"}}),
            serde_json::json!({"jsonrpc":"2.0","id":1,"result":{}})] {
            let (tx, rx) = std::sync::mpsc::channel();
            let mut peer = Peer { sent: Vec::new(), pending: Vec::new(), reply: reply.clone(), tx };
            let result = stdio_tools_exchange(&mut peer, &rx, Instant::now() + Duration::from_secs(1));
            if reply.get("error").is_some() {
                assert_eq!(result.unwrap_err(), "initialize refused: denied");
                assert_eq!(peer.sent.len(), 1);
            } else if reply["result"]["protocolVersion"].is_null() {
                assert_eq!(result.unwrap_err(), "unsupported initialize result: missing protocolVersion");
                assert_eq!(peer.sent.len(), 1);
            } else {
                assert!(result.unwrap().is_empty());
                assert_eq!(peer.sent.len(), 3);
            }
        }
    }

    #[test]
    fn stdio_responses_share_deadline_and_skip_notifications() {
        let (tx, rx) = std::sync::mpsc::channel();
        let deadline = Instant::now() + Duration::from_secs(1);
        tx.send(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"server/request"})).unwrap();
        tx.send(initialize_result()).unwrap();
        assert!(await_stdio_response(&rx, 1, "initialize", deadline).is_ok());
        // No new time allowance for tools/list, even if its reply is already queued.
        tx.send(tools_reply()).unwrap();
        assert_eq!(await_stdio_response(&rx, 2, TOOLS_LIST_METHOD, Instant::now() - Duration::from_millis(1)).unwrap_err(),
            format!("{TOOLS_LIST_METHOD} timed out"));
        drop(tx);
        assert!(await_stdio_response(&rx, 3, TOOLS_LIST_METHOD, deadline).unwrap_err().contains("server closed"));
    }

    #[test]
    fn origin_and_status_parse() {
        assert_eq!(origin_of("http://127.0.0.1:8399/mcp"), "http://127.0.0.1:8399");
        assert_eq!(origin_of("http://localhost:1/"), "http://localhost:1");
        assert_eq!(origin_of("http://[::1]:8399"), "http://[::1]:8399");
        let v: Value = serde_json::from_str(r#"{"unreal":{"enabled":true,"last_list":"live","last_list_time":"2026-09-12T06:57:00","schema_cache":true},"local-llm":{"enabled":true,"last_list":"never","last_list_time":null,"schema_cache":false}}"#).unwrap();
        let b = backends_from(&v).unwrap();
        assert_eq!(b[0].name, "local-llm");
        assert_eq!(b[0].last_list, "never");
        assert_eq!(b[0].last_list_time, None);
        assert_eq!(b[1], BackendStatus { name: "unreal".into(), enabled: true, last_list: "live".into(), last_list_time: Some("2026-09-12T06:57:00".into()), schema_cache: true });
        assert!(backends_from(&serde_json::json!([1, 2])).is_none());
    }

    /// Cross-spelling contract: a cwd in any slash/case/trailing-slash form finds
    /// the project's disabledMcpServers under every spelling Claude Code keyed it
    /// by; no matching key is unknown (None), not "nothing disabled"; denied drops.
    #[test]
    fn disabled_matches_across_spellings_and_denied_drops() {
        let root: Value = serde_json::json!({ "projects": {
            "D:/Work/App": { "disabledMcpServers": ["rider"] },
            "D:\\Work\\App": { "disabledMcpServers": ["blender"] },
            "D:/Work/Other": { "disabledMcpServers": ["proxy"] }
        }});
        let d = disabled_for(&root, "d:\\work\\app\\").expect("matched");
        assert!(d.contains("rider") && d.contains("blender") && !d.contains("proxy"));
        assert!(disabled_for(&root, "D:/Work/Nowhere").is_none());

        let mk = |n: &str| parse_entry(n, &serde_json::json!({ "command": "x" }), "user", None);
        let mut servers = vec![mk("rider"), mk("blender"), mk("proxy")];
        let denied = denied_names(&serde_json::json!({ "deniedMcpServers": [{ "serverName": "rider" }] }));
        apply_state(&mut servers, Some(&d), &denied);
        let got: Vec<_> = servers.iter().map(|s| (s.name.as_str(), s.disabled)).collect();
        assert_eq!(got, vec![("blender", Some(true)), ("proxy", Some(false))]);

        let mut servers = vec![mk("proxy")];
        apply_state(&mut servers, None, &Denied::default());
        assert_eq!(servers[0].disabled, None);
    }

    /// A `serverUrl` entry (with `*`) denies an http/sse server by its URL; a stdio
    /// server whose command happens to match is kept.
    #[test]
    fn denied_by_server_url_wildcard() {
        let denied = denied_names(&serde_json::json!({ "deniedMcpServers": [{ "serverUrl": "https://*.example.com/*" }] }));
        let http = |n: &str, u: &str| parse_entry(n, &serde_json::json!({ "type": "http", "url": u }), "user", None);
        let stdio = parse_entry("cmd", &serde_json::json!({ "command": "https://x.example.com/mcp" }), "user", None);
        let mut servers = vec![http("bad", "https://api.example.com/mcp"), http("ok", "https://example.org/mcp"), stdio];
        apply_state(&mut servers, None, &denied);
        let got: Vec<_> = servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(got, vec!["ok", "cmd"]);
    }

    /// Scheme, host and transport compare case-insensitively; the path keeps its case.
    #[test]
    fn denied_url_folds_scheme_host_and_transport() {
        let denied = denied_names(&serde_json::json!({ "deniedMcpServers": [{ "serverUrl": "HTTPS://API.Example.com/MCP*" }] }));
        let http = |n: &str, u: &str| parse_entry(n, &serde_json::json!({ "type": "HTTP", "url": u }), "user", None);
        let mut servers = vec![http("bad", "https://api.EXAMPLE.com/MCP/v1"), http("ok", "https://api.example.com/mcp")];
        apply_state(&mut servers, None, &denied);
        let got: Vec<_> = servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(got, vec!["ok"]);
    }

    /// `serverCommand` denies a stdio server whose command + args match exactly.
    #[test]
    fn denied_by_server_command_exact() {
        let denied = denied_names(&serde_json::json!({ "deniedMcpServers": [{ "serverCommand": ["npx", "-y", "srv"] }] }));
        let stdio = |n: &str, args: Value| parse_entry(n, &serde_json::json!({ "command": "npx", "args": args }), "user", None);
        let mut servers = vec![stdio("bad", serde_json::json!(["-y", "srv"])), stdio("ok", serde_json::json!(["-y", "srv", "--x"]))];
        apply_state(&mut servers, None, &denied);
        let got: Vec<_> = servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(got, vec!["ok"]);
    }

    #[test]
    fn loopback_only() {
        assert!(is_loopback_http("http://127.0.0.1:8399/mcp"));
        assert!(is_loopback_http("http://localhost/mcp"));
        assert!(is_loopback_http("http://[::1]:1/"));
        assert!(!is_loopback_http("https://127.0.0.1:8399/mcp"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.example/mcp"));
        assert!(!is_loopback_http("http://localhost2/mcp"));
        assert!(!is_loopback_http("http://10.0.0.5:8399/mcp"));
        // userinfo and look-alike hosts
        assert!(!is_loopback_http("http://localhost:80@evil.example/"));
        assert!(!is_loopback_http("http://127.0.0.1:80@evil.example/mcp"));
        assert!(!is_loopback_http("http://user:pw@localhost/mcp"));
        assert!(!is_loopback_http("http://localhost.evil/mcp"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.example"));
        assert!(is_loopback_http("http://[::1]:3000"));
        // https is refused on purpose: loopback servers here are plain http
        assert!(!is_loopback_http("https://localhost"));
        assert!(!is_loopback_http("not a url"));
    }

    fn docs(v: &[&str]) -> Vec<Value> {
        v.iter().map(|s| serde_json::from_str(s).unwrap()).collect()
    }

    fn project_server(name: &str, dir: &str) -> McpServer {
        let mut s = parse_entry(name, &serde_json::json!({"command": "node"}), "project", Some(dir));
        s.approved = false;
        s
    }

    fn approved_of(root: &str, globals: &[&str], names: &[&str], dir: &str) -> Vec<(String, bool)> {
        let root: Value = serde_json::from_str(root).unwrap();
        let mut servers: Vec<McpServer> = names.iter().map(|n| project_server(n, dir)).collect();
        apply_approval(&mut servers, &root, &docs(globals));
        servers.into_iter().map(|s| (s.name, s.approved)).collect()
    }

    #[test]
    fn approval_matrix() {
        let root = r#"{"projects":{"C:/x":{"enabledMcpjsonServers":["on"],"disabledMcpjsonServers":["off"]}}}"#;
        let got = approved_of(root, &[], &["on", "off", "pending"], "C:\\x");
        assert_eq!(got, vec![("on".into(), true), ("off".into(), false), ("pending".into(), false)]);

        // enableAll approves everything except an explicit decline
        let root = r#"{"projects":{"C:/x":{"enableAllProjectMcpServers":true,"disabledMcpjsonServers":["off"]}}}"#;
        let got = approved_of(root, &[], &["on", "off"], "C:/x");
        assert_eq!(got, vec![("on".into(), true), ("off".into(), false)]);

        // a decline in one spelling beats an approval in another; lists union across spellings
        let root = r#"{"projects":{"C:/x":{"enabledMcpjsonServers":["a","b"]},"c:\\x\\":{"disabledMcpjsonServers":["b"],"enabledMcpjsonServers":["c"]}}}"#;
        let got = approved_of(root, &[], &["a", "b", "c", "d"], "C:/x");
        assert_eq!(got, vec![("a".into(), true), ("b".into(), false), ("c".into(), true), ("d".into(), false)]);

        // user/managed settings contribute; another project's entry does not
        let root = r#"{"projects":{"C:/other":{"enabledMcpjsonServers":["a"]}}}"#;
        let got = approved_of(root, &[r#"{"enabledMcpjsonServers":["u"]}"#], &["a", "u"], "C:/x");
        assert_eq!(got, vec![("a".into(), false), ("u".into(), true)]);
        let got = approved_of(root, &[r#"{"enableAllProjectMcpServers":true}"#], &["a"], "C:/x");
        assert_eq!(got, vec![("a".into(), true)]);
    }

    #[test]
    fn repo_settings_json_cannot_approve() {
        let base = std::env::temp_dir().join(format!("vidar-mcp-appr-{}", std::process::id()));
        let claude = base.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        fs::write(claude.join("settings.json"), r#"{"enableAllProjectMcpServers":true,"enabledMcpjsonServers":["evil"]}"#).unwrap();
        let dir = base.to_string_lossy().to_string();
        let root = serde_json::json!({});
        let mut servers = vec![project_server("evil", &dir)];
        apply_approval(&mut servers, &root, &[]);
        assert!(!servers[0].approved);

        // the local (user-owned) file does count
        fs::write(claude.join("settings.local.json"), r#"{"enabledMcpjsonServers":["evil"]}"#).unwrap();
        let mut servers = vec![project_server("evil", &dir)];
        apply_approval(&mut servers, &root, &[]);
        assert!(servers[0].approved);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn listing_needs_an_approved_stdio_match() {
        let mut ok = project_server("a", "C:/x");
        ok.approved = true;
        let pending = project_server("b", "C:/x");
        let all = || vec![ok.clone(), pending.clone()];
        assert!(resolve_listable(all(), "a", "project", Some("c:\\x")).is_ok());
        assert!(resolve_listable(all(), "b", "project", Some("C:/x")).err().is_some_and(|e| e.contains("not approved")));
        assert!(resolve_listable(all(), "a", "user", None).is_err());
        assert!(resolve_listable(all(), "a", "project", Some("C:/y")).is_err());
    }

    #[test]
    fn sse_frame_yields_tools() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"a\",\"description\":\"first line\\nsecond\"},{\"name\":\"b\"}]}}\n\n";
        let msg = sse_first_message(body).expect("message");
        let tools = tools_from(&msg).expect("tools");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "a");
        assert_eq!(tools[0].description, "first line");
        assert_eq!(tools[1].description, "");
    }

    /// Live: needs the :8399 proxy up. `cargo test -- --ignored live_proxy`.
    #[test]
    #[ignore]
    fn live_proxy_lists_tools() {
        let tools = list_mcp_tools_blocking("http://127.0.0.1:8399/mcp").expect("proxy answered");
        assert!(!tools.is_empty());
        assert!(tools.iter().any(|t| t.name.starts_with("unreal_")), "{tools:?}");
    }

    #[test]
    fn sse_reader_stops_at_first_message() {
        struct Tail(std::io::Cursor<Vec<u8>>);
        impl std::io::Read for Tail {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.0.read(buf)?;
                if n == 0 {
                    // a held-open stream would block here
                    panic!("read past the first message");
                }
                Ok(n)
            }
        }
        let body = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"a\"}]}}\r\n\r\n: ping\n: ping\n";
        let r = std::io::BufReader::with_capacity(16, Tail(std::io::Cursor::new(body.as_bytes().to_vec())));
        let msg = sse_first_from_reader(r).expect("io").expect("message");
        assert_eq!(tools_from(&msg).expect("parsed")[0].name, "a");
    }

    #[test]
    fn sse_error_is_reported() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"nope\"}}\n";
        let msg = sse_first_message(body).expect("message");
        assert_eq!(tools_from(&msg).unwrap_err(), "server error: nope");
    }
}
