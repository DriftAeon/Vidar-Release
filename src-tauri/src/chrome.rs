use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;

// Hand-rolled Win32 FFI — a handful of functions, not worth a crate. DWM
// caption attributes are Win11-only (build 22000+); this machine is 26200.
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, attr: u32, pv: *const c_void, cb: u32) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: isize,
        op: *const u16,
        file: *const u16,
        params: *const u16,
        dir: *const u16,
        show: i32,
    ) -> isize;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pv: *mut c_void, co_init: u32) -> i32;
    fn CoUninitialize();
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

// ShellExecuteW over `cmd /c start`: terminal output is attacker-influenced
// (any program can print a crafted URL the user clicks), and start's quoting
// rules make cmd an injection surface. Scheme allowlist is the gate.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("scheme not allowed".into());
    }
    std::thread::spawn(move || unsafe {
        // Shell extensions may need COM: STA + DISABLE_OLE1DDE per docs.
        CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4);
        let op = wide("open");
        let file = wide(&url);
        // success is > 32; failure here has no useful user action, drop it
        let _ = ShellExecuteW(0, op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1);
        CoUninitialize();
    });
    Ok(())
}

/// Open a document's folder in whatever handles folders (the `open` verb goes
/// to the registered folder handler — File Pilot when it has taken folders
/// over; `explore` would force Explorer). A file path resolves to its parent.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let b = path.as_bytes();
    let rooted = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if !rooted {
        return Err("path must be drive-rooted".into());
    }
    let p = std::path::PathBuf::from(&path);
    let dir = if p.is_dir() { p } else if p.is_file() { p.parent().map(|d| d.to_path_buf()).ok_or("no parent folder")? } else { return Err("path does not exist".into()) };
    let target = dir.to_string_lossy().into_owned();
    std::thread::spawn(move || unsafe {
        CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4);
        let op = wide("open");
        let file = wide(&target);
        let _ = ShellExecuteW(0, op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1);
        CoUninitialize();
    });
    Ok(())
}

/// Open a document with the app named by vidar.json `documentApp` (an `.exe`,
/// spawned with the file as one argument), else with whatever the shell has
/// registered for its type. Narrower than `open_in_editor`, which forces
/// Rider: the Document tab only ever shows `.md`/`.txt`, so that is the whole
/// allowlist. The path comes from our own directory listing rather than from
/// terminal output, but it is hardened the same way anyway.
///
/// Any open failure (no association, a missing or refused exe, a spawn error)
/// falls back to the Windows Open With dialog, where the user can pick an app
/// and make it the default. `Ok(Some(note))` means that dialog ran (cancel included) and
/// `note` is the panel's status line; `Ok(None)` means the open went through. A path the
/// hardening refuses, and a shell error other than "no association", stay an `Err`: the
/// dialog could not cure those.
///
/// Async + `spawn_blocking` because unlike `open_folder` this one *joins*: the
/// return code is the only way to tell nothing is registered for the type
/// (SE_ERR_NOASSOC = 31), and a join must not sit on the webview thread.
#[tauri::command]
pub async fn open_document(window: tauri::WebviewWindow, path: String) -> Result<Option<String>, String> {
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    tauri::async_runtime::spawn_blocking(move || {
        let target = harden_path(&path, DOC_EXTS)?;
        let setting = crate::config::load().config.document_app;
        let app = doc_app(setting.as_deref(), |p| crate::editor::check_exe(p, "documentApp"));
        // why an earlier step gave up, for the dialog's note and its error
        let mut why = match &app {
            DocApp::Invalid(r) => Some(r.clone()),
            _ => None,
        };
        let mut prev = None;
        loop {
            match next_step(&app, prev) {
                OpenStep::Done => return Ok(None),
                OpenStep::Spawn(exe) => {
                    prev = Some(match spawn_app(&exe, &target) {
                        Ok(()) => true,
                        Err(e) => {
                            why = Some(format!("could not start {exe}: {e}"));
                            false
                        }
                    });
                }
                OpenStep::Shell => {
                    let code = shell_code(&target);
                    if code != SHELL_NOASSOC && code <= 32 {
                        return Err(shell_error(code));
                    }
                    if code == SHELL_NOASSOC {
                        why = Some(shell_error(code));
                    }
                    prev = Some(code > 32);
                }
                OpenStep::Dialog => {
                    let note = match &app {
                        DocApp::Unset => PICK_NOTE.to_string(),
                        _ => format!("Document App not used: {}.", why.as_deref().unwrap_or("it did not open").trim_end_matches('.')),
                    };
                    return open_with_dialog(owner, &target).map(|()| Some(note)).map_err(|e| match &why {
                        Some(w) => format!("{e} (earlier: {w})"),
                        None => e,
                    });
                }
            }
        }
    })
    .await
    .map_err(|e| format!("open task failed: {e}"))?
}

