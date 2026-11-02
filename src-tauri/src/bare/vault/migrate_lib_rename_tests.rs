//! src-tauri\src\bare\vault\migrate_lib_rename_tests.rs — the startup library rename (`kit` -> `installed`):
//! a full run, idempotence, the held-back and interrupted cases, locked vaults through the alias, and the
//! reserved old name. Every test builds its own temp root; nothing reads or writes the live runtime.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::super::store::Store;
use super::super::{content_sha, vault_hash, LockedBy, RuneRef, SetSource, Vault};
use super::*;

const OLD: &str = "kit";
const NEW: &str = "installed";

struct Fx(PathBuf);
impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-lib-rename-{tag}-{}-{nanos}", std::process::id()));
        let fx = Fx(p);
        // the old library: three sets, a fork, runes (one whose id merely starts with the old name)
        fx.put("kit/sets/kit.md", "---\nname: kit\nkind: set\nscope: [kit]\n---\n- <?rune plain?>\n- <?rune kit/kit-tip?>\n");
        fx.put("kit/sets/kit-claude.md", "---\nname: kit-claude\nkind: set\nscope: [kit]\n---\n- <?rune plain?>\n");
        fx.put("kit/sets/kit-codex.md", "---\nname: kit-codex\nkind: set\nscope: [kit]\n---\n- <?rune kit-tip?>\n");
        fx.put("kit/sets/fork.md", "---\nname: fork\nkind: set\nscope: [kit, extra]\n---\n- <?rune kit/plain?>\n");
        fx.put("kit/rules/plain.md", "---\nname: plain\nkind: rule\nscope: [kit]\n---\nPlain words.\n");
        fx.put("kit/rules/kit-tip.md", "---\nname: kit-tip\nkind: rule\nscope: [kit]\n---\nA tip.\n");
        fx.put("kit/rules/everywhere.md", "---\nname: everywhere\nkind: rule\nscope: [global]\n---\nEverywhere.\n");
        // another library slotting the old one
        fx.put("team/sets/team.md", "---\nname: team\nkind: set\nscope: [team, kit]\n---\n- <?rune own?>\n- <?rune kit/plain?>\n");
        fx.put("team/rules/own.md", "---\nname: own\nkind: rule\nscope: [team]\n---\nOwn.\n");
        fx
    }
    fn imports(&self) -> PathBuf {
        crate::paths::rune_imports_dir_in(&self.0)
    }
    fn put(&self, rel: &str, text: &str) {
        let p = self.imports().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.imports().join(rel)).unwrap()
    }
    fn store(&self) -> Store {
        Store::open(&self.0)
    }
    fn vault_dir(&self, id: &str) -> PathBuf {
        crate::paths::rune_vaults_dir_in(&self.0).join(id)
    }
    fn vault(&self, id: &str) -> Vault {
        crate::fsx::read_json(&self.vault_dir(id).join("vault.json")).unwrap()
    }
    fn run(&self, fail_at: Option<&str>) -> Result<Vec<String>, String> {
        run_with(&self.0, OLD, NEW, fail_at)
    }
    /// An unlocked vault on both libraries plus a locked one on the old library.
    fn vaults(&self) -> (Vault, Vault) {
        let s = self.store();
        let set = |l: &str, n: &str| SetSource { library: l.into(), set: n.into() };
        let rune = |l: &str, n: &str| RuneRef { library: l.into(), id: n.into() };
        let open = s.create("Open", None, &[set(OLD, "kit"), set("team", "team")], &[rune(OLD, "everywhere")]).unwrap();
        let locked = s.create("Locked", None, &[set(OLD, "kit-claude")], &[rune(OLD, "everywhere")]).unwrap();
        let locked = s.lock(&locked.id, LockedBy::Button, &locked.hash).unwrap();
        (open, locked)
    }
}
impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Every file under `dir` -> its bytes.
fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            if e.file_type().unwrap().is_dir() {
                walk(&e.path(), out);
            } else {
                out.insert(e.path(), std::fs::read(e.path()).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, &mut out);
    out
}

