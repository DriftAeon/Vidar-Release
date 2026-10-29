//! src-tauri\src\bare\vault\migrate_recall.rs — the recall-member pass.
//! A `<?recall?>` member switched off used to live outside the vault, in a retired override's `off` list
//! (`overrides\<library>\<set>.json`), which the vault migration could not carry ("a snapshot cannot drop
//! it"). This pass moves each one into the vault: the member's id joins the `recall-off` header of every
//! unlocked vault copy of that runeset (`store::RECALL_OFF`), through `Store::edit` member ops, so the hash
//! and the copy change together (model: a vault is a locked copy; its state lives in the vault).
//!
//! - Backup first: each vault it will rewrite (`vault.json` and `sets\`) goes to
//!   `runtime\migrations\recall-member-<stamp>\` with `plan.txt`, before any write.
//! - Idempotent: an id the copy already holds off is skipped, and a pass that wrote leaves `plan.txt` at
//!   `state: done`, after which later passes do nothing (a member switched back on stays on).
//! - A `vault.json`, copy or override that does not parse, and a locked vault, are warnings; untouched.
//! - Nothing to carry writes nothing. Called from `migrate::run_at_startup` after the vault migration.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::store::{recall_off, EditMode, Op, Store};
use super::{MemberEdit, RuneRef, Vault};
use crate::rules::rune;

const PREFIX: &str = "recall-member-";

#[derive(Default, Debug)]
pub(crate) struct Plan {
    /// Vault id -> the members to switch off in its copies.
    pub(crate) carries: Vec<(String, Vec<MemberEdit>)>,
    pub(crate) warnings: Vec<String>,
}

impl Plan {
    pub(crate) fn lines(&self) -> Vec<String> {
        let mut out: Vec<String> = self.carries.iter().flat_map(|(id, edits)| {
            edits.iter().map(move |m| format!("vault {id}: runeset {}/{} recall member {} off", m.library, m.runeset, m.rune.id))
        }).collect();
        out.extend(self.warnings.iter().map(|w| format!("warning {w}")));
        out
    }
}

#[derive(Debug)]
pub(crate) struct Outcome {
    pub(crate) lines: Vec<String>,
    pub(crate) backup: Option<PathBuf>,
}

fn dirs_in(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<String> = rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).filter_map(|e| e.file_name().into_string().ok()).collect();
    out.sort();
    out
}