const PICK_NOTE: &str = "Pick an app, or set one in Settings › General › Document App.";

/// The `documentApp` setting as the open path sees it.
#[derive(Debug, PartialEq)]
enum DocApp {
    /// Blank or absent: the Windows default app.
    Unset,
    /// Names an existing `.exe`.
    Valid(String),
    /// Set, but not a usable exe (missing, `.cmd`/`.bat`, not an `.exe`); carries `check_exe`'s reason.
    Invalid(String),
}

#[derive(Debug, PartialEq)]
enum OpenStep {
    Spawn(String),
    Shell,
    Dialog,
    Done,
}

fn doc_app(setting: Option<&str>, check: impl Fn(&std::path::Path) -> Result<(), String>) -> DocApp {
    match setting.map(str::trim).filter(|s| !s.is_empty()) {
        None => DocApp::Unset,
        Some(s) => match check(std::path::Path::new(s)) {
            Ok(()) => DocApp::Valid(s.to_string()),
            Err(why) => DocApp::Invalid(why),
        },
    }
}

/// The branch choice. `prev` is how the previous step went (`None` = nothing tried
/// yet, `Some(true)` = it opened the file). A set exe is spawned first, an unset one
/// goes to the shell, an invalid one skips straight to the dialog; any failure after
/// a step ends in the dialog, which is never retried.
fn next_step(app: &DocApp, prev: Option<bool>) -> OpenStep {
    match (prev, app) {
        (Some(true), _) => OpenStep::Done,
        (Some(false), _) => OpenStep::Dialog,
        (None, DocApp::Unset) => OpenStep::Shell,
        (None, DocApp::Valid(exe)) => OpenStep::Spawn(exe.clone()),
        (None, DocApp::Invalid(_)) => OpenStep::Dialog,
    }
}

/// Spawn, never wait (like `open_in_editor`): the file is one argv entry, no shell. The child
/// gets Vidar's env minus `pty::SCRUBBED_ENV`, so agent-session markers never reach the app.
fn spawn_app(exe: &str, file: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for key in crate::pty::SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The Open With dialog, offering to register the picked app as the default. Runs on the
/// calling (blocking) thread in an STA, owned by the main window. A user cancel is not an error.
fn open_with_dialog(owner: isize, file: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::UI::Shell::{
        SHOpenWithDialog, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT, OPENASINFO,
    };
    let w = wide(file);
    // F6: its own thread, so STA is ours and not a pool thread's earlier MTA. The pointers and the
    // COM error stay inside the closure (neither is Send).
    let r = run_sta(move || {
        let info = OPENASINFO {
            pcszFile: PCWSTR(w.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC,
        };
        match unsafe { SHOpenWithDialog(Some(HWND(owner as *mut _)), &info) } {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => Ok(()),
            Err(e) => Err(format!("open with dialog failed: {e}")),
        }
    });
    r.unwrap_or_else(|| Err("open with dialog failed: the dialog thread stopped".into()))
}

/// Open an `.html`/`.htm` file with the shell's handler for its type: the default
/// browser on a stock install (no browser is named here). An image (svg, png, jpg,
/// jpeg, gif, webp) opens in the program registered for `.html` instead, as a
/// `file:///` URL, never through the image's own handler (the photo viewer).
/// Same hardening as `open_document`, only the allowlist differs; the UI hides or
/// disables the button for any other extension, this is the backstop.
#[tauri::command]
pub async fn open_in_browser(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let plain = harden_path(&path, BROWSER_EXTS)?;
        if is_html_path(&plain) {
            shell_execute(&plain)
        } else {
            let exe = html_handler_exe()?;
            spawn_app(&exe, &file_url(&plain))
        }
    })
    .await
    .map_err(|e| format!("open task failed: {e}"))?
}

const DOC_EXTS: &[&str] = &["md", "txt"];
const HTML_EXTS: &[&str] = &["html", "htm"];
const BROWSER_EXTS: &[&str] = &["html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp"];

fn is_html_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    HTML_EXTS.iter().any(|e| lower.ends_with(&format!(".{e}")))
}

