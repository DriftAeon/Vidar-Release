//! src-tauri\src\modules\manifest.rs — module contract v1 (`contracts/modules.json`,
//! docs/reference/modules.md): the ModuleDecl shape and the per-pack rules. Pure over the
//! pack folder it is handed; cross-pack rules (duplicates, keyVar claims, cycles) and pins
//! live in `scan.rs`. Every failure is a reason string for a `broken` row, never a panic.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Number, Value};

/// The contract as compiled in. Only the fields the validator reads; the rest is pinned by
/// tests/modules-contract.test.mjs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub id_pattern: String,
    pub limits: Limits,
    pub kinds: Vec<String>,
    pub reserved_keys: Vec<String>,
    pub pack_levels: Vec<String>,
    pub implicit_pack_module: Implicit,
    pub gateway: GatewayRules,
    pub launch: LaunchRules,
    pub flow_core_model_ids: Vec<String>,
    pub dep_text: DepText,
    #[serde(deserialize_with = "deserialize_core")]
    pub core: Vec<ModuleDecl>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub manifest_bytes: u64,
    pub trace_terms: usize,
    pub flow_models: usize,
    /// Longest user-set module name, in code points (`moduleNames` in vidar.json).
    pub name_chars: usize,
}

#[derive(Debug, Deserialize)]
pub struct Implicit {
    pub kind: String,
    pub level: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRules {
    pub runner: String,
    pub base_url_prefix: String,
    pub key_var_template: String,
    pub key_var_id_transform: IdTransform,
    pub key_var_forbidden_prefixes: Vec<String>,
    pub key_var_pattern: String,
    pub model_pattern: String,
    /// The env keys a gateway's `env` may set (replaces core claude's `agent.gatewayEnv`).
    pub env_allowlist: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRules {
    pub executable_pattern: String,
    pub argument_pattern: String,
    pub max_arguments: usize,
}

#[derive(Debug, Deserialize)]
pub struct IdTransform {
    pub case: String,
    pub replace: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepText {
    pub forbidden_chars: Vec<String>,
}

/// One module declaration, core or pack. Unknown keys are a parse error at every level;
/// `kind` and `level` stay strings so an unknown value gets its own reason.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModuleDecl {
    pub id: String,
    pub label: String,
    pub level: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<When>,
    /// Catalog entries in contracts/dependencies.json shape, checked by `check_dep`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deps: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<Agent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<Surface>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<Capability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Profiles>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow_models: Option<Vec<FlowModel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Vec<String>>,
    /// Repo-relative files (`a/b.mjs`) and folders (`a/b/`) a set that excludes this module cuts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owns: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct When {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deps: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packs: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Surface {
    pub placement: SurfacePlacement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    /// Colour icon name (contracts/icons.json) for the surface's tab and Settings row; the UI reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfacePlacement {
    Workbench,
    Rail,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

impl Contract {
    /// Parses the contract text and checks each core kind against its own `kinds` list, which a
    /// field-level deserializer cannot reach.
    pub fn parse(text: &str) -> Result<Contract, String> {
        let c: Contract = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if let Some(d) = c.core.iter().find(|d| !c.kinds.contains(&d.kind)) {
            return Err(format!("Core Module {} Has Unknown Kind {}", d.id, d.kind));
        }
        Ok(c)
    }
}

fn deserialize_core<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<ModuleDecl>, D::Error> {
    use serde::de::Error;
    let declarations = Vec::<ModuleDecl>::deserialize(deserializer)?;
    for d in &declarations {
        if !matches!(d.level.as_str(), "core" | "required-hideable" | "optional") {
            return Err(D::Error::custom(format!("Core Module {} Has Unknown Level {}", d.id, d.level)));
        }
        if d.kind == "surface" && d.surface.is_none() {
            return Err(D::Error::custom(format!("Core Surface {} Needs surface", d.id)));
        }
        if d.kind != "surface" && d.surface.is_some() {
            return Err(D::Error::custom(format!("Core Module {} Cannot Declare surface", d.id)));
        }
        if d.kind == "capability" && d.capability.is_none() {
            return Err(D::Error::custom(format!("Core Capability {} Needs capability", d.id)));
        }
        if d.kind != "capability" && d.capability.is_some() {
            return Err(D::Error::custom(format!("Core Module {} Cannot Declare capability", d.id)));
        }
    }
    Ok(declarations)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Agent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<Setup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<FlowRunner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<Gateway>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<Launch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<Art>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Number>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    pub dep: String,
    /// Setup Via Agent tries agents by ascending order (absent sorts last).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
}

/// The script a Flow node of this runner spawns; must be one of the module's own `owns` paths.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FlowRunner {
    pub script: String,
}

/// Raw CLI launch metadata. The executable is a basename; arguments are individual literals.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Gateway {
    pub runner: String,
    pub base_url: String,
    pub key_var: String,
    pub model: String,
    /// BTreeMap: the pinned form does not depend on key order in the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Art {
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Profiles {
    pub runner: String,
    pub dir: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FlowModel {
    pub id: String,
    pub label: String,
    pub haiku: String,
    pub max_context: u64,
}

const ROWS: [&str; 2] = ["raw", "rendered"];
const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// `^[a-z][a-z0-9-]{0,31}$`, the contract's `idPattern` (no regex crate; a test pins the
/// literal against the contract).
#[cfg(test)]
pub const ID_PATTERN: &str = "^[a-z][a-z0-9-]{0,31}$";

pub fn id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Whether `value` matches the contract regex `pattern`. Each pattern compiles once (the
/// contract is compiled in, so the set is fixed); one that does not compile matches nothing.
fn shape_ok(pattern: &str, value: &str) -> bool {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<BTreeMap<String, Option<regex::Regex>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    cache
        .entry(pattern.to_string())
        .or_insert_with(|| regex::Regex::new(pattern).ok())
        .as_ref()
        .is_some_and(|re| re.is_match(value))
}

/// `<ID>_API_KEY` for `id`, built from the contract template and transform.
pub fn key_var_for(id: &str, rules: &GatewayRules) -> String {
    let mut up = if rules.key_var_id_transform.case == "upper" { id.to_ascii_uppercase() } else { id.to_string() };
    for (from, to) in &rules.key_var_id_transform.replace {
        up = up.replace(from.as_str(), to);
    }
    rules.key_var_template.replace("<ID>", &up)
}

/// `pack.json` of one pack folder to its module (the implicit content module when it has no
/// `module` block) and the lowercase hex SHA-256 of the file bytes this call read (BOM
/// included, so it equals a file hash of `pack.json`), or the broken reason.
pub fn read_pack(folder: &str, dir: &Path, c: &Contract) -> Result<(ModuleDecl, String), String> {
    use sha2::{Digest, Sha256};
    let (decl, bytes) = read_pack_bytes(folder, dir, c)?;
    let sha256: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    Ok((decl, sha256))
}

fn read_pack_bytes(folder: &str, dir: &Path, c: &Contract) -> Result<(ModuleDecl, Vec<u8>), String> {
    let file = dir.join("pack.json");
    let md = match std::fs::metadata(&file) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("No pack.json".into()),
        Err(e) => return Err(format!("Cannot Read pack.json: {e}")),
    };
    if md.len() > c.limits.manifest_bytes {
        return Err(format!("pack.json Is Over {} Bytes", c.limits.manifest_bytes));
    }
    let raw = std::fs::read(&file).map_err(|e| format!("Cannot Read pack.json: {e}"))?;
    let bytes = raw.strip_prefix(b"\xEF\xBB\xBF".as_slice()).unwrap_or(&raw);
    let pack: Value = serde_json::from_slice(bytes).map_err(|e| format!("pack.json Does Not Parse: {e}"))?;
    let Some(id) = pack.get("id").and_then(Value::as_str) else {
        return Err("pack.json Has No id".into());
    };
    if id != folder {
        return Err(format!("Id {id} Does Not Match Folder {folder}"));
    }
    if !id_ok(id) {
        return Err(format!("Id {id} Does Not Match {}", c.id_pattern));
    }
    super::compat::check_pack_compat(&pack, env!("CARGO_PKG_VERSION"), super::compat::CORE_CONTRACT)?;
    let Some(block) = pack.get("module") else {
        let label = pack.pointer("/ui/label").and_then(Value::as_str).unwrap_or(id).to_string();
        let decl = ModuleDecl {
            id: id.to_string(),
            label,
            level: c.implicit_pack_module.level.clone(),
            kind: c.implicit_pack_module.kind.clone(),
            depends_on: None,
            when: None,
            deps: None,
            agent: None,
            surface: None,
            capability: None,
            profiles: None,
            flow_models: None,
            trace: None,
            owns: None,
        };
        return Ok((decl, raw));
    };
    if let Some(obj) = block.as_object() {
        if let Some(k) = c.reserved_keys.iter().find(|k| obj.contains_key(k.as_str())) {
            return Err(format!("Key {k} Is Reserved In v1"));
        }
    }
    // Retired: the env keys a gateway may set are the contract's gateway.envAllowlist, never a pack's.
    if block.pointer("/agent/gatewayEnv").is_some() {
        return Err("agent.gatewayEnv Is Not a Pack Key".into());
    }
    let decl: ModuleDecl = serde_json::from_value(block.clone()).map_err(|e| format!("Module Block Does Not Parse: {e}"))?;
    if decl.id != id {
        return Err(format!("Module Id {} Does Not Match Pack Id {id}", decl.id));
    }
    check_decl(&decl, dir, c)?;
    Ok((decl, raw))
}

/// The per-declaration rules for a pack module.
fn check_decl(d: &ModuleDecl, dir: &Path, c: &Contract) -> Result<(), String> {
    if !c.pack_levels.contains(&d.level) {
        return Err(format!("Level {} Is Not A Pack Level", d.level));
    }
    if !c.kinds.contains(&d.kind) {
        return Err(format!("Kind {} Is Not A Kind", d.kind));
    }
    if d.kind == "surface" {
        return Err("Kind surface Is Reserved In v1 For Core Declarations Only".into());
    }
    if d.surface.is_some() {
        return Err("surface Is Only Valid For A Surface Module".into());
    }
    if d.kind == "capability" && d.capability.is_none() {
        return Err("Capability Module Needs capability".into());
    }
    if d.kind != "capability" && d.capability.is_some() {
        return Err("capability Is Only Valid For A Capability Module".into());
    }
    if d.trace.as_ref().is_some_and(|t| t.len() > c.limits.trace_terms) {
        return Err(format!("trace Has More Than {} Terms", c.limits.trace_terms));
    }
    if d.flow_models.as_ref().is_some_and(|f| f.len() > c.limits.flow_models) {
        return Err(format!("flowModels Has More Than {} Entries", c.limits.flow_models));
    }
    let mut model_ids = BTreeSet::new();
    if let Some(f) = d.flow_models.iter().flatten().find(|f| !model_ids.insert(f.id.as_str())) {
        return Err(format!("Flow Model {} Is Declared Twice", f.id));
    }
    for dep in d.deps.iter().flatten() {
        check_dep(dep, c)?;
    }
    for o in d.owns.iter().flatten() {
        if !owns_path_ok(o) {
            return Err(format!("owns {o} Is Not a Repo-Relative Path"));
        }
    }
    let depends_on = d.depends_on.as_deref().unwrap_or_default();
    if let Some(p) = &d.profiles {
        if !depends_on.contains(&p.runner) {
            return Err(format!("profiles.runner {} Is Not In dependsOn", p.runner));
        }
    }
    // A flowModels id routes a Flow node to this module's gateway (flow/env.rs); without one
    // it has nowhere to go.
    let has_gateway = d.agent.as_ref().is_some_and(|a| a.gateway.is_some());
    if d.flow_models.as_ref().is_some_and(|f| !f.is_empty()) && !has_gateway {
        return Err("flowModels Needs agent.gateway".into());
    }
    let Some(agent) = &d.agent else { return Ok(()) };
    // The trust boundary: a Flow runner script is a file this module owns, so a pack cannot point
    // Flow at a script it does not ship (or at another module's).
    if let Some(flow) = &agent.flow {
        if !d.owns.iter().flatten().any(|o| *o == flow.script && !o.ends_with('/')) {
            return Err(format!("agent.flow.script {} Is Not One of Its owns Files", flow.script));
        }
    }
    if let Some(rows) = &agent.rows {
        if let Some(r) = rows.iter().find(|r| !ROWS.contains(&r.as_str())) {
            return Err(format!("Row {r} Is Not raw Or rendered"));
        }
    }
    if let Some(launch) = &agent.launch {
        if d.kind != "agent" || !agent.rows.as_ref().is_some_and(|rows| rows.iter().any(|row| row == "raw")) {
            return Err("agent.launch Needs An Agent raw Row".into());
        }
        if !shape_ok(&c.launch.executable_pattern, &launch.executable) {
            return Err(format!("agent.launch.executable {} Is Not An Executable Basename", launch.executable));
        }
        if launch.args.len() > c.launch.max_arguments {
            return Err(format!("agent.launch.args Has More Than {} Arguments", c.launch.max_arguments));
        }
        if let Some(arg) = launch.args.iter().find(|arg| !shape_ok(&c.launch.argument_pattern, arg)) {
            return Err(format!("agent.launch.args Contains A Non-Literal Argument {arg}"));
        }
        // PowerShell -File names a repo script; an optional pack may only launch one it owns.
        if launch.executable.eq_ignore_ascii_case("pwsh") || launch.executable.eq_ignore_ascii_case("powershell") {
            if let Some(index) = launch.args.iter().position(|arg| arg.eq_ignore_ascii_case("-File")) {
                let script = launch.args.get(index + 1).ok_or("agent.launch.args -File Needs A Script")?;
                if !owns_path_ok(script) || script.ends_with('/') || !d.owns.iter().flatten().any(|o| owns_overlap(o, script)) {
                    return Err(format!("agent.launch script {script} Is Not Within Its owns Paths"));
                }
            }
        }
    }
    if let Some(art) = &agent.art {
        check_icon(dir, &art.icon)?;
    }
    if let Some(g) = &agent.gateway {
        check_gateway(d, g, c)?;
    }
    Ok(())
}

/// A deps[] entry: catalog shape (id, label, a probe deps.rs can run), text free of the
/// forbidden characters (they would break the quoted install and setup prompts).
fn check_dep(dep: &Value, c: &Contract) -> Result<(), String> {
    let id = dep.get("id").and_then(Value::as_str).ok_or("Dep Entry Has No id")?;
    let label = dep.get("label").and_then(Value::as_str).ok_or_else(|| format!("Dep {id} Has No label"))?;
    let probe = dep.get("probe").ok_or_else(|| format!("Dep {id} Has No probe"))?;
    crate::deps::check_probe(probe).map_err(|e| format!("Dep {id} probe: {e}"))?;
    let mut text: Vec<&str> = vec![id, label];
    match dep.get("usedBy") {
        None => {}
        Some(Value::Array(a)) => {
            for v in a {
                text.push(v.as_str().ok_or_else(|| format!("Dep {id} usedBy Is Not A List Of Strings"))?);
            }
        }
        Some(_) => return Err(format!("Dep {id} usedBy Is Not A List Of Strings")),
    }
    match dep.get("install") {
        None => {}
        Some(Value::Object(o)) => {
            for v in o.values() {
                text.push(v.as_str().ok_or_else(|| format!("Dep {id} install Holds A Non-String"))?);
            }
        }
        Some(_) => return Err(format!("Dep {id} install Is Not An Object")),
    }
    for t in text {
        if let Some(ch) = c.dep_text.forbidden_chars.iter().find(|ch| t.contains(ch.as_str())) {
            return Err(format!("Dep {id} Text Contains {ch}"));
        }
    }
    Ok(())
}

/// The env var a dep entry probes, when it is an env probe.
pub fn dep_env_name(dep: &Value) -> Option<&str> {
    let probe = dep.get("probe")?;
    (probe.get("kind")?.as_str()? == "env").then(|| probe.get("name")?.as_str()).flatten()
}

/// Gateway rules that need only this declaration and the contract; the env keys a gateway may
/// set are the contract's `gateway.envAllowlist`.
fn check_gateway(d: &ModuleDecl, g: &Gateway, c: &Contract) -> Result<(), String> {
    if g.runner != c.gateway.runner {
        return Err(format!("Gateway Runner {} Is Not {}", g.runner, c.gateway.runner));
    }
    if !d.depends_on.as_deref().unwrap_or_default().contains(&g.runner) {
        return Err(format!("Gateway Runner {} Is Not In dependsOn", g.runner));
    }
    let rest = g.base_url.strip_prefix(c.gateway.base_url_prefix.as_str());
    if rest.is_none_or(|r| r.is_empty()) {
        return Err(format!("Gateway baseUrl Must Start {}", c.gateway.base_url_prefix));
    }
    if let Some(p) = c.gateway.key_var_forbidden_prefixes.iter().find(|p| g.key_var.starts_with(p.as_str())) {
        return Err(format!("keyVar {} Has The Forbidden Prefix {p}", g.key_var));
    }
    if !shape_ok(&c.gateway.key_var_pattern, &g.key_var) {
        return Err(format!("keyVar {} Does Not Match keyVarPattern", g.key_var));
    }
    let models = g.env.iter().flatten().filter(|(k, _)| k.ends_with("_MODEL")).map(|(_, v)| v);
    if let Some(m) = std::iter::once(&g.model).chain(models).find(|m| !shape_ok(&c.gateway.model_pattern, m)) {
        return Err(format!("Model {m} Does Not Match modelPattern"));
    }
    let want = key_var_for(&d.id, &c.gateway);
    if g.key_var != want {
        return Err(format!("keyVar {} Is Not {want}", g.key_var));
    }
    if !d.deps.iter().flatten().any(|dep| dep_env_name(dep) == Some(g.key_var.as_str())) {
        return Err(format!("No Dep Probes keyVar {}", g.key_var));
    }
    if let Some(k) = g.env.iter().flat_map(|e| e.keys()).find(|k| !c.gateway.env_allowlist.contains(k)) {
        return Err(format!("Env Key {k} Is Not in gateway.envAllowlist"));
    }
    Ok(())
}

/// An `owns` entry: repo-relative with `/` separators, a file (`a/b.mjs`) or a folder (`a/b/`),
/// no empty, `.` or `..` segment, no drive, no backslash.
pub fn owns_path_ok(p: &str) -> bool {
    let body = p.strip_suffix('/').unwrap_or(p);
    !body.is_empty()
        && !p.contains('\\')
        && !p.contains(':')
        && body.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

/// Whether two `owns` entries overlap: the same path, or one is a folder holding the other.
/// Paths are compared with ASCII case folded, as Windows does.
pub fn owns_overlap(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    let (a, b) = (a.as_str(), b.as_str());
    let holds = |dir: &str, p: &str| dir.ends_with('/') && p.starts_with(dir);
    a.trim_end_matches('/') == b.trim_end_matches('/') || holds(a, b) || holds(b, a)
}

/// The icon as a path inside `dir`: relative, no `..`, resolving (links followed) under the
/// pack folder, and a PNG by signature.
pub fn icon_path(dir: &Path, icon: &str) -> Result<PathBuf, String> {
    let rel = Path::new(icon);
    if icon.is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("Icon {icon} Is Not A Path Inside The Pack"));
    }
    let base = std::fs::canonicalize(dir).map_err(|e| format!("Pack Folder: {e}"))?;
    let full = std::fs::canonicalize(dir.join(rel)).map_err(|_| format!("Icon {icon} Is Missing"))?;
    if !full.starts_with(&base) {
        return Err(format!("Icon {icon} Is Not A Path Inside The Pack"));
    }
    Ok(full)
}

fn check_icon(dir: &Path, icon: &str) -> Result<(), String> {
    use std::io::Read;
    let full = icon_path(dir, icon)?;
    let mut sig = [0u8; 8];
    if std::fs::File::open(&full).and_then(|mut f| f.read_exact(&mut sig)).is_err() || !is_png(&sig) {
        return Err(format!("Icon {icon} Is Not A PNG"));
    }
    Ok(())
}

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= PNG_SIG.len() && bytes[..PNG_SIG.len()] == PNG_SIG
}

#[cfg(test)]
mod contract_extension_tests {
    use super::{check_decl, read_pack, Contract, ModuleDecl};
    use serde_json::{json, Value};

