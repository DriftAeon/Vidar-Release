//! A Codex Bare row's built payload on its way to Codex: the one admission rule for a client-named
//! `<home>\layer\payload-<hash12>.md`, plus the TOML basic-string encoder and the 12,000-character
//! inline limit that only the Classic library rule (`rules::codex::choose`) still applies.
//! Bare Codex has no cap: Rendered sends the text as `developerInstructions` on `thread/start`
//! and the Raw TUI line uses a `--profile` file (`bare::home::write_codex_profile`).
//! Shared by Vidar and Falcon: Falcon mounts this file by `#[path]`
//! (`src-falcon/src/main.rs`); Vidar declares it in `bare/mod.rs`, and `rules::codex` re-exports
//! the encoder and the limit, so there is one copy of each.
//! A leaf: std and sha2 only, no `crate::` paths, so it compiles unchanged in both crates.

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// The longest encoded `developer_instructions` value the Classic library rule writes into a `-c` line
/// (`rules::codex::choose`). W0 measured argv passing to 30,073; worst-case Windows quoting doubles
/// the value (about 24,400 at this limit), under the 32,767 cap. No Bare spawn applies it.
pub const INLINE_LIMIT: usize = 12_000;

/// A TOML basic string, quotes included: `\`, `"` and control characters escaped.
pub fn encode_toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// First 12 hex digits of SHA-256 (`rules::build::hash12`).
fn hash12(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

fn is_hash12(h: &str) -> bool {
    h.len() == 12 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The `<hash12>` of a `payload-<hash12>.md` file name, else None.
fn payload_hash(path: &Path) -> Option<&str> {
    path.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("payload-"))
        .and_then(|n| n.strip_suffix(".md"))
        .filter(|h| is_hash12(h))
}

/// Windows paths compare case-insensitively.
fn same_path(a: &Path, b: &Path) -> bool {
    a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
}

/// Admit a client-named payload file: no leading `-`, absolute, no `..`, name
/// `payload-<12 lowercase hex>.md` as sent and again on the canonical file, a regular file whose
/// canonical parent is `canonicalize(<home>\layer)`. The layer itself must not be redirected: its
/// canonical form must be the canonical home's own `layer` child, so a junctioned `layer\` that
/// points elsewhere is refused. Returns the canonical path (it may carry a `\\?\` prefix; callers
/// that hand it to a child strip it). Content is not checked here: see [`read_admitted`].
pub fn admit_payload_file(raw: &str, home: &Path) -> Result<PathBuf, String> {
    const OUTSIDE: &str = "payload file is outside the bare home's layer directory";
    if raw.starts_with('-') {
        return Err("payload file starts with '-'".into());
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("payload file is not an absolute path".into());
    }
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("payload file path contains '..'".into());
    }
    if payload_hash(path).is_none() {
        return Err("payload file name is not payload-<hash12>.md".into());
    }
    let home_c = std::fs::canonicalize(home).map_err(|e| format!("bare home unavailable: {e}"))?;
    let layer_c = std::fs::canonicalize(home.join("layer")).map_err(|e| format!("bare home's layer directory unavailable: {e}"))?;
    if !same_path(&layer_c, &home_c.join("layer")) {
        return Err(format!("{OUTSIDE} (the layer directory is redirected)"));
    }
    let file = std::fs::canonicalize(path).map_err(|e| format!("payload file unavailable: {e}"))?;
    if !file.parent().is_some_and(|p| same_path(p, &layer_c)) || payload_hash(&file).is_none() || !file.is_file() {
        return Err(OUTSIDE.into());
    }
    Ok(file)
}

/// The payload's marker line and the hash it must carry: SHA-256 (first 12 hex) of the lines
/// above it, CRs dropped, joined with LF plus a final LF (Vidar's `bare` uses this one too).
pub fn payload_marker(text: &str) -> Result<(String, String), String> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
    let at = lines.iter().rposition(|l| !l.trim().is_empty()).ok_or("Bare payload is empty")?;
    let marker = lines[at].trim();
    if !marker.starts_with("VIDAR-PAYLOAD-") {
        return Err("Bare payload has no VIDAR-PAYLOAD- marker as its last line".into());
    }
    let body: String = lines[..at].iter().map(|l| format!("{l}\n")).collect();
    Ok((marker.to_string(), format!("VIDAR-PAYLOAD-{}", hash12(body.as_bytes()))))
}

/// An admitted payload's text, read once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedPayload {
    /// Canonical path, as [`admit_payload_file`] returned it.
    pub path: PathBuf,
    pub text: String,
}

