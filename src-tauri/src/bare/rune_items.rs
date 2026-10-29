//! src-tauri\src\bare\rune_items.rs — item runes (skill, agent, hook, mcp, permission, plugin) as typed
//! items, and pure mappers from them into the pieces a `set_loadout::Loadout` already carries: copy
//! sources, guard objects, MCP names, settings permissions, plugin paths and env (model R1: every kind
//! is a rune; nothing rides beside runes). No disk access; the launch owns every write.
//! - `RuneItem::from_rune` types a parsed rune (`None` for rule, fact, procedure, set). State is the
//!   caller's to filter.
//! - `map_items(agent, items, env)` (`map_claude`, `map_codex`) gives `Pieces`; a rune whose `agent:`
//!   names the other agent maps with a warning, never dropped. Codex carries no permission list or mode
//!   and no plugin: those come back as `Mapped::Unsupported { warning }` naming the rune.
//! - Secrets: a hook `command` is a `rune::Secret`; any IPC or log shows `RuneItem::redacted`,
//!   where a command hook and every MCP field are a label only.

#![allow(dead_code)] // L2a wires the mappers into `set_loadout`; L1b's vault IPC calls `redacted`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use super::set_layer::{self, Permissions};
use crate::agent_spec;
use crate::falcon::Agent;
use crate::rules::rune::{Rune, Secret};

/// What a hook runs: script files (`run`, plus Codex `open` files) or one command line (a secret).
#[derive(Clone, Debug, PartialEq)]
pub enum HookAction {
    Files { run: Vec<String>, open: Vec<String> },
    Command(Secret),
}

/// One item rune's payload, by kind; paths are as written (`~`- or `{{root}}`-relative or absolute).
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Skill { source: String },
    Agent { source: String },
    Plugin { source: String },
    Hook { event: String, matcher: Option<String>, action: HookAction },
    /// The server's url and command stay in `contracts/module-bundles.json`; a rune names them only.
    Mcp { module: String, server: String },
    Permission(Permissions),
    /// `style:` names the style; a nonempty body is the style file itself (body-carrying, run runes-close U1).
    OutputStyle { style: String, body: String },
    /// `model:` names the session model for the rune's one `agent`.
    Model { model: String },
}

/// A launch's output style: the name `outputStyle` takes and, when the rune carries a body, the file the
/// launch writes as `<config dir>\output-styles\<id>.md` (`home::generate_settings_with`). On the wire, and
/// so in the loadout hash, it is the name only (rule bodies stay out of the hash the same way).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OutputStyle {
    pub name: String,
    /// The rune id: the style file's name.
    pub id: String,
    pub description: String,
    /// Trimmed rune body; empty = a built-in or user style named only, no file written.
    pub body: String,
}

impl OutputStyle {
    /// The style file's name and text (frontmatter `name` is the name `outputStyle` takes, then the body);
    /// `None` for a name-only style. An id that is not a plain file name is refused.
    pub fn file(&self) -> Result<Option<(String, String)>, String> {
        if self.body.is_empty() {
            return Ok(None);
        }
        if self.id.is_empty() || self.id.starts_with('.') || self.id.contains(['/', '\\', ':']) {
            return Err(format!("Bare output style: rune id {:?} is not a file name", self.id));
        }
        let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
        Ok(Some((format!("{}.md", self.id), format!("---\nname: {}\ndescription: {}\n---\n\n{}\n", q(&self.name), q(&self.description), self.body))))
    }

    /// Makes `dir` (`<config dir>\output-styles`) hold `style`'s file and no other `*.md`: written only when
    /// its bytes differ, and the sweep runs only when `dir` sits inside the Bare `home` (no `..`).
    pub fn sync_dir(style: Option<&OutputStyle>, dir: &Path, home: &Path) -> Result<(), String> {
        let file = style.map(|s| s.file()).transpose()?.flatten();
        if let Some((name, text)) = &file {
            if std::fs::read(dir.join(name)).ok().as_deref() != Some(text.as_bytes()) {
                std::fs::create_dir_all(dir).map_err(|e| format!("Bare output style {}: {e}", dir.display()))?;
                crate::fsx::atomic_write(&dir.join(name), text.as_bytes()).map_err(|e| format!("Bare output style {name}: {e}"))?;
            }
        }
        if !dir.starts_with(home) || dir.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Ok(());
        }
        for p in std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()) {
            let kept = file.as_ref().is_some_and(|(n, _)| p.file_name().is_some_and(|f| f == n.as_str()));
            if !kept && p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
                std::fs::remove_file(&p).map_err(|e| format!("Bare output style {}: {e}", p.display()))?;
            }
        }
        Ok(())
    }
}

