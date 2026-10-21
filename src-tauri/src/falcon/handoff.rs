//! Jettison / dock handoff (`bridge\falcon\handoff-<direction>.json`).
//!
//! One file PER DIRECTION, no host state: whichever side leaves writes it, the
//! side that arrives peeks it (never destroys on read — a Dock and a Jettison
//! consumer must never eat the other's record) and clears it only once its
//! own adopt has actually succeeded. Two files, not one shared file with a
//! `direction` tag: a `jettison` write and an in-flight `dock` record used to
//! share one path, so the two could clobber each other.
//! Paths come from `FalconPaths::handoff`, joined from the Falcon's root.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{now_ms, write_atomic, Falcon};

/// A record older than this was left by a side that gave up; never adopted.
const HANDOFF_STALE_MS: u64 = 120_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handoff {
    session: String,
    draft: String,
    direction: String,
    at_ms: u64,
}

#[tauri::command]
pub fn falcon_handoff_write(
    falcon: State<'_, Arc<Falcon>>,
    session: String,
    draft: String,
    direction: String,
) -> Result<(), String> {
    let path = falcon.paths.handoff(&direction)?;
    let record = Handoff {
        session,
        draft,
        direction,
        at_ms: now_ms(),
    };
    let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    write_atomic(&path, &text)
}

/// Non-destructive: `None` when absent, mistyped or stale. Only a successful
/// adopt clears the record (`falcon_handoff_clear`), so a consumer that only
/// looked is never the reason the other side lost it.
#[tauri::command]
pub fn falcon_handoff_peek(
    falcon: State<'_, Arc<Falcon>>,
    direction: String,
) -> Result<Option<Handoff>, String> {
    let path = falcon.paths.handoff(&direction)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let record: Handoff = match serde_json::from_str(&text) {
        Ok(record) => record,
        Err(_) => return Ok(None),
    };
    if record.direction != direction {
        return Ok(None);
    }
    if now_ms().saturating_sub(record.at_ms) > HANDOFF_STALE_MS {
        return Ok(None);
    }
    Ok(Some(record))
}

/// Removes the record only if it still matches `direction` (defensive: the
/// two are on separate files now, so a mismatch here would mean the file
/// itself was written wrong, not a cross-direction read) and, when `session`
/// is given, that session: one slot per direction means a second Jettison
/// inside the shell's poll overwrites the first, and a clear meant for the
/// first must not delete the second's record. `session` is optional so an
/// older caller (a shell frontend not rebuilt yet) still clears as before.
/// The read-compare-remove is not atomic; the window is one file read.
#[tauri::command]
pub fn falcon_handoff_clear(
    falcon: State<'_, Arc<Falcon>>,
    direction: String,
    session: Option<String>,
) -> Result<(), String> {
    let path = falcon.paths.handoff(&direction)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if let Ok(record) = serde_json::from_str::<Handoff>(&text) {
        if clears(&record, &direction, session.as_deref()) {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Does a clear for `direction` (and `session`, if named) own `record`?
fn clears(record: &Handoff, direction: &str, session: Option<&str>) -> bool {
    record.direction == direction && session.is_none_or(|session| record.session == session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(session: &str) -> Handoff {
        Handoff {
            session: session.into(),
            draft: String::new(),
            direction: "jettison".into(),
            at_ms: 0,
        }
    }

    /// A clear for the first Jettison must not delete a second one that
    /// overwrote the slot meanwhile.
    #[test]
    fn a_clear_naming_another_session_leaves_the_record() {
        assert!(!clears(&record("s2"), "jettison", Some("s1")));
        assert!(clears(&record("s1"), "jettison", Some("s1")));
        assert!(clears(&record("s2"), "jettison", None), "unnamed clear keeps the old behaviour");
        assert!(!clears(&record("s1"), "dock", None));
    }
}
