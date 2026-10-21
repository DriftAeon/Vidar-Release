//! src-tauri\src\modules\scan.rs — the packs root to modules and broken rows. Per-pack rules
//! are `manifest::read_pack`; this file adds the rules that need every pack: ids unique
//! across core and packs, keyVar unclaimed, flowModels ids unique, `owns` disjoint, dependsOn
//! acyclic, then the gateway pins.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::manifest::{dep_env_name, owns_overlap, read_pack, Contract, ModuleDecl};
use crate::deps::CatalogClaims;
use crate::voice_slots::pins::{self, Pin, Store, Verdict};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    #[serde(flatten)]
    pub decl: ModuleDecl,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// SHA-256 of the pack.json bytes this declaration was parsed from (packs only).
    #[serde(skip)]
    pub pack_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Broken {
    pub folder: String,
    pub reason: String,
}

/// Trust is membership in `modules`: a gateway module is there only when its pin matched, or
/// when `settle` persisted its first-sight pin. Every execution consumer (Flow env, the
/// gateway snapshot) reads `modules`, so there is no second check to keep in step.
#[derive(Debug, Default, Serialize)]
pub struct Scan {
    pub modules: Vec<Listed>,
    pub broken: Vec<Broken>,
    /// The release set id when a release manifest's `set` filtered this listing (`set.rs`); the
    /// frontend then also hides rows a release build cannot run (src/modules/registry.ts).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set: Option<String>,
    /// Gateway modules seen for the first time, with the pin to record. Not trusted, so not in
    /// `modules`; only `modules_list` records them (`settle`).
    #[serde(skip)]
    pub pending: Vec<(Listed, Pin)>,
    /// Gateway packs broken only by `Changed Since Pinned`: folder -> (module id, the pin of
    /// the declaration as it is now). Trust Current re-pins from here (`module_trust_current`).
    #[serde(skip)]
    pub changed: BTreeMap<String, (String, Pin)>,
}

impl Scan {
    /// Records the pending first-sight pins through `record` (the pin store's `record` in
    /// production). Success moves those modules into `modules`; failure makes each a broken
    /// row `Pin Not Recorded`, so an unpersisted pin never grants trust.
    pub fn settle(&mut self, record: impl FnOnce(Vec<(PathBuf, Pin)>) -> Result<(), String>) {
        let pending = std::mem::take(&mut self.pending);
        if pending.is_empty() {
            return;
        }
        let pins = pending.iter().map(|(m, pin)| (pin_key(&m.decl.id), pin.clone())).collect();
        match record(pins) {
            Ok(()) => {
                self.modules.extend(pending.into_iter().map(|(m, _)| m));
                // Core first (no folder), then packs by folder name, as `scan` orders them.
                self.modules.sort_by(|a, b| a.folder.cmp(&b.folder));
            }
            Err(reason) => {
                eprintln!("modules: pins not recorded: {reason}");
                for (m, _) in pending {
                    self.broken.push(Broken { folder: m.folder.unwrap_or(m.decl.id), reason: "Pin Not Recorded".into() });
                }
                self.broken.sort_by(|a, b| a.folder.cmp(&b.folder));
            }
        }
    }
}

/// The pin store key of a gateway module's declaration. Shares `pins.json` with the voice
/// adapters; the `module:` prefix cannot collide with a file path.
pub fn pin_key(id: &str) -> PathBuf {
    PathBuf::from(format!("module:{id}"))
}

