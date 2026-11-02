//! Small helpers the host shares across modules.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch; 0 if the clock reads before it.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// Drops a leading UTF-8 byte-order mark, which Windows editors prepend to JSON.
pub fn strip_bom(text: &str) -> &str {
    text.trim_start_matches('\u{feff}')
}
