//! Kit stores each selected item as a rune and slots it in `sets/kit.md`.
//! New item templates are runes too, but start outside every set.
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::guards::{self, BareGuard, BareCodexGuard};
use super::set_layer::{self, SetLayerWrite};
use crate::rules::rune;

const LIB: &str = "kit";
const KIT_MD: &str = "---\nname: kit\nkind: set\nscope: [kit]\n---\n";
/// Codex's built-in role names: an agent template never takes one.
const RESERVED_AGENTS: [&str; 3] = ["default", "explorer", "worker"];

/// A layer item Add Kit left out: `<key>/<name>` and why.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Dropped {
    pub id: String,
    pub reason: String,
}

/// `bare_kit_create`'s result: `created` is false when a Kit already existed (nothing written).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct KitCreated {
    pub created: bool,
    pub dropped: Vec<Dropped>,
}

/// One library template file: `kind` skill, agent or hook; `agent` claude, codex or none (skills
/// and hooks serve both); `path` absolute (a skill's folder, else the file), the shape a sidecar list holds.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LibraryFile {
    pub kind: String,
    pub agent: Option<String>,
    pub name: String,
    pub path: String,
}

fn expanded(p: &str, home: Option<&Path>) -> String {
    crate::rules::import::sources::expand(p, home).to_string_lossy().into_owned()
}

/// The items of one path list that pass `check` and keep a unique name; the rest go to `dropped`.
fn keep_paths(key: &str, list: Option<&Vec<String>>, home: Option<&Path>, dropped: &mut Vec<Dropped>, check: &dyn Fn(&str) -> Result<(), String>) -> Option<Vec<String>> {
    let list = list?;
    let (mut names, mut out) = (BTreeSet::new(), Vec::new());
    for p in list {
        let name = set_layer::name_of(p);
        // A check's own text can quote file content (a TOML parse error), so its reason stays generic.
        let reason = match check(&expanded(p, home)) {
            Err(_) => Some("Invalid Kit item source"),
            Ok(()) if !names.insert(name.clone()) => Some("Another item has this name"),
            Ok(()) => None,
        };
        match reason {
            None => out.push(p.clone()),
            Some(reason) => dropped.push(Dropped { id: format!("{key}/{name}"), reason: reason.into() }),
        }
    }
    Some(out)
}

/// One guard with its `run`/`open` expanded, checked the way `write_set` checks it, against those kept before.
fn check_guard(g: &Value, home: Option<&Path>, codex: bool, kept: &[BareGuard]) -> Result<BareGuard, String> {
    let mut v = g.clone();
    let o = v.as_object_mut().ok_or("Guard is not an object")?;
    for key in ["run", "open"] {
        let Some(list) = o.get(key).filter(|v| !v.is_null()).cloned() else { continue };
        let list: Option<Vec<Value>> = list.as_array().and_then(|a| a.iter().map(|s| s.as_str().map(|s| Value::from(expanded(s, home)))).collect());
        o.insert(key.into(), Value::from(list.ok_or_else(|| format!("Guard `{key}` is not a list of paths"))?));
    }
    let plain = if codex {
        let typed: BareCodexGuard = serde_json::from_value(v).map_err(|_| "Invalid Codex guard".to_string())?;
        let scripts_ok = typed.run.iter().chain(&typed.open).all(|p| Path::new(p).is_absolute() && Path::new(p).extension().is_some_and(|e| e.eq_ignore_ascii_case("mjs")) && Path::new(p).is_file());
        if !guards::CODEX_HOOK_EVENTS.contains(&typed.event.as_str()) || (!typed.open.is_empty() && typed.event != "PreToolUse") || !scripts_ok || typed.run.is_empty() {
            return Err("Invalid Codex guard event or script".into());
        }
        BareGuard { event: typed.event, matcher: typed.matcher, run: typed.run }
    } else {
        o.remove("open");
        serde_json::from_value(v).map_err(|_| "Guard is not an event, matcher? and run list".to_string())?
    };
    if !codex {
        // name clashes count against the guards kept before this one, as at spawn
        let mut all = kept.to_vec();
        all.push(plain.clone());
        guards::validate(&all).map_err(|_| "Invalid guard files".to_string())?;
    }
    Ok(plain)
}