/// A pass already wrote and finished on this root.
fn done(root: &Path) -> bool {
    let dir = crate::paths::migrations_dir_in(root);
    dirs_in(&dir).into_iter().filter(|n| n.starts_with(PREFIX))
        .any(|n| std::fs::read_to_string(dir.join(n).join("plan.txt")).is_ok_and(|t| t.starts_with("state: done\n")))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// The completed vault migration records old and new library/set names in its retained plan.
fn renamed_sources(root: &Path) -> BTreeMap<(String, String), (String, String)> {
    let mut out = BTreeMap::new();
    for name in dirs_in(&crate::paths::migrations_dir_in(root)).into_iter().filter(|n| n.starts_with("vault-")) {
        let file = crate::paths::migrations_dir_in(root).join(name).join("plan.txt");
        let Ok(plan) = std::fs::read_to_string(file) else { continue };
        if !plan.starts_with("state: done\n") { continue; }
        let mut libs = BTreeMap::new();
        let mut sets = BTreeMap::new();
        for line in plan.lines() {
            if let Some((old, new)) = line.strip_prefix("rename library ").and_then(|s| s.split_once(" to ")) {
                if rune::check_id(old).is_ok() && rune::check_id(new).is_ok() { libs.insert(new.to_string(), old.to_string()); }
            }
            if let Some((old, new)) = line.strip_prefix("rename set ").and_then(|s| s.split_once(" to ")) {
                if let (Some((old_lib, old_set)), Some((new_lib, new_set))) = (old.split_once('/'), new.split_once('/')) {
                    if old_lib == new_lib && rune::check_id(old_lib).is_ok() && rune::check_id(old_set).is_ok() && rune::check_id(new_set).is_ok() {
                        sets.insert((new_lib.to_string(), new_set.to_string()), old_set.to_string());
                    }
                }
            }
        }
        for (new_lib, old_lib) in libs {
            out.insert((new_lib.clone(), String::new()), (old_lib, String::new()));
        }
        for ((new_lib, new_set), old_set) in sets {
            let old_lib = out.get(&(new_lib.clone(), String::new())).map(|v| v.0.clone()).unwrap_or_else(|| new_lib.clone());
            out.insert((new_lib, new_set), (old_lib, old_set));
        }
    }
    out
}

/// Read-only: the members each unlocked vault copy should hold off, from the overrides folder.
pub(crate) fn plan(root: &Path) -> Plan {
    let mut plan = Plan::default();
    let overrides = crate::paths::legacy_rune_overrides_dir_in(root);
    if !overrides.is_dir() {
        return plan;
    }
    let store = Store::open(root);
    let renames = renamed_sources(root);
    let vaults = crate::paths::rune_vaults_dir_in(root);
    for id in dirs_in(&vaults) {
        let file = vaults.join(&id).join("vault.json");
        if !file.is_file() {
            continue;
        }
        let v: Vault = match crate::fsx::read_json(&file) {
            Ok(v) => v,
            Err(e) => {
                plan.warnings.push(format!("vault {id}: vault.json does not parse ({e}); left as it is"));
                continue;
            }
        };
        if v.id != id || rune::check_id(&id).is_err() {
            plan.warnings.push(format!("vault folder {id}: vault.json names {:?}; left as it is", v.id));
            continue;
        }
        let mut edits = Vec::new();
        for c in &v.runesets {
            let (lib, set) = (&c.source.library, &c.source.set);
            if rune::check_id(lib).is_err() || rune::check_id(set).is_err() {
                continue;
            }
            let (old_lib, old_set) = renames.get(&(lib.clone(), set.clone()))
                .or_else(|| renames.get(&(lib.clone(), String::new())))
                .map(|(l, s)| (l.as_str(), if s.is_empty() { set.as_str() } else { s.as_str() }))
                .unwrap_or((lib.as_str(), set.as_str()));
            let ov_file = overrides.join(old_lib).join(format!("{old_set}.json"));
            if !ov_file.is_file() {
                continue;
            }
            let ov: Value = match crate::fsx::read_json(&ov_file) {
                Ok(o) => o,
                Err(e) => {
                    plan.warnings.push(format!("override {lib}/{set} does not parse ({e}); vault {id} left as it is"));
                    continue;
                }
            };
            let must: BTreeSet<String> = crate::fsx::read_json::<Value>(&overrides.join(old_lib).join("_required.json"))
                .ok().map(|r| strings(r.get("required")).into_iter().collect()).unwrap_or_default();
            let bytes = match std::fs::read(vaults.join(&id).join(&c.file)) {
                Ok(b) => b,
                Err(e) => {
                    plan.warnings.push(format!("vault {id}: copy {} is not readable ({e}); left as it is", c.file));
                    continue;
                }
            };
            let parsed = match rune::parse(&String::from_utf8_lossy(&bytes).replace('\r', "")) {
                Ok(r) => r,
                Err(e) => {
                    plan.warnings.push(format!("vault {id}: copy {} does not parse ({e}); left as it is", c.file));
                    continue;
                }
            };
            if !parsed.body.lines().any(|l| l == "<?recall?>") {
                continue;
            }
            let slotted: BTreeSet<String> = parsed.body.lines().filter_map(|l| crate::bare::layer::slot_in(l, lib))
                .filter(|(l, _)| l == lib).map(|(_, i)| i.to_string()).collect();
            let held = recall_off(&bytes);
            for off in strings(ov.get("off")) {
                if must.contains(&off) || slotted.contains(&off) || held.contains(&off) || rune::check_id(&off).is_err() {
                    continue;
                }
                match store.is_recall_member(lib, &off, &parsed.scope) {
                    Ok(true) => edits.push(MemberEdit { library: lib.clone(), runeset: set.clone(), rune: RuneRef { library: lib.clone(), id: off }, on: false }),
                    Ok(false) => {}
                    Err(e) => plan.warnings.push(format!("vault {id}: library {lib} does not open ({e}); `{off}` left on")),
                }
            }
        }
        if edits.is_empty() {
            continue;
        }
        if v.locked_utc.is_some() {
            plan.warnings.push(format!("vault {id} is locked; {} recall member(s) an override switched off stay on (make a variant to switch them off)", edits.len()));
            continue;
        }
        plan.carries.push((id, edits));
    }
    plan
}

fn copy_file(src: &Path, dst: &Path, rel: &str, listed: &mut Vec<String>) -> Result<(), String> {
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("backup {}: {e}", p.display()))?;
    }
    std::fs::copy(src, dst).map_err(|e| format!("backup {} -> {}: {e}", src.display(), dst.display()))?;
    listed.push(rel.to_string());
    Ok(())
}

