//! src-tauri\src\bare\launch_row_tests.rs — the Codex Bare row admission reads the row's agent id
//! through `agent_spec::parse`: an unknown id is refused, never taken for Codex.

use super::admit_row_key;

fn config_with(id: &str, tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("vidar-launch-row-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("row-config.json");
    let json = serde_json::json!({ "agents": [{ "key": "my-row", "id": id, "profile": "bare" }] });
    std::fs::write(&path, json.to_string()).unwrap();
    path
}

#[test]
fn a_codex_row_is_admitted() {
    let c = config_with("codex", "codex");
    assert_eq!(admit_row_key(Some("my-row".into()), Some("bare"), Some(&c)).unwrap(), Some("my-row".to_string()));
}

#[test]
fn a_grok_row_is_refused() {
    let c = config_with("grok", "grok");
    let e = admit_row_key(Some("my-row".into()), Some("bare"), Some(&c)).unwrap_err();
    assert!(e.contains("is not a Codex Bare row"), "{e}");
}

#[test]
fn a_claude_row_is_refused() {
    let c = config_with("claude", "claude");
    assert!(admit_row_key(Some("my-row".into()), Some("bare"), Some(&c)).is_err());
}
