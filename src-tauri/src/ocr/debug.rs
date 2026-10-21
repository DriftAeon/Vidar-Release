// Opt-in diagnostic crops, stored only in the OS temp directory.
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) fn enabled() -> bool {
    std::env::var_os("VIDAR_OCR_DEBUG").is_some_and(|v| v == "1")
}

pub(super) fn save(px: &[u8], w: i32, h: i32, label: &str) -> Result<String, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let path = std::env::temp_dir().join(format!("vidar-ocr-{}-{time}-{}-{label}.bmp",
        std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let mut header = Vec::with_capacity(54);
    header.extend_from_slice(b"BM");
    header.extend_from_slice(&(54 + px.len() as u32).to_le_bytes());
    header.extend_from_slice(&[0; 4]);
    header.extend_from_slice(&54_u32.to_le_bytes());
    header.extend_from_slice(&40_u32.to_le_bytes());
    header.extend_from_slice(&w.to_le_bytes());
    header.extend_from_slice(&(-h).to_le_bytes()); // top-down BGRA rows
    header.extend_from_slice(&1_u16.to_le_bytes());
    header.extend_from_slice(&32_u16.to_le_bytes());
    header.extend_from_slice(&[0; 24]);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
    file.write_all(&header).and_then(|_| file.write_all(px)).map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().into_owned();
    eprintln!("[ocr] {label} {w}x{h}: {path}");
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_debug_bmp_preserves_top_down_bgra_rows() {
        let pixels = [20, 40, 60, 255, 80, 100, 120, 255];
        let path = save(&pixels, 1, 2, "test").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(&bytes[..2], b"BM");
        assert_eq!(u32::from_le_bytes(bytes[2..6].try_into().unwrap()) as usize, bytes.len());
        assert_eq!(u32::from_le_bytes(bytes[10..14].try_into().unwrap()), 54);
        assert_eq!(i32::from_le_bytes(bytes[18..22].try_into().unwrap()), 1);
        assert_eq!(i32::from_le_bytes(bytes[22..26].try_into().unwrap()), -2);
        assert_eq!(u16::from_le_bytes(bytes[28..30].try_into().unwrap()), 32);
        assert_eq!(&bytes[54..], &pixels);
    }
}
