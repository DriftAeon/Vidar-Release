//! Tests for `login_back.rs`: a temp `Vidar\homes` tree with fake logins, never the real one.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::*;

/// `<temp>\Vidar\homes\{k, _shared\claude}` with a fake store login and a fake home login.
struct Fx {
    base: PathBuf,
    bare: PathBuf,
    store: PathBuf,
    own: PathBuf,
    call: PathBuf,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("vidar-loginback-{tag}-{}-{nanos}", std::process::id()));
        let homes = base.join("Vidar").join("homes");
        let bare = homes.join("k");
        let store = homes.join(SHARED).join("claude").join(".credentials.json");
        let own = bare.join("claude-config").join(".credentials.json");
        let call = bare.join("gen-claude").join("calls").join("c01-0").join("config").join(".credentials.json");
        for p in [&store, &own, &call] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        }
        std::fs::write(&store, "fake-login-store").unwrap();
        std::fs::write(&own, "fake-login-own").unwrap();
        Fx { base, bare, store, own, call }
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn age(p: &Path, secs_ago: u64) {
    let f = std::fs::OpenOptions::new().write(true).open(p).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago)).unwrap();
}

fn text(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn the_source_is_the_newer_of_the_store_and_the_home_login() {
    let f = Fx::new("source");
    age(&f.own, 3600);
    assert_eq!(source(&f.bare, "claude", "claude-config", ".credentials.json"), Some(f.store.clone()));
    age(&f.store, 7200);
    assert_eq!(source(&f.bare, "claude", "claude-config", ".credentials.json"), Some(f.own.clone()));
    std::fs::remove_file(&f.own).unwrap();
    assert_eq!(source(&f.bare, "claude", "claude-config", ".credentials.json"), Some(f.store.clone()));
    std::fs::remove_file(&f.store).unwrap();
    assert_eq!(source(&f.bare, "claude", "claude-config", ".credentials.json"), None);
}

#[test]
fn a_home_outside_a_homes_folder_has_no_store() {
    let f = Fx::new("nostore");
    let lone = f.base.join("lone");
    std::fs::create_dir_all(lone.join("claude-config")).unwrap();
    std::fs::write(lone.join("claude-config").join(".credentials.json"), "fake-login").unwrap();
    assert_eq!(source(&lone, "claude", "claude-config", ".credentials.json"), Some(lone.join("claude-config").join(".credentials.json")));
}

#[test]
fn a_broken_link_with_a_newer_call_login_is_written_back_in_place() {
    let f = Fx::new("written");
    // A tab home linked to the store, as `login_link` leaves it.
    let tab = f.bare.join("claude-homes").join("0123456789ab").join(".credentials.json");
    std::fs::create_dir_all(tab.parent().unwrap()).unwrap();
    std::fs::hard_link(&f.store, &tab).unwrap();
    age(&f.store, 3600);
    let before = identity(&f.store).unwrap().unwrap();
    assert_eq!(before.1, 2);
    // The CLI refreshed by rename: the call's name is a new, later file.
    std::fs::write(&f.call, "fake-login-refreshed").unwrap();
    assert_eq!(write_back(&f.bare, &f.store, &f.call), Ok(Back::Written));
    // Same file, same links: the tab home reads the new login too.
    assert_eq!(identity(&f.store).unwrap().unwrap(), before);
    assert_eq!(identity(&tab).unwrap().unwrap(), before);
    assert_eq!(text(&f.store), "fake-login-refreshed");
    assert_eq!(text(&tab), "fake-login-refreshed");
    assert!(!f.store.with_file_name(format!(".credentials.json{TEMP_SUFFIX}")).exists());
    // Own home login untouched; the call's file is still there for `remove_calls`.
    assert_eq!(text(&f.own), "fake-login-own");
    assert!(f.call.is_file());
}

#[test]
fn a_missing_target_is_created() {
    let f = Fx::new("created");
    std::fs::remove_file(&f.own).unwrap();
    std::fs::write(&f.call, "fake-login-refreshed").unwrap();
    assert_eq!(write_back(&f.bare, &f.own, &f.call), Ok(Back::Written));
    assert_eq!(text(&f.own), "fake-login-refreshed");
    assert!(!f.own.with_file_name(format!(".credentials.json{TEMP_SUFFIX}")).exists());
}

#[test]
fn an_intact_link_writes_nothing() {
    let f = Fx::new("linked");
    age(&f.store, 3600);
    std::fs::hard_link(&f.store, &f.call).unwrap();
    // Written in place through the link: the source already holds it.
    std::fs::write(&f.call, "fake-login-in-place").unwrap();
    let before = file_id(&f.store).unwrap();
    assert_eq!(write_back(&f.bare, &f.store, &f.call), Ok(Back::Linked));
    assert_eq!(file_id(&f.store).unwrap(), before);
}

#[test]
fn an_older_call_login_writes_nothing() {
    let f = Fx::new("older");
    std::fs::write(&f.call, "fake-login-old").unwrap();
    age(&f.call, 3600);
    assert_eq!(write_back(&f.bare, &f.store, &f.call), Ok(Back::NotNewer));
    assert_eq!(text(&f.store), "fake-login-store");
}

#[test]
fn a_missing_call_login_is_no_error() {
    let f = Fx::new("missing");
    assert_eq!(write_back(&f.bare, &f.store, &f.call), Ok(Back::Missing));
    assert_eq!(text(&f.store), "fake-login-store");
}
