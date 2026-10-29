//! src-tauri\src\bare\vault\migrate_items.rs — the startup migration's sidecar conversion (split from `migrate.rs` for the module-size cap). A sidecar
//! (`sets\<set>.layer.json`) plus the retired home-wide `bare*` lists become item rune texts and set
//! slots; `migrate.rs` places them in the library. Absorbs `fold_migrate.rs`'s conversion.
//!
//! Ids are the item's own name, as Add Kit (`bare/kit.rs` `collect_items`) names the same item (run
//! M1): a skill's folder name, an agent's file name without `.md`/`.toml`, a hook's last `run`
//! script without `.mjs` (its event when it has none), `<module>-<server>` for an MCP server and
//! `permissions`, each slugged; a clash takes `-2`, `-3` (`migrate.rs` `place`). The Runes view
//! titles a rune by its id (`src/runes/cards.ts` `runeName`), so the id is what it shows. Items come
//! in the order skills, codexSkills, agents, codexAgents, guards, codexGuards, module servers,
//! permissions. An entry on both agents' lists is one rune with no `agent:` tag (its Codex copy is
//! dropped), an entry on one list only is tagged with that agent, and values are written quoted.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::agent_spec::Agent;
use crate::bare::bundles::{Bundles, SetModules};
use crate::bare::{layer, set_layer};

const SIDECAR_KEYS: &[&str] = &["skills", "agents", "guards", "codexSkills", "codexAgents", "codexGuards", "modules", "permissions", "outputStyle"];

/// The retired keys' lists, merged into every target sidecar.
#[derive(Default)]
pub(super) struct Retired {
    pub lists: BTreeMap<&'static str, Vec<Value>>,
}

/// One planned item rune: its base id (the item's own name, slugged), kind folder, kind, one-agent
/// tag, header lines after `agent:`.
pub(super) struct Item {
    pub name: String,
    pub folder: &'static str,
    pub kind: &'static str,
    pub agent: Option<&'static str>,
    pub keys: Vec<String>,
}

/// `value` as a rune id, as `bare/kit.rs` `slug` makes it: lowercase ASCII letters and digits, any
/// other run one `-`; `item` when that is no valid id.
pub(super) fn slug(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if crate::rules::rune::check_id(out).is_ok() { out.to_string() } else { "item".into() }
}

fn quote(v: &str) -> Result<String, String> {
    if v.contains(['\n', '\r']) {
        return Err("a value holds a line break".into());
    }
    Ok(format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\"")))
}

fn scalar(key: &str, v: &str) -> Result<String, String> {
    Ok(format!("{key}: {}", quote(v)?))
}

fn block(key: &str, items: &[String]) -> Result<Vec<String>, String> {
    let mut out = vec![format!("{key}:")];
    for i in items {
        out.push(format!("  - {}", quote(i)?));
    }
    Ok(out)
}

pub(super) fn rune_text(id: &str, it: &Item, _origin: &str) -> String {
    let mut t = format!("---\nname: {id}\nkind: {}\nscope: [global]\n", it.kind);
    if let Some(a) = it.agent {
        t.push_str(&format!("agent: {a}\n"));
    }
    for k in &it.keys {
        t.push_str(k);
        t.push('\n');
    }
    t.push_str("---\n");
    t
}

