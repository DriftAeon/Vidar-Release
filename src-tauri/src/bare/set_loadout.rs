//! src-tauri\src\bare\set_loadout.rs — one resolver from picked rune sets to what a spawn carries
//! `resolve` reads distinct set refs in pick order and their Bare runes (no sidecars, bundles or
//! overrides: a launch loads only what the vault holds). Invalid refs and unreadable inputs become warnings; the launch owns all writes.
#![allow(dead_code)] // W2's launch paths and W3's View adopt `resolve`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::layer::{self, RowSets, SetRef};
use super::recall_skill;
use super::set_layer::{self, Permissions};
use crate::agent_spec;
use crate::falcon::Agent;
use crate::rules::{context::RenderCtx, library::Library, rune::State};

/// The machine paths `resolve` reads: the install root, vidar.json, the agent's Bare home and the
/// user's home for any rune source that needs expansion.
pub(crate) struct ResolveEnv<'a> {
    pub root: &'a Path,
    pub config: &'a Path,
    pub home: &'a Path,
    pub user_home: Option<&'a Path>,
}

/// One rune a loadout names: its library (absent = `rulesLibrary`), id and kind.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuneRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    pub id: String,
    pub kind: String,
}

/// An item the agent cannot carry: its kind (`guard`, or a rune kind such as `permission`, `output-style`, `mcp`),
/// the item (a rune id where there is one) and why. Rendered by `src/runes/not-carried.ts`.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Unsupported {
    pub kind: String,
    pub item: String,
    pub reason: String,
}

/// Everything a spawn of these sets carries for one agent.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Loadout {
    /// Slots that are on at spawn (`activate: always`; `paths` when delivery is disabled).
    pub rules: Vec<RuneRef>,
    /// Recall members, recall and paths slots, then procedures, in set order.
    pub on_demand: Vec<RuneRef>,
    /// Skill and agent sources (absolute paths), deduped by file or folder name.
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    /// Guards by name (`event|matcher|run file names`, `set_layer::guard_name`).
    pub guards: Vec<String>,
    /// MCP server names after module expansion, deduped, pick order.
    pub mcp: Vec<String>,
    pub permissions: Permissions,
    pub output_style: Option<super::rune_items::OutputStyle>,
    /// The first model rune for this agent; nothing writes it yet (run runes-gaps G2 does).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub unsupported: Vec<Unsupported>,
    /// Plugin rune folders, absolute (`<root>\plugins\<name>`); a vault spawn only (L2b passes them).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<String>,
    /// hash12 of the canonical JSON of every field above.
    pub hash: String,
    /// The guard objects behind `guards` (`{ event, matcher?, run, open? }`, paths absolute), same order;
    /// the launch copies them and the manifest records them. Not on the wire and not hashed.
    #[serde(skip)]
    pub guard_items: Vec<Value>,
    /// Read-only source content for the generated on-demand skill.
    #[serde(skip)]
    pub(super) recall_skill: recall_skill::Draft,
    /// Rune ids deliberately left out of delivery, reported only in manifests.
    #[serde(skip)]
    pub shadow: Vec<String>,
    /// Set resolution failures that must refuse the launch.
    #[serde(skip)]
    pub refusals: Vec<String>,
    /// Item runes' `env:` entries (values are secrets; never logged). A vault spawn only (L2b sets them).
    #[serde(skip)]
    pub env: Vec<(String, crate::rules::rune::Secret)>,
}

/// The one Not Carried warning line, for a launch's `Loadout.unsupported` row.
pub(super) fn not_carried(agent: Agent, u: &Unsupported) -> String {
    format!("{} {} Not Carried by {}: {}", u.kind, u.item, agent_label(agent), u.reason)
}

fn agent_label(agent: Agent) -> &'static str {
    agent_spec::spec(agent).label
}

/// `rulesLibrary` from vidar.json, read-only; a missing file or key is none, an unreadable one a warning.
pub(super) fn rules_library(config: &Path, warnings: &mut Vec<String>) -> Option<String> {
    let text = match crate::fsx::read_text(config) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            warnings.push(format!("vidar.json {} is unreadable ({e}); rulesLibrary sets skipped", config.display()));
            return None;
        }
    };
    match serde_json::from_str::<Value>(crate::fsx::strip_bom(&text)) {
        Ok(v) => v.get("rulesLibrary").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        Err(e) => {
            warnings.push(format!("vidar.json {} is unreadable ({e}); rulesLibrary sets skipped", config.display()));
            None
        }
    }
}

