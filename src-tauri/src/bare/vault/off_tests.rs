//! src-tauri\src\bare\vault\off_tests.rs — a rune switched off in Modify stays in the vault, listed off:
//! a one-off through `Vault::off`, a runeset slot member through
//! its copy's `slot-off` header. Neither loads; both reach `rune_vault_read`'s `off` list after the edit
//! lands (Done) and in a variant.

use std::path::{Path, PathBuf};

use super::store::{EditMode, Op, Store};
use super::{LockedBy, MemberEdit, RuneRef, SetSource};

struct Fx(PathBuf);
impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-vault-off-{tag}-{}-{nanos}", std::process::id()));
        let fixture = crate::paths::root().join("tests").join("fixtures").join("rune-vault");
        copy_dir(&fixture.join("stock-runes"), &crate::paths::rune_stock_dir_in(&p));
        copy_dir(&fixture.join("kit"), &crate::paths::rune_imports_dir_in(&p).join("kit"));
        Fx(p)
    }
    fn store(&self) -> Store {
        Store::open(&self.0)
    }
    fn copy(&self, id: &str) -> String {
        std::fs::read_to_string(crate::paths::rune_vaults_dir_in(&self.0).join(id).join("sets").join("kit--kit.md")).unwrap()
    }
}
impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
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

fn stock(id: &str) -> RuneRef {
    RuneRef { library: "stock".into(), id: id.into() }
}

fn kit_set() -> SetSource {
    SetSource { library: "kit".into(), set: "kit".into() }
}

fn member(lib: &str, id: &str, on: bool) -> Op {
    Op::Member(MemberEdit { library: "kit".into(), runeset: "kit".into(), rune: RuneRef { library: lib.into(), id: id.into() }, on })
}

fn loads(s: &Store, id: &str) -> Vec<String> {
    s.resolve(id).unwrap().runes.iter().map(|r| format!("{}/{}", r.library, r.id)).collect()
}

/// `rune_vault_read`'s lists for vault `id` now: (listed on, listed off), each `set|library/id`.
fn listed(s: &Store, id: &str) -> (Vec<String>, Vec<String>) {
    let v = super::read_view(s, id, None).unwrap();
    let key = |r: &super::ViewRune| format!("{}|{}/{}", r.set.as_ref().map(|s| s.set.as_str()).unwrap_or(""), r.library, r.id);
    (v.runes.iter().map(key).collect(), v.off.iter().map(key).collect())
}

#[test]
fn a_one_off_switched_off_stays_listed_off_after_the_edit_lands_and_comes_back_on() {
    let fx = Fx::new("oneoff");
    let s = fx.store();
    let v = s.create("Plain", None, &[],&[stock("bare-identity"), stock("vidar-app")]).unwrap();
    let edited = s.edit(&v.id, &[Op::RemoveRune(stock("bare-identity"))], EditMode::Unlocked).unwrap();
    assert_eq!(edited.runes, vec![stock("vidar-app")]);
    assert_eq!(edited.off, vec![stock("bare-identity")]);
    assert_eq!(edited.hash, super::vault_hash(&[], &edited.runes), "the off list is outside the hash");
    assert!(!loads(&s, &v.id).contains(&"stock/bare-identity".to_string()), "an off one-off never loads");
    let (on, off) = listed(&s, &v.id);
    assert!(!on.contains(&"|stock/bare-identity".to_string()), "{on:?}");
    assert_eq!(off, vec!["|stock/bare-identity".to_string()], "listed off after Done");

    let back = s.edit(&v.id, &[Op::AddRune(stock("bare-identity"))], EditMode::Unlocked).unwrap();
    assert!(back.off.is_empty() && back.runes.contains(&stock("bare-identity")));
    assert!(listed(&s, &v.id).1.is_empty());
    let json = std::fs::read_to_string(crate::paths::rune_vaults_dir_in(&fx.0).join(&v.id).join("vault.json")).unwrap();
    assert!(!json.contains("\"off\":"), "an empty off list is not written: {json}");
}

#[test]
fn a_one_off_switched_off_in_a_variant_is_listed_off_there_and_the_original_keeps_it_on() {
    let fx = Fx::new("oneoff-var");
    let s = fx.store();
    let v = s.create("Var", None, &[], &[stock("bare-identity"), stock("vidar-app")]).unwrap();
    s.resolve(&v.id).unwrap();
    s.lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    let var = s.edit(&v.id, &[Op::RemoveRune(stock("bare-identity"))], EditMode::Variant).unwrap();
    assert_ne!(var.id, v.id);
    assert_eq!(listed(&s, &var.id).1, vec!["|stock/bare-identity".to_string()]);
    let (on, off) = listed(&s, &v.id);
    assert!(on.contains(&"|stock/bare-identity".to_string()) && off.is_empty(), "the original is untouched: {on:?} {off:?}");
}