pub(super) fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn values(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// What `build` returns: base id, folder, kind, header lines.
type Built = (String, &'static str, &'static str, Vec<String>);

fn path_item(folder: &'static str, kind: &'static str, path: &str) -> Result<Built, String> {
    let name = set_layer::name_of(path);
    let name = if kind == "agent" { name.strip_suffix(".md").or_else(|| name.strip_suffix(".toml")).unwrap_or(&name) } else { &name };
    Ok((slug(name), folder, kind, vec![scalar("source", path)?]))
}

fn guard_item(g: &Value) -> Result<Built, String> {
    let o = g.as_object().ok_or("a guard is not an object")?;
    if let Some(k) = o.keys().find(|k| !["event", "matcher", "run", "open", "command"].contains(&k.as_str())) {
        return Err(format!("a guard carries `{k}`, which no hook rune holds"));
    }
    let event = o.get("event").and_then(Value::as_str).filter(|e| !e.trim().is_empty()).ok_or("a guard has no event")?;
    let matcher = o.get("matcher").and_then(Value::as_str);
    let run = strings(o.get("run"));
    let open = strings(o.get("open"));
    // As `kit.rs` `guard_id`: the last run script's name, else the event.
    let last = run.last().map(|p| set_layer::name_of(p)).unwrap_or_else(|| event.to_string());
    let name = slug(last.strip_suffix(".mjs").unwrap_or(&last));
    let mut keys = vec![scalar("event", event)?];
    if let Some(m) = matcher {
        keys.push(scalar("matcher", m)?);
    }
    if let Some(cmd) = o.get("command").and_then(Value::as_str) {
        // The command is a secret: its error never quotes it.
        keys.push(format!("command: {}", quote(cmd).map_err(|_| "a command hook holds a line break".to_string())?));
    } else if run.is_empty() {
        return Err("a guard has no run files".into());
    }
    if !run.is_empty() {
        keys.extend(block("run", &run)?);
    }
    if !open.is_empty() {
        keys.extend(block("open", &open)?);
    }
    Ok((name, "hooks", "hook", keys))
}

fn mcp_item(module: &str, server: &str) -> Result<Built, String> {
    Ok((slug(&format!("{module}-{server}")), "mcp", "mcp", vec![scalar("module", module)?, scalar("server", server)?]))
}

/// Collects items in order.
struct Acc<'a> {
    out: Vec<Item>,
    ok: bool,
    label: &'a str,
    warnings: &'a mut Vec<String>,
}

impl Acc<'_> {
    fn fail(&mut self, e: String) {
        self.warnings.push(format!("{}: {e}; the sidecar stays", self.label));
        self.ok = false;
    }
    /// `None` drops the entry (a Codex copy of a shared one).
    fn push(&mut self, built: Option<(Result<Built, String>, Option<&'static str>)>) {
        match built {
            None => {}
            Some((Ok((name, folder, kind, keys)), agent)) => self.out.push(Item { name, folder, kind, agent, keys }),
            Some((Err(e), _)) => self.fail(e),
        }
    }
    /// One kind's lists in table order (the sidecar keeps one per agent, the first agent's under the
    /// plain key): shared names untagged once, one-side names tagged. A third agent fails to compile here.
    fn pair<T>(&mut self, lists: [&[T]; 2], later_names: &BTreeSet<String>, name: impl Fn(&T) -> String, build: impl Fn(&T) -> Result<Built, String>) {
        let [first_agent, later_agent] = crate::agent_spec::ALL;
        let [first, later] = lists;
        let seen_first: BTreeSet<String> = first.iter().map(&name).collect();
        let mut seen = BTreeSet::new();
        for c in first {
            let tag = (!later_names.contains(&name(c))).then(|| first_agent.as_str());
            let fresh = seen.insert(name(c));
            self.push(fresh.then(|| (build(c), tag)));
        }
        for c in later {
            let fresh = !seen_first.contains(&name(c)) && seen.insert(name(c));
            self.push(fresh.then(|| (build(c), Some(later_agent.as_str()))));
        }
    }
}