/// The rename's end state, whichever way the run got there.
fn assert_renamed(fx: &Fx, open: &Vault, locked: &Vault, locked_before: &BTreeMap<PathBuf, Vec<u8>>) {
    let imports = fx.imports();
    assert!(!imports.join(OLD).exists(), "the old folder is gone");
    for (set, body) in [("installed", "- <?rune plain?>\n- <?rune installed/kit-tip?>\n"), ("installed-claude", "- <?rune plain?>\n"), ("installed-codex", "- <?rune kit-tip?>\n")] {
        assert_eq!(fx.read(&format!("installed/sets/{set}.md")), format!("---\nname: {set}\nkind: set\nscope: [installed]\n---\n{body}"));
    }
    assert_eq!(fx.read("installed/sets/fork.md"), "---\nname: fork\nkind: set\nscope: [installed, extra]\n---\n- <?rune installed/plain?>\n");
    assert_eq!(fx.read("installed/rules/plain.md"), "---\nname: plain\nkind: rule\nscope: [installed]\n---\nPlain words.\n");
    assert!(imports.join("installed/rules/kit-tip.md").is_file(), "a rune id is not a set name; it keeps its name");
    assert_eq!(fx.read("installed/rules/everywhere.md"), "---\nname: everywhere\nkind: rule\nscope: [global]\n---\nEverywhere.\n");
    assert_eq!(fx.read("team/sets/team.md"), "---\nname: team\nkind: set\nscope: [team, installed]\n---\n- <?rune own?>\n- <?rune installed/plain?>\n");
    assert_eq!(fx.read("team/rules/own.md"), "---\nname: own\nkind: rule\nscope: [team]\n---\nOwn.\n");

    // the unlocked vault names the new library, its copy moved, and its hash is the recomputed one
    let v = fx.vault(&open.id);
    assert_eq!(v.runesets[0].source, SetSource { library: NEW.into(), set: NEW.into() });
    assert_eq!(v.runesets[0].file, "sets/installed--installed.md");
    assert_eq!(v.runesets[1].source, SetSource { library: "team".into(), set: "team".into() });
    assert_eq!(v.runes, vec![RuneRef { library: NEW.into(), id: "everywhere".into() }]);
    let dir = fx.vault_dir(&open.id);
    assert!(!dir.join("sets/kit--kit.md").exists());
    let sets: Vec<(SetSource, String)> = v.runesets.iter().map(|c| (c.source.clone(), content_sha(&std::fs::read(dir.join(&c.file)).unwrap()))).collect();
    assert_eq!(v.hash, vault_hash(&sets, &v.runes));
    assert_ne!(v.hash, open.hash);
    let r = fx.store().resolve(&open.id).unwrap();
    let loaded: Vec<String> = r.runes.iter().map(|r| format!("{}/{}", r.library, r.id)).collect();
    assert!(loaded.contains(&"installed/plain".to_string()) && loaded.contains(&"installed/kit-tip".to_string()), "{loaded:?} {:?}", r.warnings);

    // the locked vault is byte for byte what it was
    assert_eq!(&tree(&fx.vault_dir(&locked.id)), locked_before);
}

#[test]
fn a_full_run_renames_the_library_and_unlocked_vaults_and_a_second_run_writes_nothing() {
    let fx = Fx::new("full");
    let (open, locked) = fx.vaults();
    let locked_before = tree(&fx.vault_dir(&locked.id));
    let lines = fx.run(None).unwrap();
    assert!(lines.iter().any(|l| l.contains("library kit -> installed")), "{lines:?}");
    assert_renamed(&fx, &open, &locked, &locked_before);

    let dir = backup_dir(&fx.0, OLD, NEW);
    let j: Journal = crate::fsx::read_json(&dir.join("journal.json")).unwrap();
    assert_eq!(j.state, State::Done);
    assert!(dir.join("libraries/kit/sets/kit.md").is_file() && dir.join("libraries/team/sets/team.md").is_file());
    assert!(dir.join(format!("vaults/{}/vault.json", open.id)).is_file());
    assert!(!dir.join(format!("vaults/{}", locked.id)).exists(), "a locked vault is never rewritten, so never backed up");

    let before = tree(&fx.0);
    assert_eq!(fx.run(None).unwrap(), Vec::<String>::new());
    assert!(tree(&fx.0) == before, "a second run writes nothing");
    // a done journal holds even when a folder with the old name turns up again
    fx.put("kit/rules/new.md", "---\nname: new\nkind: rule\nscope: [kit]\n---\nNew.\n");
    let before = tree(&fx.0);
    assert_eq!(fx.run(None).unwrap(), Vec::<String>::new());
    assert!(tree(&fx.0) == before);
}

#[test]
fn nothing_to_rename_is_a_no_op() {
    let fx = Fx::new("noop");
    std::fs::remove_dir_all(fx.imports().join(OLD)).unwrap();
    std::fs::write(fx.imports().join("team/sets/team.md"), "---\nname: team\nkind: set\nscope: [team]\n---\n- <?rune own?>\n").unwrap();
    let before = tree(&fx.0);
    assert_eq!(fx.run(None).unwrap(), Vec::<String>::new());
    assert!(tree(&fx.0) == before);
}

#[test]
fn a_target_that_already_exists_without_a_journal_writes_nothing_and_leaves_a_notice() {
    let fx = Fx::new("target");
    fx.put("installed/rules/mine.md", "---\nname: mine\nkind: rule\nscope: [installed]\n---\nMine.\n");
    let before = tree(&fx.0);
    let notice = fx.run(None).unwrap_err();
    assert!(notice.contains("installed") && notice.contains("nothing changed"), "{notice}");
    assert!(tree(&fx.0) == before, "no write at all, backup included");
}