/// Core modules from the contract, then every `<packs>\<folder>\pack.json` by folder name
/// (folders starting `_` or `.` are parked, as for voice). `catalog` holds the dependency ids
/// and env var names claimed by the dependency catalog. `store` is the loaded pin store;
/// an unreadable store breaks every gateway module (fail closed).
pub fn scan(packs: &Path, c: &Contract, catalog: &CatalogClaims, store: &Result<Store, String>) -> Scan {
    let mut out = Scan::default();
    for decl in &c.core {
        out.modules.push(Listed { decl: decl.clone(), source: "core", folder: None, pack_sha256: None });
    }
    let mut found: Vec<(String, ModuleDecl)> = Vec::new();
    let mut hashes: BTreeMap<String, String> = BTreeMap::new(); // folder -> pack.json sha256
    match std::fs::read_dir(packs) {
        Err(e) => out.broken.push(Broken { folder: packs.display().to_string(), reason: format!("Cannot Read packs Folder: {e}") }),
        Ok(rd) => {
            let mut dirs: Vec<(String, PathBuf)> = Vec::new();
            for e in rd.filter_map(|e| e.ok()) {
                let (name, path) = (e.file_name().to_string_lossy().into_owned(), e.path());
                if name.starts_with('_') || name.starts_with('.') {
                    continue;
                }
                match std::fs::metadata(&path) {
                    Ok(md) if md.is_dir() => dirs.push((name, path)),
                    Ok(_) => {}
                    Err(err) => out.broken.push(Broken { folder: name, reason: format!("Cannot Follow Pack Folder: {err}") }),
                }
            }
            dirs.sort();
            for (folder, dir) in dirs {
                match read_pack(&folder, &dir, c) {
                    Ok((decl, sha256)) => {
                        hashes.insert(folder.clone(), sha256);
                        found.push((folder, decl));
                    }
                    Err(reason) => out.broken.push(Broken { folder, reason }),
                }
            }
        }
    }
    let mut bad: BTreeMap<String, String> = BTreeMap::new(); // folder -> reason
    let core_ids: BTreeSet<&str> = c.core.iter().map(|m| m.id.as_str()).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for (folder, d) in &found {
        if core_ids.contains(d.id.as_str()) {
            bad.insert(folder.clone(), format!("Id {} Duplicates A Core Module", d.id));
        } else if !seen.insert(d.id.as_str()) {
            bad.insert(folder.clone(), format!("Id {} Duplicates Another Pack", d.id));
        }
    }
    let mut dep_owners: BTreeMap<&str, &str> = BTreeMap::new(); // dep id -> first pack folder
    for (folder, d) in &found {
        for dep in d.deps.iter().flatten() {
            let id = dep["id"].as_str().expect("read_pack validated dep id");
            if catalog.ids.contains(id) {
                bad.entry(folder.clone()).or_insert(format!("Dep Id {id} Duplicates The Dependency Catalog"));
            } else if let Some(other) = dep_owners.get(id) {
                bad.entry(folder.clone()).or_insert(format!("Dep Id {id} Duplicates Pack {other}"));
            } else {
                dep_owners.insert(id, folder);
            }
        }
    }
    for (folder, d) in &found {
        let Some(g) = d.agent.as_ref().and_then(|a| a.gateway.as_ref()) else { continue };
        if catalog.env_names.contains(&g.key_var) {
            bad.entry(folder.clone()).or_insert(format!("keyVar {} Is Claimed By The Dependency Catalog", g.key_var));
            continue;
        }
        let claimant = c
            .core
            .iter()
            .chain(found.iter().map(|(_, m)| m))
            .find(|other| other.id != d.id && other.deps.iter().flatten().any(|dep| dep_env_name(dep) == Some(g.key_var.as_str())));
        if let Some(other) = claimant {
            bad.entry(folder.clone()).or_insert(format!("keyVar {} Is Claimed By Module {}", g.key_var, other.id));
        }
    }
    // A flowModels id names one gateway: declared by two modules, both break, whatever the
    // folder order.
    let mut owners: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new(); // model id -> (folder, module id)
    for (folder, d) in &found {
        let ids: BTreeSet<&str> = d.flow_models.iter().flatten().map(|f| f.id.as_str()).collect();
        for id in ids {
            owners.entry(id).or_default().push((folder.as_str(), d.id.as_str()));
        }
    }
    for (model, decls) in &owners {
        if c.flow_core_model_ids.iter().any(|id| id == model) {
            for (folder, _) in decls {
                bad.entry(folder.to_string()).or_insert(format!("Flow Model {model} Is A Core Model"));
            }
            continue;
        }
        for (folder, _) in decls {
            if let Some((_, other)) = decls.iter().find(|(f, _)| f != folder) {
                bad.entry(folder.to_string()).or_insert(format!("Flow Model {model} Is Also Declared By {other}"));
            }
        }
    }
    // `owns` are disjoint across packs: a path two packs claim would be cut with either.
    for (folder, d) in &found {
        let clash = d.owns.iter().flatten().find_map(|o| {
            found
                .iter()
                .filter(|(f, _)| f != folder)
                .find(|(_, other)| other.owns.iter().flatten().any(|p| owns_overlap(o, p)))
                .map(|(_, other)| (o, other.id.as_str()))
        });
        if let Some((o, other)) = clash {
            bad.entry(folder.clone()).or_insert(format!("owns {o} Overlaps Module {other}"));
        }
    }
    for folder in cycle_members(&found) {
        bad.entry(folder).or_insert_with(|| "In A dependsOn Cycle".into());
    }
    for (folder, d) in found {
        if let Some(reason) = bad.remove(&folder) {
            out.broken.push(Broken { folder, reason });
            continue;
        }
        let pack_sha256 = hashes.remove(&folder);
        let gateway = d.agent.as_ref().is_some_and(|a| a.gateway.is_some());
        let verdict = if gateway { pin_verdict(store, &d) } else { Ok(None) };
        let listed = Listed { decl: d, source: "pack", folder: Some(folder), pack_sha256 };
        match verdict {
            Ok(None) => out.modules.push(listed),
            Ok(Some(pin)) => out.pending.push((listed, pin)),
            Err(reason) => {
                let folder = listed.folder.unwrap_or_default();
                if reason == CHANGED {
                    out.changed.insert(folder.clone(), (listed.decl.id.clone(), canonical_pin(&listed.decl)));
                }
                out.broken.push(Broken { folder, reason });
            }
        }
    }
    out.broken.sort_by(|a, b| a.folder.cmp(&b.folder));
    out
}

