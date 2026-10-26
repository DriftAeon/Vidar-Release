//! src-tauri\src\fsx.rs — shared atomic-write helper. Six variants of
//! "write tmp, rename over" had already drifted apart (config.rs's tmp name
//! collided across concurrent writers, state.rs wrote in place with no tmp at
//! all). This is the shared implementation for config.rs, state.rs and
//! settings::store: a unique tmp name so two writers never collide,
//! `sync_all` before the rename so a crash right after doesn't leave the
//! rename pointing at unflushed data, and the tmp file is removed on a
//! failed rename instead of left behind. `bridge/{workbench.rs,display.rs}`
//! still carries its own four copies of this pattern (write_workbench_png,
//! write_workbench_entry, the decision-file write, and one more) — moving
//! those onto this helper is not done here.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, clamped to 0 on a clock error (before
/// 1970 — never happens, but every caller already treated this as "keep
/// going", not a crash).
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Process-local sequence mixed into every tmp name: two same-process writes
/// that read the same clock value still get different names.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// How many fresh names `reserve_tmp` tries before giving up. A clash needs
/// another process with the same pid, timestamp and counter, so a second try
/// already means something odd; this only bounds the loop.
const TMP_ATTEMPTS: u32 = 16;

/// Creates a sibling tmp file that did not exist before (`create_new`), so a
/// writer never opens — let alone truncates — another writer's staging file.
/// The name is pid + nanosecond timestamp + a process-local counter; on
/// `AlreadyExists` it retries with the next counter value.
fn reserve_tmp(path: &Path) -> std::io::Result<(PathBuf, File)> {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("fsx");
    let mut last_err = None;
    for _ in 0..TMP_ATTEMPTS {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_file_name(format!("{file_name}.{}-{nanos}-{seq}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no free tmp name")))
}

/// Writes `bytes` to `path` by writing a freshly reserved sibling tmp file
/// (`reserve_tmp`), fsyncing it, then renaming over `path`. On any failure
/// the tmp file is removed before returning the error — nothing is left
/// behind for a scanner to trip over. Only a tmp this call created is ever
/// removed.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let (tmp, mut f) = reserve_tmp(path).map_err(|e| e.to_string())?;

    let write_result = (|| -> std::io::Result<()> {
        f.write_all(bytes)?;
        f.sync_all()
    })();
    drop(f);

    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }

    if let Err(e) = rename_retrying(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Windows `ERROR_ACCESS_DENIED` / `ERROR_SHARING_VIOLATION`: what a rename over a file that
/// another writer (or a scanner) is momentarily holding open reports.
#[cfg(windows)]
fn is_rename_contention(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(32))
}

/// Renames `tmp` over `path`; on Windows, contention errors are retried with a short bounded
/// backoff (about 1.5 s worst case). Every other error returns at once.
pub(crate) fn rename_retrying(tmp: &Path, path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        const RENAME_ATTEMPTS: u32 = 40;
        let mut attempt = 0;
        loop {
            match std::fs::rename(tmp, path) {
                Err(e) if is_rename_contention(&e) && attempt + 1 < RENAME_ATTEMPTS => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis((attempt as u64).min(5) * 10));
                }
                other => return other,
            }
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(tmp, path)
}

/// Strips a leading UTF-8 BOM (`\u{FEFF}`): some Windows editors and PowerShell 5 write one,
/// and `serde_json` treats it as invalid JSON rather than whitespace.
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

/// Reads a UTF-8 text file with any leading BOM removed. The io error is returned as-is so a
/// caller can still tell `NotFound` from a locked file.
pub fn read_text(path: &Path) -> std::io::Result<String> {
    let text = std::fs::read_to_string(path)?;
    Ok(match text.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_string(),
        None => text,
    })
}

/// Cap for agent-dropped request files (`read_text_capped`); config reads stay uncapped.
pub const DROP_CAP: u64 = 64 * 1024;

/// `read_text` for files an agent can write: reads at most `cap` bytes and
/// refuses (`InvalidData`) a file with more, so a huge drop never lands in memory.
pub fn read_text_capped(path: &Path, cap: u64) -> std::io::Result<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    File::open(path)?.take(cap + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > cap {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file is larger than {cap} bytes"),
        ));
    }
    let text = String::from_utf8(buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(strip_bom(&text).to_string())
}

