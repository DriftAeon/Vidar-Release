//! Vidar-drawn caption row over a decorated window; DWM keeps painting min/max/close.
//! WM_NCCALCSIZE drops only the caption (maximized: the off-screen frame inset stays client), the
//! frame is extended down over the row so DWM still draws its buttons, and the WRY_WEBVIEW child
//! gets a window region with the button rect and the top resize band cut out: the parent window
//! receives the hit tests there, DWM answers the buttons (HTMAXBUTTON gives Snap Layouts), this
//! file answers the band. Everything else in the row is the page's `app-region: drag`.
//! Our subclass is installed after tao's, so Windows calls it first.
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use windows::core::w;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{
        ClientToScreen, CombineRgn, CreateRectRgn, DeleteObject, FillRect, GetStockObject, ScreenToClient, SetWindowRgn,
        BLACK_BRUSH, HBRUSH, HDC, RGN_DIFF,
    },
    UI::{
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        Shell::{
            DefSubclassProc, RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT,
            ABE_TOP, ABM_GETAUTOHIDEBAR, APPBARDATA,
        },
        WindowsAndMessaging::{
            FindWindowExW, GetClientRect, GetWindowLongW, GetWindowRect, IsZoomed, KillTimer, PostMessageW, SetTimer,
            SetWindowPos, GWL_STYLE, NCCALCSIZE_PARAMS, SM_CXPADDEDBORDER, SM_CXSIZE, SM_CYCAPTION, SM_CYFRAME,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_ACTIVATE, WM_DPICHANGED,
            WM_ERASEBKGND, WM_NCCALCSIZE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN,
            WM_NCLBUTTONUP, WM_SIZE, WM_SYSCOMMAND, WM_TIMER, WS_CAPTION,
        },
    },
};

// DWM FFI hand-rolled, as chrome.rs does: three functions, no Cargo feature.
#[repr(C)]
struct Margins {
    left: i32,
    right: i32,
    top: i32,
    bottom: i32,
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmExtendFrameIntoClientArea(hwnd: isize, margins: *const Margins) -> i32;
    fn DwmDefWindowProc(hwnd: isize, msg: u32, wparam: usize, lparam: isize, result: *mut isize) -> i32;
    fn DwmGetWindowAttribute(hwnd: isize, attr: u32, pv: *mut c_void, cb: u32) -> i32;
}

const DWMWA_CAPTION_BUTTON_BOUNDS: u32 = 5;
const SUBCLASS_ID: usize = 0x56434150; // "VCAP"
/// One-shot timer id for the deferred refresh, and its delay: DWM and tauri settle after a
/// WM_SIZE, so the first refresh can read stale button bounds.
const REFRESH_TIMER: usize = 0x56434152; // "VCAR"
const REFRESH_DELAY_MS: u32 = 100;

/// Set once the subclass is in; `caption_metrics` errors until then so the page draws no row.
static INSTALLED: AtomicBool = AtomicBool::new(false);
/// Last region applied: (webview HWND, origin x, origin y, carve rects). Equal → skip SetWindowRgn.
static LAST_REGION: Mutex<Option<(isize, i32, i32, Vec<Rect>)>> = Mutex::new(None);
/// Button code (HTMINBUTTON/HTMAXBUTTON/HTCLOSE) of the last left-button press, 0 when none.
static PRESSED: AtomicU32 = AtomicU32::new(0);

pub(crate) const HTCLIENT: u32 = 1;
pub(crate) const HTCAPTION: u32 = 2;
pub(crate) const HTMINBUTTON: u32 = 8;
pub(crate) const HTMAXBUTTON: u32 = 9;
pub(crate) const HTCLOSE: u32 = 20;
pub(crate) const HTTOP: u32 = 12;
pub(crate) const HTTOPLEFT: u32 = 13;
pub(crate) const HTTOPRIGHT: u32 = 14;

/// Client-coordinate rectangle, right/bottom exclusive (Win32 RECT semantics).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
    fn is_empty(&self) -> bool {
        self.right <= self.left || self.bottom <= self.top
    }
}

/// The caption geometry in client pixels: row height, top resize band, DWM button rect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Layout {
    pub width: i32,
    pub caption: i32,
    pub band: i32,
    pub buttons: Rect,
}

