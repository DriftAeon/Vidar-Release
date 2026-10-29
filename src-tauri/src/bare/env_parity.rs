//! src-tauri\src\bare\env_parity.rs — env parity, Rust half: `prepare_with` (Claude) and `env::codex`
//! (Codex) against `tests/fixtures/agent-env-parity.json`, the fixture `tests/agent-env-parity.test.mjs`
//! holds the JS builder (`tools/lib/agent-env.mjs` buildBareEnv) to. Same contract, same profiles, same
//! parent env in the fixture's own order (first spelling wins): the same env names, spelling included
//! (compared case-insensitively for order only).

use super::*;
use std::ffi::OsString;

#[derive(Deserialize)]
struct Fixture {
    /// serde_json's `preserve_order` keeps the file order, which decides the first spelling.
    parent: serde_json::Map<String, serde_json::Value>,
    expected: Vec<String>,
    /// Every other key (the `$comment`, each other agent's block), by its fixture name.
    #[serde(flatten)]
    others: BTreeMap<String, serde_json::Value>,
}

/// The `expected` names of the agent block `name`.
fn expected_of(f: &Fixture, name: &str) -> Vec<String> {
    serde_json::from_value(f.others[name]["expected"].clone()).expect("agent block lists its expected names")
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../../../tests/fixtures/agent-env-parity.json")).expect("parity fixture is valid")
}

fn inherited(f: &Fixture) -> Vec<(OsString, OsString)> {
    f.parent.iter().map(|(k, v)| (k.into(), v.as_str().expect("parent values are strings").into())).collect()
}

fn parent_value<'a>(f: &'a Fixture, name: &str) -> Option<&'a str> {
    f.parent.get(name).and_then(|v| v.as_str())
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort_by_key(|n| n.to_lowercase());
    v
}

/// A drop-list name may only be there because the overlay set it again (CLAUDE_CONFIG_DIR, CODEX_HOME).
fn assert_no_inherited_drop(f: &Fixture, built: &Env) {
    for (n, v) in built.iter() {
        let n = n.to_string_lossy();
        if env::in_drop_list(&n) {
            assert_ne!(Some(v.to_string_lossy().as_ref()), parent_value(f, &n), "{n} inherited");
        }
    }
}

#[test]
fn the_fixture_parent_keeps_file_order() {
    let f = fixture();
    let keys: Vec<&str> = f.parent.keys().map(String::as_str).collect();
    let at = |k: &str| keys.iter().position(|x| *x == k).unwrap();
    assert!(at("PathExt") < at("PATHEXT"), "fixture order, not sort order");
}

#[test]
fn rust_builder_gives_the_fixture_names() {
    let f = fixture();
    let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let tmp = std::env::temp_dir().join(format!("vidar-bare-parity-{}-{nanos}", std::process::id()));
    let guard = home::Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) };
    let find = |_: &Env, name: &str| Some(PathBuf::from(r"X:\bin").join(name));
    let probes = Probes { find: &find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let result = prepare_with("bare", &crate::paths::root(), &tmp.join("agent-home"), inherited(&f), &Ambient::default(), &guard, &probes, &LaunchOpts { vault: Some(super::launch_row::TEST_NO_VAULT), ..Default::default() });
    let built = result.map(|l| l.env);
    let _ = std::fs::remove_dir_all(&tmp);
    let built = built.expect("prepare_with succeeds on the fixture");
    assert_no_inherited_drop(&f, &built);
    assert_eq!(sorted(built.names()), sorted(f.expected));
}

#[test]
fn rust_codex_builder_gives_the_fixture_names() {
    let f = fixture();
    let p = load_codex_profile(&crate::paths::root(), "bare").expect("profiles/bare/codex.json loads");
    let fill = |s: &str| s.replace("{{root}}", r"X:\vidar").replace("{{home}}", r"X:\vidar\runtime\homes");
    let overlay: BTreeMap<String, String> = p.overlay.iter().map(|(k, v)| (k.clone(), fill(v))).collect();
    let built = env::codex(inherited(&f), &overlay).expect("env::codex succeeds on the fixture");
    assert_no_inherited_drop(&f, &built);
    assert_eq!(built.get("CODEX_HOME").map(|v| v.to_string_lossy().into_owned()), Some(r"X:\vidar\runtime\homes\codex-home".into()));
    assert_eq!(built.get("LOCALAPPDATA").map(|v| v.to_string_lossy().into_owned()).as_deref(), parent_value(&f, "LOCALAPPDATA"), "the real one");
    assert_eq!(sorted(built.names()), sorted(expected_of(&f, "codex")));
}