fn keep_guards(key: &str, list: Option<&Vec<Value>>, home: Option<&Path>, codex: bool, dropped: &mut Vec<Dropped>) -> Option<Vec<Value>> {
    let list = list?;
    let (mut kept, mut out) = (Vec::new(), Vec::new());
    for g in list {
        let resolved = match set_layer::resolve_hook_ref(g, home, &[]) {
            Ok(v) => v,
            Err(_) => {
                dropped.push(Dropped { id: format!("{key}/{}", set_layer::guard_name(g)), reason: "Invalid hook selection".into() });
                continue;
            }
        };
        if let Ok(Some(raw)) = guards::raw_hook(&resolved) {
            if codex && guards::codex_unsupported(&raw.event, raw.matcher.as_deref()).is_some() {
                dropped.push(Dropped { id: format!("{key}/{}", set_layer::guard_name(&resolved)), reason: "Codex cannot run this hook".into() });
            } else {
                out.push(resolved);
            }
            continue;
        }
        match check_guard(&resolved, home, codex, &kept) {
            Ok(b) => { kept.push(b); out.push(resolved); }
            Err(_) => dropped.push(Dropped { id: format!("{key}/{}", set_layer::guard_name(g)), reason: "Invalid Kit hook".into() }),
        }
    }
    Some(out)
}

/// `layer` without the items a spawn would refuse, and those items.
pub(crate) fn check_items(layer: &SetLayerWrite, home: Option<&Path>) -> (SetLayerWrite, Vec<Dropped>) {
    let mut d = Vec::new();
    let skill = |p: &str| super::copies::check_skill(p, None).map(|_| ());
    let clean = SetLayerWrite {
        skills: keep_paths("skills", layer.skills.as_ref(), home, &mut d, &skill),
        agents: keep_paths("agents", layer.agents.as_ref(), home, &mut d, &|p| super::copies::check_agent(p, None).map(|_| ())),
        guards: keep_guards("guards", layer.guards.as_ref(), home, false, &mut d),
        codex_skills: keep_paths("codexSkills", layer.codex_skills.as_ref(), home, &mut d, &skill),
        codex_agents: keep_paths("codexAgents", layer.codex_agents.as_ref(), home, &mut d, &|p| super::copies::check_codex_agent(p, None).map(|_| ())),
        codex_guards: keep_guards("codexGuards", layer.codex_guards.as_ref(), home, true, &mut d),
        modules: layer.modules.clone(),
    };
    (clean, d)
}

fn kit_md(dir: &Path) -> PathBuf {
    dir.join("sets").join("kit.md")
}

/// A failed create can leave only an empty library or its empty sets folder.
fn repairable(dir: &Path) -> bool {
    let only = |d: &Path, allowed: &[&str]| fs::read_dir(d).is_ok_and(|rd| rd.flatten().all(|e| allowed.iter().any(|a| e.file_name().to_string_lossy().eq_ignore_ascii_case(a))));
    let sets = dir.join("sets");
    only(dir, &["sets"]) && (!sets.exists() || (sets.is_dir() && only(&sets, &[])))
}

fn header_value(value: &str) -> String {
    crate::rules::import::write::quote(value)
}