/// Folders whose module reaches itself through dependsOn, walked pack to pack only: core
/// modules are not followed (a core module's dependsOn names a pack, never the reverse).
fn cycle_members(found: &[(String, ModuleDecl)]) -> Vec<String> {
    let by_id: BTreeMap<&str, &ModuleDecl> = found.iter().map(|(_, d)| (d.id.as_str(), d)).collect();
    let next = |id: &str| -> Vec<&str> { by_id.get(id).and_then(|d| d.depends_on.as_ref()).map(|v| v.iter().map(String::as_str).collect()).unwrap_or_default() };
    let mut out = Vec::new();
    for (folder, d) in found {
        let mut stack: Vec<&str> = next(&d.id);
        let mut visited: BTreeSet<&str> = BTreeSet::new();
        while let Some(id) = stack.pop() {
            if id == d.id {
                out.push(folder.clone());
                break;
            }
            if visited.insert(id) {
                stack.extend(next(id));
            }
        }
    }
    out
}

/// The declaration's canonical bytes against its pin: `Ok(None)` matches, `Ok(Some)` is a
/// first sighting to record, `Err` is the broken reason.
fn pin_verdict(store: &Result<Store, String>, d: &ModuleDecl) -> Result<Option<Pin>, String> {
    let store = store.as_ref().map_err(|e| e.clone())?;
    let bytes = canonical(d);
    match pins::verdict_bytes(store, &pin_key(&d.id), &bytes) {
        Verdict::Match => Ok(None),
        Verdict::Unpinned(pin) => Ok(Some(pin)),
        Verdict::Changed => Err(CHANGED.into()),
    }
}

/// The broken reason of a gateway declaration that differs from its pin.
pub const CHANGED: &str = "Changed Since Pinned";

/// The pin of the declaration's canonical bytes, as `pins::verdict_bytes` computes it.
fn canonical_pin(d: &ModuleDecl) -> Pin {
    use sha2::{Digest, Sha256};
    let bytes = canonical(d);
    Pin { bytes: bytes.len() as u64, sha256: Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect() }
}

/// The declaration as JSON with object keys sorted, so reformatting pack.json or reordering
/// its keys does not read as a change.
pub fn canonical(d: &ModuleDecl) -> Vec<u8> {
    fn sort(v: serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(m) => {
                let sorted: BTreeMap<String, serde_json::Value> = m.into_iter().map(|(k, v)| (k, sort(v))).collect();
                serde_json::Value::Object(sorted.into_iter().collect())
            }
            serde_json::Value::Array(a) => serde_json::Value::Array(a.into_iter().map(sort).collect()),
            other => other,
        }
    }
    let v = serde_json::to_value(d).unwrap_or_default();
    serde_json::to_vec(&sort(v)).unwrap_or_default()
}
