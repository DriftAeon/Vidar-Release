//! src-tauri\src\bare\library_delete_tests.rs — `bare_library_delete`.

use std::path::{Path, PathBuf};

use super::*;
use crate::bare::vault::store::Store;
use crate::bare::vault::{LockedBy, RuneRef, SetSource};

struct Fx(PathBuf);
impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn rule(id: &str) -> String {
    format!("---\nname: {id}\nkind: rule\nscope: [global]\ndescription: d\n---\nBody of {id}.\n")
}

impl Fx {
    /// A root with import library `mine` (rules `one`, `two`; set `base` slotting both) and `other`.
    fn new() -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("vidar-libdel-{}-{nanos}", std::process::id()));
        let imports = crate::paths::rune_imports_dir_in(&root);
        for lib in ["mine", "other"] {
            for id in ["one", "two"] {
                write(&imports.join(lib).join("rules").join(format!("{id}.md")), &rule(id));
            }
            write(
                &imports.join(lib).join("sets/base.md"),
                "---\nname: base\nkind: set\nscope: [global]\ndescription: d\n---\n- <?rune one?>\n- <?rune two?>\n",
            );
        }
        Fx(root)
    }
    fn imports(&self) -> PathBuf {
        crate::paths::rune_imports_dir_in(&self.0)
    }
    fn store(&self) -> Store {
        Store::open(&self.0)
    }
}

/// The backup folders `<lib>.deleted-<yyyyMMdd-HHmmss>[-n]` under the imports dir, sorted.
fn backups(fx: &Fx, lib: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(fx.imports()).unwrap().flatten().map(|e| e.path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(&format!("{lib}.deleted-"))).collect();
    out.sort();
    out
}

fn r(lib: &str, id: &str) -> RuneRef {
    RuneRef { library: lib.into(), id: id.into() }
}

#[test]
fn deleting_a_rune_moves_it_and_its_slots_to_the_backup() {
    let fx = Fx::new();
    let got = delete_in(&fx.0, "mine", "one").unwrap();
    assert!(got.vaults.is_empty());
    let lib = fx.imports().join("mine");
    assert!(!lib.join("rules/one.md").exists());
    assert!(lib.join("rules/two.md").is_file());
    assert_eq!(std::fs::read_to_string(lib.join("sets/base.md")).unwrap().matches("<?rune").count(), 1);
    let baks = backups(&fx, "mine");
    assert_eq!(baks.len(), 1);
    let bak = &baks[0];
    let tail = bak.file_name().unwrap().to_string_lossy().trim_start_matches("mine.deleted-").to_string();
    assert!(tail.len() == 15 && tail.as_bytes()[8] == b'-' && tail.bytes().filter(|b| *b != b'-').all(|b| b.is_ascii_digit()), "{tail}");
    assert!(!bak.to_string_lossy().contains("pre-split"));
    assert!(bak.join("rules/one.md").is_file());
    assert!(std::fs::read_to_string(bak.join("sets/base.md")).unwrap().contains("<?rune one?>"));
    // The other library is untouched, and the backup folder is not a listed library.
    assert!(fx.imports().join("other/rules/one.md").is_file());
    let listed = crate::bare::sets_list::sets_in(&fx.0);
    assert!(listed.iter().all(|s| s.library.as_deref() != Some("mine.pre-split")));
    assert!(listed.iter().all(|s| !s.library.as_deref().unwrap_or("").contains(".deleted-")));
}

#[test]
fn templates_vidar_and_outside_paths_refuse() {
    let fx = Fx::new();
    write(&crate::paths::rune_vidar_dir_in(&fx.0).join("rules/s.md"), &rule("s"));
    for lib in ["vidar", "base-main", "..", "mine.pre-split", "mine.deleted-20261028-101500", "missing", "a/b"] {
        let e = delete_in(&fx.0, lib, "one").unwrap_err();
        assert!(e.contains("cannot be deleted here"), "{lib}: {e}");
    }
    assert!(delete_in(&fx.0, "mine", "../other/rules/one").is_err());
    assert!(delete_in(&fx.0, "mine", "absent").is_err());
    assert!(crate::paths::rune_vidar_dir_in(&fx.0).join("rules/s.md").is_file());
    assert!(fx.imports().join("mine/rules/one.md").is_file());
}