pub(super) fn item_text(scope: &str, kind: &str, id: &str, agent: Option<&str>, source: Option<&str>, guard: Option<&Value>) -> Result<String, String> {
    if !rune::ITEM_KINDS.contains(&kind) { return Err("Unknown Kit item kind".into()); }
    rune::check_id(id).map_err(|_| "Invalid Kit item name".to_string())?;
    let mut text = format!("---\nname: {id}\nkind: {kind}\nscope: [{scope}]\n");
    if let Some(agent) = agent { text.push_str(&format!("agent: {agent}\n")); }
    if let Some(source) = source { text.push_str(&format!("source: {}\n", header_value(source))); }
    if let Some(guard) = guard {
        let event = guard.get("event").and_then(Value::as_str).ok_or("Hook has no event")?;
        text.push_str(&format!("event: {}\n", header_value(event)));
        if let Some(matcher) = guard.get("matcher").and_then(Value::as_str) {
            text.push_str(&format!("matcher: {}\n", header_value(matcher)));
        }
        if let Some(command) = guard.get("command").and_then(Value::as_str) {
            text.push_str(&format!("command: {}\n", header_value(command)));
        } else {
            for key in ["run", "open"] {
                if let Some(paths) = guard.get(key).and_then(Value::as_array).filter(|v| !v.is_empty()) {
                    text.push_str(&format!("{key}:\n"));
                    for path in paths {
                        let path = path.as_str().ok_or("Hook path is not text")?;
                        text.push_str(&format!("  - {}\n", header_value(path)));
                    }
                }
            }
        }
    }
    text.push_str("---\n");
    // Parsing is a validation step, but its error can quote a secret header value.
    let parsed = rune::parse(&text).map_err(|_| "Invalid Kit item rune".to_string())?;
    let keys: &rune::ItemKeys = &parsed.item;
    if keys.source.as_deref() != source { return Err("Kit item source changed while encoding".into()); }
    crate::bare::rune_items::RuneItem::from_rune(&parsed).map_err(|_| "Invalid Kit item rune".to_string())?;
    Ok(text)
}

pub(super) fn mcp_text(scope: &str, id: &str, module: &str, server: &str, agent: Option<&str>) -> Result<String, String> {
    if !rune::ITEM_KINDS.contains(&"mcp") { return Err("MCP is not an item kind".into()); }
    let mut text = format!("---\nname: {id}\nkind: mcp\nscope: [{scope}]\n");
    if let Some(agent) = agent { text.push_str(&format!("agent: {agent}\n")); }
    text.push_str(&format!("module: {}\nserver: {}\n---\n", header_value(module), header_value(server)));
    let parsed = rune::parse(&text).map_err(|_| "Invalid Kit MCP rune".to_string())?;
    let keys: &rune::ItemKeys = &parsed.item;
    if keys.module.as_deref() != Some(module) || keys.server.as_deref() != Some(server) { return Err("Kit MCP fields changed while encoding".into()); }
    crate::bare::rune_items::RuneItem::from_rune(&parsed).map_err(|_| "Invalid Kit MCP rune".to_string())?;
    Ok(text)
}

pub(super) fn slug(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() { out.push(c); }
        else if !out.is_empty() && !out.ends_with('-') { out.push('-'); }
    }
    let out = out.trim_end_matches('-');
    if rune::check_id(out).is_ok() { out.to_string() } else { "item".into() }
}

pub(super) fn guard_id(g: &Value) -> String {
    let event = g.get("event").and_then(Value::as_str).unwrap_or("hook");
    let name = g.get("run").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).last()
        .map(set_layer::name_of).unwrap_or_else(|| event.to_string());
    slug(name.strip_suffix(".mjs").unwrap_or(&name))
}

pub(super) fn collect_items(clean: &SetLayerWrite) -> Vec<(&'static str, String, Option<&'static str>, Option<&str>, Option<&Value>)> {
    let mut items = Vec::new();
    for (kind, agent, list) in [
        ("skill", None, clean.skills.as_ref()), ("agent", Some("claude"), clean.agents.as_ref()),
        ("skill", Some("codex"), clean.codex_skills.as_ref()), ("agent", Some("codex"), clean.codex_agents.as_ref()),
    ] {
        for source in list.into_iter().flatten() {
            let name = set_layer::name_of(source);
            let name = if kind == "agent" { name.strip_suffix(".md").or_else(|| name.strip_suffix(".toml")).unwrap_or(&name) } else { &name };
            items.push((kind, slug(name), agent, Some(source.as_str()), None));
        }
    }
    for (agent, list) in [(Some("claude"), clean.guards.as_ref()), (Some("codex"), clean.codex_guards.as_ref())] {
        for guard in list.into_iter().flatten() {
            items.push(("hook", guard_id(guard), agent, None, Some(guard)));
        }
    }
    items
}

