// Colour inspector: one visible desktop pixel, bounded to the calling window.
// CSS coordinates are scaled against the physical client rect, including WebView zoom.
use serde::Serialize;
use windows::Win32::Foundation::{POINT, RECT};
use windows::Win32::Graphics::Gdi::{ClientToScreen, GetDC, GetPixel, ReleaseDC, HDC};
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClientRect, GetPhysicalCursorPos, IsIconic, IsWindowVisible,
    WindowFromPoint, GA_ROOT,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColourSample {
    rgb: [u8; 3],
    client_x: f64,
    client_y: f64,
}

struct DpiContext(DPI_AWARENESS_CONTEXT);
impl Drop for DpiContext {
    fn drop(&mut self) {
        unsafe { SetThreadDpiAwarenessContext(self.0); }
    }
}

struct ScreenDc(HDC);
impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe { ReleaseDC(None, self.0); }
    }
}

fn valid_extent(physical: i32, css: f64) -> bool {
    physical > 0 && css.is_finite() && css > 0.0
}

fn physical_to_css(point: i32, physical: i32, css: f64) -> Option<f64> {
    if !valid_extent(physical, css) || point < 0 || point >= physical { return None; }
    Some(f64::from(point) * css / f64::from(physical))
}

fn css_to_physical(point: f64, physical: i32, css: f64) -> Option<i32> {
    if !valid_extent(physical, css) || !point.is_finite() || point < 0.0 || point >= css {
        return None;
    }
    Some((point * f64::from(physical) / css).floor() as i32)
}

// `async`: Tauri runs it on a worker thread, so GetPixel never blocks the main (UI) thread.
#[tauri::command(async)]
pub fn colour_sample(
    window: tauri::WebviewWindow,
    viewport_width: f64,
    viewport_height: f64,
    client_x: Option<f64>,
    client_y: Option<f64>,
) -> Result<Option<ColourSample>, String> {
    let hwnd = window.hwnd().map(|h| windows::Win32::Foundation::HWND(h.0)).map_err(|e| e.to_string())?;
    unsafe {
        // The DPI context is per thread and restored in Drop, even on errors: the body has no
        // await, so the override never leaks to other work on this worker or to the process.
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if previous.0.is_null() { return Err("Cannot set pixel sampling DPI context".into()); }
        let _dpi = DpiContext(previous);
        if IsIconic(hwnd).as_bool() || !IsWindowVisible(hwnd).as_bool() { return Ok(None); }
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        let mut origin = POINT::default();
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return Err("Cannot locate the sampling window".into());
        }
        let mut cursor = POINT::default();
        match (client_x, client_y) {
            (Some(x), Some(y)) => {
                let Some(x) = css_to_physical(x, width, viewport_width) else { return Ok(None); };
                let Some(y) = css_to_physical(y, height, viewport_height) else { return Ok(None); };
                cursor = POINT { x: origin.x + x, y: origin.y + y };
            }
            (None, None) => GetPhysicalCursorPos(&mut cursor).map_err(|e| e.to_string())?,
            _ => return Err("Pixel sampling needs both coordinates".into()),
        }
        let Some(x) = physical_to_css(cursor.x - origin.x, width, viewport_width) else { return Ok(None); };
        let Some(y) = physical_to_css(cursor.y - origin.y, height, viewport_height) else { return Ok(None); };
        // Avoid picking another window that happens to cover Vidar's client rectangle.
        if GetAncestor(WindowFromPoint(cursor), GA_ROOT) != hwnd { return Ok(None); }
        let dc = ScreenDc(GetDC(None));
        if dc.0.0.is_null() { return Err("Cannot read screen pixels".into()); }
        let colour = GetPixel(dc.0, cursor.x, cursor.y).0;
        if colour == u32::MAX { return Err("Screen pixel is unavailable".into()); }
        Ok(Some(ColourSample {
            rgb: [colour as u8, (colour >> 8) as u8, (colour >> 16) as u8],
            client_x: x,
            client_y: y,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_sample_coordinates_cover_dpi_zoom_and_negative_monitor_origin() {
        // The origin is subtracted before scaling, even on a monitor left of primary.
        let screen_x = -1620;
        let origin_x = -1920;
        assert_eq!(physical_to_css(screen_x - origin_x, 1500, 1000.0), Some(200.0));
        assert_eq!(css_to_physical(200.0, 1500, 1000.0), Some(300)); // 150%
        assert_eq!(css_to_physical(200.0, 2000, 1000.0), Some(400)); // 200%
        assert_eq!(css_to_physical(200.0, 1500, 800.0), Some(375)); // zoom
        assert_eq!(physical_to_css(375, 1500, 800.0), Some(200.0));
        assert_eq!(css_to_physical(0.25, 1500, 1000.0), Some(0));
    }

    #[test]
    fn colour_sample_coordinates_reject_edges_and_invalid_viewports() {
        for point in [-1, 1000] {
            assert_eq!(physical_to_css(point, 1000, 500.0), None);
        }
        for point in [-0.1, 500.0, f64::NAN, f64::INFINITY] {
            assert_eq!(css_to_physical(point, 1000, 500.0), None);
        }
        for css in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(physical_to_css(0, 1000, css), None);
            assert_eq!(css_to_physical(0.0, 1000, css), None);
        }
        assert_eq!(physical_to_css(999, 1000, 500.0), Some(499.5));
        assert_eq!(css_to_physical(499.99, 1000, 500.0), Some(999));
        assert_eq!(physical_to_css(0, 0, 500.0), None);
    }
}
