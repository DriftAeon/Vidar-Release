//! src-tauri\src\bare\vault\migrate_recall_tests.rs — a `<?recall?>` member switched off is held in the vault's
//! own copy (`recall-off` header), and the recall-member pass moves an old
//! override's `off` list there: backup first, idempotent, never touching a vault it cannot parse.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::migrate_recall;
use super::store::{recall_off, EditMode, Op, Store};
use super::{LockedBy, MemberEdit, RuneRef, SetSource};

struct Fx(PathBuf);
impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-vault-recall-{tag}-{}-{nanos}", std::process::id()));
        let fixture = crate::paths::root().join("tests").join("fixtures").join("rune-vault");
        copy_dir(&fixture.join("stock-runes"), &crate::paths::rune_stock_dir_in(&p));
        copy_dir(&fixture.join("kit"), &crate::paths::rune_imports_dir_in(&p).join("kit"));
        Fx(p)
    }
    fn store(&self) -> Store {
        Store::open(&self.0)
    }
    fn vault_dir(&self, id: &str) -> PathBuf {
        crate::paths::rune_vaults_dir_in(&self.0).join(id)
    }
    fn copy(&self, id: &str) -> Vec<u8> {
        std::fs::read(self.vault_dir(id).join("sets").join("kit--kit.md")).unwrap()
    }
    fn override_off(&self, ids: &[&str]) {
        let dir = crate::paths::legacy_rune_overrides_dir_in(&self.0).join("kit");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kit.json"), serde_json::json!({ "off": ids }).to_string()).unwrap();
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

fn tree(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if e.file_type().unwrap().is_dir() {
            tree(&e.path(), out);
        } else {
            out.insert(e.path(), std::fs::read(e.path()).unwrap());
        }
    }
}

fn kit_set() -> SetSource {
    SetSource { library: "kit".into(), set: "kit".into() }
}

fn member(id: &str, on: bool) -> Op {
    Op::Member(MemberEdit { library: "kit".into(), runeset: "kit".into(), rune: RuneRef { library: "kit".into(), id: id.into() }, on })
}

fn loads(s: &Store, id: &str) -> Vec<String> {
    s.resolve(id).unwrap().runes.iter().map(|r| format!("{}/{}", r.library, r.id)).collect()
}

const TIP: &str = "kit/kit-recall-tip";

#[test]
fn a_recall_member_switches_off_in_the_vault_copy_and_back_on() {
    let fx = Fx::new("toggle");
    let s = fx.store();
    let v = s.create("Recall", None, &[kit_set()], &[]).unwrap();
    let library = std::fs::read(crate::paths::rune_imports_dir_in(&fx.0).join("kit/sets/kit.md")).unwrap();
    assert!(loads(&s, &v.id).contains(&TIP.to_string()));

    let off = s.edit(&v.id, &[member("kit-recall-tip", false)], EditMode::Unlocked).unwrap();
    assert_ne!(off.hash, v.hash, "the copy's header is in the vault hash");
    assert_eq!(recall_off(&fx.copy(&v.id)), vec!["kit-recall-tip".to_string()]);
    let text = String::from_utf8(fx.copy(&v.id)).unwrap().replace('\r', "");
    assert!(text.contains("recall-off: [kit-recall-tip]\n---\n"), "the key goes last in the header: {text}");
    assert!(!loads(&s, &v.id).contains(&TIP.to_string()), "an off recall member does not load");
    let view = super::read_view(&s, &v.id, None).unwrap();
    assert!(!view.runes.iter().any(|r| r.id == "kit-recall-tip"));
    assert_eq!(view.off.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["kit-recall-tip"], "Modify draws it off");
    assert!(view.off[0].recall && view.off[0].set == Some(kit_set()));
    assert_eq!(std::fs::read(crate::paths::rune_imports_dir_in(&fx.0).join("kit/sets/kit.md")).unwrap(), library, "the library runeset is never edited");
    let again = s.edit(&v.id, &[member("kit-recall-tip", false)], EditMode::Unlocked).unwrap();
    assert_eq!(again.hash, off.hash, "off twice is a no-op");

    let on = s.edit(&v.id, &[member("kit-recall-tip", true)], EditMode::Unlocked).unwrap();
    assert_eq!(on.hash, v.hash, "on restores the copy byte for byte");
    assert!(loads(&s, &v.id).contains(&TIP.to_string()));
    assert!(super::read_view(&s, &v.id, None).unwrap().off.is_empty());
    let json = serde_json::to_string(&super::read_view(&s, &v.id, None).unwrap()).unwrap();
    assert!(!json.contains("\"off\""), "an empty off list is not sent");
}