/// Copies each carried vault's `vault.json` and `sets\` files under `dir`; returns the list.
fn backup(root: &Path, dir: &Path, plan: &Plan) -> Result<Vec<String>, String> {
    let vaults = crate::paths::rune_vaults_dir_in(root);
    let mut listed = Vec::new();
    for (id, _) in &plan.carries {
        let vd = vaults.join(id);
        copy_file(&vd.join("vault.json"), &dir.join("vaults").join(id).join("vault.json"), &format!("vaults/{id}/vault.json"), &mut listed)?;
        if let Ok(rd) = std::fs::read_dir(vd.join("sets")) {
            let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
            files.sort();
            for f in files {
                let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                copy_file(&f, &dir.join("vaults").join(id).join("sets").join(&name), &format!("vaults/{id}/sets/{name}"), &mut listed)?;
            }
        }
    }
    Ok(listed)
}

fn write_plan_txt(dir: &Path, state: &str, listed: &[String], lines: &[String]) -> Result<(), String> {
    let mut text = format!("state: {state}\n");
    for l in listed {
        text.push_str(&format!("backup {l}\n"));
    }
    for l in lines {
        text.push_str(l);
        text.push('\n');
    }
    std::fs::write(dir.join("plan.txt"), text).map_err(|e| format!("recall-member plan: {e}"))
}

/// Plans, backs up, then switches each member off in its vault copy. A failed edit stops the pass with
/// `plan.txt` at `failed` (not done), so the next start re-plans; carried vaults then plan nothing.
pub(crate) fn run(root: &Path, stamp: &str) -> Result<Outcome, String> {
    if done(root) {
        return Ok(Outcome { lines: Vec::new(), backup: None });
    }
    let plan = plan(root);
    if plan.carries.is_empty() {
        return Ok(Outcome { lines: plan.lines(), backup: None });
    }
    if stamp.is_empty() || !stamp.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(format!("recall-member pass: invalid stamp {stamp:?}"));
    }
    let dir = crate::paths::migrations_dir_in(root).join(format!("{PREFIX}{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("backup {}: {e}", dir.display()))?;
    let listed = backup(root, &dir, &plan)?;
    let lines = plan.lines();
    write_plan_txt(&dir, "planned", &listed, &lines)?;
    let store = Store::open(root);
    for (id, edits) in &plan.carries {
        let ops: Vec<Op> = edits.iter().cloned().map(Op::Member).collect();
        if let Err(e) = store.edit(id, &ops, EditMode::Unlocked) {
            let _ = write_plan_txt(&dir, &format!("failed at vault {id}: {e}; restore from this folder"), &listed, &lines);
            return Err(format!("recall-member pass: vault {id}: {e} (plan: {})", dir.join("plan.txt").display()));
        }
    }
    write_plan_txt(&dir, "done", &listed, &lines)?;
    Ok(Outcome { lines, backup: Some(dir) })
}

/// The production pass on this install's root; lines land in the release log.
pub fn run_at_startup(root: &Path, stamp: &str) {
    match run(root, stamp) {
        Ok(o) => {
            o.lines.iter().for_each(|l| eprintln!("recall-member pass: {l}"));
            if let Some(b) = o.backup {
                eprintln!("recall-member pass: backup {}", b.display());
            }
        }
        Err(e) => eprintln!("{e}"),
    }
}
