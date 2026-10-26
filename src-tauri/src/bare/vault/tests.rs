//! src-tauri\src\bare\vault\tests.rs — store, lock, drift and session-record tests. These cover the
//! `vault_gate_tests` cases marked for L1b while that file cannot compile (it calls later lanes' API).

use std::path::{Path, PathBuf};

use super::session::{self, VaultPin};
use super::store::{self, EditMode, Op, Store};
use super::{content_sha, sha12, vault_hash, LockedBy, RuneRef, SetSource, Template, Vault, VaultFrom};

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

/// A temp root holding the fixture `stock` library and `kit` as an import library.
struct Fx(TempDir);
impl Fx {
    fn new(tag: &str) -> Fx {
        let t = TempDir::new(tag);
        copy_dir(&fixture().join("stock-runes"), &crate::paths::rune_stock_dir_in(&t.0));
        copy_dir(&fixture().join("kit"), &crate::paths::rune_imports_dir_in(&t.0).join("kit"));
        Fx(t)
    }
    fn root(&self) -> &Path {
        &self.0 .0
    }
    fn store(&self) -> Store {
        Store::open(self.root())
    }
    fn edit_rune(&self, lib: &str, folder: &str, id: &str, text: &str) {
        let dir = if lib == "stock" { crate::paths::rune_stock_dir_in(self.root()) } else { crate::paths::rune_imports_dir_in(self.root()).join(lib) };
        std::fs::write(dir.join(folder).join(format!("{id}.md")), text).unwrap();
    }
}

fn stock(id: &str) -> RuneRef {
    RuneRef { library: "stock".into(), id: id.into() }
}

fn kit_set() -> SetSource {
    SetSource { library: "kit".into(), set: "kit".into() }
}

const ALL_ONE_OFFS: &[&str] = &[
    "bare-identity", "gate-recall", "gate-skill", "gate-agent", "gate-hook-run", "gate-hook-command", "vidar-drive", "gate-permission", "vidar-app",
];