fn push_name(into: &mut Vec<String>, item: String, key: &dyn Fn(&str) -> String) {
    if !into.iter().any(|o| key(o.as_str()) == key(item.as_str())) {
        into.push(item);
    }
}

fn push_rune(into: &mut Vec<RuneRef>, r: RuneRef) {
    if !into.iter().any(|o| o.library == r.library && o.id == r.id) {
        into.push(r);
    }
}

fn push_unsupported(into: &mut Vec<Unsupported>, kind: &str, item: &str, reason: String) {
    if !into.iter().any(|u| u.kind == kind && u.item == item) {
        into.push(Unsupported { kind: kind.into(), item: item.into(), reason });
    }
}

/// One distinct set ref with what the rune pass needs.
struct Picked {
    r: SetRef,
    dir: PathBuf,
}

/// The loadout `sets` (row sets then add-ons, as launch passes them) give `agent`, and the warnings.
pub(crate) fn resolve(env: &ResolveEnv, agent: Agent, sets: &[SetRef]) -> (Loadout, Vec<String>) {
    resolve_with_delivery(env, agent, sets, crate::rules::set::BARE_SKILL_DELIVERY)
}

pub(super) fn resolve_with_delivery(env: &ResolveEnv, agent: Agent, sets: &[SetRef], skill_delivery: bool) -> (Loadout, Vec<String>) {
    let mut warnings = Vec::new();
    let row = RowSets { sets: Vec::new(), rules_library: rules_library(env.config, &mut warnings) };
    let mut out = Loadout::default();
    let mut picked: Vec<Picked> = Vec::new();
    for r in sets {
        if picked.iter().any(|p| p.r == *r) {
            continue;
        }
        let dir = match layer::library_dir(env.root, &row, r) {
            Ok(d) => d,
            Err(e) => {
                warnings.push(format!("Set {:?}: not read ({e})", r.set));
                continue;
            }
        };
        // A `<set>.layer.json` beside the set is not read: a launch loads only the runes of its vault.
        picked.push(Picked { r: r.clone(), dir });
    }
    let ask = out.permissions.ask.clone();
    out.permissions.allow.retain(|a| !ask.contains(a));
    drop_unsupported(agent, &mut out);
    out.guards = out.guard_items.iter().map(set_layer::guard_name).collect();
    // The hooks this loadout carries: a rune `enforced-by` another file is left out (Bare context).
    let carried: BTreeSet<String> = out
        .guard_items
        .iter()
        .flat_map(|g| g.get("run").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|p| p.as_str().and_then(|s| Path::new(s).file_name()).map(|n| n.to_string_lossy().into_owned()))
        .collect();
    let ctx = RenderCtx::bare(carried);
    let mut libs: Vec<(PathBuf, Library)> = Vec::new();
    for p in &picked {
        let i = match libs.iter().position(|(d, _)| *d == p.dir) {
            Some(i) => i,
            None => match Library::open(&p.dir) {
                Ok(lib) => {
                    libs.push((p.dir.clone(), lib));
                    libs.len() - 1
                }
                Err(e) => {
                    warnings.push(format!("Set {:?}: {e}; its runes skipped", p.r.set));
                    continue;
                }
            },
        };
        runes_of(&libs[i].1, p, &ctx, skill_delivery, &mut out, &mut warnings);
    }
    out.hash = hash_of(&out);
    (out, warnings)
}