/// Frame metrics for one DPI, as GetSystemMetricsForDpi reports them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Metrics {
    pub cy_caption: i32,
    pub cy_frame: i32,
    pub padded: i32,
}

impl Metrics {
    /// The sizing frame plus padded border: the band a decorated window resizes from, and the
    /// amount a maximized window hangs past the monitor edge.
    fn inset(&self) -> i32 {
        self.cy_frame + self.padded
    }
}

/// Client top after WM_NCCALCSIZE: the window top (caption and top frame gone), maximized too, so
/// the frame inset hanging off-screen above the monitor stays client. DwmDefWindowProc hit-tests
/// its buttons only when the client starts at the window top: with any top non-client strip (1 px
/// to the full inset) it declines every point, so DWM never tracks hover (probed 2026-10-24). A
/// top auto-hide appbar is the exception: its reveal strip needs the client 1 px below the monitor.
pub(crate) fn client_top(window_top: i32, m: Metrics, maximized: bool, autohide_top: bool) -> i32 {
    if maximized && autohide_top {
        window_top + m.inset() + 1
    } else {
        window_top
    }
}

/// Height of the drawn row: today's native caption, frame inset plus caption, less `offset`, the
/// client top's distance below the window top (0 except under a top auto-hide appbar).
pub(crate) fn caption_height(m: Metrics, offset: i32) -> i32 {
    (m.cy_caption + m.inset() - offset).max(0)
}

/// The row's top strip above the caption: the resize band restored, the off-screen inset maximized.
pub(crate) fn band_height(m: Metrics, offset: i32) -> i32 {
    (m.inset() - offset).max(0)
}

/// Button rect when DWM reports none: min/max/close are three SM_CXSIZE-wide buttons, right-aligned
/// and as tall as the row.
pub(crate) fn fallback_buttons(width: i32, caption: i32, cx_size: i32) -> Rect {
    let w = (cx_size * 3).min(width).max(0);
    Rect { left: width - w, top: 0, right: width, bottom: caption }
}

/// Which screen edges carry an auto-hide appbar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AutoHide {
    pub left: bool,
    pub top: bool,
    pub right: bool,
    pub bottom: bool,
}

/// A maximized client that covers the whole monitor hides the auto-hide taskbar's reveal strip:
/// leave 1 px on each edge that has one.
pub(crate) fn leave_autohide_edges(r: Rect, a: AutoHide) -> Rect {
    Rect {
        left: r.left + a.left as i32,
        top: r.top + a.top as i32,
        right: r.right - a.right as i32,
        bottom: r.bottom - a.bottom as i32,
    }
}

fn autohide_edges() -> AutoHide {
    let has = |edge: u32| unsafe {
        let mut data = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, uEdge: edge, ..Default::default() };
        SHAppBarMessage(ABM_GETAUTOHIDEBAR, &mut data) != 0
    };
    AutoHide { left: has(ABE_LEFT), top: has(ABE_TOP), right: has(ABE_RIGHT), bottom: has(ABE_BOTTOM) }
}

/// Hit test for a point the parent receives (the carved areas), after DwmDefWindowProc declined it.
pub(crate) fn hit_test(x: i32, y: i32, l: &Layout, maximized: bool) -> u32 {
    if !maximized && y >= 0 && y < l.band {
        return if x < l.band {
            HTTOPLEFT
        } else if x >= l.width - l.band {
            HTTOPRIGHT
        } else {
            HTTOP
        };
    }
    if l.buttons.contains(x, y) {
        // Points DWM declined (under a top auto-hide appbar it declines them all): answer
        // min/max/close by thirds ourselves.
        let third = ((x - l.buttons.left) * 3 / (l.buttons.right - l.buttons.left)).clamp(0, 2);
        return [HTMINBUTTON, HTMAXBUTTON, HTCLOSE][third as usize];
    }
    if y >= 0 && y < l.caption {
        return HTCAPTION;
    }
    HTCLIENT
}

/// The WM_SYSCOMMAND an HTMIN/MAX/CLOSE click maps to; None for any other hit code.
pub(crate) fn button_command(code: u32, maximized: bool) -> Option<u32> {
    match code {
        HTMINBUTTON => Some(0xF020), // SC_MINIMIZE
        HTMAXBUTTON => Some(if maximized { 0xF120 } else { 0xF030 }), // SC_RESTORE / SC_MAXIMIZE
        HTCLOSE => Some(0xF060),     // SC_CLOSE
        _ => None,
    }
}

