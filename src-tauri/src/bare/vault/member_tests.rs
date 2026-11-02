//! src-tauri\src\bare\vault\member_tests.rs — `Op::Member`: a rune switched
//! inside a placed runeset edits only the vault's own `sets/` copy; the library runeset stays byte-identical
//! (model R3), and a locked vault takes the toggle only as a variant or an Edit Original (R5).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::store::{EditMode, Op, Store};
use super::{LockedBy, MemberEdit, RuneRef, SetSource};

struct Fx(PathBuf);
impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-vault-member-{tag}-{}-{nanos}", std::process::id()));
        let fixture = crate::paths::root().join("tests").join("fixtures").join("rune-vault");
        copy_dir(&fixture.join("vidar-runes"), &crate::paths::rune_imports_dir_in(&p).join("base"));
        copy_dir(&fixture.join("installed"), &crate::paths::rune_imports_dir_in(&p).join("installed"));
        Fx(p)
    }
    fn store(&self) -> Store {
        Store::open(&self.0)
    }
    fn installed_file(&self) -> PathBuf {
        crate::paths::rune_imports_dir_in(&self.0).join("installed").join("sets").join("installed.md")
    }
    fn copy_file(&self, id: &str) -> PathBuf {
        crate::paths::rune_vaults_dir_in(&self.0).join(id).join("sets").join("installed--installed.md")
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

/// Every file under `dir` -> its bytes.
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

/// Every file outside `vaults/<id>/`.
fn outside(fx: &Fx, id: &str) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut all = BTreeMap::new();
    tree(&fx.0, &mut all);
    let own = crate::paths::rune_vaults_dir_in(&fx.0).join(id);
    all.into_iter().filter(|(p, _)| !p.starts_with(&own)).collect()
}

fn installed_set() -> SetSource {
    SetSource { library: "installed".into(), set: "installed".into() }
}

fn member(lib: &str, id: &str, on: bool) -> Op {
    Op::Member(MemberEdit { library: "installed".into(), runeset: "installed".into(), rune: RuneRef { library: lib.into(), id: id.into() }, on })
}

fn loads(s: &Store, id: &str) -> Vec<String> {
    s.resolve(id).unwrap().runes.iter().map(|r| format!("{}/{}", r.library, r.id)).collect()
}

