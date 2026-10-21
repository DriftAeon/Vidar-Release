// Marquee OCR: drag a rectangle over ANY window on screen, get its text.
//
// Three commands. `ocr_begin` opens a transparent always-on-top overlay that
// spans the whole virtual screen (that is what lets the drag cross Unreal, a
// browser, an image — anything, not just Vidar). The overlay page reports the
// dragged rectangle to `ocr_capture`, which hides the overlay, grabs those
// screen pixels with GDI, and runs them through the OCR engine that ships
// inside Windows. Result arrives on the main window as an `ocr-result` event.
// Opt-in VIDAR_OCR_DEBUG=1 saves diagnostic BMPs in the OS temp directory.

use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

const OVERLAY: &str = "ocr-overlay";
mod capture;
mod debug;
mod geometry;
mod pixels;
mod recognize;

struct VScreen {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

fn virtual_screen() -> VScreen {
    unsafe {
        VScreen {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

fn close_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        // Off the calling thread: sync commands run on the event-loop thread,
        // and closing a window from there while the loop is mid-teardown of
        // another window is how the close-time deadlock bites.
        thread::spawn(move || {
            let _ = w.close();
        });
    }
}

// ASYNC ON PURPOSE. A sync command runs on the event-loop thread, and on
// Windows WebviewWindowBuilder::build() deadlocks there (tauri docs,
// webview_window.rs "deadlocks when used in a synchronous command"): the HWND
// appears, the WebView2 never finishes, and every later IPC call from main
// hangs behind it. Seen with a hidden 800x600 "Vidar marquee" HWND,
// no overlay DevTools target, all invokes timing out.
#[tauri::command]
pub async fn ocr_begin(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.set_focus();
        return Ok(());
    }
    let vs = virtual_screen();
    let main = app.get_webview_window("main").ok_or("no main window")?;
    let win = WebviewWindowBuilder::new(&app, OVERLAY, WebviewUrl::App("overlay.html".into()))
        // Owned by main: Windows destroys it when main is destroyed, so closing
        // Vidar mid-marquee can't leave an invisible window (and process) behind.
        .owner(&main)
        .map_err(|e| e.to_string())?
        .title("Vidar marquee")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    // Physical, not logical: the virtual screen is measured in device pixels
    // and the builder's position()/inner_size() are logical.
    win.set_position(PhysicalPosition::new(vs.x, vs.y)).map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(vs.w as u32, vs.h as u32)).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

/// Event for an `ocr_cancel` call: a blur (the overlay lost focus) ends only the current pick, like
/// a stray click, so the tool stays armed; an explicit end (Esc, right-click, disarm) releases it.
fn cancel_event(blur: Option<bool>) -> &'static str {
    if blur.unwrap_or(false) { "ocr-empty" } else { "ocr-cancel" }
}

#[tauri::command]
pub fn ocr_cancel(app: AppHandle, blur: Option<bool>) {
    close_overlay(&app);
    let _ = app.emit(cancel_event(blur), ());
}

#[cfg(test)]
mod cancel_tests {
    use super::cancel_event;

    #[test]
    fn blur_keeps_the_tool_armed_and_an_explicit_end_releases_it() {
        assert_eq!(cancel_event(Some(true)), "ocr-empty");
        assert_eq!(cancel_event(Some(false)), "ocr-cancel");
        assert_eq!(cancel_event(None), "ocr-cancel");
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrOutcome {
    text: String,
    width: i32,
    height: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    debug_crop: Option<String>,
}

/// `ocr-error` payload: the message, plus the diagnostic crop path when one was saved, kept
/// apart so the panel shows the path on its own line.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrError {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    debug_crop: Option<String>,
}

/// CSS client coordinates are mapped using measured physical client bounds.
#[tauri::command]
pub fn ocr_capture(
    app: AppHandle, x: f64, y: f64, w: f64, h: f64, viewport_width: f64, viewport_height: f64,
) -> Result<(), String> {
    let prepare = || {
        let overlay = app.get_webview_window(OVERLAY).ok_or("No Capture Overlay")?;
        let origin = overlay.inner_position().map_err(|e| e.to_string())?;
        let size = overlay.inner_size().map_err(|e| e.to_string())?;
        let rect = geometry::screen_rect([x, y, w, h], [viewport_width, viewport_height],
            [origin.x, origin.y], [size.width, size.height])?;
        // Do not capture if hiding failed: the overlay would cover the target.
        overlay.hide().map_err(|e| e.to_string())?;
        Ok::<_, String>(rect)
    };
    let rect = match prepare() {
        Ok(rect) => rect,
        Err(e) => {
            close_overlay(&app);
            let _ = app.emit("ocr-error", OcrError { message: e.clone(), debug_crop: None });
            return Err(e);
        }
    };
    if rect.w < 4 || rect.h < 4 {
        close_overlay(&app);
        // A stray click, not a cancel: `ocr-cancel` ends the tool (marquee.ts), this does not.
        let _ = app.emit("ocr-empty", ());
        return Ok(());
    }
    thread::spawn(move || {
        // Give the compositor time to remove the hidden overlay frame.
        thread::sleep(Duration::from_millis(120));
        let diagnostics = debug::enabled();
        let mut debug_crop = None;
        let outcome = capture::grab(&rect).and_then(|px| {
            if diagnostics {
                match debug::save(&px, rect.w, rect.h, "capture") {
                    Ok(path) => debug_crop = Some(path),
                    Err(e) => eprintln!("[ocr] failed to save capture: {e}"),
                }
            }
            if pixels::uniform(&px) {
                return Err("The Captured Region Is a Solid Colour.".into());
            }
            recognize::recognize(&px, rect.w, rect.h, diagnostics)
        });
        close_overlay(&app);
        if let Some(m) = app.get_webview_window("main") { let _ = m.set_focus(); }
        match outcome {
            Ok(text) => {
                let _ = app.emit("ocr-result", OcrOutcome {
                    text, width: rect.w, height: rect.h, debug_crop,
                });
            }
            Err(message) => {
                let _ = app.emit("ocr-error", OcrError { message, debug_crop });
            }
        }
    });
    Ok(())
}