#[test]
fn a_slot_member_switched_off_stays_listed_off_in_its_runeset_and_comes_back_on() {
    let fx = Fx::new("slot");
    let s = fx.store();
    let v = s.create("Slot", None, &[kit_set()], &[]).unwrap();
    s.edit(&v.id, &[member("kit", "kit-plain-words", false), member("stock", "gate-fact", false)], EditMode::Unlocked).unwrap();
    let copy = fx.copy(&v.id);
    assert!(copy.contains("slot-off: [kit-plain-words, stock/gate-fact]"), "{copy}");
    assert!(!copy.contains("<?rune kit-plain-words?>") && !copy.contains("<?rune stock/gate-fact?>"), "{copy}");
    let got = loads(&s, &v.id);
    assert!(!got.contains(&"kit/kit-plain-words".to_string()) && !got.contains(&"stock/gate-fact".to_string()), "{got:?}");
    let (on, off) = listed(&s, &v.id);
    assert!(!on.iter().any(|k| k.ends_with("kit-plain-words")), "{on:?}");
    assert_eq!(off, vec!["kit|kit/kit-plain-words".to_string(), "kit|stock/gate-fact".to_string()], "listed off in the runeset after Done");

    s.edit(&v.id, &[member("kit", "kit-plain-words", true)], EditMode::Unlocked).unwrap();
    let copy = fx.copy(&v.id);
    assert!(copy.contains("slot-off: [stock/gate-fact]") && copy.contains("- <?rune kit-plain-words?>"), "{copy}");
    s.edit(&v.id, &[member("stock", "gate-fact", true)], EditMode::Unlocked).unwrap();
    let copy = fx.copy(&v.id);
    assert!(!copy.contains("slot-off") && copy.contains("<?rune stock/gate-fact?>"), "{copy}");
    assert!(listed(&s, &v.id).1.is_empty());
    let again = s.edit(&v.id, &[member("stock", "gate-fact", false)], EditMode::Unlocked).unwrap();
    let twice = s.edit(&v.id, &[member("stock", "gate-fact", false)], EditMode::Unlocked).unwrap();
    assert_eq!(again.hash, twice.hash, "off for an off slot member is a no-op");
}

#[test]
fn a_slot_member_switched_off_in_a_variant_is_listed_off_there() {
    let fx = Fx::new("slot-var");
    let s = fx.store();
    let v = s.create("Slot Var", None, &[kit_set()], &[]).unwrap();
    s.resolve(&v.id).unwrap();
    s.lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    let var = s.edit(&v.id, &[member("kit", "kit-plain-words", false)], EditMode::Variant).unwrap();
    assert_eq!(listed(&s, &var.id).1, vec!["kit|kit/kit-plain-words".to_string()]);
    assert!(listed(&s, &v.id).1.is_empty(), "the locked original keeps it on");
}

#[test]
fn a_runeset_switched_off_whole_stays_listed_off_with_its_runes_and_comes_back_on() {
    let fx = Fx::new("set-off");
    let s = fx.store();
    let v = s.create("Set Off", None, &[kit_set()], &[stock("vidar-app")]).unwrap();
    let edited = s.edit(&v.id, &[Op::RemoveRuneset(kit_set())], EditMode::Unlocked).unwrap();
    assert!(edited.runesets.is_empty());
    assert_eq!(edited.off_sets, vec![kit_set()]);
    assert_eq!(edited.hash, super::vault_hash(&[], &edited.runes), "the off sets are outside the hash");
    assert!(loads(&s, &v.id).iter().all(|k| !k.starts_with("kit/")), "an off runeset never loads");
    let (on, off) = listed(&s, &v.id);
    assert!(!on.iter().any(|k| k.starts_with("kit|")), "{on:?}");
    assert!(off.contains(&"kit|kit/kit-plain-words".to_string()) && off.contains(&"kit|stock/gate-fact".to_string()), "{off:?}");
    // carried through an unrelated edit
    let later = s.edit(&v.id, &[Op::RemoveRune(stock("vidar-app"))], EditMode::Unlocked).unwrap();
    assert_eq!(later.off_sets, vec![kit_set()]);
    assert!(listed(&s, &v.id).1.contains(&"kit|kit/kit-plain-words".to_string()));

    let back = s.edit(&v.id, &[Op::AddRuneset(kit_set())], EditMode::Unlocked).unwrap();
    assert!(back.off_sets.is_empty() && back.runesets.len() == 1);
    assert!(listed(&s, &v.id).1.iter().all(|k| k.starts_with('|')), "only the one-off stays off");
    let json = std::fs::read_to_string(crate::paths::rune_vaults_dir_in(&fx.0).join(&v.id).join("vault.json")).unwrap();
    assert!(!json.contains("offSets"), "an empty list is not written: {json}");
}