/// What `agent` cannot carry leaves the lists, each as a Not Carried row from its spec: command
/// guards it cannot run (a `run`/`open` guard was already checked by `map_item`, which checks every
/// hook, so the skip is the same for every agent), per-tool permissions, a permission mode and an
/// output style.
fn drop_unsupported(agent: Agent, out: &mut Loadout) {
    let carries = &agent_spec::spec(agent).carries;
    let mut kept = Vec::new();
    for g in std::mem::take(&mut out.guard_items) {
        if g.get("command").is_none() {
            kept.push(g);
            continue;
        }
        let event = g.get("event").and_then(Value::as_str).unwrap_or("");
        match (carries.guard)(event, g.get("matcher").and_then(Value::as_str)) {
            Some(reason) => push_unsupported(&mut out.unsupported, "guard", &set_layer::guard_name(&g), reason),
            None => kept.push(g),
        }
    }
    out.guard_items = kept;
    let keep_list = |list: Vec<String>, unsupported: &mut Vec<Unsupported>| -> Vec<String> {
        let mut kept = Vec::new();
        for p in list {
            match (carries.permission)(std::slice::from_ref(&p), None).refused {
                Some(reason) => push_unsupported(unsupported, "permission", &p, reason),
                None => kept.push(p),
            }
        }
        kept
    };
    out.permissions.allow = keep_list(std::mem::take(&mut out.permissions.allow), &mut out.unsupported);
    out.permissions.ask = keep_list(std::mem::take(&mut out.permissions.ask), &mut out.unsupported);
    if let Some(mode) = out.permissions.mode.take() {
        match (carries.permission)(&[], Some(&mode)).refused {
            Some(reason) => push_unsupported(&mut out.unsupported, "permission", &mode, reason),
            None => out.permissions.mode = Some(mode),
        }
    }
    if let Some(why) = carries.output_style {
        if let Some(style) = out.output_style.take() {
            push_unsupported(&mut out.unsupported, "output-style", &style.id, why.into());
        }
    }
}

/// One set's runes: slots on at spawn into `rules`, recall members, recall slots and procedures into `on_demand`.
fn runes_of(lib: &Library, p: &Picked, ctx: &RenderCtx, skill_delivery: bool, out: &mut Loadout, warnings: &mut Vec<String>) {
    let label = p.r.library.as_deref().unwrap_or("rulesLibrary");
    let set = match lib.entry(&p.r.set) {
        Ok(Some(e)) if e.kind == "set" => lib.load(&e),
        Ok(Some(e)) => Err(format!("`{}` is a {}, not a set", p.r.set, e.kind)),
        Ok(None) => Err(format!("`{}` is not in {label}", p.r.set)),
        Err(e) => Err(e),
    };
    let set = match set {
        Ok(s) if lib.tombstone(&p.r.set).is_none() => s,
        Ok(_) => return warnings.push(format!("Set `{}` in {label} is tombstoned; its runes skipped", p.r.set)),
        Err(e) => return warnings.push(format!("Set `{}`: {e}; its runes skipped", p.r.set)),
    };
    if set.state != State::Active || !ctx.keeps(&set) {
        return;
    }
    let rune_ref = |id: &str, kind: &str| RuneRef { library: p.r.library.clone(), id: id.into(), kind: kind.into() };
    let mut recalled = false;
    for line in set.body.lines() {
        if line.trim_end_matches('\r') == "<?recall?>" {
            if recalled {
                continue;
            }
            recalled = true;
            let (members, w) = crate::rules::set::recall_members_in(lib, &set, ctx);
            warnings.extend(w);
            for m in &members {
                push_rune(&mut out.on_demand, rune_ref(&m.id, &m.kind));
                if skill_delivery { out.recall_skill.push(m, &p.r); }
            }
            continue;
        }
        let Some(id) = layer::slot_id(line) else { continue };
        if ctx.skip.contains(id) {
            continue;
        }
        if lib.tombstone(id).is_some() {
            warnings.push(format!("`{id}` in set `{}` is tombstoned; skipped", p.r.set));
            continue;
        }
        let member = match lib.entry(id) {
            Ok(Some(e)) => lib.load(&e),
            Ok(None) => Err(format!("`{id}` is not in {label}")),
            Err(e) => Err(e),
        };
        let member = match member {
            Ok(m) => m,
            Err(e) => {
                warnings.push(format!("Set `{}`: {e}; skipped", p.r.set));
                continue;
            }
        };
        // Item runes are carried by the vault path's mappers (`resolve_vault`), never as rule text.
        if member.kind == "set" || crate::rules::rune::is_item_kind(&member.kind) || member.state != State::Active {
            continue;
        }
        if !member.meets(&set.scope) {
            warnings.push(format!("`{id}` in set `{}`: scope does not meet the set's; skipped", p.r.set));
            continue;
        }
        if !ctx.keeps(&member) {
            warnings.extend(ctx.drop_warning(&member));
            continue;
        }
        let r = rune_ref(id, &member.kind);
        if skill_delivery && (member.activate == "recall" || member.activate == "paths") {
            out.recall_skill.push(&member, &p.r);
        }
        if member.kind == "procedure" || member.activate == "recall" || (skill_delivery && member.activate == "paths") {
            push_rune(&mut out.on_demand, r);
        } else {
            push_rune(&mut out.rules, r);
        }
    }
}

