//! src-tauri\src\bare\vault\tests.rs — store, lock, drift and session-record tests.

use std::path::{Path, PathBuf};

use super::session::{self, VaultPin};
use super::store::{self, EditMode, Op, Store};
use super::{content_sha, sha12, vault_hash, LockedBy, RuneRef, SetSource, Vault, VaultFrom};

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-vault-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> PathBuf {
    crate::paths::root().join("tests").join("fixtures").join("rune-vault")
}

/// The fixture's vaults folder, or `rel` under it.
fn fx_vaults(rel: &str) -> PathBuf {
    fixture().join(format!("vaults/{rel}"))
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

/// A temp root holding the fixture `base` library and `installed` as an import library.
struct Fx(TempDir);
impl Fx {
    fn new(tag: &str) -> Fx {
        let t = TempDir::new(tag);
        copy_dir(&fixture().join("vidar-runes"), &crate::paths::rune_imports_dir_in(&t.0).join("base"));
        super::vidar::seed_core(&t.0);
        copy_dir(&fixture().join("installed"), &crate::paths::rune_imports_dir_in(&t.0).join("installed"));
        Fx(t)
    }
    fn root(&self) -> &Path {
        &self.0 .0
    }
    fn store(&self) -> Store {
        Store::open(self.root())
    }
    fn edit_rune(&self, lib: &str, folder: &str, id: &str, text: &str) {
        let dir = crate::paths::rune_imports_dir_in(self.root()).join(lib);
        std::fs::write(dir.join(folder).join(format!("{id}.md")), text).unwrap();
    }
}

fn base_ref(id: &str) -> RuneRef {
    RuneRef { library: "base".into(), id: id.into() }
}

fn installed_set() -> SetSource {
    SetSource { library: "installed".into(), set: "installed".into() }
}

const ALL_ONE_OFFS: &[&str] = &[
    "bare-identity", "gate-recall", "gate-skill", "gate-agent", "gate-hook-run", "gate-hook-command", "vidar-drive", "gate-permission", "roster",
];

fn full_vault(fx: &Fx, name: &str) -> Vault {
    let runes: Vec<RuneRef> = ALL_ONE_OFFS.iter().map(|id| base_ref(id)).collect();
    fx.store().create(name, None, &[installed_set()], &runes).unwrap()
}

// ---- wire formats ----

#[test]
fn the_fixture_vault_json_round_trips_through_the_vault_type() {
    for id in ["astra-code", "astra-code-no-skill"] {
        let path = fx_vaults(id).join("vault.json");
        let raw: serde_json::Value = serde_json::from_str(&read(&path)).unwrap();
        let v: Vault = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(v.id, id);
        assert_eq!(serde_json::to_value(&v).unwrap(), raw, "{id}: vault.json shape drifted from the fixture");
    }
    let locked: Vault = serde_json::from_str(&read(&fx_vaults("astra-code-no-skill").join("vault.json"))).unwrap();
    assert_eq!(locked.locked_by, Some(LockedBy::FirstMessage));
    assert!(matches!(&locked.from, Some(VaultFrom::Vault { vault, .. }) if vault == "astra-code"));
    assert!(locked.pins.contains_key("installed/team-recall-tip"), "a recall member is pinned at lock");
    let revs = fx_vaults("astra-code-no-skill").join("revs").join(&locked.hash);
    for key in locked.pins.keys() {
        let (lib, id) = key.split_once('/').unwrap();
        assert!(store::rev_body(&revs, lib, id).is_file(), "revs holds no body for {key}");
    }
}

#[test]
fn the_fixture_session_record_round_trips_and_names_no_row() {
    let dir = fx_vaults("sessions");
    let file = std::fs::read_dir(&dir).unwrap().flatten().next().unwrap().path();
    let raw: serde_json::Value = serde_json::from_str(&read(&file)).unwrap();
    let r: session::Record = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(&r).unwrap(), raw, "session record shape drifted from the fixture");
    assert_eq!(r.vault.id, "astra-code-no-skill");
    assert!(raw.get("rowKey").is_none(), "a session record never binds a launcher row (model R2)");
}

