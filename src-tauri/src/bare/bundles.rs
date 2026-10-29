//! The checked-in module item catalog and its per-launch availability filter.
#![allow(dead_code)] // Spawn and Settings callers are adopted in later lanes.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::guards::BareGuard;
use crate::agent_spec;

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
}

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
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Reads { All(String), Names(Vec<String>) }

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModuleTick {
    #[serde(default)]
    pub off: Vec<String>,
}

pub type SetModules = BTreeMap<String, ModuleTick>;

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

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Resolved {
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    pub guards: Vec<BareGuard>,
    pub mcp: Vec<Mcp>,
}

/// The first agent tag of `m` that names no agent: such a server is skipped, never handed to an agent.
pub(crate) fn unknown_tag(m: &Mcp) -> Option<&str> {
    m.agents.iter().map(String::as_str).find(|a| agent_spec::parse(a).is_none())
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

/// A broken catalog never blocks a launch; it contributes no items.
pub fn load(root: &Path) -> (Bundles, Vec<String>) {
    let path = root.join("contracts/module-bundles.json");
    let parsed = crate::fsx::read_text(&path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<Bundles>(crate::fsx::strip_bom(&s)).map_err(|e| e.to_string()))
        .and_then(|b| { validate(&b)?; Ok(b) });
    match parsed {
        Ok(b) => (b, Vec::new()),
        Err(e) => (Bundles::default(), vec![format!("Module bundles {} are unreadable or invalid ({e}); no bundle items loaded", path.display())]),
    }
}

pub fn resolve(set_modules: &SetModules, bundles: &Bundles, agent: &str) -> (Resolved, Vec<String>) {
    let mut result = Resolved::default();
    let mut warnings = Vec::new();
    let Some(agent) = agent_spec::parse(agent) else {
        warnings.push(format!("Unknown agent {agent:?} for module bundles; nothing resolved"));
        return (result, warnings);
    };
    for (module, tick) in set_modules {
        let Some(bundle) = bundles.bundles.get(module) else {
            warnings.push(format!("Unknown module {module:?} in set layer; skipped"));
            continue;
        };
        let known: BTreeSet<String> = bundle.mcp.iter().map(|m| format!("mcp:{}", m.name))
            .chain(bundle.skills.iter().map(|s| format!("skill:{}", item_name(s))))
            .chain(bundle.agents.iter().map(|s| format!("agent:{}", item_name(s))))
            .chain(bundle.guards.iter().map(guard_key)).collect();
        for item in &tick.off {
            if !known.contains(item) { warnings.push(format!("Module {module:?} has unknown off item {item:?}; ignored")); }
        }
        let excluded: BTreeSet<&str> = tick.off.iter().filter(|s| known.contains(*s)).map(String::as_str).collect();
        for m in &bundle.mcp {
            if let Some(tag) = unknown_tag(m) {
                warnings.push(format!("Module {module:?} server {:?} names unknown agent {tag:?} in module-bundles.json; skipped", m.name));
                continue;
            }
            if !excluded.contains(format!("mcp:{}", m.name).as_str()) && (m.agents.is_empty() || m.agents.iter().any(|a| agent_spec::parse(a) == Some(agent)))
                && !result.mcp.iter().any(|old| old.name.eq_ignore_ascii_case(&m.name)) { result.mcp.push(m.clone()); }
        }
        for s in &bundle.skills {
            if !excluded.contains(format!("skill:{}", item_name(s)).as_str()) && !result.skills.iter().any(|old| item_name(old) == item_name(s)) { result.skills.push(s.clone()); }
        }
        for s in &bundle.agents {
            if !excluded.contains(format!("agent:{}", item_name(s)).as_str()) && !result.agents.iter().any(|old| item_name(old) == item_name(s)) { result.agents.push(s.clone()); }
        }
        for g in &bundle.guards {
            if !excluded.contains(guard_key(g).as_str()) && !result.guards.iter().any(|old| guard_key(old) == guard_key(g)) { result.guards.push(g.clone()); }
        }
    }
    (result, warnings)
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

    #[test]
    fn unknown_module_item_availability_and_agent_filter() {
        let b = fixture();
        let ticks: SetModules = [
            ("missing".into(), ModuleTick::default()),
            ("slack".into(), ModuleTick { off: vec!["mcp:absent".into()] }),
            ("unreal".into(), ModuleTick::default()),
        ].into();
        let (r, w) = resolve(&ticks, &b, "codex");
        assert_eq!(r.mcp.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["proxy"]);
        assert!(w.iter().any(|s| s.contains("Unknown module")) && w.iter().any(|s| s.contains("unknown off item")));
        let (r, _) = resolve(&ticks, &b, "claude");
        assert!(r.mcp.iter().any(|m| m.name == "slack"), "{:?}", r.mcp);
    }

    fn mcp(name: &str, agents: &[&str]) -> Mcp {
        Mcp { name: name.into(), http: Some(Http { url: "https://example.test".into(), oauth: None }), stdio: None, agents: agents.iter().map(|a| a.to_string()).collect(), reads: Reads::All("*".into()), optional: false }
    }

    fn catalog_of(servers: Vec<Mcp>) -> (Bundles, SetModules) {
        let bundle = Bundle { mcp: servers, ..Default::default() };
        (Bundles { version: 1, bundles: [("m".to_string(), bundle)].into() }, [("m".to_string(), ModuleTick::default())].into())
    }

    #[test]
    fn a_grok_tagged_server_is_skipped_with_a_warning_for_every_agent() {
        let (b, ticks) = catalog_of(vec![mcp("g", &["grok"]), mcp("both", &["claude", "grok"]), mcp("any", &[])]);
        validate(&b).unwrap();
        for agent in ["claude", "codex"] {
            let (r, w) = resolve(&ticks, &b, agent);
            assert_eq!(r.mcp.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["any"], "{agent}");
            assert_eq!(w.len(), 2, "{w:?}");
            assert!(w.iter().all(|s| s.contains("\"grok\"") && s.contains("module-bundles.json")), "{w:?}");
        }
    }

    #[test]
    fn an_unknown_agent_asking_to_resolve_gets_nothing() {
        let (b, ticks) = catalog_of(vec![mcp("any", &[])]);
        let (r, w) = resolve(&ticks, &b, "grok");
        assert!(r.mcp.is_empty() && w.len() == 1, "{w:?}");
    }

    #[test]
    fn each_known_agent_keeps_its_own_servers() {
        let (b, ticks) = catalog_of(vec![mcp("c", &["claude"]), mcp("x", &["codex"]), mcp("any", &[])]);
        let names = |agent: &str| resolve(&ticks, &b, agent).0.mcp.into_iter().map(|m| m.name).collect::<Vec<_>>();
        assert_eq!(names("claude"), ["c", "any"]);
        assert_eq!(names("codex"), ["x", "any"]);
    }
}