/// Rects cut out of the webview's region: the button rect and the top band (maximized, the
/// off-screen inset, so the page never paints past the monitor edge).
pub(crate) fn carve(l: &Layout) -> Vec<Rect> {
    let mut out = Vec::new();
    if !l.buttons.is_empty() {
        out.push(l.buttons);
    }
    if l.band > 0 {
        out.push(Rect { left: 0, top: 0, right: l.width, bottom: l.band });
    }
    out
}

fn has_caption(hwnd: HWND) -> bool {
    unsafe { (GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0) == WS_CAPTION.0 }
}

fn maximized(hwnd: HWND) -> bool {
    unsafe { IsZoomed(hwnd).as_bool() }
}

fn metrics(hwnd: HWND) -> (Metrics, u32) {
    unsafe {
        let dpi = GetDpiForWindow(hwnd).max(96);
        let m = Metrics {
            cy_caption: GetSystemMetricsForDpi(SM_CYCAPTION, dpi),
            cy_frame: GetSystemMetricsForDpi(SM_CYFRAME, dpi),
            padded: GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi),
        };
        (m, dpi)
    }
}

/// The client top's distance below the window top (measured, not assumed); 0 on failure.
fn top_offset(hwnd: HWND) -> i32 {
    unsafe {
        let mut win = RECT::default();
        let mut origin = POINT::default();
        if GetWindowRect(hwnd, &mut win).is_err() || !ClientToScreen(hwnd, &mut origin).as_bool() {
            return 0;
        }
        origin.y - win.top
    }
}

/// DWM's caption button bounds are window-relative; shift them into client coordinates.
/// None when DWM fails or reports an empty rect.
fn button_rect(hwnd: HWND) -> Option<Rect> {
    unsafe {
        let mut b = RECT::default();
        let hr = DwmGetWindowAttribute(
            hwnd.0 as isize,
            DWMWA_CAPTION_BUTTON_BOUNDS,
            &mut b as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        );
        let mut win = RECT::default();
        let mut origin = POINT::default();
        if hr < 0 || GetWindowRect(hwnd, &mut win).is_err() || !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
        let (dx, dy) = (origin.x - win.left, origin.y - win.top);
        let r = Rect { left: b.left - dx, top: b.top - dy, right: b.right - dx, bottom: b.bottom - dy };
        if r.is_empty() { None } else { Some(r) }
    }
}

fn layout(hwnd: HWND) -> (Layout, bool, u32) {
    let (m, dpi) = metrics(hwnd);
    let max = maximized(hwnd);
    let mut rc = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut rc);
    }
    let width = rc.right - rc.left;
    let offset = top_offset(hwnd);
    let caption = caption_height(m, offset);
    let buttons = button_rect(hwnd)
        .unwrap_or_else(|| fallback_buttons(width, caption, unsafe { GetSystemMetricsForDpi(SM_CXSIZE, dpi) }));
    let l = Layout { width, caption, band: band_height(m, offset), buttons };
    (l, max, dpi)
}

fn extend_frame(hwnd: HWND, l: &Layout) {
    let margins = Margins { left: 0, right: 0, top: l.caption, bottom: 0 };
    unsafe {
        DwmExtendFrameIntoClientArea(hwnd.0 as isize, &margins);
    }
}

/// Region on WRY_WEBVIEW: everything minus the carve, in the webview's own coordinates.
fn apply_region(hwnd: HWND, l: &Layout) {
    unsafe {
        let Ok(webview) = FindWindowExW(Some(hwnd), None, w!("WRY_WEBVIEW"), None) else {
            return;
        };
        // Webview origin in parent client coords (tauri places it at 0,0; measured, not assumed).
        let mut wr = RECT::default();
        if GetWindowRect(webview, &mut wr).is_err() {
            return;
        }
        let mut at = POINT { x: wr.left, y: wr.top };
        let _ = ScreenToClient(hwnd, &mut at);
        // Unbounded right/bottom: tauri may resize the webview after this WM_SIZE.
        let rects = carve(l);
        let key = (webview.0 as isize, at.x, at.y, rects.clone());
        if let Ok(mut last) = LAST_REGION.lock() {
            if last.as_ref() == Some(&key) {
                return; // unchanged: no reset, no redraw
            }
            *last = Some(key);
        }
        let region = CreateRectRgn(-at.x, -at.y, 32767, 32767);
        for r in rects {
            let cut = CreateRectRgn(r.left - at.x, r.top - at.y, r.right - at.x, r.bottom - at.y);
            CombineRgn(Some(region), Some(region), Some(cut), RGN_DIFF);
            let _ = DeleteObject(cut.into());
        }
        // The system owns the region after this call.
        if SetWindowRgn(webview, Some(region), true) == 0 {
            let _ = DeleteObject(region.into());
            if let Ok(mut last) = LAST_REGION.lock() {
                *last = None; // not applied: try again next time
            }
        }
    }
}