/// The items of one sidecar object plus the retired keys' entries. Bad entries are warnings; the
/// second value says every entry converted (the sidecar may then be deleted).
pub(super) fn items_of(obj: &Map<String, Value>, retired: &Retired, catalog: &Bundles, label: &str, warnings: &mut Vec<String>) -> (Vec<Item>, bool) {
    let mut acc = Acc { out: Vec::new(), ok: true, label, warnings };
    // The sidecar's second-agent keys (`codex*`) and its one output style, read through the table.
    let [_, later_agent] = crate::agent_spec::ALL;
    let style_agent = crate::agent_spec::ALL.into_iter().find(|a| crate::agent_spec::spec(*a).carries.output_style.is_none());
    let extra = |k: &str| retired.lists.get(k).cloned().unwrap_or_default();
    let with = |base: Vec<String>, k: &str| -> Vec<String> { base.into_iter().chain(extra(k).iter().filter_map(Value::as_str).map(str::to_string)).collect() };
    let names = |v: &[String]| -> BTreeSet<String> { v.iter().map(|p| set_layer::name_of(p)).collect() };

    // Skills: Codex reads codexSkills when set, else the Claude list.
    let skills = with(strings(obj.get("skills")), "skills");
    let own_list = obj.get("codexSkills").is_some_and(|v| !v.is_null());
    let codex_skills = with(strings(obj.get("codexSkills")), "codexSkills");
    let mine = names(&codex_skills);
    let later_names: BTreeSet<String> = match own_list {
        true => mine,
        false => names(&skills).into_iter().chain(mine).collect(),
    };
    acc.pair([&skills, &codex_skills], &later_names, |p| set_layer::name_of(p), |p| path_item("skills", "skill", p));

    let agents = with(strings(obj.get("agents")), "agents");
    let codex_agents = with(strings(obj.get("codexAgents")), "codexAgents");
    acc.pair([&agents, &codex_agents], &names(&codex_agents), |p| set_layer::name_of(p), |p| path_item("agents", "agent", p));

    let gs: Vec<Value> = values(obj.get("guards")).into_iter().chain(extra("guards")).collect();
    let cgs: Vec<Value> = values(obj.get("codexGuards")).into_iter().chain(extra("codexGuards")).collect();
    let cg_names: BTreeSet<String> = cgs.iter().map(set_layer::guard_name).collect();
    acc.pair([&gs, &cgs], &cg_names, set_layer::guard_name, guard_item);

    // Module servers in the sidecar's own order (a bundle limited to one agent tags its rune).
    let mut servers: Vec<String> = Vec::new();
    if let Some(m) = obj.get("modules").filter(|v| !v.is_null()) {
        match (serde_json::from_value::<SetModules>(m.clone()), m.as_object()) {
            (Ok(_), Some(modules)) => {
                for (module, tick) in modules {
                    let Some(b) = catalog.bundles.get(module) else {
                        acc.fail(format!("module {module:?} is in no module bundle"));
                        continue;
                    };
                    let off = strings(tick.get("off"));
                    for s in b.mcp.iter().filter(|s| !off.contains(&format!("mcp:{}", s.name))) {
                        if let Some(tag) = crate::bare::bundles::unknown_tag(s) {
                            acc.fail(format!("module {module:?} server {:?} names unknown agent {tag:?} in module-bundles.json; skipped", s.name));
                            continue;
                        }
                        let only = match s.agents.as_slice() {
                            [a] => crate::agent_spec::parse(a).map(|a| a.as_str()),
                            _ => None,
                        };
                        servers.push(s.name.clone());
                        acc.push(Some((mcp_item(module, &s.name), only)));
                    }
                    for path in &b.skills {
                        let source = format!("{{{{root}}}}/{path}");
                        let name = set_layer::name_of(path);
                        if !off.contains(&format!("skill:{name}")) {
                            acc.push(Some((path_item("skills", "skill", &source), None)));
                        }
                    }
                    for path in &b.agents {
                        let source = format!("{{{{root}}}}/{path}");
                        let name = set_layer::name_of(path);
                        if !off.contains(&format!("agent:{name}")) {
                            acc.push(Some((path_item("agents", "agent", &source), None)));
                        }
                    }
                    for guard in &b.guards {
                        if off.contains(&crate::bare::bundles::guard_key(guard)) { continue; }
                        let value = serde_json::json!({
                            "event": guard.event,
                            "matcher": guard.matcher,
                            "run": guard.run.iter().map(|p| format!("{{{{root}}}}/{p}")).collect::<Vec<_>>(),
                        });
                        acc.push(Some((guard_item(&value), None)));
                    }
                }
            }
            (Err(e), _) => acc.fail(format!("`modules` is not an object of module ticks ({e})")),
            (Ok(_), None) => acc.fail("`modules` is not an object".into()),
        }
    }
    for n in extra("codexMcp") {
        let name = n.as_str().unwrap_or_default();
        match catalog.bundles.iter().find_map(|(m, b)| b.mcp.iter().find(|s| s.name.eq_ignore_ascii_case(name)).map(|s| (m.clone(), s.name.clone()))) {
            Some((m, s)) => {
                let fresh = !servers.contains(&s);
                servers.push(s.clone());
                acc.push(fresh.then(|| (mcp_item(&m, &s), Some(later_agent.as_str()))));
            }
            None => acc.fail(format!("server {name:?} is in no module bundle")),
        }
    }

    if let Some(p) = obj.get("permissions").filter(|v| !v.is_null()) {
        match serde_json::from_value::<set_layer::Permissions>(p.clone()) {
            Ok(p) if p.allow.is_empty() && p.ask.is_empty() && p.mode.is_none() => {}
            Ok(p) => {
                let built = (|| -> Result<Built, String> {
                    let mut keys = Vec::new();
                    if !p.allow.is_empty() {
                        keys.extend(block("allow", &p.allow)?);
                    }
                    if !p.ask.is_empty() {
                        keys.extend(block("ask", &p.ask)?);
                    }
                    if let Some(m) = &p.mode {
                        keys.push(scalar("mode", m)?);
                    }
                    Ok(("permissions".to_string(), "permissions", "permission", keys))
                })();
                acc.push(Some((built, None)));
            }
            Err(e) => acc.fail(format!("`permissions` is not {{ allow?, ask?, mode? }} ({e})")),
        }
    }
    if let Some(style) = obj.get("outputStyle").filter(|v| !v.is_null()) {
        match style.as_str().filter(|s| !s.trim().is_empty()) {
            Some(s) => acc.push(Some((scalar("style", s).map(|line| (slug(s), "styles", "output-style", vec![line])), style_agent.map(Agent::as_str)))),
            None => acc.fail("`outputStyle` is not a nonempty string".into()),
        }
    }
    for k in obj.keys().filter(|k| !SIDECAR_KEYS.contains(&k.as_str())) {
        acc.fail(format!("unknown key `{k}`"));
    }
    (acc.out, acc.ok)
}

