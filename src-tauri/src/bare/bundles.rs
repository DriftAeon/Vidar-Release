//! The checked-in module item catalog and its per-launch availability filter.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::guards::BareGuard;
use crate::agent_spec::{self, Agent};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Bundles {
    pub version: u32,
    pub bundles: BTreeMap<String, Bundle>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub mcp: Vec<Mcp>,
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    pub guards: Vec<BareGuard>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Mcp {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<Http>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdio: Option<Stdio>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    pub reads: Reads,
    #[serde(default, skip_serializing_if = "is_false")]
    pub optional: bool,
    /// `none`: the writer pins no tool-approval mode for this server (Codex's `default_tools_approval_mode`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    /// Seconds a tool call may run (Codex `tool_timeout_sec`; Claude `timeout`, in ms).
    #[serde(default, rename = "timeoutSec", skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Approval { None }

fn is_false(v: &bool) -> bool { !*v }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Http {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<Oauth>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Oauth {
    pub client_id: String,
    pub callback_port: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stdio {
    pub command: String,
    pub args: Vec<String>,
    pub env_from: Vec<String>,
    /// Variable names the spawning process forwards by name (Codex `env_vars`); no value is read here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_pass: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Reads { All(String), Names(Vec<String>) }

/// A catalog server as the frontend sees it: which transport it has, never its url or command line
/// (an MCP url can carry a token; secrets never reach IPC).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WireMcp {
    pub name: String,
    pub has_url: bool,
    pub has_command: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub optional: bool,
}

#[derive(Serialize, Debug)]
pub struct WireBundle {
    pub mcp: Vec<WireMcp>,
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    pub guards: Vec<BareGuard>,
}

impl From<Bundle> for WireBundle {
    fn from(b: Bundle) -> Self {
        let mcp = b.mcp.into_iter().map(|m| WireMcp { name: m.name, has_url: m.http.is_some(), has_command: m.stdio.is_some(), agents: m.agents, optional: m.optional }).collect();
        WireBundle { mcp, skills: b.skills, agents: b.agents, guards: b.guards }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BareModuleBundles {
    pub bundles: BTreeMap<String, WireBundle>,
    pub warnings: Vec<String>,
}

fn wire(catalog: Bundles, warnings: Vec<String>) -> BareModuleBundles {
    BareModuleBundles { bundles: catalog.bundles.into_iter().map(|(k, b)| (k, b.into())).collect(), warnings }
}

#[tauri::command]
pub fn bare_module_bundles() -> BareModuleBundles {
    let (catalog, warnings) = load(&crate::paths::root());
    wire(catalog, warnings)
}

/// The first agent tag of `m` that names no agent: such a server is skipped, never handed to an agent.
pub(crate) fn unknown_tag(m: &Mcp) -> Option<&str> {
    m.agents.iter().map(String::as_str).find(|a| agent_spec::parse(a).is_none())
}

/// Whether `agent` loads `m`: no tag names an unknown agent, and `agents` is empty or names `agent`.
pub(crate) fn serves(m: &Mcp, agent: Agent) -> bool {
    unknown_tag(m).is_none() && (m.agents.is_empty() || m.agents.iter().any(|a| agent_spec::parse(a) == Some(agent)))
}

fn item_name(path: &str) -> String {
    Path::new(path).file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_else(|| path.to_lowercase())
}

pub fn guard_key(g: &BareGuard) -> String {
    format!("guard:{}|{}|{}", g.event, g.matcher.as_deref().unwrap_or(""), g.run.iter().map(|p| item_name(p)).collect::<Vec<_>>().join(","))
}

fn unique_names(items: &[String], label: &str) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for item in items {
        let name = item_name(item);
        if name.is_empty() || !seen.insert(name.clone()) {
            return Err(format!("{label} has an empty or duplicate name {name:?}"));
        }
    }
    Ok(())
}

fn repo_relative(path: &str) -> bool {
    !path.is_empty() && Path::new(path).components().all(|c| matches!(c, std::path::Component::Normal(_)))
}

pub fn validate(b: &Bundles) -> Result<(), String> {
    if b.version != 1 { return Err(format!("unsupported version {}", b.version)); }
    for (module, bundle) in &b.bundles {
        if module.is_empty() { return Err("empty module id".into()); }
        unique_names(&bundle.skills, &format!("{module} skills"))?;
        unique_names(&bundle.agents, &format!("{module} agents"))?;
        if bundle.skills.iter().chain(&bundle.agents).any(|p| !repo_relative(p)) {
            return Err(format!("{module} has a path outside the repo"));
        }
        let mut mcp = BTreeSet::new();
        for entry in &bundle.mcp {
            if entry.name.trim().is_empty() || !mcp.insert(entry.name.to_lowercase()) {
                return Err(format!("{module} has an empty or duplicate MCP name {:?}", entry.name));
            }
            if entry.http.is_some() == entry.stdio.is_some() {
                return Err(format!("{module} MCP {:?} needs exactly one of http or stdio", entry.name));
            }
            if entry.http.as_ref().is_some_and(|h| h.url.trim().is_empty()) || entry.stdio.as_ref().is_some_and(|s| s.command.trim().is_empty()) {
                return Err(format!("{module} MCP {:?} has an empty endpoint", entry.name));
            }
            if matches!(&entry.reads, Reads::All(s) if s != "*") {
                return Err(format!("{module} MCP {:?} reads must be a list or *", entry.name));
            }
        }
        let mut guards = BTreeSet::new();
        for g in &bundle.guards {
            if !super::guards::HOOK_EVENTS.contains(&g.event.as_str()) || g.run.is_empty() || g.run.iter().any(|p| !repo_relative(p)) {
                return Err(format!("{module} has an invalid guard"));
            }
            if !guards.insert(guard_key(g)) { return Err(format!("{module} has duplicate guards")); }
        }
    }
    Ok(())
}

/// `{{root}}` in a stdio command or arg becomes the install root, so every MCP writer gets the
/// expanded form and no `{{` reaches a Codex config.
fn expand_root(mut b: Bundles, root: &Path) -> Bundles {
    let root = root.to_string_lossy();
    for s in b.bundles.values_mut().flat_map(|bundle| bundle.mcp.iter_mut()).filter_map(|m| m.stdio.as_mut()) {
        s.command = s.command.replace("{{root}}", &root);
        for a in &mut s.args { *a = a.replace("{{root}}", &root); }
    }
    b
}

/// A broken catalog never blocks a launch; it contributes no items.
pub fn load(root: &Path) -> (Bundles, Vec<String>) {
    let path = root.join("contracts/module-bundles.json");
    let parsed = crate::fsx::read_text(&path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<Bundles>(crate::fsx::strip_bom(&s)).map_err(|e| e.to_string()))
        .and_then(|b| { validate(&b)?; Ok(b) })
        .map(|b| expand_root(b, root));
    match parsed {
        Ok(b) => (b, Vec::new()),
        Err(e) => (Bundles::default(), vec![format!("Module bundles {} are unreadable or invalid ({e}); no bundle items loaded", path.display())]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Bundles {
        let (b, w) = load(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap());
        assert!(w.is_empty(), "{w:?}");
        b
    }
    #[test]
    fn checked_in_catalog_loads() { assert_eq!(fixture().version, 1); }

    #[test]
    fn the_ipc_catalog_names_each_servers_transport_but_never_its_url_or_command() {
        let catalog = fixture();
        let (urls, commands): (Vec<String>, Vec<String>) = catalog.bundles.values().flat_map(|b| b.mcp.iter())
            .map(|m| (m.http.as_ref().map(|h| h.url.clone()).unwrap_or_default(), m.stdio.as_ref().map(|s| s.command.clone()).unwrap_or_default()))
            .unzip();
        assert!(urls.iter().any(|u| !u.is_empty()), "the fixture catalog carries no http server");
        let w = wire(catalog.clone(), Vec::new());
        let text = serde_json::to_string(&w).unwrap();
        for s in urls.iter().chain(commands.iter()).filter(|s| !s.is_empty()) {
            assert!(!text.contains(s.as_str()), "{s} reached the IPC catalog");
        }
        assert!(!text.contains("\"http\"") && !text.contains("\"stdio\""), "{text}");
        let servers: Vec<&WireMcp> = w.bundles.values().flat_map(|b| b.mcp.iter()).collect();
        let source: Vec<&Mcp> = catalog.bundles.values().flat_map(|b| b.mcp.iter()).collect();
        assert_eq!(servers.len(), source.len());
        for (wired, m) in servers.iter().zip(source) {
            assert_eq!((wired.has_url, wired.has_command), (m.http.is_some(), m.stdio.is_some()), "{}", m.name);
        }
    }

    #[test]
    fn bad_catalog_is_empty_with_warning() {
        let dir = std::env::temp_dir().join(format!("vidar-bundles-bad-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("contracts")).unwrap();
        std::fs::write(dir.join("contracts/module-bundles.json"), r#"{"version":1,"bundles":{"x":{"mcp":[{"name":"a","reads":[]}],"skills":[],"agents":[],"guards":[]}}}"#).unwrap();
        let (b, w) = load(&dir);
        assert!(b.bundles.is_empty() && !w.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn mcp(name: &str, agents: &[&str]) -> Mcp {
        Mcp { name: name.into(), http: Some(Http { url: "https://example.test".into(), oauth: None }), stdio: None, agents: agents.iter().map(|a| a.to_string()).collect(), reads: Reads::All("*".into()), optional: false, approval: None, timeout_sec: None }
    }

    #[test]
    fn serves_follows_the_agent_tags_and_never_widens_an_unknown_one() {
        assert!(serves(&mcp("any", &[]), Agent::Claude) && serves(&mcp("any", &[]), Agent::Codex));
        assert!(serves(&mcp("c", &["claude"]), Agent::Claude) && !serves(&mcp("c", &["claude"]), Agent::Codex));
        assert!(serves(&mcp("x", &["codex"]), Agent::Codex) && !serves(&mcp("x", &["codex"]), Agent::Claude));
        for agent in [Agent::Claude, Agent::Codex] {
            assert!(!serves(&mcp("g", &["grok"]), agent) && !serves(&mcp("both", &["claude", "grok"]), agent));
        }
    }

    #[test]
    fn the_catalog_expands_root_in_stdio_commands_and_args() {
        let dir = std::env::temp_dir().join(format!("vidar-bundles-root-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("contracts")).unwrap();
        std::fs::write(dir.join("contracts/module-bundles.json"), r#"{"version":1,"bundles":{"x":{"mcp":[{"name":"a","stdio":{"command":"{{root}}\\n.exe","args":["{{root}}\\s.mjs"],"envFrom":[],"envPass":["T"]},"approval":"none","timeoutSec":9,"reads":"*"}],"skills":[],"agents":[],"guards":[]}}}"#).unwrap();
        let (b, w) = load(&dir);
        assert!(w.is_empty(), "{w:?}");
        let m = &b.bundles["x"].mcp[0];
        let root = dir.to_string_lossy().into_owned();
        assert_eq!((m.approval, m.timeout_sec), (Some(Approval::None), Some(9)));
        let s = m.stdio.as_ref().unwrap();
        assert_eq!((s.command.as_str(), s.args[0].as_str(), s.env_pass.as_slice()), (format!("{root}\\n.exe").as_str(), format!("{root}\\s.mjs").as_str(), &["T".to_string()][..]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn runes_dir() -> std::path::PathBuf {
        crate::paths::rune_vidar_dir_in(&crate::paths::root())
    }

    /// Every rune file under the vidar library's kind folders, parsed.
    fn library_runes() -> Vec<(String, crate::rules::rune::Rune)> {
        fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { walk(&p, out); } else if p.extension().is_some_and(|x| x == "md") { out.push(p); }
            }
        }
        let mut files = Vec::new();
        for e in std::fs::read_dir(runes_dir()).unwrap().flatten().filter(|e| e.path().is_dir()) { walk(&e.path(), &mut files); }
        files.sort();
        files.into_iter().map(|p| {
            let text = std::fs::read_to_string(&p).unwrap().replace('\r', "");
            let rune = crate::rules::rune::parse(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            (p.to_string_lossy().into_owned(), rune)
        }).collect()
    }

    #[test]
    fn every_bundle_resolves_for_each_agent_that_serves_it() {
        let catalog = fixture();
        assert!(catalog.bundles.contains_key("vidar-drive"));
        for (id, bundle) in &catalog.bundles {
            assert!(!bundle.mcp.is_empty(), "{id} holds no server");
            for m in &bundle.mcp {
                assert!(unknown_tag(m).is_none(), "{id}/{} names an unknown agent", m.name);
                assert!([Agent::Claude, Agent::Codex].iter().any(|a| serves(m, *a)), "{id}/{} serves no agent", m.name);
                let names = [m.name.clone()];
                if serves(m, Agent::Claude) { assert_eq!(super::super::claude_mcp::for_launch(&names, &catalog).len(), 1, "{id}/{}", m.name); }
                if serves(m, Agent::Codex) { assert_eq!(super::super::codex_mcp::for_launch(&names, &catalog).len(), 1, "{id}/{}", m.name); }
            }
        }
    }

    #[test]
    fn every_mcp_rune_names_a_catalog_server_and_carries_its_agents() {
        let catalog = fixture();
        let runes: Vec<_> = library_runes().into_iter().filter(|(_, r)| r.kind == "mcp").collect();
        for (path, r) in &runes {
            let (module, server) = (r.item.module.as_deref().unwrap(), r.item.server.as_deref().unwrap());
            let m = catalog.bundles.get(module).and_then(|b| b.mcp.iter().find(|m| m.name == server))
                .unwrap_or_else(|| panic!("{path}: no catalog server {module}/{server}"));
            // One agent tag on the server means the rune carries it; none, or both, means the rune is untagged.
            let want = match m.agents.as_slice() { [one] => Some(one.as_str()), _ => None };
            assert_eq!(r.agent.as_deref(), want, "{path}: agent differs from the server's agents {:?}", m.agents);
        }
        // Uniform shape: each catalog server has exactly one rune.
        for (id, bundle) in &catalog.bundles {
            for m in &bundle.mcp {
                let n = runes.iter().filter(|(_, r)| r.item.module.as_deref() == Some(id.as_str()) && r.item.server.as_deref() == Some(m.name.as_str())).count();
                assert_eq!(n, 1, "{id}/{} has {n} mcp runes", m.name);
            }
        }
    }

    #[test]
    fn rune_ids_are_unique_across_the_vidar_library() {
        let mut seen = BTreeSet::new();
        for (path, r) in library_runes() {
            assert!(seen.insert(r.id.clone()), "{path}: id {} repeats", r.id);
        }
    }

    #[test]
    fn the_codex_vidar_drive_table_has_no_approval_key_and_validates() {
        use super::super::{codex_mcp, home};
        let catalog = fixture();
        let servers = codex_mcp::for_launch(&["vidar_drive".to_string()], &catalog);
        assert_eq!(servers.len(), 1);
        let (tables, warnings) = codex_mcp::Tables::servers(&servers, &|_| None).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(tables.names, ["vidar_drive"]);
        assert!(!tables.text.contains(codex_mcp::APPROVAL_KEY) && !tables.text.contains("{{"), "{}", tables.text);
        assert!(tables.text.contains("env_vars = [\"VIDAR_CTL_TOKEN\",\"FALCON_SESSION\",\"VIDAR_CTL_SECRET\"]") && tables.text.contains("tool_timeout_sec = 3700"), "{}", tables.text);
        let (root, tmp) = (crate::paths::root(), std::env::temp_dir().join(format!("vidar-bundles-drive-{}", std::process::id())));
        let agent_home = tmp.join("agent-home");
        home::prepare_dirs(&agent_home, &["codex-home".into()]).unwrap();
        let template = crate::paths::rune_vidar_dir_in(&root).join("settings").join("codex-config.toml");
        let target = agent_home.join("codex-home/config.toml");
        let pwsh = Path::new(r"C:\Users\testuser\AppData\Local\Microsoft\WindowsApps\pwsh.exe");
        let guard = home::Guard::from_vidar_env();
        let payload = "p\nVIDAR-PAYLOAD-0123456789ab\n";
        home::generate_codex_config_for(&template, &target, &root, &agent_home, pwsh, payload, &guard, None, &tables).unwrap();
        let doc = home::parse_toml_lite(&std::fs::read_to_string(&target).unwrap()).unwrap();
        let tpl = home::parse_toml_lite(&std::fs::read_to_string(&template).unwrap()).unwrap();
        home::validate_codex_with(&doc, &tpl, &root, &agent_home, pwsh, payload, &guard, None, &tables, &home::HookTrust::default()).unwrap();
        assert!(!doc.iter().any(|(k, _)| k.starts_with("mcp_servers.vidar_drive.") && k.ends_with(codex_mcp::APPROVAL_KEY)));
        std::fs::remove_dir_all(tmp).ok();
    }
}