fn full_vault(fx: &Fx, name: &str) -> Vault {
    let runes: Vec<RuneRef> = ALL_ONE_OFFS.iter().map(|id| stock(id)).collect();
    fx.store().create(name, None, &[kit_set()], &runes).unwrap()
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
    assert!(locked.pins.contains_key("kit/kit-recall-tip"), "a recall member is pinned at lock");
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
    let op: Op = serde_json::from_str(r#"{"op":"removeRune","ref":{"library":"stock","id":"x"}}"#).unwrap();
    assert_eq!(op, Op::RemoveRune(stock("x")));
    let op: Op = serde_json::from_str(r#"{"op":"addRuneset","ref":{"library":"kit","set":"kit"}}"#).unwrap();
    assert_eq!(op, Op::AddRuneset(kit_set()));
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
    assert!(v.runesets[0].file.ends_with("kit--kit.md"));
    let dir = crate::paths::rune_vaults_dir_in(fx.root()).join("gate-full");
    assert_eq!(std::fs::read(dir.join("sets/kit--kit.md")).unwrap(), std::fs::read(fixture().join("kit/sets/kit.md")).unwrap(), "a byte copy");
    let r = fx.store().resolve(&v.id).unwrap();
    let ids: Vec<String> = r.runes.iter().map(|x| format!("{}/{}", x.library, x.id)).collect();
    for want in ["kit/kit-verdict-first", "kit/kit-plain-words", "stock/gate-fact", "kit/kit-recall-tip"] {
        assert!(ids.contains(&want.to_string()), "{want} missing: {ids:?}");
    }
    for id in ALL_ONE_OFFS {
        assert!(ids.contains(&format!("stock/{id}")), "{id} missing: {ids:?} {:?}", r.warnings);
    }
    assert!(r.runes.iter().any(|x| x.id == "kit-recall-tip" && x.recall));
    assert!(r.drift.is_empty());
    // A second vault of the same name takes the next id; reserved names refuse.
    assert_eq!(fx.store().create("Gate Full", None, &[], &[]).unwrap().id, "gate-full-2");
    for bad in ["Sessions", "defaults", "Stock Claude", "custom-abc123", "!!"] {
        assert!(fx.store().create(bad, None, &[], &[]).is_err(), "{bad}");
    }
    assert_eq!(fx.store().list().unwrap().len(), 2);
}

#[test]
fn a_vault_from_a_template_copies_it_and_the_template_stays() {
    let fx = Fx::new("template");
    let dir = crate::paths::rune_templates_dir_in(fx.root());
    std::fs::create_dir_all(&dir).unwrap();
    let template = Template { version: 1, id: "stock-claude".into(), name: "Stock Claude".into(), runesets: vec![kit_set()], runes: vec![stock("bare-identity")] };
    let t = serde_json::to_string(&template).unwrap();
    std::fs::write(dir.join("stock-claude.json"), &t).unwrap();
    let v = fx.store().create("Mine", Some(VaultFrom::Template { template: "stock-claude".into() }), &[], &[stock("gate-skill")]).unwrap();
    assert_eq!(v.runes, vec![stock("bare-identity"), stock("gate-skill")]);
    assert_eq!(v.runesets[0].source, kit_set());
    assert_eq!(read(&dir.join("stock-claude.json")), t);
    let listed = fx.store().list().unwrap();
    assert!(listed.iter().any(|l| l.id == "stock-claude" && l.template));
    assert!(listed.iter().any(|l| l.id == "mine" && !l.template));
}

#[test]
fn stock_vault_edit_survives_ensure_and_template_change() {
    let fx = Fx::new("stock-edit");
    let dir = crate::paths::rune_templates_dir_in(fx.root());
    std::fs::create_dir_all(&dir).unwrap();
    let template = Template { version: 1, id: "stock-claude".into(), name: "Stock Claude".into(), runesets: vec![], runes: vec![stock("bare-identity")] };
    std::fs::write(dir.join("stock-claude.json"), serde_json::to_vec(&template).unwrap()).unwrap();
    let original = fx.store().ensure_stock("stock-claude").unwrap();
    let edited = fx.store().edit(&original.id, &[Op::AddRune(stock("gate-skill"))], EditMode::Unlocked).unwrap();
    std::fs::write(dir.join("stock-claude.json"), serde_json::to_vec(&Template { runes: vec![], ..template }).unwrap()).unwrap();
    assert_eq!(fx.store().ensure_stock("stock-claude").unwrap(), edited);
}

#[test]
fn an_identical_custom_pick_reuses_its_vault() {
    let fx = Fx::new("custom");
    let a = fx.store().create_custom(&[kit_set()], &[]).unwrap();
    let b = fx.store().create_custom(&[kit_set()], &[]).unwrap();
    assert_eq!(a.id, b.id);
    assert!(a.id.starts_with("custom-") && a.id.len() == "custom-".len() + 6, "{}", a.id);
    let c = fx.store().create_custom(&[kit_set()], &[stock("gate-skill")]).unwrap();
    assert_ne!(c.id, a.id);
    assert_eq!(fx.store().list().unwrap().iter().filter(|v| v.id.starts_with("custom-")).count(), 2);
}

#[test]
fn a_cross_library_slot_resolves_and_the_runeset_copy_does_not_follow_its_original() {
    let fx = Fx::new("cross-lib");
    let v = fx.store().create("Gate Kit Only", None, &[kit_set()], &[stock("bare-identity")]).unwrap();
    let has_fact = |fx: &Fx| fx.store().resolve(&v.id).unwrap().runes.iter().any(|x| x.library == "stock" && x.id == "gate-fact");
    assert!(has_fact(&fx));
    fx.edit_rune("kit", "sets", "kit", "---\nname: kit\nkind: set\nscope: [global]\n---\n- <?rune kit-plain-words?>\n");
    assert!(has_fact(&fx), "the vault's runeset copy followed its original");
}

// ---- lock, variant, invalidate, drift ----

#[test]
fn a_pre_lock_edit_changes_the_hash_and_lock_refuses_a_stale_session_hash() {
    let fx = Fx::new("lock");
    let v = full_vault(&fx, "Gate Lock");
    let edited = fx.store().edit(&v.id, &[Op::RemoveRune(stock("gate-agent"))], EditMode::Unlocked).unwrap();
    assert_eq!(edited.id, v.id, "an unlocked edit stays on the vault");
    assert_ne!(edited.hash, v.hash);
    let e = fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).err().unwrap();
    assert!(e.contains("hash"), "{e}");
    let locked = fx.store().lock(&v.id, LockedBy::FirstMessage, &edited.hash).unwrap();
    assert_eq!(locked.hash, edited.hash, "lock is outside the hash");
    assert_eq!(locked.locked_by, Some(LockedBy::FirstMessage));
    assert!(locked.locked_utc.is_some() && !locked.pins.is_empty());
    assert!(locked.pins.contains_key("kit/kit-recall-tip") && locked.pins.contains_key("stock/gate-fact"));
    let again = fx.store().lock(&v.id, LockedBy::Button, &edited.hash).unwrap();
    assert_eq!(again.locked_by, Some(LockedBy::FirstMessage), "lock is idempotent; the first lock stands");
    assert!(fx.store().lock(&v.id, LockedBy::Button, &v.hash).err().unwrap().contains("hash"));
    assert!(fx.store().edit(&v.id, &[Op::AddRune(stock("gate-agent"))], EditMode::Unlocked).is_err());
    let var = fx.store().edit(&v.id, &[Op::AddRune(stock("gate-agent"))], EditMode::Variant).unwrap();
    assert_ne!(var.id, v.id);
    assert!(matches!(&var.from, Some(VaultFrom::Vault { vault, hash }) if vault == &v.id && hash == &edited.hash));
    assert!(var.locked_utc.is_none(), "a variant starts unlocked");
    assert_eq!(fx.store().get(&v.id).unwrap(), again, "a variant leaves the locked original untouched");
    let inv = fx.store().edit(&v.id, &[Op::AddRune(stock("gate-agent"))], EditMode::Invalidate).unwrap();
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
    fx.edit_rune("kit", "rules", "kit-verdict-first", "---\nname: kit-verdict-first\nkind: rule\nscope: [global]\ndescription: Kit rule one\n---\nEDITED-AFTER-LOCK\n");
    let r = fx.store().resolve(&v.id).unwrap();
    let body = &r.runes.iter().find(|x| x.library == "kit" && x.id == "kit-verdict-first").unwrap().body;
    assert!(body.contains("GATE-RULE-KIT-VERDICT-FIRST") && !body.contains("EDITED-AFTER-LOCK"), "{body}");
    assert_eq!(r.drift, vec![RuneRef { library: "kit".into(), id: "kit-verdict-first".into() }]);
    assert_eq!(fx.store().drift(&v.id).unwrap(), r.drift);
    let unlocked = full_vault(&fx, "Gate Drift Open");
    assert!(fx.store().drift(&unlocked.id).unwrap().is_empty());
}

#[test]
fn recall_members_of_a_locked_vault_come_only_from_its_pins() {
    let fx = Fx::new("recall-pins");
    let v = full_vault(&fx, "Gate Recall");
    let locked = fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    assert!(locked.pins.contains_key("kit/kit-recall-tip"));
    fx.edit_rune("kit", "procedures", "kit-recall-late", "---\nname: kit-recall-late\nkind: procedure\nscope: [global]\nactivate: recall\ndescription: Added after lock\n---\nGATE-PROCEDURE-KIT-RECALL-LATE\n");
    let r = fx.store().resolve(&v.id).unwrap();
    assert!(r.runes.iter().any(|x| x.id == "kit-recall-tip" && x.recall));
    assert!(!r.runes.iter().any(|x| x.id == "kit-recall-late"), "a recall rune added after lock joined a locked vault");
    // The open vault sees the new member.
    let open = full_vault(&fx, "Gate Recall Open");
    assert!(fx.store().resolve(&open.id).unwrap().runes.iter().any(|x| x.id == "kit-recall-late"));
}

#[test]
fn a_disabled_runeset_loads_nothing_and_its_slot_leaves_the_rune_to_a_later_recall() {
    let fx = Fx::new("disabled-set");
    // A Disabled set first: it slots the recall rune the active `kit` set loads through `<?recall?>`,
    // and one rule no other set names.
    fx.edit_rune("kit", "rules", "kit-off-only", "---\nname: kit-off-only\nkind: rule\nscope: [global]\ndescription: Only the off set\n---\nOFF-ONLY\n");
    fx.edit_rune("kit", "sets", "kit-off", "---\nname: kit-off\nkind: set\nscope: [global]\nstate: disabled\n---\n- <?rune kit-recall-tip?>\n- <?rune kit-off-only?>\n");
    let off = SetSource { library: "kit".into(), set: "kit-off".into() };
    let v = fx.store().create("Gate Disabled", None, &[off, kit_set()], &[]).unwrap();
    let check = |label: &str| {
        let r = fx.store().resolve(&v.id).unwrap();
        let tip: Vec<_> = r.runes.iter().filter(|x| x.id == "kit-recall-tip").collect();
        assert_eq!(tip.len(), 1, "{label}: {:?}", r.runes.iter().map(|x| &x.id).collect::<Vec<_>>());
        assert!(tip[0].recall, "{label}: the active set's recall flag");
        assert!(!r.runes.iter().any(|x| x.id == "kit-off-only"), "{label}: a Disabled set's slot loaded");
        assert!(r.runes.iter().any(|x| x.id == "kit-verdict-first"), "{label}");
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
    let variant = fx.store().edit(&v.id, &[Op::RemoveRune(stock("gate-skill"))], EditMode::Variant).unwrap();
    assert_ne!(variant.id, v.id);
    let unlocked_edit = fx.store().edit(&v.id, &[Op::RemoveRune(stock("gate-agent"))], EditMode::Unlocked).unwrap();
    assert_ne!(unlocked_edit.hash, v.hash);
    let found = session::find(fx.root(), "t2-tab", Some("s-gate-0001"), None).unwrap().expect("record by falconSession");
    assert_eq!(found.vault, VaultPin { id: v.id.clone(), hash: v.hash.clone() });
    let shown = fx.store().load_at(&found.vault.id, &found.vault.hash).unwrap();
    assert!(shown.runes.contains(&stock("gate-skill")) && shown.runes.contains(&stock("gate-agent")), "the view shows the vault the session loaded");
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
fn make_variant_moves_the_tab_and_the_earlier_thread_keeps_its_vault() {
    let fx = Fx::new("move");
    let v = full_vault(&fx, "Gate Move");
    let mut r = session::record("claude", "rendered", "tab-m", VaultPin { id: v.id.clone(), hash: v.hash.clone() }, "h", "l");
    r.falcon_session = Some("fs-m".into());
    r.thread_id = Some("th-m".into());
    session::write(fx.root(), &r).unwrap();
    fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    let var = fx.store().edit(&v.id, &[Op::RemoveRune(stock("gate-skill"))], EditMode::Variant).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let pin = VaultPin { id: var.id.clone(), hash: var.hash.clone() };
    let moved = session::move_to(fx.root(), "tab-m", Some("fs-m"), pin.clone()).unwrap().expect("a record to move");
    assert_eq!((moved.vault.clone(), moved.thread_id.clone(), moved.falcon_session.as_deref()), (pin.clone(), None, Some("fs-m")));
    assert_eq!(session::find(fx.root(), "tab-m", None, None).unwrap().unwrap().vault, pin, "the tab respawns on the variant");
    assert_eq!(session::find(fx.root(), "tab-m", Some("fs-m"), None).unwrap().unwrap().vault, pin);
    let earlier = session::find(fx.root(), "x", None, Some("th-m")).unwrap().unwrap();
    assert_eq!(earlier.vault, VaultPin { id: v.id.clone(), hash: v.hash.clone() }, "a Resume of the earlier thread keeps its vault");
    assert!(fx.store().get(&v.id).unwrap().locked_utc.is_some(), "the original stays locked");
    assert!(session::move_to(fx.root(), "none", None, pin).unwrap().is_none());
}

#[test]
fn the_shipped_stock_templates_create_a_vault_and_resolve_every_rune() {
    for (template, ids) in [
        ("stock-claude", vec!["bare-identity", "vidar-app", "gate", "drive-allow", "mode-auto", "mcp-write-asks", "guard-driver", "mcp-gate"]),
        ("stock-codex", vec!["bare-identity-codex", "vidar-drive", "vidar-control", "drive-allow"]),
    ] {
        let t = TempDir::new(template);
        let repo = crate::paths::root();
        copy_dir(&crate::paths::rune_stock_dir_in(&repo), &crate::paths::rune_stock_dir_in(&t.0));
        copy_dir(&crate::paths::rune_templates_dir_in(&repo), &crate::paths::rune_templates_dir_in(&t.0));
        let store = Store::open(&t.0);
        let v = store.create("Probe", Some(VaultFrom::Template { template: template.into() }), &[], &[]).unwrap();
        assert_eq!(v.runes, ids.iter().map(|i| stock(i)).collect::<Vec<_>>(), "{template}");
        let r = store.resolve(&v.id).unwrap();
        for id in ids {
            assert!(r.runes.iter().any(|x| x.library == "stock" && x.id == id), "{template}: {id} did not resolve: {:?}", r.warnings);
        }
    }
}

#[test]
fn adopt_with_no_record_builds_or_reuses_a_vault_from_the_echoed_sets() {
    let fx = Fx::new("adopt");
    let dir = crate::paths::rune_templates_dir_in(fx.root());
    std::fs::create_dir_all(&dir).unwrap();
    let floor = Template { version: 1, id: "stock-claude".into(), name: "Stock Claude".into(), runesets: vec![], runes: vec![] };
    std::fs::write(dir.join("stock-claude.json"), serde_json::to_string(&floor).unwrap()).unwrap();
    assert!(session::find(fx.root(), "t-old", Some("s-old-0001"), None).unwrap().is_none());
    let a = session::adopt(fx.root(), "claude", "t-old", "s-old-0001", &[kit_set()]).unwrap();
    let b = session::adopt(fx.root(), "claude", "t-old2", "s-old-0002", &[kit_set()]).unwrap();
    assert_eq!(a.vault, b.vault, "identical echoed sets reuse one vault by content hash");
    let r = session::find(fx.root(), "t-other", Some("s-old-0001"), None).unwrap().expect("adopt wrote the record");
    assert_eq!(r.vault, a.vault);
    let v = fx.store().get(&a.vault.id).unwrap();
    assert_eq!(v.runesets.iter().map(|s| s.source.clone()).collect::<Vec<_>>(), vec![kit_set()]);
}

// ---- the Runes View read (L3b1) ----

#[test]
fn the_view_read_lists_every_rune_by_runeset_and_redacts_item_runes() {
    let fx = Fx::new("view");
    let v = full_vault(&fx, "Gate View");
    let view = super::read_view(&fx.store(), &v.id, None).unwrap();
    let wire = serde_json::to_string(&view).unwrap();
    assert!(!wire.contains("sk-secret-1") && !wire.contains("gate-notify"), "a hook command reached the view: {wire}");
    assert!(view.warnings.is_empty(), "{:?}", view.warnings);
    let keys: Vec<(Option<String>, String, bool)> = view.runes.iter().map(|r| (r.set.as_ref().map(|s| s.set.clone()), format!("{}/{}", r.library, r.id), r.recall)).collect();
    assert_eq!(&keys[..4], &[
        (Some("kit".into()), "kit/kit-verdict-first".into(), false),
        (Some("kit".into()), "kit/kit-plain-words".into(), false),
        (Some("kit".into()), "stock/gate-fact".into(), false),
        (Some("kit".into()), "kit/kit-recall-tip".into(), true),
    ]);
    assert!(view.runes[4..].iter().all(|r| r.set.is_none()), "one-offs come last, outside any runeset");
    let cmd = view.runes.iter().find(|r| r.id == "gate-hook-command").unwrap();
    assert_eq!((cmd.body.as_str(), cmd.item.as_ref().unwrap().label), ("", "Command Hook"));
    let mcp = view.runes.iter().find(|r| r.id == "vidar-drive").unwrap();
    assert_eq!((mcp.body.as_str(), mcp.item.as_ref().unwrap().label), ("", "MCP Server"));
    assert!(serde_json::to_string(mcp).unwrap().find("vidar_drive").is_none(), "an MCP server field reached the view");
    let rule = view.runes.iter().find(|r| r.id == "kit-verdict-first").unwrap();
    assert!(rule.body.contains("GATE-RULE-KIT-VERDICT-FIRST") && rule.item.is_none() && !rule.drift);
}

#[test]
fn a_locked_view_shows_the_copy_at_lock_and_flags_the_rune_edited_after() {
    let fx = Fx::new("view-locked");
    let v = full_vault(&fx, "Gate View Locked");
    fx.store().lock(&v.id, LockedBy::Button, &v.hash).unwrap();
    fx.edit_rune("kit", "rules", "kit-verdict-first", "---\nname: kit-verdict-first\nkind: rule\nscope: [global]\ndescription: Kit rule one\n---\nEDITED-AFTER-LOCK\n");
    let view = super::read_view(&fx.store(), &v.id, Some(&v.hash)).unwrap();
    let rule = view.runes.iter().find(|r| r.id == "kit-verdict-first").unwrap();
    assert!(rule.body.contains("GATE-RULE-KIT-VERDICT-FIRST") && !rule.body.contains("EDITED-AFTER-LOCK"), "{}", rule.body);
    assert!(rule.drift);
    assert_eq!(view.runes.iter().filter(|r| r.drift).count(), 1);
    assert_eq!(view.drift, vec![RuneRef { library: "kit".into(), id: "kit-verdict-first".into() }]);
    assert!(!serde_json::to_string(&view).unwrap().contains("sk-secret-1"));
}
