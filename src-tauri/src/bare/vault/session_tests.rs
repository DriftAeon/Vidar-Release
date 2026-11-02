//! src-tauri\src\bare\vault\session_tests.rs — L3c: the thread id a session record takes, what adopt
//! and the create command start from, and the launcher pre-pick file.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::session::{self, VaultPin};
use super::store::Store;
use super::{SetSource, VaultFrom};

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

fn installed_set() -> SetSource {
    SetSource { library: "installed".into(), set: "installed".into() }
}

/// A temp root with the fixture `vidar` library and `installed` as an import library.
fn root(tag: &str) -> TempDir {
    let t = TempDir::new(tag);
    let fixture = crate::paths::root().join("tests").join("fixtures").join("rune-vault");
    copy_dir(&fixture.join("vidar-runes"), &crate::paths::rune_vidar_dir_in(&t.0));
    copy_dir(&fixture.join("installed"), &crate::paths::rune_imports_dir_in(&t.0).join("installed"));
    t
}

#[test]
fn a_record_takes_its_thread_id_once_and_resume_finds_the_vault_by_it() {
    let t = root("thread");
    let v = Store::open(&t.0).create("Pick", None, &[installed_set()], &[]).unwrap();
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
    let v = Store::open(&t.0).create("Pick", None, &[installed_set()], &[]).unwrap();
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
fn a_base_id_is_no_vault_and_a_read_never_creates_one() {
    let t = root("base-read");
    let s = Store::open(&t.0);
    assert!(s.get("base-main").is_err());
    assert!(super::read_view(&s, Some("base-main"), None).is_err(), "no vault is written from a read");
    assert!(s.get("base-main").is_err());
    assert!(super::read_view(&s, Some("custom-none00"), None).is_err(), "a read never creates a vault");
}

#[test]
fn adopt_yields_the_vidar_runeset_then_the_echoed_sets() {
    let t = root("floor");
    let a = session::adopt(&t.0, "claude", "t-old", "s-old-0001", &[installed_set()]).unwrap();
    let v = Store::open(&t.0).get(&a.vault.id).unwrap();
    let vidar = SetSource { library: "vidar".into(), set: "vidar".into() };
    assert_eq!(v.runesets.iter().map(|c| c.source.clone()).collect::<Vec<_>>(), vec![vidar.clone(), installed_set()]);
    // The Vidar Runeset is deduped when the echo repeats it, and every adopt is a new copy with the same hash.
    let again = super::create_at(&t.0, None, None, &[vidar, installed_set()], &[]).unwrap();
    assert_ne!(again.id, v.id);
    assert_eq!(again.hash, v.hash);
}

#[test]
fn the_create_command_starts_every_unnamed_vault_from_the_blank() {
    let t = root("create-floor");
    let v = super::create_at(&t.0, None, None, &[installed_set()], &[]).unwrap();
    assert_eq!(v.runesets.first().map(|c| (c.source.library.as_str(), c.source.set.as_str())), Some(("vidar", "vidar")));
    let bare = super::create_at(&t.0, None, None, &[], &[]).unwrap();
    assert_eq!(bare.runesets.len(), 1, "the blank vault holds only the Vidar Runeset");
    // `from` a vault at a hash starts a copy of that vault
    let from = VaultFrom::Vault { vault: v.id.clone(), hash: v.hash.clone() };
    let of_v = super::create_at(&t.0, None, Some(from), &[], &[]).unwrap();
    assert!(of_v.id.starts_with("copy-") && of_v.hash == v.hash);
}

#[test]
fn a_grok_agent_is_refused_at_adopt_and_nothing_is_written() {
    let t = root("grok");
    assert!(session::adopt(&t.0, "grok", "t-g", "s-g-0001", &[installed_set()]).unwrap_err().contains("\"grok\""));
    assert!(std::fs::read_dir(crate::paths::rune_vaults_dir_in(&t.0)).map_or(true, |mut d| d.next().is_none()), "a vault was written for grok");
}

#[test]
fn adopt_keeps_each_known_agents_body() {
    let t = root("bodies");
    assert_eq!(session::adopt(&t.0, "claude", "t-a", "s-a-0001", &[installed_set()]).unwrap().body, "rendered");
}

#[test]
fn the_pre_pick_survives_a_relaunch_through_the_defaults_file() {
    let t = TempDir::new("defaults");
    assert!(super::read_defaults(&t.0).is_empty());
    super::write_default(&t.0, "claude", "custom-abc123").unwrap();
    super::write_default(&t.0, "codex", "custom-def456").unwrap();
    super::write_default(&t.0, "claude", "mine").unwrap();
    let d = super::read_defaults(&t.0);
    assert_eq!(d.get("claude").map(String::as_str), Some("mine"));
    assert_eq!(d.get("codex").map(String::as_str), Some("custom-def456"));
    assert!(super::write_default(&t.0, "claude", "..\\x").is_err());
    assert!(super::write_default(&t.0, "a b", "mine").is_err());
}
