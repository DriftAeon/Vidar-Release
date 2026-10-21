// What a past Claude conversation last ran on (model + effort), read from the tail of its transcript
// so Resume and the Raw -> Rendered switch can respawn on it instead of the roster entry's launch model.
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const CHUNK: u64 = 256 * 1024;
const TOTAL_CAP: u64 = 4 * 1024 * 1024;

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Newest qualifying assistant line in `text` (lines are in file order; scanned newest first).
/// Only `claude-` model ids count: `<synthetic>` and any other vendor's ids are skipped.
pub fn last_meta(text: &str) -> SessionMeta {
    for line in text.lines().rev() {
        if !line.contains("\"type\":\"assistant\"") { continue; }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue }; // a cut-off line
        if v.get("type").and_then(Value::as_str) != Some("assistant") { continue; }
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) { continue; }
        let Some(model) = v.pointer("/message/model").and_then(Value::as_str) else { continue };
        if !model.starts_with("claude-") { continue; }
        let effort = v.get("effort").and_then(Value::as_str).map(str::to_owned);
        return SessionMeta { model: Some(model.to_owned()), effort };
    }
    SessionMeta::default()
}

fn read_meta(path: &Path) -> SessionMeta {
    let Ok(mut f) = fs::File::open(path) else { return SessionMeta::default() };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return SessionMeta::default() };
    let mut end = len;
    while end > 0 && len - end < TOTAL_CAP {
        let start = end.saturating_sub(CHUNK);
        let mut buf = vec![0u8; (end - start) as usize];
        if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err() {
            return SessionMeta::default();
        }
        // a chunk that starts mid-file may begin with a partial line: skip it here and let the
        // next (older) chunk end right after it, so a line starting exactly at `start` is not lost
        let skip = if start > 0 { buf.iter().position(|&b| b == b'\n').map_or(buf.len(), |i| i + 1) } else { 0 };
        let meta = last_meta(&String::from_utf8_lossy(&buf[skip..]));
        if meta.model.is_some() { return meta; }
        let next = start + skip as u64;
        end = if start > 0 && next < end { next } else { start };
    }
    SessionMeta::default()
}

fn transcript(cwd: &str, session_id: &str, profile: Option<&str>) -> Option<PathBuf> {
    // the id becomes a file name: refuse anything that is not a plain id
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return None; }
    let claude = crate::bare::claude_dir::claude_dir_for(profile)?;
    Some(claude.join("projects").join(crate::status::project_slug(cwd)).join(format!("{session_id}.jsonl")))
}

/// Off the main thread: a transcript runs to megabytes. `profile`: the tab's launch profile.
#[tauri::command]
pub async fn read_session_meta(cwd: String, session_id: String, profile: Option<String>) -> SessionMeta {
    tauri::async_runtime::spawn_blocking(move || {
        transcript(&cwd, &session_id, profile.as_deref()).map(|p| read_meta(&p)).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_meta_picks_newest_claude_line() {
        let text = [
            r#"ssistant","message":{"model":"claude-sonnet-5-5"}}"#, // cut first line
            r#"{"type":"assistant","effort":"high","message":{"model":"claude-opus-5-5"}}"#,
            r#"{"type":"assistant","message":{"model":"acme-1"}}"#,
            r#"{"type":"assistant","message":{"model":"<synthetic>"}}"#,
            r#"{"type":"assistant","message":{"model":"claude-son"#, // cut last line
        ]
        .join("\n");
        assert_eq!(
            last_meta(&text),
            SessionMeta { model: Some("claude-opus-5-5".into()), effort: Some("high".into()) }
        );
    }

    #[test]
    fn transcript_follows_the_profile() {
        let bare = transcript("C:\\r\\x", "abc-1", Some("bare")).unwrap();
        assert!(bare.to_string_lossy().contains("claude-config\\projects\\C--r-x\\abc-1.jsonl"), "{bare:?}");
        assert_eq!(transcript("C:\\r\\x", "abc-1", Some("other")), None);
        assert_eq!(transcript("C:\\r\\x", "../x", None), None);
    }

    #[test]
    fn recent_meta_reads_past_an_old_vendor_entry() {
        // a transcript written under a gateway carries its own fields; they must not stop the read
        let text = [
            r#"{"type":"assistant","effort":"low","message":{"model":"claude-opus-5-5"}}"#,
            r#"{"type":"assistant","gateway":"acme","effort":"max","message":{"model":"acme-1","extra":{"n":1}}}"#,
        ]
        .join("\n");
        assert_eq!(
            last_meta(&text),
            SessionMeta { model: Some("claude-opus-5-5".into()), effort: Some("low".into()) }
        );
    }

    #[test]
    fn recent_meta_none_without_claude_line() {
        let text = [
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","message":{"model":"acme-1"}}"#,
            r#"{"type":"assistant","message":{"model":"<synthetic>"}}"#,
        ]
        .join("\n");
        assert_eq!(last_meta(&text), SessionMeta { model: None, effort: None });
    }
}