/// The non-MCP runes a selected module contributes. Paths stay rooted at the install instead of
/// depending on a launcher row or a sidecar resolver at session start.
pub(super) struct ModuleItem {
    pub kind: &'static str,
    pub id: String,
    pub source: Option<String>,
    pub guard: Option<Value>,
}

pub(super) fn module_items(bundle: &super::bundles::Bundle, tick: &super::bundles::ModuleTick) -> Vec<ModuleItem> {
    let off = &tick.off;
    let mut out = Vec::new();
    for (kind, paths) in [("skill", &bundle.skills), ("agent", &bundle.agents)] {
        for path in paths {
            let name = set_layer::name_of(path);
            if off.contains(&format!("{kind}:{name}")) { continue; }
            let name = if kind == "agent" { name.strip_suffix(".md").or_else(|| name.strip_suffix(".toml")).unwrap_or(&name) } else { &name };
            out.push(ModuleItem { kind, id: slug(name), source: Some(format!("{{{{root}}}}/{path}")), guard: None });
        }
    }
    for guard in &bundle.guards {
        if off.contains(&super::bundles::guard_key(guard)) { continue; }
        let value = serde_json::json!({
            "event": guard.event,
            "matcher": guard.matcher,
            "run": guard.run.iter().map(|p| format!("{{{{root}}}}/{p}")).collect::<Vec<_>>(),
        });
        out.push(ModuleItem { kind: "hook", id: guard_id(&value), source: None, guard: Some(value) });
    }
    out
}

/// Writes one new file (`create_new`); a failed write removes what it created.
type Writer<'a> = &'a dyn Fn(&Path, &str) -> Result<(), String>;

pub(super) fn write_new(path: &Path, text: &str) -> Result<(), String> {
    let mut out = OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| "Cannot create Kit rune file".to_string())?;
    if out.write_all(text.as_bytes()).is_err() {
        drop(out);
        let _ = fs::remove_file(path);
        return Err("Cannot write Kit rune file".into());
    }
    Ok(())
}

pub(crate) fn create_at(imports: &Path, layer: &SetLayerWrite, home: Option<&Path>) -> Result<KitCreated, String> {
    create_with(imports, layer, home, &write_new)
}

