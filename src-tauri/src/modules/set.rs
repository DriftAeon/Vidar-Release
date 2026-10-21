//! src-tauri\src\modules\set.rs — a release set's membership at runtime. A zip built with
//! `-Set` carries `release-manifest.json` beside the exe with `set.included`: the modules the
//! set resolved to, dependants of excluded modules already dropped (modules-resolve.mjs
//! `resolveSet`) and `set.dropped`: included modules the build dropped for an excluded
//! dependency. A non-core module is left out of the registry when the build knew it and left
//! it out: a contract core[] row outside `included`, a pack whose id is in `dropped`, or a
//! gateway pack outside `included` (no released set ships one, tools/release/sets.test.mjs).
//! A pack folder the build never saw (one a user adds after install) stays listed: the zip's
//! excluded pack folders are cut from the stage, so the set has nothing to say about it.
//! Core-level modules always stay. A left-out pack folder reads as a broken row saying so, never
//! a silent gap. No manifest (dev checkout), no `set` block or a malformed one: no filter (the
//! last two log one line).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::OnceLock;

use serde_json::Value;

use super::scan::{Broken, Listed, Scan};

#[derive(Debug, PartialEq)]
pub struct ReleaseSet {
    pub id: String,
    pub included: BTreeSet<String>,
    /// Ids the build dropped for an excluded dependency (`set.dropped`; empty when absent).
    pub dropped: BTreeSet<String>,
}

fn strings(v: Option<&Value>, key: &str) -> Result<BTreeSet<String>, String> {
    let arr = v.and_then(Value::as_array).ok_or(format!("set.{key} is not an array"))?;
    arr.iter().map(|x| x.as_str().map(str::to_string).ok_or(format!("set.{key} holds a non-string"))).collect()
}

/// `Ok(None)`: the manifest has no `set` block. `Err`: unreadable JSON or a malformed `set`.
fn parse(text: &str) -> Result<Option<ReleaseSet>, String> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    let Some(set) = v.get("set") else { return Ok(None) };
    let id = set.get("id").and_then(Value::as_str).ok_or("set.id is not a string")?;
    let included = strings(set.get("included"), "included")?;
    let dropped = match set.get("dropped") {
        None => BTreeSet::new(),
        d => strings(d, "dropped")?,
    };
    Ok(Some(ReleaseSet { id: id.to_string(), included, dropped }))
}

/// The set in `manifest`, or None (absent file silently; no set block or malformed, one log line).
pub fn read(manifest: &Path) -> Option<ReleaseSet> {
    let text = std::fs::read_to_string(manifest).ok()?;
    match parse(&text) {
        Ok(Some(s)) => Some(s),
        Ok(None) => {
            eprintln!("modules: {} has no set block; every module listed", manifest.display());
            None
        }
        Err(e) => {
            eprintln!("modules: {} unreadable ({e}); every module listed", manifest.display());
            None
        }
    }
}

/// The set beside the running exe, read once per process.
pub fn current() -> Option<&'static ReleaseSet> {
    static S: OnceLock<Option<ReleaseSet>> = OnceLock::new();
    S.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        read(&exe.parent()?.join("release-manifest.json"))
    })
    .as_ref()
}

impl ReleaseSet {
    /// The broken reason of a pack folder this set leaves out directly.
    fn left_out(&self) -> String {
        format!("Left Out By Release Set {}", self.id)
    }

    /// Did the build know this module and leave it out? Core-level never; otherwise a core[]
    /// row outside `included`, a dropped id, or a gateway pack outside `included`.
    fn excludes(&self, m: &Listed) -> bool {
        if m.decl.level == "core" || self.included.contains(&m.decl.id) {
            return false;
        }
        let gateway = m.decl.agent.as_ref().is_some_and(|a| a.gateway.is_some());
        m.source == "core" || self.dropped.contains(&m.decl.id) || gateway
    }