#[test]
fn the_member_wire_shape_reads_as_the_ts_side_sends_it() {
    let op: Op = serde_json::from_str(r#"{"op":"member","ref":{"library":"installed","runeset":"installed","rune":{"library":"installed","id":"team-plain-words"},"on":false}}"#).unwrap();
    assert_eq!(op, member("installed", "team-plain-words", false));
}

#[test]
fn a_member_toggle_writes_only_the_vault_copy_and_leaves_the_library_set_byte_identical() {
    let fx = Fx::new("copy");
    let s = fx.store();
    let v = s.create("Astra", None, &[installed_set()], &[]).unwrap();
    let library_before = std::fs::read(fx.installed_file()).unwrap();
    let before = outside(&fx, &v.id);
    assert!(loads(&s, &v.id).contains(&"installed/team-plain-words".to_string()));

    let off = s.edit(&v.id, &[member("installed", "team-plain-words", false)], EditMode::Unlocked).unwrap();
    assert_ne!(off.hash, v.hash, "the copy's bytes are in the vault hash");
    assert_eq!(std::fs::read(fx.installed_file()).unwrap(), library_before, "the library runeset is never edited");
    let after = outside(&fx, &off.id);
    assert_eq!(after.keys().collect::<Vec<_>>(), before.keys().collect::<Vec<_>>(), "no file is added outside vaults/<id>/");
    assert!(after == before, "no file outside vaults/<id>/ changed");
    let copy = std::fs::read_to_string(fx.copy_file(&v.id)).unwrap();
    assert!(!copy.contains("<?rune team-plain-words?>"), "{copy}");
    assert!(!loads(&s, &v.id).contains(&"installed/team-plain-words".to_string()));

    let on = s.edit(&v.id, &[member("installed", "team-plain-words", true)], EditMode::Unlocked).unwrap();
    assert!(loads(&s, &on.id).contains(&"installed/team-plain-words".to_string()));
    assert!(std::fs::read_to_string(fx.copy_file(&v.id)).unwrap().contains("- <?rune team-plain-words?>"), "put back with the list prefix");
    assert_eq!(std::fs::read(fx.installed_file()).unwrap(), library_before);
    let again = s.edit(&v.id, &[member("installed", "team-plain-words", true)], EditMode::Unlocked).unwrap();
    assert_eq!(again.hash, on.hash, "on for a slotted rune is a no-op");
}

#[test]
fn a_cross_library_slot_goes_out_and_comes_back_with_its_library_named() {
    let fx = Fx::new("cross");
    let s = fx.store();
    let v = s.create("Cross", None, &[installed_set()], &[]).unwrap();
    s.edit(&v.id, &[member("base", "gate-fact", false)], EditMode::Unlocked).unwrap();
    let copy = std::fs::read_to_string(fx.copy_file(&v.id)).unwrap();
    assert!(!copy.contains("<?rune base/gate-fact?>") && copy.contains("slot-off: [base/gate-fact]"), "{copy}");
    s.edit(&v.id, &[member("base", "gate-fact", true)], EditMode::Unlocked).unwrap();
    assert!(std::fs::read_to_string(fx.copy_file(&v.id)).unwrap().contains("<?rune base/gate-fact?>"));
}

#[test]
fn a_non_member_or_an_absent_runeset_refuses_and_writes_nothing() {
    let fx = Fx::new("refuse");
    let s = fx.store();
    let v = s.create("Refuse", None, &[installed_set()], &[]).unwrap();
    let copy = std::fs::read(fx.copy_file(&v.id)).unwrap();
    // a recall member now switches off in the copy's header; a non-member refuses
    let e = s.edit(&v.id, &[member("installed", "team-nope", false)], EditMode::Unlocked).unwrap_err();
    assert!(e.contains("recall"), "{e}");
    let other = Op::Member(MemberEdit { library: "installed".into(), runeset: "nope".into(), rune: RuneRef { library: "installed".into(), id: "x".into() }, on: false });
    assert!(s.edit(&v.id, &[other], EditMode::Unlocked).unwrap_err().contains("not in the vault"));
    assert_eq!(std::fs::read(fx.copy_file(&v.id)).unwrap(), copy);
    assert_eq!(s.get(&v.id).unwrap().hash, v.hash);
}

#[test]
fn a_locked_member_toggle_asks_then_a_variant_or_edit_original_takes_it() {
    let fx = Fx::new("locked");
    let s = fx.store();
    let v = s.create("Locked", None, &[installed_set()], &[]).unwrap();
    s.resolve(&v.id).unwrap();
    let locked = s.lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    let copy = std::fs::read(fx.copy_file(&v.id)).unwrap();
    let library_before = std::fs::read(fx.installed_file()).unwrap();

    let e = s.edit(&v.id, &[member("installed", "team-plain-words", false)], EditMode::Unlocked).unwrap_err();
    assert!(e.contains("locked"), "{e}");
    assert_eq!(std::fs::read(fx.copy_file(&v.id)).unwrap(), copy, "a refused toggle writes nothing");

    let variant = s.edit(&v.id, &[member("installed", "team-plain-words", false)], EditMode::Variant).unwrap();
    assert_ne!(variant.id, v.id);
    assert!(!loads(&s, &variant.id).contains(&"installed/team-plain-words".to_string()));
    assert_eq!(std::fs::read(fx.copy_file(&v.id)).unwrap(), copy, "the variant leaves the locked vault's copy alone");
    assert_eq!(s.get(&v.id).unwrap().hash, locked.hash);

    let edited = s.edit(&v.id, &[member("installed", "team-plain-words", false)], EditMode::Invalidate).unwrap();
    assert!(edited.locked_utc.is_none(), "Edit Original clears the lock");
    assert!(!loads(&s, &v.id).contains(&"installed/team-plain-words".to_string()));
    let rev = crate::paths::rune_vaults_dir_in(&fx.0).join(&v.id).join("revs").join(&locked.hash).join("sets").join("installed--installed.md");
    assert_eq!(std::fs::read(rev).unwrap(), copy, "the loaded state stays in revs/<hash>/");
    assert_eq!(std::fs::read(fx.installed_file()).unwrap(), library_before);
}

#[test]
fn library_runes_lists_this_agents_runes_without_sets_or_secrets() {
    let fx = Fx::new("library");
    let got = super::library_runes_in(&fx.store(), "codex").unwrap();
    let keys: Vec<String> = got.runes.iter().map(|r| format!("{}/{}", r.library, r.id)).collect();
    assert!(keys.contains(&"installed/team-plain-words".to_string()), "{keys:?}");
    assert!(keys.contains(&"base/gate-fact".to_string()), "{keys:?}");
    assert!(keys.contains(&"base/gate-hook-command".to_string()), "a codex rune lists for codex: {keys:?}");
    assert!(!keys.contains(&"base/fixture-echo".to_string()), "a claude-only rune stays out: {keys:?}");
    assert!(!keys.contains(&"installed/installed".to_string()), "a runeset is not a rune to add: {keys:?}");
    assert!(got.runes.iter().all(|r| r.set.is_none()));
    let json = serde_json::to_string(&got).unwrap();
    assert!(!json.contains("sk-secret-1"), "a hook command never leaves the store");
    assert!(super::library_runes_in(&fx.store(), "../x").is_err());
}

#[test]
fn library_runesets_list_members_and_leave_out_another_agents_set() {
    let fx = Fx::new("library-sets");
    let codex = crate::paths::rune_imports_dir_in(&fx.0).join("installed").join("sets").join("codex-only.md");
    std::fs::write(&codex, "---\nname: codex-only\nkind: set\nscope: [global]\nagent: codex\ndescription: d\n---\n- <?rune team-plain-words?>\n").unwrap();
    let got = super::library_runes_in(&fx.store(), "claude").unwrap();
    let sets: Vec<String> = got.runesets.iter().map(|s| format!("{}/{}", s.library, s.set)).collect();
    assert_eq!(sets, vec!["installed/installed".to_string()], "a codex set stays out of a claude library");
    let members: Vec<String> = got.runesets[0].members.iter().map(RuneRef::key).collect();
    assert_eq!(members, vec!["installed/team-verdict-first", "installed/team-plain-words", "base/gate-fact", "installed/team-recall-tip"]);
    assert!(!got.runesets[0].fixed, "an import library's runeset can be deleted");
    let codex_sets = super::library_runes_in(&fx.store(), "codex").unwrap().runesets;
    assert!(codex_sets.iter().any(|s| s.set == "codex-only"));
}