// ---- a spawn's Rune Vault ----

/// What a spawn on one vault carries: the loadout, the warnings, the payload text (`None` when no
/// text rune renders; the profile's static payload then stands) and the vault's runesets as
/// `library/set` for the manifest.
pub(crate) struct VaultLoadout {
    pub loadout: Loadout,
    pub warnings: Vec<String>,
    pub text: Option<String>,
    pub sets: Vec<String>,
}

/// One resolved rune, parsed.
struct Held {
    library: String,
    rune: crate::rules::rune::Rune,
    recall: bool,
}

/// Resolves vault `v` (`Store::resolve`: unlocked reads the libraries and writes `revs/<hash>/` where
/// absent; locked reads its revision and reports drift) into the existing `Loadout` fields. Item runes
/// go through `rune_items` (skills, agents, guards, MCP names, permissions, plugins, env); text runes
/// render in each runeset's own lines, one-offs after: an always rule as its body, a recall, paths or
/// procedure rune as a pointer into the on-demand skill. Nothing reads a launcher row, a sidecar or a
/// bundle (model R1, R2).
pub(crate) fn resolve_vault(env: &ResolveEnv, agent: Agent, store: &super::vault::store::Store, v: &super::vault::Vault) -> Result<VaultLoadout, String> {
    use super::rune_items::{self, MapEnv, Mapped, RuneItem};
    use crate::rules::rune::{self, Rune};

    let sets: Vec<String> = v.runesets.iter().map(|c| format!("{}/{}", c.source.library, c.source.set)).collect();
    let mut out = Loadout::default();
    let mut warnings = Vec::new();
    if v.runesets.is_empty() && v.runes.is_empty() {
        out.hash = hash_of(&out);
        return Ok(VaultLoadout { loadout: out, warnings, text: None, sets });
    }
    let resolved = store.resolve(&v.id)?;
    warnings.extend(resolved.warnings);
    for d in &resolved.drift {
        warnings.push(format!("Rune `{}` changed in its library after vault {:?} locked; the locked copy loads", d.key(), v.id));
    }
    // Parse every carried body once; items split off for the mappers, text runes keyed for the render.
    // `Store::resolve` already skips Disabled runesets, so a later set's `<?recall?>` keeps their slots.
    let mut held: Vec<Held> = Vec::new();
    let mut items: Vec<RuneItem> = Vec::new();
    for r in &resolved.runes {
        let parsed: Rune = match rune::parse(&r.body.replace('\r', "")) {
            Ok(p) => p,
            Err(e) => {
                warnings.push(format!("Rune `{}/{}`: {e}; skipped", r.library, r.id));
                continue;
            }
        };
        if parsed.state != State::Active {
            if parsed.state == State::Disabled && parsed.kind != "set" {
                warnings.push(format!("`{}` is disabled and was skipped", parsed.id));
            }
            continue;
        }
        if rune::is_item_kind(&parsed.kind) {
            match RuneItem::from_rune(&parsed) {
                Ok(Some(it)) => items.push(it),
                Ok(None) => {}
                Err(e) => warnings.push(format!("Rune `{}/{}`: {e}; skipped", r.library, r.id)),
            }
            continue;
        }
        held.push(Held { library: r.library.clone(), rune: parsed, recall: r.recall });
    }

    // Items: the merged pieces, and per item what the agent cannot carry (`Loadout.unsupported`).
    let map_env = MapEnv { root: env.root, user_home: env.user_home };
    for it in &items {
        if let Ok(mapped) = rune_items::map_item(agent, it, &map_env) {
            for m in mapped {
                if let Mapped::Unsupported { warning } = m {
                    let prefix = format!("Rune `{}`: ", it.id);
                    let reason = warning.strip_prefix(&prefix).unwrap_or(&warning).trim_end_matches("; not carried").to_string();
                    push_unsupported(&mut out.unsupported, it.kind(), &it.id, reason);
                }
            }
        }
    }
    let pieces = rune_items::map_items(agent, &items, &map_env);
    warnings.extend(pieces.warnings);
    for p in pieces.skills {
        push_name(&mut out.skills, p, &set_layer::name_of);
    }
    for p in pieces.agents {
        push_name(&mut out.agents, p, &set_layer::name_of);
    }
    out.guard_items = pieces.guard_items;
    for m in pieces.mcp {
        push_name(&mut out.mcp, m.server, &str::to_lowercase);
    }
    out.permissions = pieces.permissions;
    out.output_style = pieces.output_style;
    out.model = pieces.model;
    out.plugins = pieces.plugins;
    out.env = pieces.env;
    drop_unsupported(agent, &mut out);
    out.guards = out.guard_items.iter().map(set_layer::guard_name).collect();

    // Text: each runeset's lines with its slots filled, then the one-offs (a rune renders once).
    let carried: BTreeSet<String> = out
        .guard_items
        .iter()
        .flat_map(|g| g.get("run").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|p| p.as_str().and_then(|s| Path::new(s).file_name()).map(|n| n.to_string_lossy().into_owned()))
        .collect();
    let ctx = RenderCtx::bare(carried);
    let find = |lib: &str, id: &str| held.iter().find(|h| h.library == lib && h.rune.id == id);
    let mut done: BTreeSet<String> = BTreeSet::new();
    let mut lines: Vec<String> = Vec::new();
    let mut place = |h: &Held, prefix: &str, source: &str, lines: &mut Vec<String>, out: &mut Loadout, warnings: &mut Vec<String>| {
        let key = format!("{}/{}", h.library, h.rune.id);
        if !done.insert(key) {
            return;
        }
        let r = &h.rune;
        if r.kind == "set" {
            return;
        }
        if !ctx.keeps(r) {
            warnings.extend(ctx.drop_warning(r));
            return;
        }
        let rune_ref = RuneRef { library: Some(h.library.clone()), id: r.id.clone(), kind: r.kind.clone() };
        let pointer = h.recall || r.kind == "procedure" || r.activate == "recall" || r.activate == "paths";
        if pointer {
            push_rune(&mut out.on_demand, rune_ref);
            out.recall_skill.push(r, &SetRef { library: Some(h.library.clone()), set: source.to_string() });
            lines.push(crate::rules::set::pointer(r));
            return;
        }
        push_rune(&mut out.rules, rune_ref);
        let body = crate::rules::set::member_lines(&r.body);
        if body.is_empty() {
            return;
        }
        lines.push(format!("<!-- rune: {} -->", r.id));
        let pad = " ".repeat(prefix.len());
        for (i, l) in body.iter().enumerate() {
            lines.push(match (i, l.trim().is_empty()) {
                (0, _) => format!("{prefix}{l}"),
                (_, true) => String::new(),
                _ => format!("{pad}{l}"),
            });
        }
    };
    for c in &v.runesets {
        let body = match store.snapshot_body(v, c) {
            Ok((b, State::Active)) => b,
            Ok((_, State::Disabled)) => {
                warnings.push(format!("`{}` is disabled and was skipped", c.source.set));
                continue;
            }
            Ok((_, State::Draft)) => continue,
            Err(e) => {
                warnings.push(format!("Runeset {}/{}: {e}; its lines skipped", c.source.library, c.source.set));
                continue;
            }
        };
        if body.trim().is_empty() {
            return Err(format!("Runeset {}/{} built empty; Bare spawn refused", c.source.library, c.source.set));
        }
        let own = c.source.library.as_str();
        for line in body.lines() {
            if line == "<?recall?>" {
                for h in held.iter().filter(|h| h.recall && h.library == own) {
                    place(h, "", &c.source.set, &mut lines, &mut out, &mut warnings);
                }
            } else if let Some((lib, id)) = super::layer::slot_in(line, own) {
                // A missing slot was warned by resolve; an item slot rides the mappers, never text.
                if let Some(h) = find(lib, id) {
                    let width = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches(['-', '*', '.']).trim_start().len();
                    place(h, &line[..width], &c.source.set, &mut lines, &mut out, &mut warnings);
                }
            } else {
                lines.push(line.to_string());
            }
        }
        lines.push(String::new());
    }
    for r in &v.runes {
        if let Some(h) = find(&r.library, &r.id) {
            lines.push(String::new());
            place(h, "", &v.id, &mut lines, &mut out, &mut warnings);
        }
    }
    let text = crate::rules::context::tidy(&lines.join("\n"));
    let text = text.trim().to_string();

    // A `required-by: vidar` rune of the agent's stock template that this vault lacks warns, never bars.
    let present: BTreeSet<String> = resolved.runes.iter().map(|r| format!("{}/{}", r.library, r.id)).collect();
    // Template and stock library resolve under the store's root, as the vault's own runes do.
    if let Ok(t) = store.template(&format!("stock-{}", agent.as_str())) {
        let stock = store.library("stock").ok();
        for r in t.runes.iter().filter(|r| r.library == "stock" && !present.contains(&r.key())) {
            let text = stock.as_ref().and_then(|l| l.entry(&r.id).ok().flatten()).and_then(|e| crate::fsx::read_text(&e.path).ok());
            if text.and_then(|t| super::vault::store::header_value(&t, "required-by")).as_deref() == Some("vidar") {
                warnings.push(rune_items::drop_warning(&r.id));
            }
        }
    }
    out.hash = hash_of(&out);
    Ok(VaultLoadout { loadout: out, warnings, text: (!text.is_empty()).then_some(text), sets })
}

