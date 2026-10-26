//! src-tauri\src\bare\vault\migrate_split.rs — the per-agent split of a converted sidecar, and the
//! repair of a vault an earlier run already wrote with a mixed runeset (run 2026-10-25-rune-vault, K1).
//!
//! A sidecar's runes tagged `agent: claude` or `agent: codex` leave the base set for their own sets
//! (`<set>-claude`, `<set>-codex`); untagged runes stay. A stock vault loads the base (when it holds
//! anything) plus the sets of its own agent. `repair` finds a stock vault whose runeset still mixes tags
//! (the first migration put one `kit/kit` in all four) and splits it the same way, backup first.

use super::*;
use crate::bare::vault::store::Store;

/// A stock vault rewritten in place: the new vault.json, files to write and files to drop.
pub(super) struct VaultFix {
    pub(super) vault: Vault,
    write: Vec<(String, Vec<u8>)>,
    remove: Vec<String>,
}

/// Slot ids of a set in file order.
pub(super) fn slot_order(text: &str) -> Vec<String> {
    text.lines().filter_map(|l| crate::bare::layer::slot_id(l.trim_end()).map(str::to_string)).collect()
}

fn title_of(name: &str) -> String {
    name.split('-').filter(|w| !w.is_empty()).map(title).collect::<Vec<_>>().join(" ")
}

fn header_scope(base: &str, lib: &str) -> String {
    let mut in_header = false;
    for (i, l) in base.lines().enumerate() {
        let b = l.trim_end();
        if i == 0 && b == "---" {
            in_header = true;
        } else if in_header && b == "---" {
            break;
        } else if in_header && b.starts_with("scope:") {
            return b.to_string();
        }
    }
    format!("scope: [{lib}]")
}

/// A new empty set `name` beside `base` (same scope, line ends).
fn new_set_text(base: &str, name: &str, lib: &str) -> String {
    let nl = if base.contains("\r\n") { "\r\n" } else { "\n" };
    format!("---{nl}name: {name}{nl}kind: set{nl}{}{nl}---{nl}# {}{nl}", header_scope(base, lib), title_of(name))
}

/// Places `items` of a sidecar into `set_old`, tagged ones into a set per agent (`<set>-<agent>`).
pub(super) fn place_split(plan: &mut Plan, env: &Env, lib_old: &str, set_old: &str, items: Vec<Item>) -> Result<(), String> {
    let mut base: Vec<Item> = Vec::new();
    let mut by: BTreeMap<&'static str, Vec<Item>> = BTreeMap::new();
    for it in items {
        match it.agent {
            Some(a) => by.entry(a).or_default().push(it),
            None => base.push(it),
        }
    }
    let mut made: Vec<(&'static str, String)> = Vec::new();
    for (agent, list) in by {
        let lib = plan.lib(env, lib_old)?;
        let name = format!("{}-{agent}", lib.set_new(set_old));
        if rune::check_id(&name).is_err() || lib.sets.contains_key(&name) || lib.set_md(&name).exists() {
            plan.warnings.push(format!("{lib_old}/{set_old}: set {name} already exists; its {agent} runes stay in the base set"));
            base.extend(list);
            continue;
        }
        let base_text = lib.text(set_old)?.clone();
        let text = new_set_text(&base_text, &name, &lib.new);
        lib.sets.insert(name.clone(), (text.clone().into_bytes(), text));
        lib.made.insert(name.clone());
        made.push((agent, name.clone()));
        place(plan, env, lib_old, &name, list)?;
    }
    place(plan, env, lib_old, set_old, base)?;
    for (_, name) in &made {
        let lib = plan.lib(env, lib_old)?;
        let text = lib.sets.get(name).map(|(_, t)| t.clone()).unwrap_or_default();
        if let Some(entry) = lib.sets.get_mut(name) {
            entry.0 = text.clone().into_bytes();
        }
        let write = RuneWrite { lib: lib.new.clone(), rel: format!("sets/{name}.md"), bytes: text.into_bytes() };
        plan.runes.push(write);
    }
    if !made.is_empty() {
        plan.splits.entry((lib_old.to_string(), set_old.to_string())).or_default().extend(made);
    }
    Ok(())
}

type Libs = BTreeMap<String, Option<Library>>;

fn tag_of(libs: &mut Libs, env: &Env, lib: &str, id: &str) -> Option<&'static str> {
    let l = libs
        .entry(lib.to_string())
        .or_insert_with(|| if lib == "stock" { None } else { crate::bare::layer::library_dir_named(env.root, lib).ok().and_then(|d| Library::open(&d).ok()) })
        .as_ref()?;
    let entry = l.entry(id).ok()??;
    match l.load(&entry).ok()?.agent.as_deref() {
        Some("claude") => Some("claude"),
        Some("codex") => Some("codex"),
        _ => None,
    }
}