fn refresh(hwnd: HWND) {
    if !has_caption(hwnd) {
        return;
    }
    let (l, _, _) = layout(hwnd);
    extend_frame(hwnd, &l);
    apply_region(hwnd, &l);
}

pub fn install(window: &tauri::WebviewWindow) {
    let hwnd = match window.hwnd() {
        Ok(h) => HWND(h.0),
        Err(e) => {
            eprintln!("caption: {e}");
            return;
        }
    };
    unsafe {
        if !SetWindowSubclass(hwnd, Some(callback), SUBCLASS_ID, 0).as_bool() {
            eprintln!("caption: cannot install subclass");
            return;
        }
        // Recompute the frame now so WM_NCCALCSIZE runs through the subclass.
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    INSTALLED.store(true, Ordering::SeqCst);
    refresh(hwnd);
    schedule_refresh(hwnd);
}

/// One-shot ~100 ms timer on the top-level window (SetTimer with the same id restarts it, so a
/// drag-resize coalesces to one refresh after the last WM_SIZE).
fn schedule_refresh(hwnd: HWND) {
    unsafe {
        SetTimer(Some(hwnd), REFRESH_TIMER, REFRESH_DELAY_MS, None);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionMetrics {
    /// Row height in physical pixels.
    height: i32,
    /// Top strip inside the row in physical pixels, the band icon and title centre below: DWM's
    /// resize band restored, the frame inset hanging off-screen maximized.
    band: i32,
    /// Width of the DWM button rect in physical pixels (0 when DWM reports none).
    buttons_width: i32,
    maximized: bool,
    dpi: u32,
}

#[tauri::command]
pub fn caption_metrics(window: tauri::WebviewWindow) -> Result<CaptionMetrics, String> {
    if !INSTALLED.load(Ordering::SeqCst) {
        return Err("caption subclass not installed".into());
    }
    let hwnd = window.hwnd().map(|h| HWND(h.0)).map_err(|e| e.to_string())?;
    let (l, max, dpi) = layout(hwnd);
    Ok(CaptionMetrics {
        height: l.caption,
        band: l.band,
        buttons_width: l.buttons.right - l.buttons.left,
        maximized: max,
        dpi,
    })
}

unsafe extern "system" fn callback(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _data: usize) -> LRESULT {
    if msg == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(callback), id);
        let _ = KillTimer(Some(hwnd), REFRESH_TIMER);
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    }
    if msg == WM_TIMER && wparam.0 == REFRESH_TIMER {
        let _ = KillTimer(Some(hwnd), REFRESH_TIMER);
        refresh(hwnd);
        return LRESULT(0);
    }
    if !has_caption(hwnd) {
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    }
    // DWM first: caption button hover, press and HTMIN/MAX/CLOSE hit tests (HTMAXBUTTON → Snap Layouts).
    let mut dwm: isize = 0;
    if DwmDefWindowProc(hwnd.0 as isize, msg, wparam.0, lparam.0, &mut dwm) != 0 {
        return LRESULT(dwm);
    }
    match msg {
        WM_NCCALCSIZE if wparam.0 != 0 => {
            let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
            let window_top = params.rgrc[0].top;
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            let (m, _) = metrics(hwnd);
            let max = maximized(hwnd);
            let edges = if max { autohide_edges() } else { AutoHide::default() };
            params.rgrc[0].top = client_top(window_top, m, max, edges.top);
            if max {
                let r = params.rgrc[0];
                // client_top already left the top reveal strip.
                let r = leave_autohide_edges(
                    Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                    AutoHide { top: false, ..edges },
                );
                params.rgrc[0] = RECT { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            }
            result
        }
        WM_NCHITTEST => {
            // Native sides and bottom first; only a client answer is ours to refine.
            let native = DefSubclassProc(hwnd, msg, wparam, lparam);
            if native.0 as u32 != HTCLIENT {
                return native;
            }
            let mut pt = POINT { x: (lparam.0 & 0xffff) as i16 as i32, y: ((lparam.0 >> 16) & 0xffff) as i16 as i32 };
            if !ScreenToClient(hwnd, &mut pt).as_bool() {
                return native;
            }
            let (l, max, _) = layout(hwnd);
            LRESULT(hit_test(pt.x, pt.y, &l, max) as isize)
        }
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if button_command(wparam.0 as u32, false).is_some() => {
            // Remember the pressed button; skip DefSubclassProc, its tracking loop paints classic buttons.
            PRESSED.store(wparam.0 as u32, Ordering::SeqCst);
            LRESULT(0)
        }
        WM_NCLBUTTONUP => {
            // Release over the button that took the press runs its system command.
            let pressed = PRESSED.swap(0, Ordering::SeqCst);
            match button_command(wparam.0 as u32, maximized(hwnd)) {
                Some(sc) if pressed != 0 && pressed == wparam.0 as u32 => {
                    let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(sc as usize), LPARAM(0));
                    LRESULT(0)
                }
                _ => DefSubclassProc(hwnd, msg, wparam, lparam),
            }
        }
        WM_ERASEBKGND => {
            // tao fills the client with its background; the extended band must be alpha 0
            // (BLACK_BRUSH) or it covers DWM's buttons.
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            let (l, _, _) = layout(hwnd);
            let band = RECT { left: 0, top: 0, right: l.width, bottom: l.caption };
            FillRect(HDC(wparam.0 as *mut c_void), &band, HBRUSH(GetStockObject(BLACK_BRUSH).0));
            if result.0 == 0 { LRESULT(1) } else { result }
        }
        WM_SIZE | WM_DPICHANGED | WM_ACTIVATE => {
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            refresh(hwnd);
            if msg == WM_SIZE {
                schedule_refresh(hwnd);
            }
            result
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // GetSystemMetricsForDpi values for 100%, 125%, 150% (caption, frame, padded border).
    const M96: Metrics = Metrics { cy_caption: 23, cy_frame: 4, padded: 4 };
    const M120: Metrics = Metrics { cy_caption: 27, cy_frame: 5, padded: 5 };
    const M144: Metrics = Metrics { cy_caption: 34, cy_frame: 6, padded: 6 };

    /// Restored and maximized share one geometry: the client starts at the window top in both.
    fn layout96() -> Layout {
        Layout {
            width: 1000,
            caption: caption_height(M96, 0),
            band: band_height(M96, 0),
            buttons: Rect { left: 862, top: 0, right: 1000, bottom: 30 },
        }
    }

    #[test]
    fn client_top_stays_at_the_window_top_even_maximized() {
        assert_eq!(client_top(100, M96, false, false), 100);
        // Maximized: the off-screen inset stays client, or DWM declines its button hit tests.
        assert_eq!(client_top(-8, M96, true, false), -8);
        assert_eq!(client_top(-12, M144, true, false), -12);
        // A top auto-hide appbar keeps its 1 px reveal strip below the monitor top.
        assert_eq!(client_top(-8, M96, true, true), 1);
        assert_eq!(client_top(-10, M120, true, true), 1);
        // Restored ignores the appbar.
        assert_eq!(client_top(100, M96, false, true), 100);
    }

    #[test]
    fn caption_height_matches_the_native_caption_per_dpi() {
        assert_eq!(caption_height(M96, 0), 31);
        assert_eq!(caption_height(M120, 0), 37);
        assert_eq!(caption_height(M144, 0), 46);
        // Under a top auto-hide appbar the client starts inset + 1 below the window top.
        assert_eq!(caption_height(M96, 9), 22);
        assert_eq!(caption_height(M96, 100), 0);
    }

    #[test]
    fn band_is_the_frame_inset_less_the_client_offset() {
        assert_eq!(band_height(M96, 0), 8);
        assert_eq!(band_height(M144, 0), 12);
        assert_eq!(band_height(M96, 9), 0);
    }

    #[test]
    fn hit_test_top_band_resizes_with_corners() {
        let l = layout96();
        assert_eq!(hit_test(500, 0, &l, false), HTTOP);
        assert_eq!(hit_test(500, 7, &l, false), HTTOP);
        assert_eq!(hit_test(3, 2, &l, false), HTTOPLEFT);
        assert_eq!(hit_test(995, 2, &l, false), HTTOPRIGHT);
    }

    #[test]
    fn hit_test_band_wins_over_the_button_rect() {
        let l = layout96();
        assert_eq!(hit_test(900, 4, &l, false), HTTOP);
    }

    #[test]
    fn hit_test_button_rect_left_by_dwm_splits_into_thirds() {
        let l = layout96();
        assert_eq!(hit_test(870, 10, &l, true), HTMINBUTTON);
        assert_eq!(hit_test(930, 10, &l, true), HTMAXBUTTON);
        assert_eq!(hit_test(990, 10, &l, true), HTCLOSE);
        assert_eq!(hit_test(999, 22, &l, true), HTCLOSE);
        // The row left of the buttons stays draggable.
        assert_eq!(hit_test(861, 10, &l, true), HTCAPTION);
        // Restored: the top band still wins over the button rect.
        assert_eq!(hit_test(900, 4, &layout96(), false), HTTOP);
    }

    #[test]
    fn button_command_maps_codes_to_system_commands() {
        assert_eq!(button_command(HTMINBUTTON, false), Some(0xF020));
        assert_eq!(button_command(HTMAXBUTTON, false), Some(0xF030));
        assert_eq!(button_command(HTMAXBUTTON, true), Some(0xF120));
        assert_eq!(button_command(HTCLOSE, true), Some(0xF060));
        assert_eq!(button_command(HTCAPTION, false), None);
    }

    #[test]
    fn hit_test_caption_row_drags_below_the_band() {
        let l = layout96();
        assert_eq!(hit_test(300, 8, &l, false), HTCAPTION);
        assert_eq!(hit_test(300, 30, &l, false), HTCAPTION);
        assert_eq!(hit_test(300, 31, &l, false), HTCLIENT);
    }

    #[test]
    fn hit_test_maximized_has_no_band() {
        let l = layout96();
        assert_eq!(hit_test(500, 0, &l, true), HTCAPTION);
        assert_eq!(hit_test(2, 0, &l, true), HTCAPTION);
        // The off-screen strip over the buttons is the button, not a resize band.
        assert_eq!(hit_test(930, 4, &l, true), HTMAXBUTTON);
        assert_eq!(hit_test(500, 30, &l, true), HTCAPTION);
        assert_eq!(hit_test(500, 31, &l, true), HTCLIENT);
    }

    #[test]
    fn fallback_buttons_are_three_buttons_right_aligned_by_row_height() {
        // SM_CXSIZE is 36 at 96 dpi, 45 at 120, 54 at 144.
        assert_eq!(fallback_buttons(1000, 31, 36), Rect { left: 892, top: 0, right: 1000, bottom: 31 });
        assert_eq!(fallback_buttons(1920, 46, 54), Rect { left: 1758, top: 0, right: 1920, bottom: 46 });
        assert_eq!(fallback_buttons(60, 31, 36), Rect { left: 0, top: 0, right: 60, bottom: 31 });
    }

    #[test]
    fn autohide_leaves_one_pixel_only_on_flagged_edges() {
        let r = Rect { left: 0, top: 0, right: 1920, bottom: 1080 };
        assert_eq!(leave_autohide_edges(r, AutoHide::default()), r);
        let bottom = AutoHide { bottom: true, ..AutoHide::default() };
        assert_eq!(leave_autohide_edges(r, bottom), Rect { bottom: 1079, ..r });
        let all = AutoHide { left: true, top: true, right: true, bottom: true };
        assert_eq!(leave_autohide_edges(r, all), Rect { left: 1, top: 1, right: 1919, bottom: 1079 });
    }

    #[test]
    fn carve_cuts_buttons_and_the_top_band() {
        // Restored the band is the resize band; maximized it is the off-screen inset.
        let l = layout96();
        assert_eq!(carve(&l), vec![l.buttons, Rect { left: 0, top: 0, right: 1000, bottom: 8 }]);
        let no_band = Layout { band: 0, ..l };
        assert_eq!(carve(&no_band), vec![l.buttons]);
        let none = Layout { buttons: Rect::default(), ..no_band };
        assert!(carve(&none).is_empty());
    }
}
