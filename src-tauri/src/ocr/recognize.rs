// WinRT OCR on a worker thread, after resizing to the engine's runtime cap.
use std::borrow::Cow;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use super::{debug, pixels};

pub(super) fn recognize(px: &[u8], w: i32, h: i32, diagnostics: bool) -> Result<String, String> {
    let s = |e: windows::core::Error| e.to_string();
    // Balance initialization even when recognition or bitmap preparation fails.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED).map_err(s)?; }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) { unsafe { RoUninitialize(); } }
    }
    let _apartment = Apartment;
    let max = OcrEngine::MaxImageDimension().map_err(s)?;
    if max == 0 || max > i32::MAX as u32 { return Err("Invalid OCR Image Dimension Limit".into()); }
    let (cw, ch) = pixels::ocr_size(w, h, max as i32);
    let prepared = if (cw, ch) == (w, h) { Cow::Borrowed(px) }
        else { Cow::Owned(pixels::resize(px, w, h, cw, ch)) };
    if diagnostics {
        if let Err(e) = debug::save(&prepared, cw, ch, "ocr-input") {
            eprintln!("[ocr] failed to save OCR input: {e}");
        }
    }
    let writer = DataWriter::new().map_err(s)?;
    writer.WriteBytes(&prepared).map_err(s)?;
    let buf = writer.DetachBuffer().map_err(s)?;
    let bmp = SoftwareBitmap::CreateCopyFromBuffer(&buf, BitmapPixelFormat::Bgra8, cw, ch).map_err(s)?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "No OCR Language Pack Installed for Your Windows Display Language".to_string())?;
    let result = engine.RecognizeAsync(&bmp).map_err(s)?.get().map_err(s)?;
    let lines = result.Lines().map_err(s)?;
    let n = lines.Size().map_err(s)?;
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        out.push(lines.GetAt(i).map_err(s)?.Text().map_err(s)?.to_string());
    }
    Ok(out.join("\n"))
}