fn create_with(imports: &Path, layer: &SetLayerWrite, home: Option<&Path>, write: Writer) -> Result<KitCreated, String> {
    fs::create_dir_all(imports).map_err(|e| format!("Rune imports unavailable: {e}"))?;
    let dir = imports.join(LIB);
    let made_dir = match fs::create_dir(&dir) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if kit_md(&dir).is_file() {
                return Ok(KitCreated { created: false, dropped: Vec::new() });
            }
            if !dir.is_dir() || !repairable(&dir) {
                return Err("Library kit already exists without a kit set; Add Kit refused".into());
            }
            false
        }
        Err(e) => return Err(format!("Cannot create {}: {e}", dir.display())),
    };
    let (clean, mut dropped) = check_items(layer, home);
    let mut plan = Vec::new();
    let mut slots = Vec::new();
    let mut used = BTreeSet::new();
    for (kind, base, agent, source, guard) in collect_items(&clean) {
        let mut id = base.clone();
        let mut n = 2;
        while !used.insert(id.clone()) {
            id = format!("{base}-{n}");
            n += 1;
        }
        match item_text(LIB, kind, &id, agent, source, guard) {
            Ok(text) => {
                let sub = format!("{}s", kind);
                plan.push((dir.join(&sub).join(format!("{id}.md")), text));
                slots.push(format!("<?rune {id}?>\n"));
            }
            Err(reason) => dropped.push(Dropped { id: format!("{kind}/{id}"), reason }),
        }
    }
    if let Some(modules) = &clean.modules {
        let (catalog, _) = super::bundles::load(&crate::paths::root());
        for (module, tick) in modules {
            let Some(bundle) = catalog.bundles.get(module) else {
                dropped.push(Dropped { id: format!("module/{module}"), reason: "Unknown Kit module".into() });
                continue;
            };
            for mcp in &bundle.mcp {
                if tick.off.iter().any(|off| off == &format!("mcp:{}", mcp.name)) { continue; }
                let base = slug(&format!("{module}-{}", mcp.name));
                let mut id = base.clone();
                let mut n = 2;
                while !used.insert(id.clone()) { id = format!("{base}-{n}"); n += 1; }
                let agent = (mcp.agents.len() == 1).then(|| mcp.agents[0].as_str());
                match mcp_text(LIB, &id, module, &mcp.name, agent) {
                    Ok(text) => { plan.push((dir.join("mcp").join(format!("{id}.md")), text)); slots.push(format!("<?rune {id}?>\n")); }
                    Err(reason) => dropped.push(Dropped { id: format!("mcp/{id}"), reason }),
                }
            }
            for item in module_items(bundle, tick) {
                let base = item.id;
                let mut id = base.clone();
                let mut n = 2;
                while !used.insert(id.clone()) { id = format!("{base}-{n}"); n += 1; }
                match item_text(LIB, item.kind, &id, None, item.source.as_deref(), item.guard.as_ref()) {
                    Ok(text) => { plan.push((dir.join(format!("{}s", item.kind)).join(format!("{id}.md")), text)); slots.push(format!("<?rune {id}?>\n")); }
                    Err(reason) => dropped.push(Dropped { id: format!("{}/{id}", item.kind), reason }),
                }
            }
        }
    }
    let mut made = Vec::new();
    let result = (|| {
        for (path, text) in &plan {
            fs::create_dir_all(path.parent().ok_or("Kit item has no folder")?).map_err(|_| "Cannot create Kit item folder".to_string())?;
            write(path, text)?;
            made.push(path.clone());
        }
        fs::create_dir_all(dir.join("sets")).map_err(|_| "Cannot create Kit set folder".to_string())?;
        let md = kit_md(&dir);
        write(&md, &format!("{KIT_MD}{}", slots.concat()))?;
        made.push(md);
        Ok::<(), String>(())
    })();
    if let Err(e) = result {
        for path in made { let _ = fs::remove_file(path); }
        for sub in ["skills", "agents", "hooks", "mcp", "sets"] { let _ = fs::remove_dir(dir.join(sub)); }
        if made_dir {
            let _ = fs::remove_dir_all(&dir);
        }
        return Err(e);
    }
    Ok(KitCreated { created: true, dropped })
}

/// `library`'s folder under `imports` (not canonicalised), refused when its name or its real place is wrong.
pub(super) fn library_dir(imports: &Path, library: &str) -> Result<PathBuf, String> {
    rune::check_id(library).map_err(|_| format!("Library {library:?} is not a library name"))?;
    let outside = || format!("Library {library} has no folder under {}", imports.display());
    let base = imports.canonicalize().map_err(|_| outside())?;
    let dir = imports.join(library);
    let real = dir.canonicalize().map_err(|_| outside())?;
    if !real.is_dir() || !real.starts_with(&base) {
        return Err(outside());
    }
    Ok(dir)
}