#[test]
fn the_fixture_hashes_come_from_the_hash_function() {
    let vaults = fx_vaults("");
    let load = |id: &str| -> Vault { serde_json::from_str(&read(&vaults.join(id).join("vault.json"))).unwrap() };
    let (a, b) = (load("astra-code"), load("astra-code-no-skill"));
    for v in [&a, &b] {
        let snap = std::fs::read(vaults.join(&v.id).join(&v.runesets[0].file)).unwrap();
        assert_eq!(v.runesets[0].source_hash, content_sha(&snap), "{}: sourceHash", v.id);
        let sets: Vec<(SetSource, String)> = v.runesets.iter().map(|c| (c.source.clone(), content_sha(&std::fs::read(vaults.join(&v.id).join(&c.file)).unwrap()))).collect();
        assert_eq!(v.hash, vault_hash(&sets, &v.runes), "{}: hash", v.id);
    }
    assert!(matches!(&b.from, Some(VaultFrom::Vault { hash, .. }) if hash == &a.hash), "variant from.hash");
    let rev = vaults.join(&b.id).join("revs").join(&b.hash);
    for (key, pin) in &b.pins {
        let (lib, id) = key.split_once('/').unwrap();
        let body = std::fs::read(store::rev_body(&rev, lib, id)).unwrap();
        assert_eq!(pin, &sha12(&body), "pin {key}");
    }
    let rev_vault: Vault = serde_json::from_str(&read(&rev.join("vault.json"))).unwrap();
    assert_eq!(rev_vault, b, "the revision holds the vault as locked");
    let rec = std::fs::read_dir(vaults.join("sessions")).unwrap().flatten().next().unwrap().path();
    let r: session::Record = serde_json::from_str(&read(&rec)).unwrap();
    assert_eq!(r.vault.hash, b.hash);
}