/// Slot ids of `text` grouped by the agent tag of their rune in `lib`; untagged ids are absent.
fn tagged(libs: &mut Libs, env: &Env, lib: &str, text: &str) -> BTreeMap<&'static str, Vec<String>> {
    let mut out: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    for id in slot_order(text) {
        if let Some(a) = tag_of(libs, env, lib, &id) {
            out.entry(a).or_default().push(id);
        }
    }
    out
}

/// Splits the library set `lib/set` itself (once): its tagged slots move to `<set>-<agent>` sets.
fn split_library_set(env: &Env, plan: &mut Plan, libs: &mut Libs, lib: &str, set: &str) -> Result<(), String> {
    if rune::check_id(lib).is_err() || rune::check_id(set).is_err() || lib == "stock" {
        return Ok(());
    }
    let Ok(dir) = crate::bare::layer::library_dir_named(env.root, lib) else { return Ok(()) };
    let Ok(bytes) = std::fs::read(dir.join("sets").join(format!("{set}.md"))) else { return Ok(()) };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let groups = tagged(libs, env, lib, &text);
    if groups.is_empty() {
        return Ok(());
    }
    let names: Vec<(&'static str, String)> = groups.keys().map(|a| (*a, format!("{set}-{a}"))).collect();
    if names.iter().any(|(_, n)| rune::check_id(n).is_err() || dir.join("sets").join(format!("{n}.md")).exists()) {
        plan.warnings.push(format!("{lib}/{set}: a set named {set}-<agent> already exists; the library set stays mixed"));
        return Ok(());
    }
    for (a, name) in &names {
        let mut t = new_set_text(&text, name, lib);
        append_slots(&mut t, &groups[a]);
        plan.runes.push(RuneWrite { lib: lib.to_string(), rel: format!("sets/{name}.md"), bytes: t.into_bytes() });
    }
    let all: BTreeSet<String> = groups.values().flatten().cloned().collect();
    let l = plan.lib(env, lib)?;
    let t = l.text(set)?;
    *t = remove_slots(t, &all);
    Ok(())
}

/// Finds stock vaults whose runesets mix agent tags and plans their split (idempotent: a second run
/// finds none). The library set splits once; each affected vault's own copy splits, so its member
/// edits survive. A locked vault is left with a warning.
pub(super) fn repair(env: &Env, plan: &mut Plan) -> Result<(), String> {
    let vaults_dir = crate::paths::rune_vaults_dir_in(env.root);
    let Ok(rd) = std::fs::read_dir(&vaults_dir) else { return Ok(()) };
    let mut ids: Vec<String> = rd.flatten().filter(|e| e.path().join("vault.json").is_file()).filter_map(|e| e.file_name().into_string().ok()).collect();
    ids.sort();
    let store = Store::open(env.root);
    let mut libs: Libs = BTreeMap::new();
    let mut lib_done: BTreeSet<(String, String)> = BTreeSet::new();
    for id in ids {
        let Ok(v) = store.get(&id) else { continue };
        let Some(VaultFrom::Template { template }) = &v.from else { continue };
        let Some(agent) = template.strip_prefix("stock-").and_then(|a| ["claude", "codex"].into_iter().find(|x| *x == a)) else { continue };
        let dir = vaults_dir.join(&id);
        let mut runesets: Vec<RunesetCopy> = Vec::new();
        let mut write: Vec<(String, Vec<u8>)> = Vec::new();
        let mut remove: Vec<String> = Vec::new();
        let mut changed = false;
        for c in &v.runesets {
            let keep = |runesets: &mut Vec<RunesetCopy>| runesets.push(c.clone());
            let Ok(bytes) = std::fs::read(dir.join(&c.file)) else { keep(&mut runesets); continue };
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let groups = tagged(&mut libs, env, &c.source.library, &text);
            if !groups.keys().any(|a| *a != agent) {
                keep(&mut runesets);
                continue;
            }
            if v.locked_utc.is_some() {
                plan.warnings.push(format!("vault {id} is locked and its runeset {}/{} mixes agents; left as it is", c.source.library, c.source.set));
                keep(&mut runesets);
                continue;
            }
            if lib_done.insert((c.source.library.clone(), c.source.set.clone())) {
                split_library_set(env, plan, &mut libs, &c.source.library, &c.source.set)?;
            }
            let all: BTreeSet<String> = groups.values().flatten().cloned().collect();
            let base_text = remove_slots(&text, &all);
            let mut parts: Vec<(String, String)> = Vec::new();
            if !slots_of(&base_text).is_empty() || base_text.contains("<?recall") {
                parts.push((c.source.set.clone(), base_text));
            }
            if let Some(mine) = groups.get(agent) {
                let name = format!("{}-{agent}", c.source.set);
                let mut t = new_set_text(&text, &name, &c.source.library);
                append_slots(&mut t, mine);
                parts.push((name, t));
            }
            let mut files = Vec::new();
            for (name, t) in parts {
                let file = format!("sets/{}--{name}.md", c.source.library);
                let source = SetSource { library: c.source.library.clone(), set: name };
                if runesets.iter().any(|r| r.source == source) || v.runesets.iter().any(|r| r.source == source && r.file != c.file) {
                    continue;
                }
                files.push(file.clone());
                let bytes = t.into_bytes();
                runesets.push(RunesetCopy { file: file.clone(), source, copied_utc: c.copied_utc.clone(), source_hash: content_sha(&bytes) });
                write.push((file, bytes));
            }
            if !files.contains(&c.file) {
                remove.push(c.file.clone());
            }
            changed = true;
        }
        if !changed {
            continue;
        }
        let pairs: Vec<(SetSource, String)> = runesets.iter().map(|c| (c.source.clone(), c.source_hash.clone())).collect();
        let mut vault = v.clone();
        vault.hash = vault_hash(&pairs, &v.runes);
        vault.runesets = runesets;
        plan.fixes.push(VaultFix { vault, write, remove });
    }
    Ok(())
}

/// Writes one fix into the vault folder `dir`, journalled.
pub(super) fn apply_fix(dir: &Path, f: &VaultFix, journal: &mut Vec<Undo>) -> Result<(), String> {
    for rel in &f.remove {
        let p = dir.join(rel);
        if let Ok(before) = std::fs::read(&p) {
            std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            journal.push(Undo::Restore(p, before));
        }
    }
    for (rel, bytes) in &f.write {
        let p = dir.join(rel);
        if p.exists() {
            rewrite(&p, bytes, journal)?;
        } else {
            create(&p, bytes, journal)?;
        }
    }
    let json = serde_json::to_string_pretty(&f.vault).map_err(|e| e.to_string())? + "\n";
    rewrite(&dir.join("vault.json"), json.as_bytes(), journal)
}