#[test]
fn a_locked_vault_keeps_an_off_recall_member_out_and_a_variant_carries_it() {
    let fx = Fx::new("locked");
    let s = fx.store();
    let v = s.create("Locked", None, &[kit_set()], &[]).unwrap();
    let off = s.edit(&v.id, &[member("kit-recall-tip", false)], EditMode::Unlocked).unwrap();
    s.resolve(&v.id).unwrap();
    let locked = s.lock(&v.id, LockedBy::FirstMessage, &off.hash).unwrap();
    assert!(!locked.pins.contains_key(TIP), "an off member is not pinned");
    assert!(!loads(&s, &v.id).contains(&TIP.to_string()));
    let view = super::read_view(&s, &v.id, None).unwrap();
    assert_eq!(view.off.len(), 1, "a locked view still lists it off, read from its library");
    let cross = Op::Member(MemberEdit { library: "kit".into(), runeset: "kit".into(), rune: RuneRef { library: "stock".into(), id: "gate-fact".into() }, on: false });
    let variant = s.edit(&v.id, &[cross], EditMode::Variant).unwrap();
    assert_eq!(recall_off(&fx.copy(&variant.id)), vec!["kit-recall-tip".to_string()], "a variant copies the off state");
}

#[test]
fn neither_slotted_nor_recalled_still_refuses_and_writes_nothing() {
    let fx = Fx::new("refuse");
    let s = fx.store();
    let v = s.create("Refuse", None, &[kit_set()], &[]).unwrap();
    let before = fx.copy(&v.id);
    let e = s.edit(&v.id, &[member("no-such-rune", false)], EditMode::Unlocked).unwrap_err();
    assert!(e.contains("neither slotted"), "{e}");
    assert_eq!(fx.copy(&v.id), before);
}

#[test]
fn the_pass_backs_up_first_then_holds_the_override_in_the_copy_and_a_second_run_changes_nothing() {
    let fx = Fx::new("pass");
    let s = fx.store();
    let v = s.create("Pass", None, &[kit_set()], &[]).unwrap();
    let copy_before = fx.copy(&v.id);
    let json_before = std::fs::read(fx.vault_dir(&v.id).join("vault.json")).unwrap();
    fx.override_off(&["kit-recall-tip", "kit-plain-words", "not-a-member"]);

    let planned = migrate_recall::plan(&fx.0);
    assert_eq!(planned.carries.len(), 1, "{planned:?}");
    assert_eq!(planned.carries[0].1.iter().map(|m| m.rune.id.as_str()).collect::<Vec<_>>(), ["kit-recall-tip"], "a slotted id or a non-member is not a recall member");

    let out = migrate_recall::run(&fx.0, "2026-10-27T000000000Z").unwrap();
    let backup = out.backup.expect("a pass that writes keeps a backup");
    assert!(backup.starts_with(crate::paths::migrations_dir_in(&fx.0)));
    assert!(backup.file_name().unwrap().to_string_lossy().starts_with("recall-member-"));
    assert_eq!(std::fs::read(backup.join("vaults").join(&v.id).join("sets/kit--kit.md")).unwrap(), copy_before, "the copy is backed up as it was");
    assert_eq!(std::fs::read(backup.join("vaults").join(&v.id).join("vault.json")).unwrap(), json_before, "vault.json is backed up as it was");
    let plan_txt = std::fs::read_to_string(backup.join("plan.txt")).unwrap();
    assert!(plan_txt.starts_with("state: done\n"), "{plan_txt}");
    assert!(plan_txt.contains("backup vaults/") && plan_txt.contains("recall member kit-recall-tip off"), "{plan_txt}");
    assert_eq!(recall_off(&fx.copy(&v.id)), vec!["kit-recall-tip".to_string()]);
    assert!(!loads(&s, &v.id).contains(&TIP.to_string()));

    let mut first = BTreeMap::new();
    tree(&fx.0, &mut first);
    let again = migrate_recall::run(&fx.0, "2026-10-27T000000001Z").unwrap();
    assert!(again.backup.is_none() && again.lines.is_empty(), "{again:?}");
    assert!(migrate_recall::plan(&fx.0).carries.is_empty(), "the copy already holds it, done marker aside");
    let mut second = BTreeMap::new();
    tree(&fx.0, &mut second);
    assert!(first == second, "a second run changes no file");

    s.edit(&v.id, &[member("kit-recall-tip", true)], EditMode::Unlocked).unwrap();
    migrate_recall::run(&fx.0, "2026-10-27T000000002Z").unwrap();
    assert!(loads(&s, &v.id).contains(&TIP.to_string()), "a member switched back on stays on");
}

