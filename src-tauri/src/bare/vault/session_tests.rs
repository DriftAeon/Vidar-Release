//! src-tauri\src\bare\vault\session_tests.rs — L3c: the thread id a session record takes, the stock
//! vault a read writes, the floor every Custom vault starts from, and the launcher pre-pick file.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::session::{self, VaultPin};
use super::store::Store;
use super::{RuneRef, SetSource, Template};

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-vault-l3c-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
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

/// A temp root with the fixture `stock` library, `kit` as an import library and a `stock-claude`
/// template whose floor is the identity rune.
fn root(tag: &str) -> TempDir {
    let t = TempDir::new(tag);
    let fixture = crate::paths::root().join("tests").join("fixtures").join("rune-vault");
    copy_dir(&fixture.join("stock-runes"), &crate::paths::rune_stock_dir_in(&t.0));
    copy_dir(&fixture.join("kit"), &crate::paths::rune_imports_dir_in(&t.0).join("kit"));
    let dir = crate::paths::rune_templates_dir_in(&t.0);
    std::fs::create_dir_all(&dir).unwrap();
    let template = Template { version: 1, id: "stock-claude".into(), name: "Stock Claude".into(), runesets: vec![], runes: vec![stock("bare-identity")] };
    std::fs::write(dir.join("stock-claude.json"), serde_json::to_string(&template).unwrap()).unwrap();
    t
}

#[test]
fn a_record_takes_its_thread_id_once_and_resume_finds_the_vault_by_it() {
    let t = root("thread");
    let v = Store::open(&t.0).create_custom(&[kit_set()], &[]).unwrap();
    let mut r = session::record("claude", "rendered", "tab-1", VaultPin { id: v.id.clone(), hash: v.hash.clone() }, "", "");
    r.falcon_session = Some("s-0001".into());
    session::write(&t.0, &r).unwrap();

    let got = session::append_thread_id(&t.0, "tab-1", Some("s-0001"), "th-aaaa").unwrap().unwrap();
    assert_eq!(got.thread_id.as_deref(), Some("th-aaaa"));
    let files = || std::fs::read_dir(crate::paths::rune_vaults_dir_in(&t.0).join("sessions")).unwrap().count();
    assert_eq!(files(), 2, "the id lands as one appended record");
    // Again with the same id, and with a different one: no new record, the first id stands.
    session::append_thread_id(&t.0, "tab-1", Some("s-0001"), "th-aaaa").unwrap();
    let other = session::append_thread_id(&t.0, "tab-1", Some("s-0001"), "th-bbbb").unwrap().unwrap();
    assert_eq!(other.thread_id.as_deref(), Some("th-aaaa"));
    assert_eq!(files(), 2);

    // Resume after a relaunch: a new tab id, no Falcon session, only the thread id.
    let found = session::find(&t.0, "tab-new", None, Some("th-aaaa")).unwrap().expect("found by thread id");
    assert_eq!(found.vault, VaultPin { id: v.id, hash: v.hash });
    assert!(session::find(&t.0, "tab-new", None, Some("th-bbbb")).unwrap().is_none());
}

#[test]
fn a_thread_id_never_lands_on_another_sessions_record() {
    let t = root("thread-wrong");
    let v = Store::open(&t.0).create_custom(&[kit_set()], &[]).unwrap();
    let mut hosted = session::record("codex", "hosted", "tab-1", VaultPin { id: v.id.clone(), hash: v.hash.clone() }, "", "");
    hosted.falcon_session = Some("s-0001".into());
    session::write(&t.0, &hosted).unwrap();
    // Another Falcon session, and an in-process tab, under the same tab id take nothing.
    assert!(session::append_thread_id(&t.0, "tab-1", Some("s-9999"), "th-x").unwrap().is_none());
    assert!(session::append_thread_id(&t.0, "tab-1", None, "th-y").unwrap().is_none());
    assert!(session::append_thread_id(&t.0, "tab-2", None, "th-z").unwrap().is_none());
    let r = session::find(&t.0, "tab-1", Some("s-0001"), None).unwrap().unwrap();
    assert_eq!(r.thread_id, None);
}

