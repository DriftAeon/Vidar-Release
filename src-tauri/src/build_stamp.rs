//! The build stamp shown in Settings > General, read from files beside the running exe.
//!
//! Two sources, no git at runtime:
//! - `<exe>.head` (JSON) written by `tools/release/build-release.ps1` beside a local release build:
//!   `head`, `dirty`, `built_utc`. Marked `local`.
//! - `release-manifest.json` beside `vidar.exe` in a release zip (`tools/release/release-zip.ps1`),
//!   whose `exe.build_stamp` carries the same three fields. Not `local`: a zip shipped with
//!   `-AllowDirty` records `dirty`, but the zip user has no local changes, so the view hides it.
//!
//! Neither present (dev builds, swapped `fast` builds) returns `None`.
//!
//! Every stamp also carries `version` (`CARGO_PKG_VERSION`) and `set`: the release set id from
//! `release-manifest.json` `set.id`, `None` when there is no manifest (dev and local builds). The
//! release check (`release_check.rs`) reads both through `VERSION` and `release_set()`.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

/// This build's version, as Cargo.toml states it.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStamp {
    head: String,
    dirty: bool,
    built_utc: String,
    local: bool,
    set: Option<String>,
    version: String,
}

fn from_fields(v: &Value, local: bool) -> Option<BuildStamp> {
    let head = v.get("head")?.as_str()?.trim();
    if head.is_empty() {
        return None;
    }
    Some(BuildStamp {
        head: head.to_string(),
        dirty: v.get("dirty").and_then(Value::as_bool).unwrap_or(false),
        built_utc: v.get("built_utc").and_then(Value::as_str).unwrap_or("").to_string(),
        local,
        set: None,
        version: VERSION.to_string(),
    })
}

/// `set.id` of a release manifest; absent, empty or unreadable is `None`.
fn parse_set(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let id = v.get("set")?.get("id")?.as_str()?.trim();
    (!id.is_empty()).then(|| id.to_string())
}

fn set_beside(exe: &Path) -> Option<String> {
    parse_set(&std::fs::read_to_string(exe.parent()?.join("release-manifest.json")).ok()?)
}

/// The release set this exe shipped in, or `None` outside a release zip.
pub fn release_set() -> Option<String> {
    set_beside(&std::env::current_exe().ok()?)
}

fn parse_head(text: &str) -> Option<BuildStamp> {
    from_fields(&serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?, true)
}

fn parse_manifest(text: &str) -> Option<BuildStamp> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    from_fields(v.get("exe")?.get("build_stamp")?, false)
}

fn read_beside(exe: &Path) -> Option<BuildStamp> {
    let mut head = exe.as_os_str().to_owned();
    head.push(".head");
    let stamp = match std::fs::read_to_string(&head).ok().and_then(|t| parse_head(&t)) {
        Some(s) => s,
        None => parse_manifest(&std::fs::read_to_string(exe.parent()?.join("release-manifest.json")).ok()?)?,
    };
    Some(BuildStamp { set: set_beside(exe), ..stamp })
}

#[tauri::command]
pub fn build_stamp() -> Option<BuildStamp> {
    read_beside(&std::env::current_exe().ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_stamp_head_file_is_local() {
        let s = parse_head(r#"{"head":"abc1234def","dirty":true,"dirty_paths":["x"],"exe_sha256":"00","built_utc":"2026-10-11T00:00:00Z"}"#).unwrap();
        assert_eq!(
            s,
            BuildStamp {
                head: "abc1234def".into(),
                dirty: true,
                built_utc: "2026-10-11T00:00:00Z".into(),
                local: true,
                set: None,
                version: VERSION.into(),
            }
        );
    }

    #[test]
    fn build_stamp_set_and_version() {
        assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
        assert_eq!(parse_set(r#"{"set":{"id":"claude-codex","included":[]}}"#), Some("claude-codex".into()));
        assert_eq!(parse_set("\u{feff}{\"set\":{\"id\":\"claude\"}}"), Some("claude".into()));
        assert_eq!(parse_set(r#"{"head":"x"}"#), None);
        assert_eq!(parse_set(r#"{"set":{"id":""}}"#), None);
        assert_eq!(parse_set("not json"), None);
        assert_eq!(set_beside(Path::new("Z:\\no\\such\\vidar.exe")), None);
    }

    #[test]
    fn build_stamp_manifest_is_not_local() {
        let s = parse_manifest(r#"{"head":"zzz","exe":{"build_stamp":{"head":"abc1234","dirty":true,"built_utc":"t"}}}"#).unwrap();
        assert!(!s.local);
        assert!(s.dirty);
        assert_eq!(s.head, "abc1234");
    }

    #[test]
    fn build_stamp_missing_or_malformed_is_none() {
        assert_eq!(parse_manifest(r#"{"exe":{"build_stamp":null}}"#), None);
        assert_eq!(parse_head("not json"), None);
        assert_eq!(parse_head(r#"{"head":""}"#), None);
        assert_eq!(read_beside(Path::new("Z:\\no\\such\\vidar.exe")), None);
    }
}