/// `C:\a b\#x.png` -> `file:///C:/a%20b/%23x.png`: backslashes to slashes, everything outside
/// unreserved characters, `/` and the drive colon percent-encoded (UTF-8 bytes).
fn file_url(path: &str) -> String {
    let mut out = String::from("file:///");
    for (i, c) in path.replace('\\', "/").chars().enumerate() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/') || (i == 1 && c == ':') {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for byte in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// The executable registered for `.html` (the default browser), or an error: an image never
/// falls back to its own handler.
fn html_handler_exe() -> Result<String, String> {
    use windows::core::{w, PWSTR};
    use windows::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_NONE, ASSOCSTR_EXECUTABLE};
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let r = unsafe {
        AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_EXECUTABLE, w!(".html"), None, Some(PWSTR(buf.as_mut_ptr())), &mut len)
    };
    if r.is_err() || len < 2 {
        return Err("no browser registered for .html".into());
    }
    // len counts the terminating NUL
    let exe = String::from_utf16_lossy(&buf[..(len as usize - 1).min(buf.len())]);
    if exe.trim().is_empty() {
        return Err("no browser registered for .html".into());
    }
    Ok(exe)
}

/// The path hardening shared by every open: returns the plain (no `\\?\`) resolved path.
fn harden_path(path: &str, exts: &[&str]) -> Result<String, String> {
    let b = path.as_bytes();
    if b.len() < 4 || !b[0].is_ascii_alphabetic() || b[1] != b':' || (b[2] != b'\\' && b[2] != b'/') {
        return Err("not a drive-letter path".into());
    }
    // On the RAW input: the canonical form below carries a second colon by
    // construction (\\?\C:\...), so an ADS check there would never fire.
    if path[2..].contains(':') {
        return Err("colon in path body".into());
    }
    let canon = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canon.is_file() {
        return Err("not a file".into());
    }
    let cs = canon.to_string_lossy();
    // reserved device names (CON, NUL...) don't canonicalize to \\?\<drive>:
    let ok_prefix = cs.strip_prefix("\\\\?\\").map_or(false, |rest| {
        rest.as_bytes().first().map_or(false, |c| c.is_ascii_alphabetic())
            && rest.as_bytes().get(1) == Some(&b':')
    });
    if !ok_prefix {
        return Err("unexpected canonical form".into());
    }
    // Extension checked on the RESOLVED name: a junction or a symlink cannot
    // smuggle a .exe in behind a .md.
    let ext = canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("no extension")?;
    if !exts.contains(&ext.as_str()) {
        return Err(format!("extension .{ext} not allowed"));
    }
    // ShellExecuteW does not reliably take the \\?\ long-path prefix that
    // canonicalize adds (editor.rs strips it for Rider for the same reason).
    Ok(cs.trim_start_matches("\\\\?\\").to_string())
}

/// SE_ERR_NOASSOC
const SHELL_NOASSOC: isize = 31;

/// ShellExecuteW's return: > 32 is success, and the value is an error code otherwise.
fn shell_code(target: &str) -> isize {
    let op = wide("open");
    let file = wide(target);
    // Shell extensions may need COM: STA + DISABLE_OLE1DDE per docs, on a thread of our own (F6).
    run_sta(move || unsafe {
        ShellExecuteW(0, op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1)
    })
    .unwrap_or(0)
}

/// Runs `f` on a fresh thread that initialises COM as STA with DISABLE_OLE1DDE and uninitialises it
/// after, and waits. A tokio blocking-pool thread may already be in the MTA (RPC_E_CHANGED_MODE);
/// a thread made here never is. `None` when the thread could not start or panicked.
fn run_sta<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    std::thread::Builder::new()
        .name("sta-shell".into())
        .spawn(move || {
            let init = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4) };
            let r = f();
            if init >= 0 {
                unsafe { CoUninitialize() };
            }
            r
        })
        .ok()?
        .join()
        .ok()
}

fn shell_error(code: isize) -> String {
    match code {
        SHELL_NOASSOC => "no application is registered for this file type".into(),
        2 | 3 => "the shell could not find the file".into(),
        5 => "access denied".into(),
        other => format!("the shell refused to open it (code {other})"),
    }
}

fn shell_execute(target: &str) -> Result<(), String> {
    let code = shell_code(target);
    if code > 32 {
        return Ok(());
    }
    Err(shell_error(code))
}

const DWMWA_CAPTION_COLOR: u32 = 35;
const DWMWA_TEXT_COLOR: u32 = 36;

fn colorref(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

#[tauri::command]
pub fn set_caption_color(
    window: tauri::WebviewWindow,
    r: u8,
    g: u8,
    b: u8,
    tr: u8,
    tg: u8,
    tb: u8,
) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let cap = colorref(r, g, b);
    let txt = colorref(tr, tg, tb);
    unsafe {
        DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &cap as *const u32 as *const c_void, 4);
        DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &txt as *const u32 as *const c_void, 4);
    }
    Ok(())
}