#[test]
fn ops_and_modes_have_a_camel_case_wire_shape() {
    let op: Op = serde_json::from_str(r#"{"op":"removeRune","ref":{"library":"base","id":"x"}}"#).unwrap();
    assert_eq!(op, Op::RemoveRune(base_ref("x")));
    let op: Op = serde_json::from_str(r#"{"op":"addRuneset","ref":{"library":"installed","set":"installed"}}"#).unwrap();
    assert_eq!(op, Op::AddRuneset(installed_set()));
    let m: EditMode = serde_json::from_str(r#""invalidate""#).unwrap();
    assert_eq!(m, EditMode::Invalidate);
    let by: LockedBy = serde_json::from_str(r#""first-message""#).unwrap();
    assert_eq!(by, LockedBy::FirstMessage);
}

// ---- create, ids, resolve ----

#[test]
fn a_named_vault_copies_its_runesets_and_resolves_every_kind() {
    let fx = Fx::new("full");
    let v = full_vault(&fx, "Gate Full");
    assert_eq!(v.id, "gate-full");
    assert!(v.runesets[0].file.ends_with("installed--installed.md"));
    let dir = crate::paths::rune_vaults_dir_in(fx.root()).join("gate-full");
    assert_eq!(std::fs::read(dir.join("sets/installed--installed.md")).unwrap(), std::fs::read(fixture().join("installed/sets/installed.md")).unwrap(), "a byte copy");
    let r = fx.store().resolve(&v.id).unwrap();
    let ids: Vec<String> = r.runes.iter().map(|x| format!("{}/{}", x.library, x.id)).collect();
    for want in ["installed/team-verdict-first", "installed/team-plain-words", "base/gate-fact", "installed/team-recall-tip"] {
        assert!(ids.contains(&want.to_string()), "{want} missing: {ids:?}");
    }
    for id in ALL_ONE_OFFS {
        assert!(ids.contains(&format!("base/{id}")), "{id} missing: {ids:?} {:?}", r.warnings);
    }
    assert!(r.runes.iter().any(|x| x.id == "team-recall-tip" && x.recall));
    assert!(r.drift.is_empty());
    // A second vault of the same name takes the next id; reserved names refuse.
    assert_eq!(fx.store().create("Gate Full", None, &[], &[]).unwrap().id, "gate-full-2");
    for bad in ["Sessions", "defaults", "Copy Claude", "custom-abc123", "!!"] {
        assert!(fx.store().create(bad, None, &[], &[]).is_err(), "{bad}");
    }
    assert_eq!(fx.store().list().unwrap().len(), 2);
}

/// A stored vault named `Base` holding the identity rune, the source the copy and sweep tests start from.
fn base_vault(fx: &Fx) -> Vault {
    super::create_at(fx.root(), Some("Base".into()), None, &[], &[base_ref("bare-identity")]).unwrap()
}

/// Rewrites a vault's `createdUtc` (a copy made a while ago).
fn age(fx: &Fx, id: &str, created: &str) {
    let path = crate::paths::rune_vaults_dir_in(fx.root()).join(id).join("vault.json");
    let mut v: Vault = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    v.created_utc = created.into();
    crate::fsx::write_json_pretty(&path, &v, false).unwrap();
}

#[test]
fn a_vault_copied_twice_gives_two_ids_with_one_hash_and_the_original_stays_unlocked() {
    let fx = Fx::new("copy-base");
    let base = base_vault(&fx);
    let a = fx.store().start_copy(&base.id, None, &[], &[]).unwrap();
    let b = fx.store().start_copy(&base.id, None, &[], &[]).unwrap();
    assert_ne!(a.id, b.id);
    assert!(a.id.starts_with("copy-") && crate::rules::rune::check_id(&a.id).is_ok(), "{}", a.id);
    assert_eq!(a.hash, b.hash);
    assert_eq!((a.name.as_str(), &a.from), ("Base", &Some(VaultFrom::Vault { vault: base.id.clone(), hash: a.hash.clone() })));
    assert_eq!(a.runes, vec![base_ref("bare-identity")]);
    assert!(fx.store().get(&base.id).unwrap().locked_utc.is_none());
    assert!(fx.store().create("copy-x", None, &[], &[]).is_err(), "copy- is a reserved prefix");
}

#[test]
fn an_identical_blank_start_twice_gives_two_vaults() {
    let fx = Fx::new("custom");
    let a = super::create_at(fx.root(), None, None, &[installed_set()], &[]).unwrap();
    let b = super::create_at(fx.root(), None, None, &[installed_set()], &[]).unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(a.hash, b.hash);
    assert_eq!(fx.store().list().unwrap().iter().filter(|v| v.id.starts_with("copy-")).count(), 2);
    let c = super::create_at(fx.root(), None, None, &[installed_set()], &[base_ref("gate-skill")]).unwrap();
    assert_ne!(c.hash, a.hash);
}

#[test]
fn a_copy_spawn_records_the_copy_and_leaves_the_original_unlocked() {
    let fx = Fx::new("vault-for");
    let base = base_vault(&fx);
    let copy = fx.store().start_copy(&base.id, None, &[], &[]).unwrap();
    let opts = crate::bare::LaunchOpts { vault: Some(&copy.id), ..Default::default() };
    let v = crate::bare::launch_row::vault_for(fx.root(), &opts, crate::bare::agent_homes::Agent::Claude).unwrap().unwrap();
    assert_eq!(v.id, copy.id);
    let seed = crate::bare::vault_spawn::SessionSeed::new(fx.root(), crate::bare::agent_homes::Agent::Claude, "rendered", Some(&v), "").unwrap();
    seed.write("tab-1", Some("s-0001"), fx.root()).unwrap();
    assert_eq!(session::find(fx.root(), "tab-1", Some("s-0001"), None).unwrap().unwrap().vault.id, v.id);
    assert!(fx.store().get(&base.id).unwrap().locked_utc.is_none());
}

#[test]
fn the_sweep_deletes_only_unlocked_unrecorded_unpicked_copies_older_than_a_day() {
    let fx = Fx::new("sweep");
    let base = base_vault(&fx);
    let mk = |created: &str| {
        let v = fx.store().start_copy(&base.id, None, &[], &[]).unwrap();
        age(&fx, &v.id, created);
        v.id
    };
    let old = "2026-10-01T00:00:00Z";
    let (doomed, young, recorded, picked) = (mk(old), mk("2026-10-31T11:00:00Z"), mk(old), mk(old));
    let locked = mk(old);
    fx.store().lock(&locked, LockedBy::Button, &fx.store().get(&locked).unwrap().hash).unwrap();
    let hash = fx.store().get(&recorded).unwrap().hash;
    session::write(fx.root(), &session::record("claude", "rendered", "t", VaultPin { id: recorded.clone(), hash }, "", "")).unwrap();
    super::write_default(fx.root(), "claude", &picked).unwrap();
    let now = 1_793_449_860_000; // 2026-10-31T12:31:00Z
    let gone = fx.store().sweep_copies(None, now).unwrap();
    assert_eq!(gone, vec![doomed.clone()]);
    for id in [&young, &recorded, &picked, &locked, &base.id] {
        assert!(fx.store().get(id).is_ok(), "{id} was swept");
    }
    assert!(fx.store().get(&doomed).is_err());
}

#[test]
fn the_sweep_aborts_and_deletes_nothing_on_an_unreadable_record() {
    let fx = Fx::new("sweep-closed");
    let base = base_vault(&fx);
    let v = fx.store().start_copy(&base.id, None, &[], &[]).unwrap();
    age(&fx, &v.id, "2026-10-01T00:00:00Z");
    let sessions = crate::paths::rune_vaults_dir_in(fx.root()).join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(sessions.join("2026-10-02T000000000Z-claude-deadbeef.json"), "{ not json").unwrap();
    assert!(fx.store().sweep_copies(None, 1_793_449_860_000).is_err());
    assert!(fx.store().get(&v.id).is_ok());
}

#[test]
fn legacy_custom_cleanup_deletes_only_the_unnamed_ones_and_keeps_a_home_with_a_transcript() {
    let fx = Fx::new("legacy-custom");
    let mk = |id: &str| {
        let v = fx.store().create("Scratch", None, &[installed_set()], &[]).unwrap();
        let dirs = crate::paths::rune_vaults_dir_in(fx.root());
        std::fs::rename(dirs.join(&v.id), dirs.join(id)).unwrap();
        let path = dirs.join(id).join("vault.json");
        let mut j: Vault = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        j.id = id.into();
        crate::fsx::write_json_pretty(&path, &j, false).unwrap();
    };
    for id in ["custom-aaaaaa", "custom-bbbbbb", "custom-cccccc", "custom-dddddd"] {
        mk(id);
    }
    // dddddd is named by nothing, but a thread's transcript sits in its `vault:<id>` home
    let home = fx.root().join("home");
    let agent = crate::bare::agent_homes::Agent::Claude;
    let hash12 = crate::bare::agent_homes::pick_vault(agent, &home, &home.join("legacy"), Some("custom-dddddd")).combo.unwrap().0;
    let dir = home.join("claude-homes").join(&hash12);
    std::fs::create_dir_all(dir.join("projects").join("p")).unwrap();
    std::fs::write(dir.join("projects").join("p").join("t.jsonl"), "{}\n").unwrap();
    let index = serde_json::json!({ hash12.clone(): { "sets": ["vault:custom-dddddd"], "dir": format!("claude-homes/{hash12}"), "lastUsed": 0 } });
    let index_file = crate::bare::agent_homes::index_file(agent, &home);
    std::fs::create_dir_all(index_file.parent().unwrap()).unwrap();
    std::fs::write(&index_file, index.to_string()).unwrap();
    let hash = fx.store().get("custom-bbbbbb").unwrap().hash;
    session::write(fx.root(), &session::record("claude", "rendered", "t", VaultPin { id: "custom-bbbbbb".into(), hash }, "", "")).unwrap();
    super::write_default(fx.root(), "claude", "custom-cccccc").unwrap();
    assert_eq!(fx.store().clean_legacy_custom(Some(&home)).unwrap(), vec!["custom-aaaaaa".to_string()]);
    assert!(fx.store().get("custom-bbbbbb").is_ok() && fx.store().get("custom-cccccc").is_ok());
    assert!(fx.store().get("custom-dddddd").is_ok() && dir.join("projects").join("p").join("t.jsonl").is_file());
}

#[test]
fn a_base_id_spawn_refuses_as_an_unknown_vault() {
    let fx = Fx::new("vault-for");
    let go = |id: &str| {
        let opts = crate::bare::LaunchOpts { vault: Some(id), ..Default::default() };
        crate::bare::launch_row::vault_for(fx.root(), &opts, crate::bare::agent_homes::Agent::Claude).unwrap_err()
    };
    for id in ["base-main", "base-main@abcdef123456", "base-side"] {
        let e = go(id);
        assert!(e.contains("Unknown vault") && e.contains("Bare spawn refused"), "{id}: {e}");
    }
    assert!(fx.store().list().unwrap().is_empty(), "a refused spawn wrote no vault");
}

#[test]
fn a_pre_vault_custom_sets_spawn_refuses_and_writes_nothing() {
    let fx = Fx::new("sets-only");
    let sets = [crate::bare::LaunchSetRef { library: Some("installed".into()), set: "installed".into() }];
    let opts = crate::bare::LaunchOpts { custom_sets: Some(&sets), ..Default::default() };
    let e = crate::bare::launch_row::vault_for(fx.root(), &opts, crate::bare::agent_homes::Agent::Claude).unwrap_err();
    assert_eq!(e, "This session predates Rune Vaults; spawn refused");
    assert!(fx.store().list().unwrap().is_empty());
}

#[test]
fn a_vault_without_the_vidar_runeset_at_index_zero_refuses_at_launch() {
    let fx = Fx::new("no-vidar");
    let v = base_vault(&fx);
    let path = crate::paths::rune_vaults_dir_in(fx.root()).join(&v.id).join("vault.json");
    let mut j: Vault = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    j.runesets.retain(|c| !super::vidar::is_reserved(&c.source));
    crate::fsx::write_json_pretty(&path, &j, false).unwrap();
    let opts = crate::bare::LaunchOpts { vault: Some(&v.id), ..Default::default() };
    let e = crate::bare::launch_row::vault_for(fx.root(), &opts, crate::bare::agent_homes::Agent::Claude).unwrap_err();
    assert_eq!(e, "Vault lacks the Vidar Runeset; spawn refused");
}


#[test]
fn a_cross_library_slot_resolves_and_the_runeset_copy_does_not_follow_its_original() {
    let fx = Fx::new("cross-lib");
    let v = fx.store().create("Gate Installed Only", None, &[installed_set()], &[base_ref("bare-identity")]).unwrap();
    let has_fact = |fx: &Fx| fx.store().resolve(&v.id).unwrap().runes.iter().any(|x| x.library == "base" && x.id == "gate-fact");
    assert!(has_fact(&fx));
    fx.edit_rune("installed", "sets", "installed", "---\nname: installed\nkind: set\nscope: [global]\n---\n- <?rune team-plain-words?>\n");
    assert!(has_fact(&fx), "the vault's runeset copy followed its original");
}

// ---- lock, variant, invalidate, drift ----

#[test]
fn a_pre_lock_edit_changes_the_hash_and_lock_refuses_a_stale_session_hash() {
    let fx = Fx::new("lock");
    let v = full_vault(&fx, "Gate Lock");
    let edited = fx.store().edit(&v.id, &[Op::RemoveRune(base_ref("gate-agent"))], EditMode::Unlocked).unwrap();
    assert_eq!(edited.id, v.id, "an unlocked edit stays on the vault");
    assert_ne!(edited.hash, v.hash);
    let e = fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).err().unwrap();
    assert!(e.contains("hash"), "{e}");
    let locked = fx.store().lock(&v.id, LockedBy::FirstMessage, &edited.hash).unwrap();
    assert_eq!(locked.hash, edited.hash, "lock is outside the hash");
    assert_eq!(locked.locked_by, Some(LockedBy::FirstMessage));
    assert!(locked.locked_utc.is_some() && !locked.pins.is_empty());
    assert!(locked.pins.contains_key("installed/team-recall-tip") && locked.pins.contains_key("base/gate-fact"));
    let again = fx.store().lock(&v.id, LockedBy::Button, &edited.hash).unwrap();
    assert_eq!(again.locked_by, Some(LockedBy::FirstMessage), "lock is idempotent; the first lock stands");
    assert!(fx.store().lock(&v.id, LockedBy::Button, &v.hash).err().unwrap().contains("hash"));
    assert!(fx.store().edit(&v.id, &[Op::AddRune(base_ref("gate-agent"))], EditMode::Unlocked).is_err());
    let var = fx.store().edit(&v.id, &[Op::AddRune(base_ref("gate-agent"))], EditMode::Variant).unwrap();
    assert_ne!(var.id, v.id);
    assert!(matches!(&var.from, Some(VaultFrom::Vault { vault, hash }) if vault == &v.id && hash == &edited.hash));
    assert!(var.locked_utc.is_none(), "a variant starts unlocked");
    assert_eq!(fx.store().get(&v.id).unwrap(), again, "a variant leaves the locked original untouched");
    let inv = fx.store().edit(&v.id, &[Op::AddRune(base_ref("gate-agent"))], EditMode::Invalidate).unwrap();
    assert_eq!(inv.id, v.id);
    assert!(inv.locked_utc.is_none() && inv.pins.is_empty(), "the rewritten vault waits for its next lock");
    let old = fx.store().load_at(&v.id, &edited.hash).expect("the invalidated revision stays readable in revs/");
    assert_eq!(old.pins, locked.pins);
}

#[test]
fn a_locked_vault_resolves_its_copied_body_after_a_library_edit_and_reports_drift() {
    let fx = Fx::new("drift");
    let v = full_vault(&fx, "Gate Drift");
    fx.store().lock(&v.id, LockedBy::Button, &v.hash).unwrap();
    fx.edit_rune("installed", "rules", "team-verdict-first", "---\nname: team-verdict-first\nkind: rule\nscope: [global]\ndescription: Team rule one\n---\nEDITED-AFTER-LOCK\n");
    let r = fx.store().resolve(&v.id).unwrap();
    let body = &r.runes.iter().find(|x| x.library == "installed" && x.id == "team-verdict-first").unwrap().body;
    assert!(body.contains("GATE-RULE-TEAM-VERDICT-FIRST") && !body.contains("EDITED-AFTER-LOCK"), "{body}");
    assert_eq!(r.drift, vec![RuneRef { library: "installed".into(), id: "team-verdict-first".into() }]);
    assert_eq!(fx.store().drift(&v.id).unwrap(), r.drift);
    let unlocked = full_vault(&fx, "Gate Drift Open");
    assert!(fx.store().drift(&unlocked.id).unwrap().is_empty());
}

#[test]
fn recall_members_of_a_locked_vault_come_only_from_its_pins() {
    let fx = Fx::new("recall-pins");
    let v = full_vault(&fx, "Gate Recall");
    let locked = fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    assert!(locked.pins.contains_key("installed/team-recall-tip"));
    fx.edit_rune("installed", "procedures", "team-recall-late", "---\nname: team-recall-late\nkind: procedure\nscope: [global]\nactivate: recall\ndescription: Added after lock\n---\nGATE-PROCEDURE-TEAM-RECALL-LATE\n");
    let r = fx.store().resolve(&v.id).unwrap();
    assert!(r.runes.iter().any(|x| x.id == "team-recall-tip" && x.recall));
    assert!(!r.runes.iter().any(|x| x.id == "team-recall-late"), "a recall rune added after lock joined a locked vault");
    // The open vault sees the new member.
    let open = full_vault(&fx, "Gate Recall Open");
    assert!(fx.store().resolve(&open.id).unwrap().runes.iter().any(|x| x.id == "team-recall-late"));
}

#[test]
fn a_disabled_runeset_loads_nothing_and_its_slot_leaves_the_rune_to_a_later_recall() {
    let fx = Fx::new("disabled-set");
    // A Disabled set first: it slots the recall rune the active `installed` set loads through `<?recall?>`,
    // and one rule no other set names.
    fx.edit_rune("installed", "rules", "team-off-only", "---\nname: team-off-only\nkind: rule\nscope: [global]\ndescription: Only the off set\n---\nOFF-ONLY\n");
    fx.edit_rune("installed", "sets", "installed-off", "---\nname: installed-off\nkind: set\nscope: [global]\nstate: disabled\n---\n- <?rune team-recall-tip?>\n- <?rune team-off-only?>\n");
    let off = SetSource { library: "installed".into(), set: "installed-off".into() };
    let v = fx.store().create("Gate Disabled", None, &[off, installed_set()], &[]).unwrap();
    let check = |label: &str| {
        let r = fx.store().resolve(&v.id).unwrap();
        let tip: Vec<_> = r.runes.iter().filter(|x| x.id == "team-recall-tip").collect();
        assert_eq!(tip.len(), 1, "{label}: {:?}", r.runes.iter().map(|x| &x.id).collect::<Vec<_>>());
        assert!(tip[0].recall, "{label}: the active set's recall flag");
        assert!(!r.runes.iter().any(|x| x.id == "team-off-only"), "{label}: a Disabled set's slot loaded");
        assert!(r.runes.iter().any(|x| x.id == "team-verdict-first"), "{label}");
    };
    check("unlocked");
    fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    check("locked");
}

// ---- session records ----

#[test]
fn a_session_keeps_its_original_vault_after_a_variant_and_a_new_tab() {
    let fx = Fx::new("readopt");
    let v = full_vault(&fx, "Gate Readopt");
    fx.store().resolve(&v.id).unwrap(); // a spawn writes revs/<hash>/
    let mut r = session::record("claude", "rendered", "t1-tab", VaultPin { id: v.id.clone(), hash: v.hash.clone() }, "h", "l");
    r.falcon_session = Some("s-gate-0001".into());
    session::write(fx.root(), &r).unwrap();
    let variant = fx.store().edit(&v.id, &[Op::RemoveRune(base_ref("gate-skill"))], EditMode::Variant).unwrap();
    assert_ne!(variant.id, v.id);
    let unlocked_edit = fx.store().edit(&v.id, &[Op::RemoveRune(base_ref("gate-agent"))], EditMode::Unlocked).unwrap();
    assert_ne!(unlocked_edit.hash, v.hash);
    let found = session::find(fx.root(), "t2-tab", Some("s-gate-0001"), None).unwrap().expect("record by falconSession");
    assert_eq!(found.vault, VaultPin { id: v.id.clone(), hash: v.hash.clone() });
    let shown = fx.store().load_at(&found.vault.id, &found.vault.hash).unwrap();
    assert!(shown.runes.contains(&base_ref("gate-skill")) && shown.runes.contains(&base_ref("gate-agent")), "the view shows the vault the session loaded");
    let text = read(&std::fs::read_dir(crate::paths::rune_vaults_dir_in(fx.root()).join("sessions")).unwrap().flatten().next().unwrap().path());
    assert!(!text.contains("rowKey"));
}

#[test]
fn lookup_goes_falcon_session_then_thread_then_tab_and_the_newest_wins() {
    let fx = Fx::new("lookup");
    let pin = |h: &str| VaultPin { id: "v".into(), hash: h.into() };
    let mut a = session::record("codex", "hosted", "tab-1", pin("aaaaaaaaaaaa"), "", "");
    a.falcon_session = Some("fs-1".into());
    session::write(fx.root(), &a).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let mut b = session::record("codex", "raw", "tab-2", pin("bbbbbbbbbbbb"), "", "");
    b.thread_id = Some("th-1".into());
    session::write(fx.root(), &b).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let c = session::record("codex", "raw", "tab-1", pin("cccccccccccc"), "", "");
    session::write(fx.root(), &c).unwrap();
    let hash = |t: &str, f: Option<&str>, th: Option<&str>| session::find(fx.root(), t, f, th).unwrap().map(|r| r.vault.hash);
    assert_eq!(hash("tab-2", Some("fs-1"), Some("th-1")).as_deref(), Some("aaaaaaaaaaaa"), "falconSession first");
    assert_eq!(hash("tab-1", Some("fs-none"), Some("th-1")).as_deref(), Some("bbbbbbbbbbbb"), "then threadId");
    assert_eq!(hash("tab-1", None, None).as_deref(), Some("cccccccccccc"), "then tab, newest");
    assert_eq!(hash("tab-9", None, None), None);
    std::thread::sleep(std::time::Duration::from_millis(5));
    let t = session::append_thread_id(fx.root(), "tab-1", Some("fs-1"), "th-2").unwrap().unwrap();
    assert_eq!((t.thread_id.as_deref(), t.vault.hash.as_str()), (Some("th-2"), "aaaaaaaaaaaa"));
    assert_eq!(hash("x", None, Some("th-2")).as_deref(), Some("aaaaaaaaaaaa"));
    assert!(session::append_thread_id(fx.root(), "none", None, "th-3").unwrap().is_none());
}

#[test]
fn make_variant_leaves_the_tab_record_on_the_locked_vault() {
    let fx = Fx::new("move");
    let v = full_vault(&fx, "Gate Move");
    let pin = VaultPin { id: v.id.clone(), hash: v.hash.clone() };
    let mut r = session::record("claude", "rendered", "tab-m", pin.clone(), "h", "l");
    r.falcon_session = Some("fs-m".into());
    r.thread_id = Some("th-m".into());
    session::write(fx.root(), &r).unwrap();
    fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    let var = fx.store().edit(&v.id, &[Op::RemoveRune(base_ref("gate-skill"))], EditMode::Variant).unwrap();
    assert_ne!(var.id, v.id);
    // the variant is for new sessions: nothing repoints the tab's or the thread's record
    for found in [
        session::find(fx.root(), "tab-m", None, None).unwrap().unwrap(),
        session::find(fx.root(), "tab-m", Some("fs-m"), None).unwrap().unwrap(),
        session::find(fx.root(), "x", None, Some("th-m")).unwrap().unwrap(),
    ] {
        assert_eq!(found.vault, pin, "the record keeps the vault the session loaded");
    }
    assert!(fx.store().get(&v.id).unwrap().locked_utc.is_some(), "the original stays locked");
}

#[test]
fn a_variant_of_a_copy_never_takes_a_reserved_id() {
    let fx = Fx::new("variant-id");
    let base = base_vault(&fx);
    let ops = [Op::AddRune(base_ref("gate-skill"))];
    let copy = fx.store().start_copy(&base.id, None, &[], &[]).unwrap();
    let a = fx.store().edit(&copy.id, &ops, EditMode::Variant).unwrap();
    assert_eq!(a.id, "base-variant", "a copy's variant is named from its name, never `copy-`");
    let b = fx.store().edit(&copy.id, &ops, EditMode::Variant).unwrap();
    assert_eq!(b.id, "base-variant-2");
    for id in [&a.id, &b.id] {
        assert!(!id.starts_with("custom-") && !id.starts_with("copy-"), "{id}");
    }
}

#[test]
fn adopt_with_no_record_builds_or_reuses_a_vault_from_the_echoed_sets() {
    let fx = Fx::new("adopt");
    assert!(session::find(fx.root(), "t-old", Some("s-old-0001"), None).unwrap().is_none());
    let a = session::adopt(fx.root(), "claude", "t-old", "s-old-0001", &[installed_set()]).unwrap();
    let b = session::adopt(fx.root(), "claude", "t-old2", "s-old-0002", &[installed_set()]).unwrap();
    assert_ne!(a.vault.id, b.vault.id, "each adopted session starts its own copy");
    assert_eq!(a.vault.hash, b.vault.hash);
    let again = session::adopt(fx.root(), "claude", "t-old", "s-old-0001", &[installed_set()]).unwrap();
    assert_eq!(again.vault, a.vault, "the same Falcon session adopted twice keeps its first record");
    let r = session::find(fx.root(), "t-other", Some("s-old-0001"), None).unwrap().expect("adopt wrote the record");
    assert_eq!(r.vault, a.vault);
    let v = fx.store().get(&a.vault.id).unwrap();
    let vidar = SetSource { library: "vidar".into(), set: "vidar".into() };
    assert_eq!(v.runesets.iter().map(|s| s.source.clone()).collect::<Vec<_>>(), vec![vidar, installed_set()]);
}

// ---- the Runes View read (L3b1) ----

#[test]
fn the_view_read_lists_every_rune_by_runeset_and_redacts_item_runes() {
    let fx = Fx::new("view");
    let v = full_vault(&fx, "Gate View");
    let view = super::read_view(&fx.store(), Some(&v.id), None).unwrap();
    let wire = serde_json::to_string(&view).unwrap();
    assert!(!wire.contains("sk-secret-1") && !wire.contains("gate-notify"), "a hook command reached the view: {wire}");
    assert!(view.warnings.is_empty(), "{:?}", view.warnings);
    let keys: Vec<(Option<String>, String, bool)> = view.runes.iter().map(|r| (r.set.as_ref().map(|s| s.set.clone()), format!("{}/{}", r.library, r.id), r.recall)).collect();
    assert_eq!(&keys[..4], &[
        (Some("installed".into()), "installed/team-verdict-first".into(), false),
        (Some("installed".into()), "installed/team-plain-words".into(), false),
        (Some("installed".into()), "base/gate-fact".into(), false),
        (Some("installed".into()), "installed/team-recall-tip".into(), true),
    ]);
    assert!(view.runes[4..].iter().all(|r| r.set.is_none()), "one-offs come last, outside any runeset");
    let cmd = view.runes.iter().find(|r| r.id == "gate-hook-command").unwrap();
    assert_eq!((cmd.body.as_str(), cmd.item.as_ref().unwrap().label), ("", "Command Hook"));
    let mcp = view.runes.iter().find(|r| r.id == "vidar-drive").unwrap();
    assert_eq!((mcp.body.as_str(), mcp.item.as_ref().unwrap().label), ("", "MCP Server"));
    assert!(serde_json::to_string(mcp).unwrap().find("vidar_drive").is_none(), "an MCP server field reached the view");
    let rule = view.runes.iter().find(|r| r.id == "team-verdict-first").unwrap();
    assert!(rule.body.contains("GATE-RULE-TEAM-VERDICT-FIRST") && rule.item.is_none() && !rule.drift);
}

#[test]
fn a_rune_two_placed_runesets_share_is_listed_once_and_names_the_second_in_also() {
    let fx = Fx::new("view-shared");
    // `second` shares a slot, a cross-library slot and the recall member with `installed`, and has one of its own
    fx.edit_rune(
        "installed",
        "sets",
        "second",
        "---\nname: second\nkind: set\nscope: [global]\ndescription: Second runeset sharing runes with installed\n---\n- <?rune team-plain-words?>\n- <?rune base/gate-fact?>\n- <?rune base/bare-identity?>\n\n<?recall?>\n",
    );
    let second = SetSource { library: "installed".into(), set: "second".into() };
    let s = fx.store();
    let v = s.create("Shared", None, &[installed_set(), second.clone()], &[]).unwrap();
    let view = super::read_view(&s, Some(&v.id), None).unwrap();
    assert!(view.warnings.is_empty(), "{:?}", view.warnings);
    let row = |id: &str| -> Vec<&super::ViewRune> { view.runes.iter().filter(|r| r.id == id).collect() };
    for id in ["team-plain-words", "gate-fact", "team-recall-tip"] {
        let rows = row(id);
        assert_eq!(rows.len(), 1, "{id} is listed once");
        assert_eq!(rows[0].set.as_ref(), Some(&installed_set()), "{id} sits under the first runeset");
        assert_eq!(rows[0].also, vec![second.clone()], "{id} names the second runeset in also");
    }
    let own = row("bare-identity");
    assert_eq!((own.len(), own[0].set.as_ref(), own[0].also.is_empty()), (1, Some(&second), true));
    assert!(row("team-verdict-first")[0].also.is_empty(), "a rune only the first holds names no other");
    let loads: Vec<String> = s.resolve(&v.id).unwrap().runes.iter().map(|r| format!("{}/{}", r.library, r.id)).collect();
    assert_eq!(loads.iter().filter(|k| k.as_str() == "installed/team-plain-words").count(), 1, "a shared rune still loads once: {loads:?}");
    let wire = serde_json::to_string(&view).unwrap();
    assert!(wire.contains(r#""also":[{"library":"installed","set":"second"}]"#), "{wire}");
}

#[test]
fn a_locked_view_shows_the_copy_at_lock_and_flags_the_rune_edited_after() {
    let fx = Fx::new("view-locked");
    let v = full_vault(&fx, "Gate View Locked");
    fx.store().lock(&v.id, LockedBy::Button, &v.hash).unwrap();
    fx.edit_rune("installed", "rules", "team-verdict-first", "---\nname: team-verdict-first\nkind: rule\nscope: [global]\ndescription: Team rule one\n---\nEDITED-AFTER-LOCK\n");
    let view = super::read_view(&fx.store(), Some(&v.id), Some(&v.hash)).unwrap();
    let rule = view.runes.iter().find(|r| r.id == "team-verdict-first").unwrap();
    assert!(rule.body.contains("GATE-RULE-TEAM-VERDICT-FIRST") && !rule.body.contains("EDITED-AFTER-LOCK"), "{}", rule.body);
    assert!(rule.drift);
    assert_eq!(view.runes.iter().filter(|r| r.drift).count(), 1);
    assert_eq!(view.drift, vec![RuneRef { library: "installed".into(), id: "team-verdict-first".into() }]);
    assert!(!serde_json::to_string(&view).unwrap().contains("sk-secret-1"));
}

#[test]
fn the_command_refuses_a_duplicate_vault_name_but_not_a_copy_with_it() {
    use super::create_typed_at as typed;
    let t = TempDir::new("dup");
    let s = Store::open(&t.0);
    typed(&t.0, Some("Mascot Fact".into()), None, &[], &[]).unwrap();
    assert_eq!(typed(&t.0, Some("  mascot fact ".into()), None, &[], &[]).unwrap_err(), "exists: mascot fact");
    // Internal callers (Store::create) keep the id suffix.
    assert_eq!(s.create("Mascot Fact", None, &[], &[]).unwrap().id, "mascot-fact-2");
    let named = crate::paths::rune_vaults_dir_in(&t.0).join("copy-1-aa");
    std::fs::create_dir_all(&named).unwrap();
    let mut v: serde_json::Value = crate::fsx::read_json(&crate::paths::rune_vaults_dir_in(&t.0).join("mascot-fact/vault.json")).unwrap();
    v["id"] = "copy-1-aa".into();
    v["name"] = "Spare Name".into();
    std::fs::write(named.join("vault.json"), serde_json::to_string(&v).unwrap()).unwrap();
    assert!(s.list().unwrap().iter().any(|l| l.id == "copy-1-aa" && l.name == "Spare Name"), "the copy vault is listed");
    typed(&t.0, Some("Spare Name".into()), None, &[], &[]).unwrap();
}