/// `read_text` then `serde_json` into `T`; both failure kinds become a message naming the file.
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = read_text(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_json_deserializes_and_tolerates_a_bom() {
        #[derive(serde::Deserialize, PartialEq, Debug)]
        struct Shape {
            a: u32,
        }
        let dir = std::env::temp_dir().join(format!("vidar-fsx-readjson-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bom = dir.join("bom.json");
        let bad = dir.join("bad.json");
        std::fs::write(&bom, "\u{FEFF}{\"a\":7}").unwrap();
        std::fs::write(&bad, "{\"a\":\"x\"}").unwrap();
        let ok = read_json::<Shape>(&bom);
        let wrong_shape = read_json::<Shape>(&bad);
        let missing = read_json::<Shape>(&dir.join("absent.json"));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(ok, Ok(Shape { a: 7 }));
        assert!(wrong_shape.is_err());
        assert!(missing.is_err());
    }

    #[test]
    fn read_text_capped_refuses_an_oversized_file() {
        let dir = std::env::temp_dir().join(format!("vidar-fsx-capped-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let at_cap = dir.join("at.json");
        let over = dir.join("over.json");
        std::fs::write(&at_cap, vec![b'a'; 16]).unwrap();
        std::fs::write(&over, vec![b'a'; 17]).unwrap();
        let bom = dir.join("bom.json");
        std::fs::write(&bom, "\u{FEFF}{}").unwrap();
        let ok = read_text_capped(&at_cap, 16);
        let too_big = read_text_capped(&over, 16);
        let stripped = read_text_capped(&bom, 16);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(ok.unwrap().len(), 16);
        assert_eq!(too_big.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(stripped.unwrap(), "{}");
        assert_eq!(DROP_CAP, 65_536);
    }

    #[test]
    fn atomic_write_creates_and_overwrites() {
        let path = std::env::temp_dir().join("vidar-fsx-test-write.json");
        let _ = std::fs::remove_file(&path);
        atomic_write(&path, b"{\"a\":1}").expect("first write");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        atomic_write(&path, b"{\"a\":2}").expect("overwrite");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file_on_success() {
        let dir = std::env::temp_dir().join("vidar-fsx-test-dir");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("clean.json");
        let _ = std::fs::remove_file(&path);
        atomic_write(&path, b"{}").expect("write");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no tmp file should remain: {leftovers:?}");
        let _ = std::fs::remove_file(&path);
    }

    // Review finding 8: several threads write the same destination at once. No
    // write may fail on a tmp collision, the published file must equal exactly
    // one complete payload, and no tmp file may be left behind.
    #[test]
    fn concurrent_writers_to_one_destination_publish_one_whole_payload() {
        const WRITERS: usize = 8;
        const ROUNDS: usize = 25;
        // Unique per run (pid + nanos) so parallel or leftover runs never share the dir;
        // removed below before the asserts.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir()
            .join(format!("vidar-fsx-test-concurrent-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shared.json");
        // Distinct, large-ish payloads so a truncated or interleaved stage
        // could never equal any one of them.
        let payloads: Vec<Vec<u8>> =
            (0..WRITERS).map(|i| vec![b'a' + i as u8; 64 * 1024]).collect();

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(WRITERS));
        let handles: Vec<_> = payloads
            .iter()
            .cloned()
            .map(|payload| {
                let barrier = barrier.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..ROUNDS).map(|_| atomic_write(&path, &payload)).collect::<Vec<_>>()
                })
            })
            .collect();
        let results: Vec<Result<(), String>> =
            handles.into_iter().flat_map(|h| h.join().expect("writer thread")).collect();

        let published = std::fs::read(&path).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .map(|e| e.file_name())
            .collect();
        let _ = std::fs::remove_dir_all(&dir);

        let errors: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();
        assert!(errors.is_empty(), "concurrent writes failed: {errors:?}");
        assert!(payloads.contains(&published), "published file is not one complete payload");
        assert!(leftovers.is_empty(), "tmp files left behind: {leftovers:?}");
    }

    #[test]
    fn now_ms_is_a_plausible_recent_timestamp() {
        // 2026-01-01 in ms since epoch — a loose floor so this never flakes,
        // just catches "returned 0" or "returned seconds instead of ms".
        assert!(now_ms() > 1_767_225_600_000);
    }
}