    fn with_core(decl: Value) -> Result<Contract, serde_json::Error> {
        let mut contract: Value = serde_json::from_str(include_str!("../../../contracts/modules.json")).unwrap();
        contract["core"] = json!([decl]);
        serde_json::from_value(contract)
    }

    #[test]
    fn core_surface_and_capability_shapes() {
        for (kind, level, detail) in [
            ("surface", "required-hideable", json!({ "surface": { "placement": "workbench", "order": 1 } })),
            ("surface", "optional", json!({ "surface": { "placement": "rail" } })),
            ("capability", "required-hideable", json!({ "capability": { "host": "speak-group" } })),
            ("capability", "optional", json!({ "capability": {} })),
        ] {
            let mut decl = json!({ "id": "acme", "label": "Acme", "level": level, "kind": kind });
            decl.as_object_mut().unwrap().extend(detail.as_object().unwrap().clone());
            assert!(with_core(decl).is_ok(), "{kind}/{level}");
        }
        for bad in [
            json!({ "id": "acme", "label": "Acme", "level": "core", "kind": "surface" }),
            json!({ "id": "acme", "label": "Acme", "level": "core", "kind": "surface", "surface": { "placement": "unknown" } }),
            json!({ "id": "acme", "label": "Acme", "level": "core", "kind": "capability", "capability": { "unknown": true } }),
            json!({ "id": "acme", "label": "Acme", "level": "core", "kind": "agent", "when": { "unknown": [] } }),
        ] {
            assert!(with_core(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn pack_capability_shape_rejects_missing_and_unknown_fields() {
        let contract: Contract = serde_json::from_str(include_str!("../../../contracts/modules.json")).unwrap();
        let missing: ModuleDecl = serde_json::from_value(json!({
            "id": "acme", "label": "Acme", "level": "optional", "kind": "capability"
        })).unwrap();
        assert!(check_decl(&missing, std::path::Path::new("."), &contract).unwrap_err().contains("Needs capability"));
        for bad in [
            json!({ "id": "acme", "label": "Acme", "level": "optional", "kind": "capability", "capability": { "unknown": true } }),
            json!({ "id": "acme", "label": "Acme", "level": "optional", "kind": "capability", "capability": {}, "when": { "unknown": [] } }),
        ] {
            assert!(serde_json::from_value::<ModuleDecl>(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn raw_launch_rejects_shell_expressions_before_listing() {
        let contract: Contract = serde_json::from_str(include_str!("../../../contracts/modules.json")).unwrap();
        let base = json!({
            "id": "acme", "label": "Acme", "level": "optional", "kind": "agent",
            "agent": { "rows": ["raw"], "launch": { "executable": "acme", "args": ["--mode", "plain"] } }
        });
        let check = |value: Value| {
            let decl: ModuleDecl = serde_json::from_value(value).unwrap();
            check_decl(&decl, std::path::Path::new("."), &contract)
        };
        assert!(check(base.clone()).is_ok());
        for bad in ["../acme", "C:\\acme.exe", "acme;whoami", "acme|more"] {
            let mut value = base.clone();
            value["agent"]["launch"]["executable"] = json!(bad);
            assert!(check(value).unwrap_err().contains("Executable Basename"), "{bad}");
        }
        for bad in ["--mode;whoami", "$(whoami)", "a & b", "`whoami`", "a|b"] {
            let mut value = base.clone();
            value["agent"]["launch"]["args"] = json!([bad]);
            assert!(check(value).unwrap_err().contains("Non-Literal Argument"), "{bad}");
        }
        let mut too_many = base.clone();
        too_many["agent"]["launch"]["args"] = json!(vec!["x"; 17]);
        assert!(check(too_many).unwrap_err().contains("More Than 16"));
        let mut no_raw = base;
        no_raw["agent"]["rows"] = json!(["rendered"]);
        assert!(check(no_raw).unwrap_err().contains("Needs An Agent raw Row"));
    }

    #[test]
    fn read_pack_applies_requires_and_keeps_absent_keys() {
        let contract: Contract = serde_json::from_str(include_str!("../../../contracts/modules.json")).unwrap();
        let root = std::env::temp_dir().join(format!("vidar-pack-compat-{}", std::process::id()));
        let dir = root.join("acme");
        std::fs::create_dir_all(&dir).unwrap();
        let read = |pack: Value| {
            std::fs::write(dir.join("pack.json"), pack.to_string()).unwrap();
            read_pack("acme", &dir, &contract).map(|_| ())
        };
        assert!(read(json!({ "id": "acme", "version": 1 })).is_ok());
        let ok = json!({ "id": "acme", "version": 1, "release": "1.0.0", "requires": { "contract": 1, "minCore": "0.0.1" } });
        assert!(read(ok).is_ok());
        let new = json!({ "id": "acme", "version": 1, "requires": { "contract": 1, "minCore": "999.0.0" } });
        assert_eq!(read(new).unwrap_err(), "Needs Vidar 999.0.0 or Newer");
        let bad = json!({ "id": "acme", "version": 1, "release": "x" });
        assert!(read(bad).unwrap_err().contains("release"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn raw_launch_script_must_be_owned() {
        let contract: Contract = serde_json::from_str(include_str!("../../../contracts/modules.json")).unwrap();
        let local = crate::paths::packs_dir().join("local");
        if !local.exists() {
            eprintln!("skipped: {} is not in this tree (pack not shipped)", local.display());
            return;
        }
        assert!(read_pack("local", &local, &contract).is_ok());
        let mut value: Value = serde_json::from_str(include_str!("../../../tests/fixtures/modules/launch-script-outside.json")).unwrap();
        let check = |value: Value| {
            let decl: ModuleDecl = serde_json::from_value(value).unwrap();
            check_decl(&decl, std::path::Path::new("."), &contract)
        };
        assert!(check(value.clone()).unwrap_err().contains("Is Not Within Its owns Paths"));
        value["agent"]["launch"]["args"][1] = json!("tools/local/local-tab.ps1");
        assert!(check(value.clone()).is_ok());
        value["owns"] = json!(["tools/local/local-tab.ps1"]);
        assert!(check(value).is_ok());
    }
}