/// Read an admitted payload's bytes once and check them: the name's `<hash12>` is the bytes'
/// own (the file is content-addressed, `bare/layer.rs` `write_filled`), the text is UTF-8, and
/// its last line is the marker its body hashes to.
pub fn read_admitted(path: &Path) -> Result<AdmittedPayload, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("payload file unavailable: {e}"))?;
    let named = payload_hash(path).ok_or("payload file name is not payload-<hash12>.md")?;
    if hash12(&bytes) != named {
        return Err("payload file does not match the hash in its name; Bare spawn refused".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "payload file is not UTF-8; Bare spawn refused".to_string())?;
    let (got, expected) = payload_marker(&text)?;
    if got != expected {
        return Err(format!("Bare payload marker {got} does not match {expected}; Bare spawn refused"));
    }
    Ok(AdmittedPayload { path: path.to_path_buf(), text })
}

/// [`admit_payload_file`] then [`read_admitted`]: the path check first, the one read after it.
pub fn admit_and_read(raw: &str, home: &Path) -> Result<AdmittedPayload, String> {
    read_admitted(&admit_payload_file(raw, home)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("codex-payload-test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A marked payload as `write_filled` writes it, under `<home>\layer\`.
    fn write_payload(home: &Path, body: &str) -> PathBuf {
        let body: String = body.lines().map(|l| format!("{l}\n")).collect();
        let text = format!("{body}VIDAR-PAYLOAD-{}\n", hash12(body.as_bytes()));
        let layer = home.join("layer");
        std::fs::create_dir_all(&layer).unwrap();
        let path = layer.join(format!("payload-{}.md", hash12(text.as_bytes())));
        std::fs::write(&path, &text).unwrap();
        path
    }

    #[test]
    fn a_marked_payload_under_the_layer_is_admitted_and_read_once() {
        let d = Dir::new();
        let path = write_payload(&d.0, "Use \"tabs\".\n\tIndented \\ line");
        let got = admit_and_read(&path.to_string_lossy(), &d.0).unwrap();
        assert!(got.text.ends_with('\n') && got.text.contains("VIDAR-PAYLOAD-"));
        let value = encode_toml_string(&got.text);
        assert!(value.starts_with("\"Use \\\"tabs\\\".\\n\\tIndented \\\\ line\\n"), "{value}");
    }

    #[test]
    fn a_payload_outside_the_layer_or_off_the_name_rule_is_refused() {
        let d = Dir::new();
        let inside = write_payload(&d.0, "x");
        let name = inside.file_name().unwrap().to_owned();
        let beside = d.0.join(&name);
        std::fs::copy(&inside, &beside).unwrap();
        assert!(admit_payload_file(&beside.to_string_lossy(), &d.0).unwrap_err().contains("outside the bare home's layer directory"));
        for raw in ["-payload-0123456789ab.md", r"layer\payload-0123456789ab.md"] {
            assert!(admit_payload_file(raw, &d.0).is_err(), "{raw}");
        }
        let dotted = d.0.join("layer").join("..").join("layer").join(&name);
        assert!(admit_payload_file(&dotted.to_string_lossy(), &d.0).unwrap_err().contains("'..'"));
        let upper = d.0.join("layer").join("payload-0123456789AB.md");
        assert!(admit_payload_file(&upper.to_string_lossy(), &d.0).unwrap_err().contains("payload-<hash12>.md"));
    }

    #[test]
    fn a_payload_through_a_junctioned_layer_is_refused() {
        let d = Dir::new();
        let home = d.0.join("home");
        let outside = d.0.join("outside");
        let file = write_payload(&outside, "x");
        let name = file.file_name().unwrap().to_owned();
        std::fs::create_dir_all(&home).unwrap();
        let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(home.join("layer")).arg(outside.join("layer")).output();
        if !made.as_ref().is_ok_and(|o| o.status.success()) || !home.join("layer").exists() {
            eprintln!("SKIP a_payload_through_a_junctioned_layer_is_refused: could not create a junction");
            return;
        }
        let via = home.join("layer").join(name);
        let e = admit_payload_file(&via.to_string_lossy(), &home).unwrap_err();
        assert!(e.contains("outside the bare home's layer directory"), "{e}");
    }

    #[test]
    fn a_payload_whose_bytes_or_marker_do_not_match_is_refused() {
        let d = Dir::new();
        let path = write_payload(&d.0, "x");
        // Same name, other bytes: the content address no longer holds.
        std::fs::write(&path, "y\nVIDAR-PAYLOAD-000000000000\n").unwrap();
        assert!(admit_and_read(&path.to_string_lossy(), &d.0).unwrap_err().contains("hash in its name"));
        // Content-addressed but the marker is wrong.
        let text = "y\nVIDAR-PAYLOAD-000000000000\n";
        let named = d.0.join("layer").join(format!("payload-{}.md", hash12(text.as_bytes())));
        std::fs::write(&named, text).unwrap();
        assert!(admit_and_read(&named.to_string_lossy(), &d.0).unwrap_err().contains("does not match"));
    }
}
