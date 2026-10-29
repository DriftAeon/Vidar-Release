//! src-tauri\src\bare\vault\store_header.rs — the header lists a placed runeset copy keeps beside its slot lines
//! (`recall-off`, `slot-off`): read and rewrite helpers split out of store.rs (module-size cap). Only a vault's
//! `sets/` copy carries these keys; resolve never loads from them.

use super::store::header_value;

/// The header key a placed runeset copy holds its switched-off `<?recall?>` members in, as bare ids (a
/// recall member is always of the copy's own library): `recall-off: [a, b]`. Only a vault's `sets/` copy
/// carries it, never a library runeset; resolve and the view skip them.
pub(crate) const RECALL_OFF: &str = "recall-off";

/// The header key a placed runeset copy holds its switched-off slot members in, as slot tokens (`id` for
/// the copy's own library, `library/id` otherwise): `slot-off: [a, stock/b]`. Taking a slot line out
/// records its token here, so the view still lists the rune off; putting it back drops the token. Only a
/// vault's `sets/` copy carries it; resolve reads slot lines only, so it never loads.
pub(crate) const SLOT_OFF: &str = "slot-off";

/// A header list key's entries; none when the key is absent.
pub(super) fn header_list(bytes: &[u8], key: &str) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes).replace('\r', "");
    let Some(v) = header_value(text.trim_start_matches('\u{FEFF}'), key) else { return Vec::new() };
    let inner = v.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(&v);
    inner.split(',').map(|s| s.trim().trim_matches('"').to_string()).filter(|s| !s.is_empty()).collect()
}

/// The recall members a copy's header switches off; none when the key is absent.
pub(crate) fn recall_off(bytes: &[u8]) -> Vec<String> {
    header_list(bytes, RECALL_OFF)
}

/// The slot members a copy's header switches off, as `(library, id)`; none when the key is absent.
pub(crate) fn slot_off(bytes: &[u8], own: &str) -> Vec<(String, String)> {
    header_list(bytes, SLOT_OFF).iter().map(|t| match t.split_once('/') {
        Some((lib, id)) => (lib.to_string(), id.to_string()),
        None => (own.to_string(), t.clone()),
    }).collect()
}

/// `bytes` with the header's `recall-off` line set to `ids` (sorted, deduped; last in the header) or
/// dropped when `ids` is empty. Refuses a copy with no closed `---` header.
pub(super) fn with_recall_off(bytes: &[u8], ids: &[String], label: &str) -> Result<Vec<u8>, String> {
    with_header_list(bytes, RECALL_OFF, ids, label)
}

/// `bytes` with the header's `key` line set to `ids` (sorted, deduped; last in the header) or dropped
/// when `ids` is empty. Refuses a copy with no closed `---` header.
pub(super) fn with_header_list(bytes: &[u8], key: &str, ids: &[String], label: &str) -> Result<Vec<u8>, String> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| format!("runeset {label} copy is not UTF-8"))?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let bare = |l: &str| l.trim_end_matches(['\n', '\r']).trim_start_matches('\u{FEFF}').to_string();
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let close = match lines.first() {
        Some(l) if bare(l) == "---" => lines.iter().skip(1).position(|l| bare(l) == "---").map(|i| i + 1),
        _ => None,
    }
    .ok_or_else(|| format!("runeset {label} copy has no header to hold its switched-off members"))?;
    let mut ids: Vec<&String> = ids.iter().collect();
    ids.sort();
    ids.dedup();
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if i > 0 && i < close && bare(l).strip_prefix(key).is_some_and(|r| r.starts_with(':')) {
            continue;
        }
        if i == close && !ids.is_empty() {
            let joined: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
            out.push_str(&format!("{key}: [{}]{eol}", joined.join(", ")));
        }
        out.push_str(l);
    }
    Ok(out.into_bytes())
}