#[test]
fn a_runeset_switched_off_in_a_variant_is_listed_off_there_and_the_original_keeps_it_on() {
    let fx = Fx::new("set-off-var");
    let s = fx.store();
    let v = s.create("Set Var", None, &[kit_set()], &[]).unwrap();
    s.resolve(&v.id).unwrap();
    s.lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    let var = s.edit(&v.id, &[Op::RemoveRuneset(kit_set())], EditMode::Variant).unwrap();
    assert_eq!(var.off_sets, vec![kit_set()]);
    assert!(listed(&s, &var.id).1.contains(&"kit|kit/kit-plain-words".to_string()));
    let (on, off) = listed(&s, &v.id);
    assert!(on.contains(&"kit|kit/kit-plain-words".to_string()) && off.is_empty(), "{on:?} {off:?}");
}

/// A vault with a one-off, a switched-off one-off, a switched-off slot member and a switched-off runeset, all of
/// library `kit` but the cross-library `stock/gate-fact` slot, which must survive a prune of `kit`.
fn with_offs(s: &Store, name: &str) -> super::Vault {
    let kit_rune = RuneRef { library: "kit".into(), id: "kit-plain-words".into() };
    let v = s.create(name, None, &[kit_set()], &[kit_rune.clone()]).unwrap();
    s.edit(&v.id, &[Op::RemoveRune(kit_rune), member("kit", "kit-plain-words", false), member("stock", "gate-fact", false)], EditMode::Unlocked).unwrap()
}

#[test]
fn deleting_a_library_rune_prunes_every_vaults_off_lists_and_a_locked_vault_keeps_its_text() {
    let fx = Fx::new("prune");
    let s = fx.store();
    let a = with_offs(&s, "Open Vault");
    let b = with_offs(&s, "Locked Vault");
    s.resolve(&b.id).unwrap();
    let locked = s.lock(&b.id, LockedBy::FirstMessage, &b.hash).unwrap();
    assert!(fx.copy(&a.id).contains("slot-off: [kit-plain-words, stock/gate-fact]"));

    let done = crate::bare::library_delete::delete_in(&fx.0, "kit", Some("kit-plain-words")).unwrap();
    assert!(!done.vaults.contains(&locked.name), "the delete never edits a locked vault's runes");
    for id in [&a.id, &b.id] {
        let v = s.get(id).unwrap();
        assert!(v.off.is_empty(), "{id}: {:?}", v.off);
        let copy = fx.copy(id);
        assert!(copy.contains("slot-off: [stock/gate-fact]") && !copy.contains("slot-off: [kit-plain-words"), "{id}: {copy}");
    }
    let after = s.get(&b.id).unwrap();
    assert_eq!((after.locked_utc.clone(), after.hash.clone()), (locked.locked_utc.clone(), locked.hash.clone()), "still locked at its hash");
    let rev = crate::paths::rune_vaults_dir_in(&fx.0).join(&b.id).join("revs").join(&locked.hash);
    assert!(rev.is_dir(), "the locked vault's loaded revision stays");
}

#[test]
fn deleting_a_whole_library_prunes_the_off_runesets_and_the_off_one_offs_of_every_vault() {
    let fx = Fx::new("prune-lib");
    let s = fx.store();
    let a = with_offs(&s, "Open Vault");
    let kept = s.edit(&a.id, &[Op::RemoveRuneset(kit_set())], EditMode::Unlocked).unwrap();
    assert_eq!(kept.off_sets, vec![kit_set()]);
    let b = s.create("Locked Vault", None, &[], &[stock("vidar-app")]).unwrap();
    s.resolve(&b.id).unwrap();
    s.lock(&b.id, LockedBy::FirstMessage, &b.hash).unwrap();
    assert_eq!(s.prune_off("kit", None).unwrap(), vec!["Open Vault".to_string()]);
    let a = s.get(&a.id).unwrap();
    assert!(a.off.is_empty() && a.off_sets.is_empty(), "{:?} {:?}", a.off, a.off_sets);
    assert!(s.prune_off("kit", None).unwrap().is_empty(), "nothing left to prune");
}