// Window icon (WM_SETICON ICON_SMALL), shown at the window's top-left corner; the Vidar-drawn
// caption row (caption.rs) draws its own icon beside it from a PNG. tauri's set_icon lands on tao's set_window_icon,
// which sends one WM_SETICON with ICON_SMALL and never touches ICON_BIG
// (tao 0.35.3 window.rs:882-891) — so the taskbar button, Alt-Tab tile and
// pinned shortcut keep the exe-resource icon build.rs embeds from icon.ico.
// tao parks the HICON in window_state as an Arc<Owned<HICON>>, so there is
// nothing to keep alive or free here.
//
// Straight (non-premultiplied) RGBA8, row-major, 32x32: tao swaps to BGRA
// itself (icon.rs:19-22). Regenerate with tools\release\make-titlebar-icon.ps1;
// icons\titlebar-32.png is the same pixels, viewable, for review.
const TITLEBAR_ICON: &[u8] = include_bytes!("../icons/titlebar-32.rgba");
const TITLEBAR_ICON_PX: u32 = 32;

pub fn set_titlebar_icon(window: &tauri::WebviewWindow) {
    let img = tauri::image::Image::new(TITLEBAR_ICON, TITLEBAR_ICON_PX, TITLEBAR_ICON_PX);
    if let Err(e) = window.set_icon(img) {
        eprintln!("titlebar icon: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_browser_allow_list_takes_images_and_refuses_programs() {
        let dir = std::env::temp_dir().join(format!("vidar-browser-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let check = |ext: &str| {
            let p = dir.join(format!("f.{ext}"));
            std::fs::write(&p, b"x").unwrap();
            harden_path(p.to_str().unwrap(), BROWSER_EXTS)
        };
        for ok in ["png", "PNG", "html", "svg", "webp"] {
            assert!(check(ok).is_ok(), "{ok}");
        }
        for bad in ["exe", "bat", "lnk"] {
            assert!(check(bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_url_encodes_space_hash_and_percent() {
        assert_eq!(file_url("C:\\a b\\#x%.png"), "file:///C:/a%20b/%23x%25.png");
        assert!(is_html_path("C:\\a\\p.HTML") && !is_html_path("C:\\a\\p.png"));
    }

    fn app(setting: Option<&str>, ok: bool) -> DocApp {
        doc_app(setting, |_| if ok { Ok(()) } else { Err("bad exe".to_string()) })
    }

    #[test]
    fn the_setting_is_unset_valid_or_invalid() {
        assert_eq!(app(None, true), DocApp::Unset);
        assert_eq!(app(Some("  "), true), DocApp::Unset);
        assert_eq!(app(Some(" C:\\a\\app.exe "), true), DocApp::Valid("C:\\a\\app.exe".into()));
        assert_eq!(app(Some("C:\\a\\app.exe"), false), DocApp::Invalid("bad exe".into()));
    }

    #[test]
    fn the_first_step_follows_the_setting() {
        assert_eq!(next_step(&DocApp::Unset, None), OpenStep::Shell);
        assert_eq!(next_step(&DocApp::Valid("C:\\a.exe".into()), None), OpenStep::Spawn("C:\\a.exe".into()));
        assert_eq!(next_step(&DocApp::Invalid("x".into()), None), OpenStep::Dialog);
    }

    #[test]
    fn a_step_that_opened_the_file_is_done_and_a_failed_one_ends_in_the_dialog() {
        for a in [DocApp::Unset, DocApp::Valid("C:\\a.exe".into()), DocApp::Invalid("x".into())] {
            assert_eq!(next_step(&a, Some(true)), OpenStep::Done);
            assert_eq!(next_step(&a, Some(false)), OpenStep::Dialog);
        }
    }

    #[test]
    fn only_no_association_is_a_dialog_case_among_the_shell_codes() {
        assert_eq!(shell_error(SHELL_NOASSOC), "no application is registered for this file type");
        assert_eq!(shell_error(2), "the shell could not find the file");
        assert_eq!(shell_error(5), "access denied");
        assert_eq!(shell_error(8), "the shell refused to open it (code 8)");
    }

    #[test]
    fn a_missing_exe_and_a_cmd_launcher_read_as_invalid_through_check_exe() {
        let dir = std::env::temp_dir();
        let tag = std::process::id();
        let cmd = dir.join(format!("vidar-chrome-test-docapp-{tag}.cmd"));
        std::fs::write(&cmd, b"x").unwrap();
        let check = |p: &std::path::Path| crate::editor::check_exe(p, "documentApp");
        let missing = dir.join(format!("vidar-chrome-test-docapp-missing-{tag}.exe"));
        let got = (
            doc_app(Some(&cmd.to_string_lossy()), check),
            doc_app(Some(&missing.to_string_lossy()), check),
        );
        let _ = std::fs::remove_file(&cmd);
        assert!(matches!(got.0, DocApp::Invalid(_)), "{:?}", got.0);
        assert!(matches!(got.1, DocApp::Invalid(_)), "{:?}", got.1);
    }
}