impl Serialize for OutputStyle {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.name)
    }
}

/// An item rune: id, payload and the keys any kind may carry.
#[derive(Clone, Debug, PartialEq)]
pub struct RuneItem {
    pub id: String,
    pub description: String,
    pub item: Item,
    /// `agent:`: the one agent that runs it (`None` = both).
    pub agent: Option<Agent>,
    /// `required-by: vidar`: dropping it from a vault warns (`drop_warning`).
    pub required_by_vidar: bool,
    /// `env:` entries, name and value; a value is a secret.
    pub env: Vec<(String, Secret)>,
}

/// The IPC- and log-safe view of an item rune: a command hook and an MCP rune show a label
/// in place of their fields; env shows names only.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RedactedItem {
    pub id: String,
    pub kind: &'static str,
    pub label: &'static str,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<&'static str>,
    pub required_by_vidar: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub run: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub open: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ask: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub env_names: Vec<String>,
}

fn agent_of(name: Option<&str>) -> Option<Agent> {
    name.and_then(agent_spec::parse)
}

fn label_of(agent: Agent) -> &'static str {
    agent_spec::spec(agent).label
}

impl RuneItem {
    /// The typed item of a parsed rune; `Ok(None)` for the text kinds. `rune::parse` already checked
    /// the keys per kind, so an error here means a rune built some other way.
    pub fn from_rune(r: &Rune) -> Result<Option<RuneItem>, String> {
        let k = &r.item;
        let need = |v: &Option<String>, key: &str| v.clone().ok_or_else(|| format!("`{}`: a {} rune needs `{key}`", r.id, r.kind));
        let item = match r.kind.as_str() {
            "skill" => Item::Skill { source: need(&k.source, "source")? },
            "agent" => Item::Agent { source: need(&k.source, "source")? },
            "plugin" => Item::Plugin { source: need(&k.source, "source")? },
            "hook" => Item::Hook {
                event: need(&k.event, "event")?,
                matcher: k.matcher.clone(),
                action: match &k.command {
                    Some(c) => HookAction::Command(c.clone()),
                    None => HookAction::Files { run: k.run.clone(), open: k.open.clone() },
                },
            },
            "mcp" => Item::Mcp { module: need(&k.module, "module")?, server: need(&k.server, "server")? },
            "permission" => Item::Permission(Permissions { allow: k.allow.clone(), ask: k.ask.clone(), mode: k.mode.clone() }),
            "output-style" => Item::OutputStyle { style: need(&k.style, "style")?, body: r.body.trim().to_string() },
            "model" => {
                let model = need(&k.model, "model")?;
                crate::rules::rune::check_model(&model).map_err(|e| format!("`{}`: {e}", r.id))?;
                if r.agent.is_none() {
                    return Err(format!("`{}`: a model rune needs `agent`", r.id));
                }
                Item::Model { model }
            }
            _ => return Ok(None),
        };
        let env = k
            .env
            .iter()
            .map(|e| e.split_once('=').map(|(n, v)| (n.to_string(), Secret::new(v.to_string()))))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("`{}`: an `env` entry is not NAME=value", r.id))?;
        Ok(Some(RuneItem {
            id: r.id.clone(),
            description: r.description.clone(),
            item,
            agent: agent_of(r.agent.as_deref()),
            required_by_vidar: r.required_by_vidar(),
            env,
        }))
    }

    pub fn kind(&self) -> &'static str {
        match self.item {
            Item::Skill { .. } => "skill",
            Item::Agent { .. } => "agent",
            Item::Plugin { .. } => "plugin",
            Item::Hook { .. } => "hook",
            Item::Mcp { .. } => "mcp",
            Item::Permission(_) => "permission",
            Item::OutputStyle { .. } => "output-style",
            Item::Model { .. } => "model",
        }
    }

    /// The view any IPC or log shows: never a hook command, an MCP field or an env value.
    pub fn redacted(&self) -> RedactedItem {
        let mut v = RedactedItem {
            id: self.id.clone(),
            kind: self.kind(),
            label: "",
            description: self.description.clone(),
            agent: self.agent.map(Agent::as_str),
            required_by_vidar: self.required_by_vidar,
            source: None,
            event: None,
            matcher: None,
            run: Vec::new(),
            open: Vec::new(),
            allow: Vec::new(),
            ask: Vec::new(),
            mode: None,
            style: None,
            model: None,
            env_names: self.env.iter().map(|(n, _)| n.clone()).collect(),
        };
        match &self.item {
            Item::Skill { source } => (v.label, v.source) = ("Skill", Some(source.clone())),
            Item::Agent { source } => (v.label, v.source) = ("Agent", Some(source.clone())),
            Item::Plugin { source } => (v.label, v.source) = ("Plugin", Some(source.clone())),
            Item::Hook { event, matcher, action } => {
                (v.event, v.matcher) = (Some(event.clone()), matcher.clone());
                v.label = match action {
                    HookAction::Command(_) => "Command Hook",
                    HookAction::Files { run, open } => {
                        (v.run, v.open) = (run.clone(), open.clone());
                        "Hook"
                    }
                };
            }
            Item::Mcp { .. } => v.label = "MCP Server",
            Item::Permission(p) => {
                (v.allow, v.ask, v.mode) = (p.allow.clone(), p.ask.clone(), p.mode.clone());
                v.label = "Permission";
            }
            Item::OutputStyle { style, .. } => { v.label = "Output Style"; v.style = Some(style.clone()); }
            Item::Model { model } => { v.label = "Model"; v.model = Some(model.clone()); }
        }
        v
    }
}