/// hash12 of the loadout's wire JSON without `hash` (struct field order, so stable across runs).
fn hash_of(l: &Loadout) -> String {
    let mut v = serde_json::to_value(l).expect("serializable loadout");
    if let Some(o) = v.as_object_mut() {
        o.remove("hash");
    }
    crate::rules::build::hash12(v.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const CATALOG: &str = r#"{"version":1,"bundles":{
        "jira":{"mcp":[{"name":"atlassian","http":{"url":"https://mcp.atlassian.com/v2/mcp"},"reads":[]}],"skills":["mods/review"],"agents":[],"guards":[]},
        "slack":{"mcp":[{"name":"slack","http":{"url":"https://mcp.slack.com/mcp"},"agents":["claude"],"reads":[]}],"skills":[],"agents":[],"guards":[]}}}"#;

    /// A root with vidar.json (`rulesLibrary: lib`), the bundle catalog and an import library `imp`.
    fn root(tag: &str) -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let t = Tmp(std::env::temp_dir().join(format!("vidar-loadout-{tag}-{}-{nanos}", std::process::id())));
        write(&crate::paths::config_path_in(&t.0), r#"{"rulesLibrary":"lib"}"#);
        write(&t.0.join("contracts/module-bundles.json"), CATALOG);
        std::fs::create_dir_all(t.0.join("lib/sets")).unwrap();
        std::fs::create_dir_all(crate::paths::rune_imports_dir_in(&t.0).join("imp/sets")).unwrap();
        t
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn lib_dir(t: &Tmp, library: Option<&str>) -> PathBuf {
        match library {
            None => t.0.join("lib"),
            Some(l) => crate::paths::rune_imports_dir_in(&t.0).join(l),
        }
    }

    /// A rune file `<folder>/<id>.md` with `header` lines after name and kind.
    fn rune(t: &Tmp, library: Option<&str>, kind: &str, id: &str, header: &str, body: &str) {
        let folder = match kind { "rule" => "rules", "fact" => "facts", "procedure" => "procedures", _ => "sets" };
        write(&lib_dir(t, library).join(folder).join(format!("{id}.md")), &format!("---\nname: {id}\nkind: {kind}\n{header}---\n{body}\n"));
    }

    fn sidecar(t: &Tmp, library: Option<&str>, set: &str, json: &str) {
        write(&set_layer::sidecar_path(&lib_dir(t, library), set), json);
    }

    fn sref(library: Option<&str>, set: &str) -> SetRef {
        SetRef { library: library.map(str::to_string), set: set.into() }
    }

    fn run(t: &Tmp, agent: Agent, sets: &[SetRef]) -> (Loadout, Vec<String>) {
        let (config, home) = (crate::paths::config_path_in(&t.0), t.0.join("home"));
        let env = ResolveEnv { root: &t.0, config: &config, home: &home, user_home: Some(&t.0) };
        resolve(&env, agent, sets)
    }

    fn ids(l: &[RuneRef]) -> Vec<&str> {
        l.iter().map(|r| r.id.as_str()).collect()
    }

    fn guard_script(t: &Tmp, name: &str) -> String {
        let p = t.0.join("hooks").join(name);
        write(&p, "// guard\n");
        p.to_string_lossy().replace('\\', "\\\\")
    }

    #[test]
    fn disabled_vault_runeset_maps_neither_text_nor_items() {
        let t = root("disabled-vault-set");
        let lib = Some("imp");
        rune(&t, lib, "rule", "from-disabled", "scope: [global]\n", "Hidden rule");
        rune(&t, lib, "skill", "hidden-skill", "scope: [global]\nsource: skills/hidden\n", "");
        rune(&t, lib, "set", "disabled-set", "scope: [global]\nstate: disabled\n", "- <?rune from-disabled?>\n- <?rune hidden-skill?>");
        let store = super::super::vault::store::Store::open(&t.0);
        let v = store.create("Disabled Set Probe", None, &[super::super::vault::SetSource { library: "imp".into(), set: "disabled-set".into() }], &[]).unwrap();
        let config = crate::paths::config_path_in(&t.0);
        let home = t.0.join("home");
        let env = ResolveEnv { root: &t.0, config: &config, home: &home, user_home: Some(&t.0) };
        let loaded = resolve_vault(&env, Agent::Claude, &store, &v).unwrap();
        assert!(loaded.loadout.rules.is_empty(), "disabled set leaked rule text");
        assert!(loaded.loadout.skills.is_empty(), "disabled set mapped its skill item");
        assert!(loaded.text.is_none());
    }

    #[test]
    fn output_style_rune_in_a_vault_replaces_the_legacy_sidecar_setting() {
        let t = root("output-style-vault");
        let dir = lib_dir(&t, Some("imp"));
        write(&dir.join("styles/compact.md"), "---\nname: compact\nkind: output-style\nscope: [global]\nstyle: compact\n---\n");
        rune(&t, Some("imp"), "set", "styled", "scope: [global]\n", "- <?rune compact?>");
        sidecar(&t, Some("imp"), "styled", r#"{"outputStyle":"ignored"}"#);
        let store = super::super::vault::store::Store::open(&t.0);
        let v = store.create("Styled", None, &[super::super::vault::SetSource { library: "imp".into(), set: "styled".into() }], &[]).unwrap();
        let config = crate::paths::config_path_in(&t.0);
        let home = t.0.join("home");
        let env = ResolveEnv { root: &t.0, config: &config, home: &home, user_home: Some(&t.0) };
        assert_eq!(resolve_vault(&env, Agent::Claude, &store, &v).unwrap().loadout.output_style.map(|s| s.name).as_deref(), Some("compact"));
        let codex = resolve_vault(&env, Agent::Codex, &store, &v).unwrap();
        assert!(codex.loadout.output_style.is_none());
        assert!(codex.loadout.unsupported.iter().any(|u| u.kind == "output-style"));
    }

    #[test]
    fn the_post_pass_rows_follow_each_agents_spec() {
        let seeded = || {
            let mut l = Loadout::default();
            l.permissions.allow = vec!["Bash(ls)".into()];
            l.permissions.ask = vec!["Edit".into()];
            l.permissions.mode = Some("plan".into());
            l
        };
        let mut claude = seeded();
        drop_unsupported(Agent::Claude, &mut claude);
        assert!(claude.unsupported.is_empty());
        assert_eq!((claude.permissions.allow.len(), claude.permissions.ask.len()), (1, 1));
        assert_eq!(claude.permissions.mode.as_deref(), Some("plan"));
        let mut codex = seeded();
        drop_unsupported(Agent::Codex, &mut codex);
        let rows: Vec<_> = codex.unsupported.iter().map(|u| (u.kind.as_str(), u.item.as_str(), u.reason.as_str())).collect();
        assert_eq!(
            rows,
            [
                ("permission", "Bash(ls)", "Codex has no per-tool list"),
                ("permission", "Edit", "Codex has no per-tool list"),
                ("permission", "plan", "Codex has no permission mode"),
            ]
        );
        assert!(codex.permissions.allow.is_empty() && codex.permissions.ask.is_empty() && codex.permissions.mode.is_none());
    }

    #[test]
    fn pick_order_first_wins_across_sets_and_stray_sidecars_do_not_load() {
        let t = root("order");
        rune(&t, None, "rule", "short", "scope: [a, b]\n", "Keep it short.");
        rune(&t, None, "rule", "plain", "scope: [b]\n", "Plain words.");
        rune(&t, None, "set", "one", "scope: [a]\n", "- <?rune short?>");
        rune(&t, None, "set", "two", "scope: [b]\n", "- <?rune plain?>\n- <?rune short?>");
        sidecar(&t, None, "one", r#"{"skills":["~\\s\\alpha"],"permissions":{"mode":"plan"},"outputStyle":"terse"}"#);
        sidecar(&t, None, "two", r#"{"skills":["~\\other\\Alpha","~\\s\\beta"],"permissions":{"mode":"acceptEdits"},"outputStyle":"long"}"#);
        let (l, w) = run(&t, Agent::Claude, &[sref(None, "one"), sref(None, "two"), sref(None, "one")]);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(ids(&l.rules), ["short", "plain"]);
        assert!(l.skills.is_empty());
        assert!(l.permissions.mode.is_none() && l.output_style.is_none());
        let (back, _) = run(&t, Agent::Claude, &[sref(None, "two"), sref(None, "one")]);
        assert_eq!(ids(&back.rules), ["plain", "short"]);
        assert!(back.skills.is_empty() && back.output_style.is_none());
    }

    #[test]
    fn a_recall_only_set_yields_its_bare_members_on_demand() {
        let t = root("recall");
        rune(&t, None, "fact", "braces", "scope: [vidar]\ndescription: Brace style\n", "Allman.");
        rune(&t, None, "fact", "tabs-only", "scope: [vidar, !bare]\ndescription: Tabs\n", "Tabs.");
        rune(&t, None, "rule", "always-on", "scope: [vidar]\n", "On.");
        rune(&t, None, "procedure", "ship-it", "scope: [vidar]\n", "Steps.");
        rune(&t, None, "set", "vidar-recall", "scope: [vidar]\n", "# Recall\n\n<?recall?>");
        rune(&t, None, "set", "procs", "scope: [vidar]\n", "- <?rune ship-it?>");
        let (l, w) = run(&t, Agent::Claude, &[sref(None, "vidar-recall"), sref(None, "procs")]);
        assert!(w.is_empty(), "{w:?}");
        assert!(l.rules.is_empty(), "{:?}", l.rules);
        assert_eq!(ids(&l.on_demand), ["braces", "ship-it"]);
        assert_eq!((l.on_demand[0].kind.as_str(), l.on_demand[1].kind.as_str()), ("fact", "procedure"));
    }

    #[test]
    fn the_hash_is_stable_and_moves_with_one_item() {
        let t = root("hash");
        rune(&t, None, "rule", "r", "scope: [s]\n", "R.");
        rune(&t, None, "set", "s", "scope: [s]\n", "- <?rune r?>");
        sidecar(&t, None, "s", r#"{"skills":["~\\s\\one"]}"#);
        let (a, _) = run(&t, Agent::Claude, &[sref(None, "s")]);
        let (b, _) = run(&t, Agent::Claude, &[sref(None, "s")]);
        assert_eq!(a.hash.len(), 12);
        assert_eq!(a.hash, b.hash);
        sidecar(&t, None, "s", r#"{"skills":["~\\s\\two"]}"#);
        let (c, _) = run(&t, Agent::Claude, &[sref(None, "s")]);
        assert_eq!(a.hash, c.hash, "a stray sidecar cannot alter the launch");
    }

}