#[test]
fn unlocked_vaults_drop_the_refs_and_a_locked_rev_stays_byte_identical() {
    let fx = Fx::new();
    let set = SetSource { library: "mine".into(), set: "base".into() };
    let store = fx.store();
    let open = store.create("Open", None, &[], &[r("mine", "one"), r("other", "one")]).unwrap();
    let with_set = store.create("With Set", None, &[set.clone()], &[]).unwrap();
    let locked = store.create("Locked", None, &[set.clone()], &[r("mine", "one")]).unwrap();
    store.lock(&locked.id, LockedBy::Button, &locked.hash).unwrap();
    let snap = |id: &str| -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        fn walk(d: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            let mut es: Vec<_> = std::fs::read_dir(d).unwrap().flatten().collect();
            es.sort_by_key(|e| e.path());
            for e in es {
                if e.path().is_dir() { walk(&e.path(), out) } else { out.push((e.path(), std::fs::read(e.path()).unwrap())) }
            }
        }
        walk(&crate::paths::rune_vaults_dir_in(&fx.0).join(id), &mut out);
        out
    };
    let before = snap(&locked.id);

    let one = delete_in(&fx.0, "mine", "one").unwrap();
    assert_eq!(one.vaults, vec!["Open".to_string()]);
    assert_eq!(store.get(&open.id).unwrap().runes, vec![r("other", "one")]);

    let set_gone = delete_in(&fx.0, "mine", "base").unwrap();
    assert_eq!(set_gone.vaults, vec!["With Set".to_string()]);
    assert!(store.get(&with_set.id).unwrap().runesets.is_empty());

    assert_eq!(snap(&locked.id), before, "a locked vault and its revs are never touched");
    assert!(store.get(&locked.id).unwrap().locked_utc.is_some());
}

#[test]
fn deleting_a_set_rune_drops_its_placed_copy() {
    let fx = Fx::new();
    let set = SetSource { library: "mine".into(), set: "base".into() };
    let v = fx.store().create("Has Base", None, &[set], &[]).unwrap();
    let got = delete_in(&fx.0, "mine", "base").unwrap();
    assert_eq!(got.vaults, vec!["Has Base".to_string()]);
    assert!(fx.store().get(&v.id).unwrap().runesets.is_empty());
    assert!(backups(&fx, "mine")[0].join("sets/base.md").is_file());
}

#[test]
fn delete_runeset_keeps_its_runes_and_a_template_runeset_refuses() {
    let fx = Fx::new();
    // an import runeset is never fixed; the Vidar library's are (A.1d: `fixed` replaced the template check)
    assert!(!crate::bare::vault::library_sets::fixed(&fx.0, "other"));
    assert!(crate::bare::vault::library_sets::fixed(&fx.0, "vidar"));
    let sets = fx.store().library_runesets("claude");
    let fixed = |lib: &str| sets.iter().find(|s| s.library == lib && s.set == "base").map(|s| s.fixed);
    assert_eq!(fixed("other"), Some(false));
    assert_eq!(fixed("mine"), Some(false));
    // an import runeset goes alone: its runes stay in storage
    delete_in(&fx.0, "mine", "base").unwrap();
    assert!(!fx.imports().join("mine/sets/base.md").exists());
    assert!(fx.imports().join("mine/rules/one.md").is_file() && fx.imports().join("mine/rules/two.md").is_file());
    assert!(fx.store().library_runesets("claude").iter().all(|s| s.library != "mine"));
}

#[test]
fn a_fixed_runeset_refuses_with_the_reason_for_its_library() {
    let fx = Fx::new();
    let set = "---\nname: base\nkind: set\nscope: [global]\ndescription: d\n---\n- <?rune one?>\n";
    write(&fx.imports().join("vidar/sets/base.md"), set);
    write(&fx.imports().join("vidar/rules/one.md"), &rule("one"));
    write(&crate::paths::config_path_in(&fx.0), "{ \"rulesLibrary\": \"other\" }");
    let vidar = delete_in(&fx.0, "vidar", "base").unwrap_err();
    assert_eq!(vidar, "Runeset base ships with Vidar, so it cannot be deleted");
    let rules = delete_in(&fx.0, "other", "base").unwrap_err();
    assert_eq!(rules, "Runeset base holds Vidar's rules, so it cannot be deleted");
    assert!(fx.imports().join("other/sets/base.md").is_file() && fx.imports().join("vidar/sets/base.md").is_file());
}

#[test]
fn stamp_is_a_utc_civil_time() {
    assert_eq!(super::stamp(0), "19700101-000000");
    assert_eq!(super::stamp(1_000_000_000), "20010909-014640");
}