#[test]
fn the_thread_id_comes_from_claude_init_or_falcon_thread_only() {
    let init = json!({ "type": "system", "subtype": "init", "session_id": "c-1" });
    assert_eq!(session::thread_id_in_line(&init), Some("c-1"));
    let thread = json!({ "method": "falcon/thread", "params": { "result": { "thread": { "id": "x-1" } }, "resumed": false } });
    assert_eq!(session::thread_id_in_line(&thread), Some("x-1"));
    for other in [
        json!({ "type": "assistant", "session_id": "c-1" }),
        json!({ "id": 4, "result": { "thread": { "id": "read-1" } } }),
        json!({ "method": "thread/started", "params": { "thread": { "id": "x-2" } } }),
        json!({ "type": "system", "subtype": "init", "session_id": "" }),
    ] {
        assert_eq!(session::thread_id_in_line(&other), None, "{other}");
    }
}

#[test]
fn reading_a_stock_vault_before_any_launch_writes_it_from_the_template() {
    let t = root("stock-read");
    let s = Store::open(&t.0);
    assert!(s.get("stock-claude").is_err(), "no stock launch yet");
    let view = super::read_view(&s, "stock-claude", None).unwrap();
    assert_eq!(view.vault.runes, vec![stock("bare-identity")]);
    assert!(s.get("stock-claude").is_ok());
    assert!(super::read_view(&s, "custom-none00", None).is_err(), "a non-stock id is never created by a read");
}

#[test]
fn an_adopted_session_and_a_set_pick_start_from_the_stock_floor() {
    let t = root("floor");
    let a = session::adopt(&t.0, "claude", "t-old", "s-old-0001", &[kit_set()]).unwrap();
    let v = Store::open(&t.0).get(&a.vault.id).unwrap();
    assert!(v.runes.contains(&stock("bare-identity")), "the adopted vault lacks the identity rune: {:?}", v.runes);
    assert_eq!(v.runesets.iter().map(|c| c.source.clone()).collect::<Vec<_>>(), vec![kit_set()]);
    // A pick that repeats a floor rune is deduped, so it is the same Custom vault.
    let again = super::floored_custom(&t.0, "claude", &[kit_set()], &[stock("bare-identity")]).unwrap();
    assert_eq!(again.id, v.id);
    assert_eq!(again.runes, vec![stock("bare-identity")]);
    // No `stock-codex.json`: the pick refuses rather than building a vault without its floor.
    let e = super::floored_custom(&t.0, "codex", &[kit_set()], &[]).unwrap_err();
    assert_eq!(e, "Stock Template Missing: stock-codex");
}

#[test]
fn the_create_command_floors_every_custom_vault_and_refuses_without_an_agent_or_template() {
    let t = root("create-floor");
    // A bare pick through the command path gets the floor's identity rune.
    let v = super::create_at(&t.0, None, None, &[kit_set()], &[], Some("claude")).unwrap();
    assert!(v.runes.contains(&stock("bare-identity")), "an unfloored Custom vault: {:?}", v.runes);
    // The launcher's pre-floored pick is the same vault.
    let again = super::create_at(&t.0, None, None, &[kit_set()], &[stock("bare-identity")], Some("claude")).unwrap();
    assert_eq!(again.id, v.id);
    assert_eq!(super::create_at(&t.0, None, None, &[kit_set()], &[], Some("codex")).unwrap_err(), "Stock Template Missing: stock-codex");
    for agent in [None, Some("..\\x")] {
        assert!(super::create_at(&t.0, None, None, &[kit_set()], &[], agent).is_err(), "{agent:?}");
    }
}

#[test]
fn the_pre_pick_survives_a_relaunch_through_the_defaults_file() {
    let t = TempDir::new("defaults");
    assert!(super::read_defaults(&t.0).is_empty());
    super::write_default(&t.0, "claude", "custom-abc123").unwrap();
    super::write_default(&t.0, "codex", "stock-codex").unwrap();
    super::write_default(&t.0, "claude", "mine").unwrap();
    let d = super::read_defaults(&t.0);
    assert_eq!(d.get("claude").map(String::as_str), Some("mine"));
    assert_eq!(d.get("codex").map(String::as_str), Some("stock-codex"));
    assert!(super::write_default(&t.0, "claude", "..\\x").is_err());
    assert!(super::write_default(&t.0, "a b", "mine").is_err());
}