#[test]
fn a_run_interrupted_after_the_folder_rename_completes_on_the_next_start() {
    let fx = Fx::new("interrupt");
    let (open, locked) = fx.vaults();
    let locked_before = tree(&fx.vault_dir(&locked.id));
    let e = fx.run(Some("after-rename")).unwrap_err();
    assert!(e.contains("interrupted"), "{e}");
    assert!(fx.imports().join("installed/sets/kit.md").is_file(), "only the folder moved");
    assert_eq!(fx.vault(&open.id).runesets[0].source.library, OLD);
    // between starts the old name reads through the alias
    assert_eq!(crate::bare::layer::library_dir_named(&fx.0, OLD).unwrap(), fx.imports().join(NEW).canonicalize().unwrap());

    fx.run(None).unwrap();
    assert_renamed(&fx, &open, &locked, &locked_before);
}

#[test]
fn a_refused_folder_rename_changes_no_data_and_is_retried_next_start() {
    let fx = Fx::new("refused");
    let (open, locked) = fx.vaults();
    let locked_before = tree(&fx.vault_dir(&locked.id));
    let data = |fx: &Fx| -> BTreeMap<PathBuf, Vec<u8>> {
        let mut t = tree(&fx.imports());
        t.extend(tree(&crate::paths::rune_vaults_dir_in(&fx.0)));
        t
    };
    let before = data(&fx);
    let notice = fx.run(Some("rename")).unwrap_err();
    assert!(notice.contains("retried next start"), "{notice}");
    assert!(data(&fx) == before, "only the backup folder was written");

    fx.run(None).unwrap();
    assert_renamed(&fx, &open, &locked, &locked_before);
}

#[test]
fn a_locked_vault_on_the_old_name_reads_through_the_alias() {
    let fx = Fx::new("alias");
    let (_, locked) = fx.vaults();
    assert!(fx.store().drift(&locked.id).unwrap().is_empty());
    fx.run(None).unwrap();
    let drift = fx.store().drift(&locked.id).unwrap();
    // `everywhere` (scope [global]) is byte-identical in its new folder: no drift through the alias
    assert!(!drift.contains(&RuneRef { library: OLD.into(), id: "everywhere".into() }), "{drift:?}");
    // a rune whose `scope:` named the old library was rescoped, so its pinned body no longer matches
    assert!(drift.contains(&RuneRef { library: OLD.into(), id: "plain".into() }), "{drift:?}");
    let view = super::super::read_view(&fx.store(), Some(&locked.id), None).unwrap();
    assert!(view.warnings.is_empty(), "{:?}", view.warnings);
    assert_eq!(fx.vault(&locked.id).runesets[0].source.library, OLD, "the locked vault still names the old library");
}

#[test]
fn an_unlocked_vault_with_a_stale_revision_keeps_it_and_takes_a_new_hash() {
    let fx = Fx::new("stale-rev");
    let (open, _) = fx.vaults();
    let stale = fx.vault_dir(&open.id).join("revs").join(&open.hash);
    std::fs::create_dir_all(stale.join("sets")).unwrap();
    std::fs::write(stale.join("sets/kit--kit.md"), "old copy\n").unwrap();
    let stale_before = tree(&stale);
    fx.run(None).unwrap();
    let v = fx.vault(&open.id);
    assert_ne!(v.hash, open.hash);
    assert_eq!(tree(&stale), stale_before, "the old revision folder is left alone");
}

#[test]
fn the_old_name_resolves_to_the_new_library_only_when_no_folder_holds_it() {
    let fx = Fx::new("resolve");
    fx.put("installed/rules/x.md", "---\nname: x\nkind: rule\nscope: [installed]\n---\nX.\n");
    let named = |n: &str| crate::bare::layer::library_dir_named(&fx.0, n).unwrap();
    assert_eq!(named(OLD), fx.imports().join(OLD).canonicalize().unwrap(), "a folder under the old name is read as itself");
    std::fs::remove_dir_all(fx.imports().join(OLD)).unwrap();
    assert_eq!(named(OLD), fx.imports().join(NEW).canonicalize().unwrap());
}

#[test]
fn a_library_named_kit_is_refused() {
    assert!(retired(OLD) && !retired(NEW));
    let fx = Fx::new("refuse");
    let split = crate::rules::import::split::split("# Hello\nA rule.\n", &[], "");
    let dir = fx.0.join("import-target");
    let meta = crate::rules::import::write::Meta { name: OLD, source: "test", date: "2026-10-30" };
    let err = crate::rules::import::write::write_library(&dir, &split, &meta, &[], &[], false).unwrap_err();
    assert!(err.contains("reserved"), "{err}");
    assert!(!dir.exists());
}