/// `redacted` of a parsed rune, or `None` for the text kinds and a rune that does not type.
pub fn redacted_rune(r: &Rune) -> Option<RedactedItem> {
    RuneItem::from_rune(r).ok().flatten().map(|i| i.redacted())
}

/// The warning when a vault drops a `required-by: vidar` rune (any kind).
pub fn drop_warning(id: &str) -> String {
    format!("Rune `{id}` is required by Vidar; a session without it may not work")
}

/// The machine paths a mapper expands against: the install root (`{{root}}`) and the user's home (`~`).
pub struct MapEnv<'a> {
    pub root: &'a Path,
    pub user_home: Option<&'a Path>,
}

/// An MCP server a vault carries, by module and server name; the launch resolves the endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpRef {
    pub module: String,
    pub server: String,
}

/// One piece an item gives an agent. No Debug: a `Guard` may hold a command.
pub enum Mapped {
    Skill(String),
    Agent(String),
    Plugin(String),
    /// `{ event, matcher?, run, open? }` (paths absolute) or `{ event, matcher?, command }`: the
    /// `Loadout::guard_items` shape.
    Guard(Value),
    Mcp(McpRef),
    Permissions(Permissions),
    OutputStyle(OutputStyle),
    Model(String),
    Env(String, Secret),
    Unsupported { warning: String },
}

/// `{{root}}/a/b`, `~/a/b` or an absolute path, made absolute; a `..`, `.` or empty segment after
/// `{{root}}` is refused so a rune cannot point outside the install root that way.
pub fn expand_path(path: &str, env: &MapEnv) -> Result<PathBuf, String> {
    if let Some(rest) = path.strip_prefix("{{root}}") {
        let rest = rest.strip_prefix(['/', '\\']).ok_or_else(|| format!("path {path:?} has no separator after {{{{root}}}}"))?;
        let mut p = env.root.to_path_buf();
        for seg in rest.split(['/', '\\']) {
            if seg.is_empty() || seg == "." || seg == ".." {
                return Err(format!("path {path:?} has an empty, `.` or `..` segment"));
            }
            p.push(seg);
        }
        return Ok(p);
    }
    let p = crate::rules::import::sources::expand(path, env.user_home);
    if p.is_absolute() { Ok(p) } else { Err(format!("path {path:?} is not absolute, `~`- or {{{{root}}}}-relative")) }
}

/// A plugin loads by path from the repo's `plugins\` only (`mods-local-only`):
/// `{{root}}/plugins/<name>`, one plain segment.
pub fn plugin_path(source: &str, env: &MapEnv) -> Result<PathBuf, String> {
    let name = source
        .strip_prefix("{{root}}/plugins/")
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .ok_or_else(|| format!("plugin source {source:?} is not {{{{root}}}}/plugins/<name>"))?;
    Ok(env.root.join("plugins").join(name))
}