pub(super) fn slots_of(text: &str) -> BTreeSet<String> {
    text.lines().filter_map(|l| layer::slot_id(l.trim_end())).map(str::to_string).collect()
}

pub(super) fn append_slots(text: &mut String, ids: &[String]) {
    let have = slots_of(text);
    let new: Vec<&String> = ids.iter().filter(|i| !have.contains(*i)).collect();
    if new.is_empty() {
        return;
    }
    let crlf = text.contains("\r\n");
    let nl = if crlf { "\r\n" } else { "\n" };
    if !text.ends_with('\n') {
        text.push_str(nl);
    }
    text.push_str(nl);
    for id in new {
        text.push_str(&format!("- <?rune {id}?>{nl}"));
    }
}

pub(super) fn remove_slots(text: &str, ids: &BTreeSet<String>) -> String {
    text.split_inclusive('\n').filter(|l| !layer::slot_id(l.trim_end()).is_some_and(|id| ids.contains(id))).collect()
}

/// `text` with `old` in its header `scope: [..]` list replaced by `new` (a renamed generation
/// library's sets name the library in their scope); any other text stays byte for byte.
pub(super) fn rescope_header(text: &str, old: &str, new: &str) -> String {
    let mut out = String::new();
    let mut in_header = false;
    for (i, l) in text.split_inclusive('\n').enumerate() {
        let bare = l.trim_end();
        if i == 0 && bare == "---" {
            in_header = true;
        } else if in_header && bare == "---" {
            in_header = false;
        } else if in_header {
            let list = bare.strip_prefix("scope:").map(str::trim).and_then(|v| v.strip_prefix('[')).and_then(|v| v.strip_suffix(']'));
            if let Some(list) = list {
                let items: Vec<&str> = list.split(',').map(str::trim).collect();
                if items.contains(&old) {
                    let items: Vec<&str> = items.into_iter().map(|s| if s == old { new } else { s }).collect();
                    out.push_str(&format!("scope: [{}]{}", items.join(", "), &l[bare.len()..]));
                    continue;
                }
            }
        }
        out.push_str(l);
    }
    out
}

/// `text` with its header `name:` set to `name`.
pub(super) fn rename_header(text: &str, name: &str) -> String {
    let mut out = String::new();
    let mut in_header = false;
    let mut done = false;
    for (i, l) in text.split_inclusive('\n').enumerate() {
        let bare = l.trim_end();
        if i == 0 && bare == "---" {
            in_header = true;
        } else if in_header && bare == "---" {
            in_header = false;
        } else if in_header && !done && bare.starts_with("name:") {
            out.push_str(&format!("name: {name}{}", &l[bare.len()..]));
            done = true;
            continue;
        }
        out.push_str(l);
    }
    out
}
