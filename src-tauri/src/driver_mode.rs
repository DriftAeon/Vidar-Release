//! Driver Mode truth file: `runtime\bridge\driver\<falcon session>.json`, the same file
//! `tools\falcon\driver-mode.ps1` writes and `~\.claude\hooks\guard-driver.mjs` reads.
//! On = `{"on":true,"since":"<UTC>"}`; off = no file.

use std::path::{Path, PathBuf};

use crate::{fsx, paths};

/// `s` + 8 hex, `-`, 8 digits. The id becomes a file name, so nothing else gets through.
fn valid_session(session: &str) -> bool {
    let b = session.as_bytes();
    b.len() == 18
        && b[0] == b's'
        && b[1..9].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
        && b[9] == b'-'
        && b[10..].iter().all(|c| c.is_ascii_digit())
}

fn file_for(dir: &Path, session: &str) -> Result<PathBuf, String> {
    if !valid_session(session) {
        return Err(format!("not a Falcon session id: {session}"));
    }
    Ok(dir.join(format!("{session}.json")))
}

/// `yyyy-MM-ddTHH:mm:ssZ` from unix seconds (civil-from-days, proleptic Gregorian).
pub(crate) fn utc_stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn get_in(dir: &Path, session: &str) -> Result<bool, String> {
    let file = file_for(dir, session)?;
    let Ok(text) = fsx::read_text(&file) else { return Ok(false) };
    let value: serde_json::Value = serde_json::from_str(fsx::strip_bom(&text)).unwrap_or_default();
    Ok(value.get("on").and_then(|v| v.as_bool()) == Some(true))
}

fn set_in(dir: &Path, session: &str, on: bool) -> Result<(), String> {
    let file = file_for(dir, session)?;
    if on {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let secs = fsx::now_ms() / 1000;
        let body = format!("{{\"on\":true,\"since\":\"{}\"}}", utc_stamp(secs));
        fsx::atomic_write(&file, body.as_bytes())
    } else {
        match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Is Driver Mode on for this Falcon session?
#[tauri::command]
pub fn driver_mode_get(session: String) -> Result<bool, String> {
    get_in(&paths::driver_mode_dir(), &session)
}

/// Turn Driver Mode on (write the file) or off (delete it) for this Falcon session.
#[tauri::command]
pub fn driver_mode_set(session: String, on: bool) -> Result<(), String> {
    set_in(&paths::driver_mode_dir(), &session, on)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_validate_and_round_trip() {
        assert!(!valid_session("..\\x"));
        assert!(valid_session("s1a2b3c4d-12345678"));
        let dir = std::env::temp_dir().join(format!("vidar-driver-{}", fsx::now_ms()));
        assert_eq!(utc_stamp(0), "1970-01-01T00:00:00Z");
        assert!(!get_in(&dir, "s1a2b3c4d-12345678").unwrap());
        set_in(&dir, "s1a2b3c4d-12345678", true).unwrap();
        assert!(get_in(&dir, "s1a2b3c4d-12345678").unwrap());
        set_in(&dir, "s1a2b3c4d-12345678", false).unwrap();
        assert!(!get_in(&dir, "s1a2b3c4d-12345678").unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
