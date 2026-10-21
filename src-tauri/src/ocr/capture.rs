// Desktop DC capture. Read the bitmap only after restoring the DC's old object.
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
    GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    CAPTUREBLT, DIB_RGB_COLORS, ROP_CODE, SRCCOPY,
};
use super::geometry::Rect;

pub(super) fn grab(r: &Rect) -> Result<Vec<u8>, String> {
    // Bound the raw allocation; resizing later cannot protect this buffer.
    let bytes = (r.w as usize).checked_mul(r.h as usize).and_then(|n| n.checked_mul(4))
        .filter(|n| *n <= 256 * 1024 * 1024).ok_or("Capture Region Too Large")?;
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() { return Err("Screen Capture GetDC Failed".into()); }
        let mem = CreateCompatibleDC(Some(screen));
        if mem.is_invalid() {
            ReleaseDC(None, screen);
            return Err("Screen Capture DC Creation Failed".into());
        }
        let bmp = CreateCompatibleBitmap(screen, r.w, r.h);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return Err("Screen Capture Bitmap Creation Failed".into());
        }
        let old = SelectObject(mem, bmp.into());
        if old.is_invalid() {
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return Err("Screen Capture Bitmap Selection Failed".into());
        }
        let blitted = BitBlt(mem, 0, 0, r.w, r.h, Some(screen), r.x, r.y,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0)).is_ok();
        // GetDIBits requires the bitmap to be deselected from every DC.
        let restored = !SelectObject(mem, old).is_invalid();
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: r.w, biHeight: -r.h, biPlanes: 1, biBitCount: 32,
            biCompression: BI_RGB.0, ..Default::default()
        };
        let mut px = vec![0u8; bytes];
        let lines = if restored {
            GetDIBits(mem, bmp, 0, r.h as u32, Some(px.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS)
        } else { 0 };
        // DC first: if the restore failed the bitmap is still selected into `mem`, and
        // DeleteObject refuses a selected bitmap (it would leak).
        let _ = DeleteDC(mem);
        let _ = DeleteObject(bmp.into());
        ReleaseDC(None, screen);
        if !blitted || lines != r.h { return Err("Screen Capture Failed or Was Incomplete".into()); }
        // BI_RGB does not populate alpha; WinRT OCR receives opaque BGRA.
        for p in px.chunks_exact_mut(4) { p[3] = 255; }
        Ok(px)
    }
}
