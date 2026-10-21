//! Release log file and panic hook, shared by Vidar and the Falcon shell (the shell pulls this
//! file in by `#[path]`, so it must not reach `crate::`). Release builds point the process's
//! stderr at `<dir>\<name>.log` so every `eprintln!` lands there; a panic writes one record
//! (message, location, backtrace) straight to the file. Every error in here is swallowed.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE};

const CAP_BYTES: u64 = 4 * 1024 * 1024;
const ROTATE_EVERY: Duration = Duration::from_secs(60);

struct Log {
    path: PathBuf,
    prev: PathBuf,
    /// The last two handles: the one stderr points at, and the one before it, which a writer
    /// that fetched the old handle a moment before a rotation may still be using.
    files: Vec<File>,
}

static LOG: Mutex<Option<Log>> = Mutex::new(None);
static PANIC_PATH: OnceLock<PathBuf> = OnceLock::new();
static REDIRECTED: AtomicBool = AtomicBool::new(false);

/// Release builds only: stderr to the file, plus the panic hook. Debug keeps stderr on the
/// console and still sends panics to the file.
pub fn init(dir: &Path, name: &str) {
    init_with(dir, name, cfg!(not(debug_assertions)));
}

fn init_with(dir: &Path, name: &str, redirect: bool) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(format!("{name}.log"));
    let prev = dir.join(format!("{name}.prev.log"));
    let _ = PANIC_PATH.set(path.clone());
    if redirect {
        if std::fs::metadata(&path).map(|m| m.len() > CAP_BYTES).unwrap_or(false) {
            let _ = std::fs::rename(&path, &prev);
        }
        if let Some(file) = open_append(&path) {
            banner(&file);
            if redirect_stderr(&file) {
                REDIRECTED.store(true, Ordering::SeqCst);
            }
            if let Ok(mut guard) = LOG.lock() {
                *guard = Some(Log { path, prev, files: vec![file] });
            }
            let _ = std::thread::Builder::new().name("runlog-rotate".into()).spawn(|| loop {
                std::thread::sleep(ROTATE_EVERY);
                rotate();
            });
        }
    }
    install_hook();
}

fn open_append(path: &Path) -> Option<File> {
    // std's default share mode already includes READ, WRITE and DELETE.
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn redirect_stderr(file: &File) -> bool {
    unsafe { SetStdHandle(STD_ERROR_HANDLE, HANDLE(file.as_raw_handle())).is_ok() }
}

fn bin_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "?".into())
}

fn banner(mut file: &File) {
    let _ = writeln!(file, "==== {} {} pid {} ====", utc_stamp(), bin_name(), std::process::id());
}

/// (volume serial, file index) of an open file.
fn file_id(file: &File) -> Option<(u32, u32, u32)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info).ok()? };
    Some((info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
}

/// Size comes from our own handle. If the path no longer names that file (another process
/// rotated it), reopen the path instead of renaming someone else's file.
fn rotate() {
    let Ok(mut guard) = LOG.lock() else { return };
    let Some(log) = guard.as_mut() else { return };
    let Some(current) = log.files.last() else { return };
    if current.metadata().map(|m| m.len()).unwrap_or(0) <= CAP_BYTES {
        return;
    }
    let Some(mine) = file_id(current) else { return };
    let on_path = File::open(&log.path).ok().and_then(|f| file_id(&f));
    if on_path == Some(mine) {
        // Close the older handle first: it may still be open on the .prev we replace.
        while log.files.len() > 1 {
            log.files.remove(0);
        }
        let _ = std::fs::rename(&log.path, &log.prev);
    }
    if let Some(file) = open_append(&log.path) {
        banner(&file);
        redirect_stderr(&file);
        log.files.push(file);
        while log.files.len() > 2 {
            log.files.remove(0);
        }
    }
}

fn install_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut rec = format!(
            "==== {} PANIC {} pid {} thread {}\n",
            utc_stamp(),
            bin_name(),
            std::process::id(),
            std::thread::current().name().unwrap_or("<unnamed>")
        );
        if let Some(loc) = info.location() {
            rec.push_str(&format!("at {}:{}:{}\n", loc.file(), loc.line(), loc.column()));
        }
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string payload>".into());
        rec.push_str(&format!("{msg}\n{}\n", std::backtrace::Backtrace::force_capture()));
        if let Some(file) = PANIC_PATH.get().and_then(|p| open_append(p)) {
            let _ = (&file).write_all(rec.as_bytes());
        }
        if !REDIRECTED.load(Ordering::SeqCst) {
            previous(info);
        }
    }));
}

pub fn utc_stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(all(test, not(falcon_shell)))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    const ROLE: &str = "VIDAR_RUNLOG_ROLE";

    fn helper_name() -> String {
        let local = module_path!().split_once("::").map(|(_, rest)| rest).unwrap_or(module_path!());
        format!("{local}::role_helper")
    }

    /// Not a test on its own: a no-op unless re-run by `panic_and_stderr_reach_the_log`.
    #[test]
    fn role_helper() {
        let Ok(dir) = std::env::var(ROLE) else { return };
        init_with(Path::new(&dir), "t", true);
        eprintln!("MARKER_STDERR");
        panic!("MARKER_PANIC");
    }

    #[test]
    fn panic_and_stderr_reach_the_log() {
        let dir = std::env::temp_dir().join(format!("vidar-runlog-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = Command::new(std::env::current_exe().unwrap())
            .args([helper_name().as_str(), "--exact", "--nocapture", "--test-threads=1"])
            .env(ROLE, &dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        let text = std::fs::read_to_string(dir.join("t.log")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        for needle in ["====", "MARKER_STDERR", "PANIC", "MARKER_PANIC", "runlog.rs:"] {
            assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
        }
    }
}
