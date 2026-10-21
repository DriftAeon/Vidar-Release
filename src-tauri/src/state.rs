use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WindowEvent};

// The literal lives in crate::paths::window_state_path().
fn state_path() -> std::path::PathBuf {
    crate::paths::window_state_path()
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct WinState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
}

// Last known NON-maximized bounds — saving on close while maximized would
// otherwise make a later unmaximize "restore" to near-fullscreen.
#[derive(Default)]
pub struct WinTracker(pub Mutex<Option<WinState>>);

/// `--no-activate` on the command line (swap-release.ps1 -Background): show the
/// main window without activating it, so a headless swap never takes the
/// foreground from whatever the user is doing. A CLI arg, never an env var:
/// Vidar hands its environment to every tab. There is no single-instance
/// plugin, so a second launch is its own process and reads its own args.
pub fn no_activate() -> bool {
    has_no_activate(std::env::args().skip(1))
}

fn has_no_activate<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().any(|a| a == "--no-activate")
}

fn read_state() -> Option<WinState> {
    serde_json::from_str(&std::fs::read_to_string(state_path()).ok()?).ok()
}

/// `no_activate`: the window was built with `focused(false)` (main.rs), which
/// makes tao show it with SW_SHOWNOACTIVATE and skips the WebView2 MoveFocus;
/// here it also skips `set_focus` (a saved maximize still activates).
pub fn restore(window: &tauri::WebviewWindow, no_activate: bool) {
    if let Some(s) = read_state() {
        let cx = f64::from(s.x) + f64::from(s.w) / 2.0;
        let cy = f64::from(s.y) + f64::from(s.h) / 2.0;
        // monitor layout may have changed since last run — skip restore if the
        // saved center isn't on any current screen
        if let Ok(Some(mon)) = window.monitor_from_point(cx, cy) {
            // Clamp into the WORK AREA, not the monitor bounds. Saved state can
            // be larger than the screen (stale entry, a different DPI, or a
            // resolution change), and applying it verbatim put the bottom edge
            // under the taskbar. Size first, then pull the origin back inside;
            // clamping w/h first is what keeps max_* >= the work-area origin,
            // so the clamp() calls below can't invert.
            let wa = mon.work_area();

            // set_size takes the INNER (client) size, but we save the OUTER
            // rect to match outer_position. Feeding an outer size straight into
            // set_size grew the window by the title bar + borders on every
            // save/restore cycle, so it always reopened bigger than it closed.
            let chrome = window
                .outer_size()
                .ok()
                .zip(window.inner_size().ok())
                .map(|(o, i)| (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)))
                .unwrap_or((0, 0));

            // Restore verbatim when the saved rect is plausible. Windows snap
            // positions the VISIBLE edge on the work-area boundary, and the
            // invisible DWM resize border means the saved GetWindowRect legally
            // overhangs the work area by ~7px on left/right/bottom. Clamping
            // that away pulls the visible edges inward — short on the bottom
            // and right, overhanging on the left. So the work-area clamp is a
            // safety net for stale/invalid state only, not the normal path.
            let m = mon.size();
            let (ow, oh, x, y) = if s.w <= m.width && s.h <= m.height {
                (s.w, s.h, s.x, s.y)
            } else {
                let ow = s.w.min(wa.size.width);
                let oh = s.h.min(wa.size.height);
                let max_x = wa.position.x + wa.size.width as i32 - ow as i32;
                let max_y = wa.position.y + wa.size.height as i32 - oh as i32;
                (ow, oh, s.x.clamp(wa.position.x, max_x), s.y.clamp(wa.position.y, max_y))
            };

            let _ = window.set_size(PhysicalSize::new(
                ow.saturating_sub(chrome.0).max(1),
                oh.saturating_sub(chrome.1).max(1),
            ));
            let _ = window.set_position(PhysicalPosition::new(x, y));
            // SW_MAXIMIZE always activates, so a saved maximize takes the
            // foreground even under --no-activate. Deferring it to the first
            // activation left a background swap small until clicked; the user
            // chose the focus steal (2026-10-10).
            if s.maximized {
                let _ = window.maximize();
            }
        }
    }
    // window ships visible:false to avoid a default-position flash
    let _ = window.show();
    if !no_activate {
        let _ = window.set_focus();
    }
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent, tracker: &WinTracker) {
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let (Ok(false), Ok(p), Ok(s)) =
                (window.is_maximized(), window.outer_position(), window.outer_size())
            {
                // ignore the minimized state (position goes to -32000)
                if p.x > -30000 && s.width > 0 {
                    *tracker.0.lock().unwrap() = Some(WinState {
                        x: p.x,
                        y: p.y,
                        w: s.width,
                        h: s.height,
                        maximized: false,
                    });
                }
            }
        }
        WindowEvent::CloseRequested { .. } => {
            let maximized = window.is_maximized().unwrap_or(false);
            let state = tracker.0.lock().unwrap().map(|s| WinState { maximized, ..s });
            if let Some(state) = state {
                if let Ok(json) = serde_json::to_string(&state) {
                    // Atomic (crate::fsx): a plain `fs::write` could leave
                    // window-state.json truncated by a crash mid-write.
                    let _ = crate::fsx::atomic_write(&state_path(), json.as_bytes());
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::has_no_activate;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_activate_only_on_exact_flag() {
        assert!(!has_no_activate(args(&[])));
        assert!(has_no_activate(args(&["--no-activate"])));
        assert!(has_no_activate(args(&["--other", "--no-activate"])));
        assert!(!has_no_activate(args(&["--no-activate=1", "-no-activate", "--No-Activate"])));
    }
}