#[test]
fn a_renamed_library_uses_its_old_override_and_turns_off_the_recall_member() {
    let fx = Fx::new("renamed");
    let imports = crate::paths::rune_imports_dir_in(&fx.0);
    let renamed = imports.join("kit-renamed");
    copy_dir(&imports.join("kit"), &renamed);
    let set = renamed.join("sets/kit.md");
    let text = std::fs::read_to_string(&set).unwrap().replace("scope: [kit]", "scope: [kit-renamed]");
    std::fs::write(&set, text).unwrap();
    let s = fx.store();
    let source = SetSource { library: "kit-renamed".into(), set: "kit".into() };
    let v = s.create("Renamed", None, &[source], &[]).unwrap();
    fx.override_off(&["kit-recall-tip"]);
    let migration = crate::paths::migrations_dir_in(&fx.0).join("vault-test");
    std::fs::create_dir_all(&migration).unwrap();
    std::fs::write(migration.join("plan.txt"), "state: done\nrename library kit to kit-renamed\n").unwrap();

    let planned = migrate_recall::plan(&fx.0);
    assert_eq!(planned.carries.len(), 1, "{planned:?}");
    assert_eq!(planned.carries[0].1[0].rune.library, "kit-renamed");
    migrate_recall::run(&fx.0, "2026-10-27T000000000Z").unwrap();
    let view = super::read_view(&s, &v.id, None).unwrap();
    assert_eq!(view.off.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["kit-recall-tip"]);
}

#[test]
fn the_pass_never_touches_a_vault_it_cannot_parse_or_a_locked_one_and_nothing_to_do_writes_nothing() {
    let fx = Fx::new("skip");
    let s = fx.store();
    let none = migrate_recall::run(&fx.0, "2026-10-27T000000000Z").unwrap();
    assert!(none.backup.is_none() && !crate::paths::migrations_dir_in(&fx.0).exists(), "no overrides, nothing written");

    let v = s.create("Locked", None, &[kit_set()], &[]).unwrap();
    s.resolve(&v.id).unwrap();
    s.lock(&v.id, LockedBy::Button, &v.hash).unwrap();
    let bad = fx.vault_dir("broken");
    std::fs::create_dir_all(bad.join("sets")).unwrap();
    std::fs::write(bad.join("vault.json"), "{ not json").unwrap();
    fx.override_off(&["kit-recall-tip"]);
    let mut before = BTreeMap::new();
    tree(&crate::paths::rune_vaults_dir_in(&fx.0), &mut before);

    let out = migrate_recall::run(&fx.0, "2026-10-27T000000000Z").unwrap();
    assert!(out.backup.is_none(), "{out:?}");
    assert!(out.lines.iter().any(|l| l.contains("vault broken: vault.json does not parse")), "{:?}", out.lines);
    assert!(out.lines.iter().any(|l| l.contains(&format!("vault {} is locked", v.id))), "{:?}", out.lines);
    let mut after = BTreeMap::new();
    tree(&crate::paths::rune_vaults_dir_in(&fx.0), &mut after);
    assert!(before == after, "no vault file changed");
}