pub(crate) fn item_create_at(imports: &Path, library: &str, agent: &str, kind: &str, name: &str, _home: Option<&Path>) -> Result<LibraryFile, String> {
    rune::check_id(name).map_err(|_| format!("Invalid Name `{name}`: lowercase letters, digits and single hyphens"))?;
    if !matches!(agent, "claude" | "codex") {
        return Err(format!("Agent {agent:?} is not claude or codex"));
    }
    let dir = library_dir(imports, library)?;
    let file = match kind {
        "skill" => dir.join("skills").join(format!("{name}.md")),
        "agent" => dir.join("agents").join(format!("{name}.md")),
        "hook" => dir.join("hooks").join(format!("{name}.md")),
        _ => return Err(format!("Kind {kind:?} is not skill, agent or hook")),
    };
    if kind == "agent" && RESERVED_AGENTS.contains(&name) {
        return Err(format!("{name} is a built-in Codex role name"));
    }
    if file.exists() || files_at(imports, library)?.iter().any(|item| item.name == name) {
        return Err(format!("{name} already exists"));
    }
    let parent = file.parent().ok_or("Template has no folder")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create item rune folder".to_string())?;
    let agent_key = (agent == "codex" || kind == "agent").then_some(agent);
    let mut text = match kind {
        "hook" => item_text(LIB, kind, name, agent_key, None, Some(&serde_json::json!({"event":"PreToolUse", "run": ["{{root}}/replace-with-hook.mjs"]})))?,
        _ => item_text(LIB, kind, name, agent_key, Some("{{root}}/replace-with-item-path"), None)?,
    };
    text.push_str("\nDescribe this item here.\n");
    let mut out = match OpenOptions::new().write(true).create_new(true).open(&file) {
        Ok(f) => f,
        Err(_) => return Err("Cannot create item rune".into()),
    };
    if out.write_all(text.as_bytes()).is_err() {
        drop(out);
        let _ = fs::remove_file(&file);
        return Err("Cannot write item rune".into());
    }
    Ok(LibraryFile { kind: kind.into(), agent: agent_key.map(str::to_string), name: name.into(), path: file.to_string_lossy().into_owned() })
}

pub(crate) fn files_at(imports: &Path, library: &str) -> Result<Vec<LibraryFile>, String> {
    let dir = library_dir(imports, library)?;
    let mut out = Vec::new();
    let entries = |sub: &str| fs::read_dir(dir.join(sub)).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| !t.is_symlink()));
    let row = |kind: &str, agent: Option<&str>, name: String, path: PathBuf| LibraryFile { kind: kind.into(), agent: agent.map(str::to_string), name, path: path.to_string_lossy().into_owned() };
    for (sub, kind) in [("skills", "skill"), ("agents", "agent"), ("hooks", "hook")] {
        for e in entries(sub) {
            let p = e.path();
            if !p.is_file() || p.extension().is_none_or(|x| !x.eq_ignore_ascii_case("md")) { continue }
            let Ok(text) = fs::read_to_string(&p) else { continue };
            let Ok(parsed) = rune::parse(&text) else { continue };
            if parsed.kind != kind { continue }
            out.push(row(kind, parsed.agent.as_deref(), parsed.id, p));
        }
    }
    out.sort_by(|a, b| (&a.kind, &a.name, &a.agent).cmp(&(&b.kind, &b.name, &b.agent)));
    Ok(out)
}

/// Makes the Kit library and set from `layer` (the Runes tab's Add Kit); see the module header.
#[tauri::command]
pub fn bare_kit_create(layer: SetLayerWrite) -> Result<KitCreated, String> {
    create_at(&crate::paths::rune_imports_dir(), &layer, crate::paths::home().as_deref())
}

/// Writes a skill, agent or hook template into `library`, unticked.
#[tauri::command]
pub fn bare_kit_item_create(library: String, agent: String, kind: String, name: String) -> Result<LibraryFile, String> {
    item_create_at(&crate::paths::rune_imports_dir(), &library, &agent, &kind, &name, crate::paths::home().as_deref())
}

/// The template files of `library`: its `skills\`, `agents\` and `hooks\`.
#[tauri::command]
pub fn bare_library_files(library: String) -> Result<Vec<LibraryFile>, String> {
    files_at(&crate::paths::rune_imports_dir(), &library)
}

#[cfg(test)]
#[path = "kit_tests.rs"]
mod tests;