fn text(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// The pieces one item gives `agent`, or an error (the rune is skipped with that warning).
/// A plugin or permission on Codex is `Unsupported`; a hook event or matcher the agent cannot carry
/// is `Unsupported` too. Env rides with a carried item only.
pub fn map_item(agent: Agent, it: &RuneItem, env: &MapEnv) -> Result<Vec<Mapped>, String> {
    let carries = &agent_spec::spec(agent).carries;
    let at = |e: String| format!("Rune `{}`: {e}; skipped", it.id);
    let unsupported = |why: String| Ok(vec![Mapped::Unsupported { warning: format!("Rune `{}`: {why}; not carried", it.id) }]);
    let mut out = match &it.item {
        Item::Model { .. } if it.agent.is_some_and(|a| a != agent) => {
            return unsupported(format!("its model is for {}", it.agent.map_or("", label_of)));
        }
        Item::Model { .. } if carries.model.is_some() => return unsupported(carries.model.unwrap_or_default().into()),
        Item::Model { model } => vec![Mapped::Model(model.clone())],
        Item::Skill { .. } if carries.skill.is_some() => return unsupported(carries.skill.unwrap_or_default().into()),
        Item::Skill { source } => vec![Mapped::Skill(text(expand_path(source, env).map_err(at)?))],
        Item::Agent { .. } if carries.agent.is_some() => return unsupported(carries.agent.unwrap_or_default().into()),
        Item::Agent { source } => vec![Mapped::Agent(text(expand_path(source, env).map_err(at)?))],
        Item::Plugin { .. } if carries.plugin.is_some() => return unsupported(carries.plugin.unwrap_or_default().into()),
        Item::Plugin { source } => vec![Mapped::Plugin(text(plugin_path(source, env).map_err(at)?))],
        Item::Hook { event, matcher, action } => {
            if let Some(why) = (carries.guard)(event, matcher.as_deref()) {
                return unsupported(why);
            }
            let mut g = json!({ "event": event });
            if let Some(m) = matcher {
                g["matcher"] = json!(m);
            }
            match action {
                // `{{root}}` in a command is the install root, as in a `run` path (stock `guard-driver`).
                HookAction::Command(c) => g["command"] = json!(c.expose().replace("{{root}}", &env.root.to_string_lossy())),
                HookAction::Files { run, open } => {
                    let abs = |l: &[String]| l.iter().map(|p| expand_path(p, env).map(text)).collect::<Result<Vec<_>, _>>();
                    g["run"] = json!(abs(run).map_err(at)?);
                    if !open.is_empty() {
                        g["open"] = json!(abs(open).map_err(at)?);
                    }
                }
            }
            vec![Mapped::Guard(g)]
        }
        Item::Mcp { .. } if carries.mcp.is_some() => return unsupported(carries.mcp.unwrap_or_default().into()),
        Item::Mcp { module, server } => vec![Mapped::Mcp(McpRef { module: module.clone(), server: server.clone() })],
        Item::Permission(p) => {
            let entries: Vec<String> = p.allow.iter().chain(p.ask.iter()).cloned().collect();
            let carry = (carries.permission)(&entries, p.mode.as_deref());
            match carry.refused {
                // Entries the agent keeps (Codex's `mcp__`) ride on; the rest keep their warning.
                Some(what) if !carry.kept.is_empty() => {
                    let keep = |l: &[String]| l.iter().filter(|e| carry.kept.contains(e)).cloned().collect::<Vec<_>>();
                    let warning = format!("Rune `{}`: {what}; not carried", it.id);
                    vec![Mapped::Permissions(Permissions { allow: keep(&p.allow), ask: keep(&p.ask), mode: None }), Mapped::Unsupported { warning }]
                }
                Some(what) => return unsupported(what),
                None => vec![Mapped::Permissions(p.clone())],
            }
        }
        Item::OutputStyle { .. } if carries.output_style.is_some() => {
            return unsupported(carries.output_style.unwrap_or_default().into());
        }
        Item::OutputStyle { style, body } => vec![Mapped::OutputStyle(OutputStyle {
            name: style.clone(),
            id: it.id.clone(),
            description: it.description.clone(),
            body: body.clone(),
        })],
    };
    out.extend(it.env.iter().map(|(n, v)| Mapped::Env(n.clone(), v.clone())));
    Ok(out)
}

/// Everything a vault's item runes give one agent, deduped in item order (first wins), in the shapes
/// `Loadout` holds. No Debug: `guard_items` may hold a command and `env` values.
#[derive(Default)]
pub struct Pieces {
    /// Skill and agent sources, absolute, deduped by file or folder name (`set_layer::name_of`).
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    /// Guard names (`set_layer::guard_name`) and the guard objects behind them, same order.
    pub guards: Vec<String>,
    pub guard_items: Vec<Value>,
    pub mcp: Vec<McpRef>,
    /// Allow minus ask (an ask wins), first `mode` wins.
    pub permissions: Permissions,
    /// First selected Claude output style; a second style rune warns and is dropped.
    pub output_style: Option<OutputStyle>,
    /// First model rune for this agent; a second warns and is dropped.
    pub model: Option<String>,
    /// Plugin folders, absolute (`<root>\plugins\<name>`).
    pub plugins: Vec<String>,
    pub env: Vec<(String, Secret)>,
    /// One per `Mapped::Unsupported`.
    pub unsupported: Vec<String>,
    /// Other-agent runes, skipped runes, conflicting modes or env names.
    pub warnings: Vec<String>,
}

fn push_named(into: &mut Vec<String>, item: String) {
    let name = set_layer::name_of(&item);
    if !into.iter().any(|o| set_layer::name_of(o) == name) {
        into.push(item);
    }
}

fn push_unique(into: &mut Vec<String>, item: &str) {
    if !into.iter().any(|o| o == item) {
        into.push(item.to_string());
    }
}

/// Claude Code's built-in output styles; a body-carrying style rune under one of these names would shadow it.
/// (No list existed in the source; these are Default, Explanatory and Learning.)
const BUILTIN_STYLES: [&str; 3] = ["Default", "Explanatory", "Learning"];

/// Map every item for `agent` (see `map_item`) and merge the pieces.
pub fn map_items(agent: Agent, items: &[RuneItem], env: &MapEnv) -> Pieces {
    let mut out = Pieces::default();
    for it in items {
        if let Some(only) = it.agent.filter(|a| *a != agent && !matches!(it.item, Item::Model { .. })) {
            out.warnings.push(format!("Rune `{}` is for {}; carried on {} anyway", it.id, label_of(only), label_of(agent)));
        }
        let mapped = match map_item(agent, it, env) {
            Ok(m) => m,
            Err(e) => {
                out.warnings.push(e);
                continue;
            }
        };
        for m in mapped {
            match m {
                Mapped::Skill(s) => push_named(&mut out.skills, s),
                Mapped::Agent(s) => push_named(&mut out.agents, s),
                Mapped::Plugin(s) => push_unique(&mut out.plugins, &s),
                Mapped::Guard(g) => {
                    let name = set_layer::guard_name(&g);
                    if !out.guards.contains(&name) {
                        out.guards.push(name);
                        out.guard_items.push(g);
                    }
                }
                Mapped::Mcp(r) => {
                    if !out.mcp.iter().any(|o| o.server.eq_ignore_ascii_case(&r.server)) {
                        out.mcp.push(r);
                    }
                }
                Mapped::Permissions(p) => {
                    p.allow.iter().for_each(|a| push_unique(&mut out.permissions.allow, a));
                    p.ask.iter().for_each(|a| push_unique(&mut out.permissions.ask, a));
                    match (&out.permissions.mode, p.mode) {
                        (None, m) => out.permissions.mode = m,
                        (Some(old), Some(m)) if *old != m => {
                            out.warnings.push(format!("Rune `{}` asks permission mode {m}; {old} came first and stays", it.id));
                        }
                        _ => {}
                    }
                }
                Mapped::OutputStyle(style) if !style.body.is_empty() && BUILTIN_STYLES.iter().any(|b| b.eq_ignore_ascii_case(&style.name)) => {
                    out.warnings.push(format!("Rune `{}` carries a body under the built-in style name {}; the built-in stays", it.id, style.name));
                }
                Mapped::OutputStyle(style) => match &out.output_style {
                    None => out.output_style = Some(style),
                    Some(old) if old.id != style.id => {
                        out.warnings.push(format!("Rune `{}` asks output style {}; {} came first and stays", it.id, style.name, old.name));
                    }
                    Some(_) => {}
                },
                Mapped::Model(m) => match &out.model {
                    None => out.model = Some(m),
                    Some(old) if *old != m => {
                        out.warnings.push(format!("Rune `{}` asks model {m}; {old} came first and stays", it.id));
                    }
                    Some(_) => {}
                },
                Mapped::Env(n, v) => match out.env.iter().find(|(o, _)| *o == n) {
                    Some((_, old)) if old != &v => out.warnings.push(format!("Rune `{}` sets env {n} again; the first value stays", it.id)),
                    Some(_) => {}
                    None => out.env.push((n, v)),
                },
                Mapped::Unsupported { warning } => out.unsupported.push(warning),
            }
        }
    }
    let ask = out.permissions.ask.clone();
    out.permissions.allow.retain(|a| !ask.contains(a));
    out
}

/// Test shorthands for `map_items`; the product maps through `agent_spec::ALL`.
#[cfg(test)]
pub fn map_claude(items: &[RuneItem], env: &MapEnv) -> Pieces {
    map_items(Agent::Claude, items, env)
}

#[cfg(test)]
pub fn map_codex(items: &[RuneItem], env: &MapEnv) -> Pieces {
    map_items(Agent::Codex, items, env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{library::Library, rune};

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    }

    fn stock_items() -> Vec<RuneItem> {
        let lib = Library::open(&repo().join("tests/fixtures/rune-vault/stock-runes")).unwrap();
        let (runes, errors) = lib.all_runes();
        assert!(errors.is_empty(), "{errors:?}");
        runes.iter().filter_map(|(r, _)| RuneItem::from_rune(r).unwrap()).collect()
    }

    fn item(text: &str) -> RuneItem {
        RuneItem::from_rune(&rune::parse(text).unwrap()).unwrap().unwrap()
    }

    #[test]
    fn the_redacted_view_never_holds_a_hook_command_or_mcp_fields() {
        let hook = item("---\nname: notify\nkind: hook\nscope: [global]\nevent: Stop\ncommand: sk-secret-1\n---\n");
        let v = hook.redacted();
        assert_eq!((v.kind, v.label, v.event.as_deref()), ("hook", "Command Hook", Some("Stop")));
        let wire = serde_json::to_string(&v).unwrap();
        for out in [format!("{v:?}"), wire.clone(), format!("{hook:?}")] {
            assert!(!out.contains("sk-secret-1"), "secret leaked: {out}");
        }
        let mcp = item("---\nname: drive\nkind: mcp\nscope: [global]\nmodule: secret-module\nserver: secret_server\n---\n").redacted();
        let wire = serde_json::to_string(&mcp).unwrap();
        assert_eq!(mcp.label, "MCP Server");
        assert!(!wire.contains("secret") && !format!("{mcp:?}").contains("secret"), "{wire}");
        let envd = item("---\nname: gate\nkind: plugin\nscope: [global]\nsource: {{root}}/plugins/gate\nenv: TOKEN=sk-secret-1\n---\n");
        let wire = serde_json::to_string(&envd.redacted()).unwrap();
        assert!(wire.contains("\"envNames\":[\"TOKEN\"]") && !wire.contains("sk-secret-1"), "{wire}");
        assert!(!format!("{envd:?}").contains("sk-secret-1"));
        let fixture = stock_items().into_iter().find(|i| i.id == "gate-hook-command").unwrap();
        assert!(!serde_json::to_string(&fixture.redacted()).unwrap().contains("sk-secret-1"));
        let r = rune::parse("---\nname: notify\nkind: hook\nscope: [global]\nevent: Stop\ncommand: sk-secret-1\n---\n").unwrap();
        assert_eq!(redacted_rune(&r).unwrap().label, "Command Hook");
        assert!(redacted_rune(&rune::parse("---\nname: r\nkind: rule\nscope: [global]\n---\nText\n").unwrap()).is_none());
    }

    #[test]
    fn every_stock_item_maps_for_claude_and_a_codex_rune_warns_but_rides() {
        let root = repo();
        let env = MapEnv { root: &root, user_home: None };
        let p = map_claude(&stock_items(), &env);
        assert!(p.skills.iter().any(|s| s.ends_with("gate-skill")), "{:?}", p.skills);
        assert!(p.agents.iter().any(|s| s.ends_with("gate-agent.md")), "{:?}", p.agents);
        assert!(p.guards.iter().any(|g| g.contains("gate-hook-run.mjs")), "{:?}", p.guards);
        assert!(p.guard_items.iter().any(|g| g["command"].as_str().is_some_and(|c| c.contains("gate-notify.mjs"))), "a Codex-only hook still rides on Claude");
        assert!(p.warnings.iter().any(|w| w.contains("gate-hook-command") && w.contains("for Codex")), "{:?}", p.warnings);
        // Both MCP runes ride: the Claude one, and the Codex one with a warning.
        assert_eq!(p.mcp.len(), 2, "{:?}", p.mcp);
        for (module, server) in [("fixture-echo", "fixture_echo"), ("vidar-drive", "vidar_drive")] {
            assert!(p.mcp.contains(&McpRef { module: module.into(), server: server.into() }), "{:?}", p.mcp);
        }
        assert_eq!((p.permissions.allow.as_slice(), p.permissions.ask.as_slice()), (&["mcp__plugin_vidar_drive".to_string()][..], &["mcp__gate_write".to_string()][..]));
        assert_eq!(p.permissions.mode.as_deref(), Some("auto"));
        assert_eq!(p.plugins, [text(root.join("plugins").join("vidar-app"))]);
        assert!(p.plugins[0].ends_with("plugins\\vidar-app") || p.plugins[0].ends_with("plugins/vidar-app"));
        assert!(p.unsupported.is_empty(), "{:?}", p.unsupported);
    }

    #[test]
    fn codex_returns_unsupported_for_mode_and_plugins_and_keeps_the_rest() {
        let root = repo();
        let env = MapEnv { root: &root, user_home: None };
        let items = stock_items();
        let perm = items.iter().find(|i| i.id == "gate-permission").unwrap();
        let mapped = map_item(Agent::Codex, perm, &env).unwrap();
        // The `mcp__` entries ride on Codex (Flow reads them); the mode keeps its warning.
        assert!(matches!(mapped.as_slice(), [Mapped::Permissions(k), Mapped::Unsupported { warning }]
            if k.mode.is_none() && !k.allow.is_empty() && k.allow.iter().chain(&k.ask).all(|e| e.starts_with("mcp__"))
                && warning.contains("gate-permission") && warning.contains("permission mode")));
        let p = map_codex(&items, &env);
        assert!(p.unsupported.iter().any(|w| w.contains("gate-permission")) && p.unsupported.iter().any(|w| w.contains("vidar-app")), "{:?}", p.unsupported);
        assert!(p.plugins.is_empty() && p.permissions.mode.is_none());
        assert_eq!((p.permissions.allow.as_slice(), p.permissions.ask.as_slice()), (&["mcp__plugin_vidar_drive".to_string()][..], &["mcp__gate_write".to_string()][..]));
        assert_eq!(p.guard_items.len(), 2, "both hooks ride on Codex");
        // The Claude MCP rune `fixture-echo` rides on Codex with a warning, beside `vidar-drive`.
        assert!(p.skills.len() == 1 && p.agents.len() == 1 && p.mcp.len() == 2, "{:?}", p.mcp);
        assert!(!p.warnings.iter().any(|w| w.contains("gate-hook-command")), "a Codex rune on Codex does not warn");
    }

    #[test]
    fn required_by_env_and_path_rules() {
        let root = repo();
        let env = MapEnv { root: &root, user_home: None };
        let gate = item("---\nname: gate\nkind: plugin\nscope: [global]\nrequired-by: vidar\nsource: {{root}}/plugins/gate\nenv: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1\n---\n");
        assert!(gate.required_by_vidar && drop_warning(&gate.id).contains("`gate`"));
        let p = map_claude(std::slice::from_ref(&gate), &env);
        assert_eq!(p.env.iter().map(|(n, v)| (n.as_str(), v.expose())).collect::<Vec<_>>(), [("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS", "1")]);
        assert!(map_codex(&[gate], &env).env.is_empty(), "an unsupported item carries no env");
        let outside = item("---\nname: out\nkind: plugin\nscope: [global]\nsource: ~/plugins/out\n---\n");
        assert!(map_item(Agent::Claude, &outside, &env).err().unwrap().contains("plugins/<name>"));
        let up = item("---\nname: up\nkind: skill\nscope: [global]\nsource: {{root}}/../x\n---\n");
        let p = map_claude(&[up], &env);
        assert!(p.skills.is_empty() && p.warnings.iter().any(|w| w.contains("`up`") && w.contains("..")), "{:?}", p.warnings);
        assert!(expand_path("relative/x", &env).is_err());
    }

    #[test]
    fn the_shipped_guard_driver_hook_runs_from_the_root_with_its_root_arg() {
        let root = repo();
        let env = MapEnv { root: &root, user_home: None };
        let text = std::fs::read_to_string(root.join("profiles/bare/stock-runes/hooks/guard-driver.md")).unwrap();
        let p = map_claude(&[item(&text.replace('\r', ""))], &env);
        let r = root.to_string_lossy();
        let want = format!("node \"{r}\\tools\\agent-layer\\guard-driver.mjs\" --root \"{r}\"");
        assert_eq!(p.guard_items.len(), 1);
        assert_eq!(p.guard_items[0]["command"].as_str(), Some(want.as_str()));
        assert_eq!(p.guard_items[0]["event"].as_str(), Some("PreToolUse"));
    }

    #[test]
    fn a_style_rune_carries_its_body_and_a_second_style_warns() {
        let root = repo();
        let env = MapEnv { root: &root, user_home: None };
        let brief = item("---\nname: brief\nkind: output-style\nscope: [global]\ndescription: Short answers.\nstyle: Brief\n---\n\nAnswer in one line.\n");
        let named = item("---\nname: explain\nkind: output-style\nscope: [global]\nstyle: Explanatory\n---\n");
        let p = map_claude(&[brief.clone(), named.clone(), brief.clone()], &env);
        let s = p.output_style.as_ref().unwrap();
        assert_eq!((s.name.as_str(), s.id.as_str(), s.description.as_str(), s.body.as_str()), ("Brief", "brief", "Short answers.", "Answer in one line."));
        assert_eq!(p.warnings, ["Rune `explain` asks output style Explanatory; Brief came first and stays"], "a repeat of the first rune does not warn");
        assert_eq!(serde_json::to_string(s).unwrap(), "\"Brief\"", "the wire carries the name only");
        assert_eq!(brief.redacted().style.as_deref(), Some("Brief"));
        assert!(map_claude(&[named], &env).output_style.unwrap().body.is_empty());
        assert!(map_codex(&[brief], &env).output_style.is_none());
    }

    #[test]
    fn a_model_rune_needs_an_agent_and_a_clean_name_and_the_first_one_wins() {
        let root = repo();
        let env = MapEnv { root: &root, user_home: None };
        let head = |name: &str, agent: &str, model: &str| format!("---\nname: {name}\nkind: model\nscope: [global]\n{agent}model: {model}\n---\n");
        let a = item(&head("opus", "agent: claude\n", "opus"));
        let b = item(&head("sonnet", "agent: claude\n", "sonnet"));
        let c = item(&head("gpt", "agent: codex\n", "gpt-6"));
        let p = map_claude(&[a.clone(), b.clone(), a.clone(), c.clone()], &env);
        assert_eq!(p.model.as_deref(), Some("opus"));
        assert_eq!(p.warnings, ["Rune `sonnet` asks model sonnet; opus came first and stays"]);
        assert_eq!(p.unsupported, ["Rune `gpt`: its model is for Codex; not carried"]);
        assert_eq!(map_codex(&[a.clone(), c], &env).model.as_deref(), Some("gpt-6"));
        assert_eq!(a.redacted().model.as_deref(), Some("opus"));
        let err = rune::parse(&head("m", "", "opus")).unwrap_err();
        assert!(err.contains("needs `agent`"), "{err}");
        for bad in ["\"a\\\"b\"", "-fast"] {
            assert!(rune::parse(&head("m", "agent: claude\n", bad)).is_err(), "{bad}");
        }
        assert!(rune::parse("---\nname: r\nkind: rule\nscope: [global]\nmodel: opus\n---\n").is_err(), "model key only on a model rune");
    }
}