    /// Drops every module `excludes` from `modules`, `pending` (first-sight gateways, so no pin
    /// is recorded and no snapshot entry written) and `changed`, then every non-core module
    /// whose dependsOn names one it dropped, transitively. A dropped pack folder gets a broken
    /// row (`Left Out By Release Set <id>`, or `Needs <id>` for a dependant); a gateway pack
    /// Changed Since Pinned that the set leaves out reads the same instead, so no Trust Current
    /// is offered that `trust_current_in` would refuse. Other broken rows stay. Marks `s.set`.
    pub fn apply(&self, s: &mut Scan) {
        let rows: Vec<&Listed> = s.modules.iter().chain(s.pending.iter().map(|(m, _)| m)).collect();
        // id -> broken reason for its folder.
        let mut gone: BTreeMap<String, String> = rows.iter().filter(|m| self.excludes(m)).map(|m| (m.decl.id.clone(), self.left_out())).collect();
        for (id, _) in s.changed.values() {
            if !self.included.contains(id) || self.dropped.contains(id) {
                gone.insert(id.clone(), self.left_out());
            }
        }
        loop {
            let more: Vec<(String, String)> = rows
                .iter()
                .filter(|m| m.decl.level != "core" && !gone.contains_key(&m.decl.id))
                .filter_map(|m| m.decl.depends_on.iter().flatten().find(|d| gone.contains_key(*d)).map(|d| (m.decl.id.clone(), format!("Needs {d}"))))
                .collect();
            if more.is_empty() {
                break;
            }
            gone.extend(more);
        }
        let mut rows_out: Vec<Broken> = rows
            .iter()
            .filter_map(|m| Some(Broken { folder: m.folder.clone()?, reason: gone.get(&m.decl.id)?.clone() }))
            .collect();
        for (folder, (id, _)) in &s.changed {
            if let Some(reason) = gone.get(id) {
                s.broken.retain(|b| &b.folder != folder);
                rows_out.push(Broken { folder: folder.clone(), reason: reason.clone() });
            }
        }
        s.modules.retain(|m| !gone.contains_key(&m.decl.id));
        s.pending.retain(|(m, _)| !gone.contains_key(&m.decl.id));
        s.changed.retain(|_, (id, _)| !gone.contains_key(id));
        s.broken.extend(rows_out);
        s.broken.sort_by(|a, b| a.folder.cmp(&b.folder));
        s.set = Some(self.id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::super::{contract, scan::scan};
    use super::*;
    use crate::voice_slots::pins::Store;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-modules-set-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Core[] plus content packs: `extra`; `mid` (the build dropped it); `child` (dependsOn
    /// `mid`); `late`, added after install; `late-needs` (added after install, dependsOn the
    /// excluded core[] row `lab`).
    fn registry(root: &Path) -> Scan {
        let packs = root.join("mod-packs");
        for (id, needs) in [("extra", vec![]), ("mid", vec![]), ("child", vec!["mid"]), ("late", vec![]), ("late-needs", vec!["lab"])] {
            let text = serde_json::json!({ "id": id, "module": { "id": id, "label": id, "level": "optional", "kind": contract().implicit_pack_module.kind, "dependsOn": needs } });
            std::fs::create_dir_all(packs.join(id)).unwrap();
            std::fs::write(packs.join(id).join("pack.json"), text.to_string()).unwrap();
        }
        let s = scan(&packs, contract(), &Default::default(), &Ok(Store::default()));
        assert!(s.broken.is_empty(), "{:?}", s.broken);
        s
    }

    fn ids(s: &Scan) -> Vec<String> {
        s.modules.iter().map(|m| m.decl.id.clone()).collect()
    }

    fn broken(folder: &str, reason: &str) -> Broken {
        Broken { folder: folder.into(), reason: reason.into() }
    }

    /// Included kept, core-level kept unlisted; an excluded core[] row and a dropped pack leave,
    /// and so do their dependants; a pack the build never saw stays listed. Each left-out pack
    /// folder reads as a broken row saying why.
    #[test]
    fn modules_set_keeps_included_core_and_unknown_packs_drops_the_rest() {
        let root = temp("filter");
        let manifest = root.join("release-manifest.json");
        std::fs::write(&manifest, r#"{ "head": "x", "set": { "id": "t", "included": ["tray", "extra"], "dropped": ["mid"] } }"#).unwrap();
        let set = read(&manifest).expect("set read");
        let mut s = registry(&root);
        set.apply(&mut s);
        let _ = std::fs::remove_dir_all(&root);
        let got = ids(&s);
        assert_eq!(set.id, "t");
        for kept in ["relay", "speak", "listen", "tray", "extra", "late"] {
            assert!(got.iter().any(|i| i == kept), "{kept} kept: {got:?}");
        }
        for gone in ["lab", "flow", "mid", "child", "late-needs"] {
            assert!(!got.iter().any(|i| i == gone), "{gone} dropped: {got:?}");
        }
        assert_eq!(s.set.as_deref(), Some("t"), "the listing names the set that filtered it");
        assert_eq!(s.broken, vec![broken("child", "Needs mid"), broken("late-needs", "Needs lab"), broken("mid", "Left Out By Release Set t")]);
    }

    /// A gateway pack outside `included` leaves (no released set ships one), first sight or
    /// Changed Since Pinned alike; the changed one reads Left Out, so no Trust Current is offered.
    /// Included, it stays Changed Since Pinned and keeps its Trust Current entry.
    #[test]
    fn modules_set_drops_an_unincluded_gateway_and_its_changed_row() {
        use super::super::scan::{pin_key, CHANGED};
        let root = temp("gateway");
        let packs = root.join("mod-packs");
        let pins = root.join("pins.json");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("modules").join("ok-gateway").join("acme").join("pack.json");
        std::fs::create_dir_all(packs.join("acme")).unwrap();
        std::fs::copy(&fixture, packs.join("acme").join("pack.json")).unwrap();
        let set = |included: &[&str]| ReleaseSet { id: "t".into(), included: included.iter().map(|s| s.to_string()).collect(), dropped: BTreeSet::new() };
        let mut first = scan(&packs, contract(), &Default::default(), &Ok(Store::default()));
        assert_eq!(first.pending.len(), 1, "acme is first sight");
        set(&["tray"]).apply(&mut first);
        let other = crate::voice_slots::pins::Pin { bytes: 1, sha256: "00".into() };
        crate::voice_slots::pins::record(&pins, vec![(pin_key("acme"), other)], true).unwrap();
        let changed = || scan(&packs, contract(), &Default::default(), &crate::voice_slots::pins::load(&pins));
        let (mut out, mut kept) = (changed(), changed());
        assert_eq!(out.broken, vec![broken("acme", CHANGED)]);
        set(&["tray"]).apply(&mut out);
        set(&["tray", "acme"]).apply(&mut kept);
        let _ = std::fs::remove_dir_all(&root);
        assert!(first.pending.is_empty() && !ids(&first).iter().any(|i| i == "acme"));
        assert_eq!(first.broken, vec![broken("acme", "Left Out By Release Set t")]);
        assert!(out.changed.is_empty());
        assert_eq!(out.broken, vec![broken("acme", "Left Out By Release Set t")]);
        assert!(kept.changed.contains_key("acme"));
        assert_eq!(kept.broken, vec![broken("acme", CHANGED)]);
    }

    /// No manifest, a manifest without `set`, or a malformed one: no filter.
    #[test]
    fn modules_set_absent_or_malformed_changes_nothing() {
        let root = temp("none");
        let manifest = root.join("release-manifest.json");
        let absent = read(&manifest);
        std::fs::write(&manifest, r#"{ "head": "x" }"#).unwrap();
        let no_block = read(&manifest);
        std::fs::write(&manifest, "{ not json").unwrap();
        let broken_json = read(&manifest);
        std::fs::write(&manifest, r#"{ "set": { "id": "t", "included": "tray" } }"#).unwrap();
        let bad_shape = read(&manifest);
        std::fs::write(&manifest, r#"{ "set": { "id": "t", "included": ["tray"], "dropped": "mid" } }"#).unwrap();
        let bad_dropped = read(&manifest);
        std::fs::write(&manifest, r#"{ "set": { "id": "t", "included": ["tray"] } }"#).unwrap();
        let no_dropped = read(&manifest).expect("a set without dropped reads").dropped;
        let unfiltered = registry(&root);
        let before = ids(&unfiltered);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!((absent, no_block, broken_json, bad_shape, bad_dropped), (None, None, None, None, None));
        assert!(no_dropped.is_empty());
        assert!(["lab", "mid", "child"].iter().all(|id| before.iter().any(|i| i == id)), "unfiltered registry lists all: {before:?}");
        assert_eq!(unfiltered.set, None);
    }
}
