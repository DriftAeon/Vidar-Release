//! The vault's model rune in the Bare homes (runes-gaps G2): settings.json `model` and config.toml's
//! top-level `model`, written through the escapers and mirrored into the template check.

use super::home::{
    generate_codex_config_for, generate_codex_config_with, generate_settings, generate_settings_with, parse_toml_lite, prepare_dirs, Guard,
    HookTrust, SettingsExtras, Toml, TomlDoc,
};
use super::codex_mcp::Tables as McpTables;
use serde_json::Value;
use std::path::{Path, PathBuf};

const PAYLOAD: &str = "Line one.\nVIDAR-PAYLOAD-0123456789ab\n";
const PWSH: &str = r"C:\Users\testuser\AppData\Local\Microsoft\WindowsApps\pwsh.exe";

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-bare-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn guard() -> Guard {
    Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) }
}

fn profiles(name: &str) -> PathBuf {
    crate::paths::root().join("profiles").join("bare").join(name)
}

/// A Codex config generated with `model` under `<t>\<sub>`, parsed back, and its bytes.
fn codex_with_model(t: &Tmp, sub: &str, model: Option<&str>) -> (TomlDoc, String) {
    let (root, home) = (t.0.join("root"), t.0.join(sub));
    prepare_dirs(&home, &["codex-home".into()]).unwrap();
    let target = home.join("codex-home").join("config.toml");
    generate_codex_config_with(&profiles("codex.config.template.toml"), &target, &root, &home, Path::new(PWSH), PAYLOAD, &guard(), None, &McpTables::default(), &HookTrust::default(), model).unwrap();
    let text = std::fs::read_to_string(&target).unwrap();
    (parse_toml_lite(&text).unwrap(), text)
}

fn model_of(doc: &TomlDoc) -> Option<&Toml> {
    doc.iter().find(|(k, _)| k == "model").map(|(_, v)| v)
}

#[test]
fn a_model_rune_is_a_top_level_codex_key_and_none_leaves_the_bytes() {
    let t = Tmp::new("codex-model");
    let (doc, text) = codex_with_model(&t, "h1", Some("gpt-6"));
    assert_eq!(model_of(&doc), Some(&Toml::Str("gpt-6".into())));
    assert!(text.starts_with("model = \"gpt-6\"\n"));
    // No model rune: no key, the same bytes as the pre-model generator.
    let (plain, plain_text) = codex_with_model(&t, "h2", None);
    assert!(model_of(&plain).is_none());
    assert_eq!(plain_text, text.strip_prefix("model = \"gpt-6\"\n").unwrap());
    let (root, home) = (t.0.join("root"), t.0.join("h3"));
    prepare_dirs(&home, &["codex-home".into()]).unwrap();
    let target = home.join("codex-home").join("config.toml");
    generate_codex_config_for(&profiles("codex.config.template.toml"), &target, &root, &home, Path::new(PWSH), PAYLOAD, &guard(), None, &McpTables::default()).unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), plain_text);
}

#[test]
fn a_backslash_in_a_codex_model_name_round_trips() {
    let t = Tmp::new("codex-model-bs");
    let (doc, _) = codex_with_model(&t, "h1", Some(r"a\b'c"));
    assert_eq!(model_of(&doc), Some(&Toml::Str(r"a\b'c".into())));
}

#[test]
fn a_model_rune_is_a_claude_settings_key_and_none_leaves_the_bytes() {
    let t = Tmp::new("claude-model");
    let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
    prepare_dirs(&home, &["claude-config".into()]).unwrap();
    let template = profiles("claude.settings.template.json");
    let dir = home.join("claude-config");
    let (plain, with, again) = (dir.join("plain.json"), dir.join("settings.json"), dir.join("again.json"));
    generate_settings(&template, &plain, &root, &home, &guard(), &[]).unwrap();
    let extras = SettingsExtras { model: Some(r"opus\[1m]".to_string()), ..Default::default() };
    generate_settings_with(&template, &with, &root, &home, &guard(), &[], &extras).unwrap();
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&with).unwrap()).unwrap();
    assert_eq!(v["model"].as_str(), Some(r"opus\[1m]"));
    let p: Value = serde_json::from_str(&std::fs::read_to_string(&plain).unwrap()).unwrap();
    assert!(p.get("model").is_none());
    // Without a model the extras path writes the plain bytes.
    generate_settings_with(&template, &again, &root, &home, &guard(), &[], &SettingsExtras::default()).unwrap();
    assert_eq!(std::fs::read(&again).unwrap(), std::fs::read(&plain).unwrap());
}
