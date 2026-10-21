//! Line parsers for the Unreal logs: editor log tail and UnrealBuildTool's `Log.txt`.
//!
//! Pure text in, facts out; no file access. Every diagnostic pattern here is unproven
//! against a real compile or Live Coding failure (bench-tab-plan Risk 1) and ships on
//! synthetic fixtures; `Log<Cat>: Error:` lines still list through the UE pattern.

use std::sync::LazyLock;

use regex::Regex;

use super::{BuildResult, Diag, LiveResult, Severity, Source};

/// `text` cap in characters (not bytes).
pub const TEXT_CAP: usize = 300;

/// A diagnostic plus the time its line carried, used only to order the merged list.
#[derive(Debug, Clone)]
pub struct RawDiag {
    pub diag: Diag,
    pub at: Option<u64>,
}

#[derive(Debug, Default)]
pub struct LogScan {
    pub closed: bool,
    pub diags: Vec<RawDiag>,
    pub live: Option<(LiveResult, Option<u64>)>,
}

#[derive(Debug)]
pub struct UbtScan {
    pub result: BuildResult,
    pub diags: Vec<RawDiag>,
}

static MSVC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\((\d+)(?:,\d+)?\)\s*:\s*(?:fatal\s+)?(error|warning)\b\s*(.*)$").unwrap()
});
static UE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\u{FEFF}?(?:\[[^\]]*\]){0,2}\s*Log\w+:\s*(Error|Warning):\s*(.*)$").unwrap()
});
static STAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\u{FEFF}?\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]").unwrap()
});
static CLOSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\u{FEFF}?\[[^\]]*\]\[[^\]]*\]Log file closed,").unwrap());
static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z]:[\\/]").unwrap());
static LIVE_FAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(compil\w*\s+(failed|error)|live coding[^\n]*failed|patch\w*\s+failed)").unwrap());
static LIVE_OK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)((compil\w*|patch\w*|live coding)[^\n]*(succeeded|successfully|completed))").unwrap()
});

/// First `n` characters; safe on multi-byte text.
pub fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// UTC `[yyyy.mm.dd-hh.mm.ss:mmm]` prefix as epoch milliseconds.
pub fn stamp_ms(line: &str) -> Option<u64> {
    let c = STAMP.captures(line)?;
    let n = |i: usize| c[i].parse::<i64>().ok();
    let days = days_from_civil(n(1)?, n(2)?, n(3)?);
    let secs = days * 86_400 + n(4)? * 3600 + n(5)? * 60 + n(6)?;
    u64::try_from(secs * 1000 + n(7)?).ok()
}

/// Days since 1970-01-01 (Howard Hinnant's civil-from-days inverse).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `.`/`..` collapsed over a `\`-separated path; a leading `\\` (UNC) is kept. None when `..`
/// climbs above the first segment (the drive or the server).
fn collapse(path: &str) -> Option<String> {
    let (prefix, rest) = match path.strip_prefix("\\\\") {
        Some(r) => ("\\\\", r),
        None => ("", path),
    };
    let mut out: Vec<&str> = Vec::new();
    for seg in rest.split('\\') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.len() <= 1 { return None; }
                out.pop();
            }
            s => out.push(s),
        }
    }
    Some(format!("{prefix}{}", out.join("\\")))
}

/// Absolute paths pass through normalised; a relative path with a directory part is resolved
/// against the project root; a bare file name has no safe home, so None.
pub fn resolve_path(raw: &str, root: &str) -> Option<String> {
    let s = raw.trim().trim_matches('"').replace('/', "\\");
    if s.is_empty() { return None; }
    let b = s.as_bytes();
    let drive = b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\';
    if drive || (b.len() > 2 && s.starts_with("\\\\") && b[2] != b'\\') {
        return collapse(&s);
    }
    if !s.contains('\\') { return None; }
    collapse(&format!("{}\\{}", root.trim_end_matches('\\'), s))
}

/// The file part of the text before `(`: the last drive-letter path, else the last token.
fn file_part(prefix: &str) -> &str {
    if let Some(m) = DRIVE.find_iter(prefix).last() {
        return &prefix[m.start()..];
    }
    let tok = prefix.rsplit(char::is_whitespace).next().unwrap_or("");
    tok.rsplit(']').next().unwrap_or("")
}

/// `<path>(<line>[,col]): (error|warning) ...`, unanchored.
fn msvc_line(line: &str, root: &str, source: Source) -> Option<Diag> {
    let c = MSVC.captures(line)?;
    let whole = c.get(0)?;
    let ln = c[1].parse::<u32>().ok()?;
    // An unresolvable path keeps the diagnostic, just without a file to open.
    let file = resolve_path(file_part(&line[..whole.start()]), root);
    let severity = if &c[2] == "error" { Severity::Error } else { Severity::Warning };
    let rest = c[3].trim();
    let text = if rest.is_empty() { c[2].to_string() } else { rest.to_string() };
    Some(Diag { file, line: Some(ln), severity, text: truncate_chars(&text, TEXT_CAP), source })
}

fn ue_line(line: &str) -> Option<Diag> {
    let c = UE_LINE.captures(line)?;
    let severity = if &c[1] == "Error" { Severity::Error } else { Severity::Warning };
    Some(Diag { file: None, line: None, severity, text: truncate_chars(c[2].trim(), TEXT_CAP), source: Source::Log })
}

/// The MSVC match wins over the UE pattern on the same line.
fn diag_of(line: &str, root: &str, source: Source) -> Option<Diag> {
    msvc_line(line, root, source).or_else(|| if source == Source::Log { ue_line(line) } else { None })
}

pub fn scan_log(text: &str, root: &str) -> LogScan {
    let mut scan = LogScan::default();
    let mut last_at: Option<u64> = None;
    for line in text.lines() {
        if let Some(at) = stamp_ms(line) { last_at = Some(at); }
        if CLOSED.is_match(line) { scan.closed = true; }
        let diag = diag_of(line, root, Source::Log);
        if line.contains("LogLiveCoding") {
            let failed = diag.as_ref().is_some_and(|d| d.severity == Severity::Error) || LIVE_FAIL.is_match(line);
            if failed {
                scan.live = Some((LiveResult::Failed, last_at));
            } else if LIVE_OK.is_match(line) {
                scan.live = Some((LiveResult::Succeeded, last_at));
            }
        }
        if let Some(diag) = diag { scan.diags.push(RawDiag { diag, at: last_at }); }
    }
    scan
}

/// Normalised form for comparing project paths: `/` separators, lowercase.
pub fn norm_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// `norm_path` of the real path when it resolves (junctions, subst, mapped drives, `\\?\`),
/// else of the text as given.
fn canon_norm(p: &str) -> String {
    match std::fs::canonicalize(p) {
        Ok(c) => {
            let s = c.to_string_lossy().into_owned();
            norm_path(s.strip_prefix(r"\\?\").unwrap_or(&s))
        }
        Err(_) => norm_path(p),
    }
}

/// Whether the `Resolved project argument` line in `text` names `uproject` (full path of the
/// `.uproject`). Both sides are canonicalised when they exist on disk, else compared as text.
pub fn ubt_matches(text: &str, uproject: &str) -> bool {
    let Some(raw) = text.lines().find_map(|l| {
        let i = l.find("Resolved project argument ")?;
        Some(l[i + "Resolved project argument ".len()..].trim().to_string())
    }) else { return false };
    let want = norm_path(uproject);
    let resolved = norm_path(raw.trim_matches('"'));
    // Never split on " to ": paths hold spaces. The resolved path is the line's tail.
    let plain = resolved.ends_with(&want)
        && resolved[..resolved.len() - want.len()].chars().last().is_some_and(|c| c.is_whitespace());
    if plain { return true; }
    let want = canon_norm(uproject);
    // Try every whitespace-started tail of the line as the path.
    raw.char_indices()
        .filter(|(_, c)| c.is_whitespace())
        .map(|(i, c)| &raw[i + c.len_utf8()..])
        .chain(std::iter::once(raw.as_str()))
        .any(|cand| {
            let cand = cand.trim().trim_matches('"');
            cand.to_lowercase().ends_with(".uproject") && canon_norm(cand) == want
        })
}

/// Reads a UBT `Log.txt`. None when its `Resolved project argument` line names another project.
/// `uproject` is the full path of the project's `.uproject` file.
pub fn scan_ubt(text: &str, uproject: &str, root: &str) -> Option<UbtScan> {
    if !ubt_matches(text, uproject) { return None; }
    let mut result = BuildResult::Unknown;
    let mut diags = Vec::new();
    for line in text.lines() {
        if let Some(r) = line.split_once("Result:").map(|(_, r)| r.trim()) {
            let r = r.to_ascii_lowercase();
            result = if r.starts_with("succeeded") {
                BuildResult::Succeeded
            } else if r.starts_with("fail") {
                BuildResult::Failed
            } else {
                BuildResult::Unknown
            };
        }
        if let Some(diag) = diag_of(line, root, Source::Ubt) { diags.push(RawDiag { diag, at: None }); }
    }
    Some(UbtScan { result, diags })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = r"C:\Projects\Acme";

    #[test]
    fn msvc_line_yields_file_and_line() {
        let l = r"[2026.10.04-06.50.01:100][ 12]LogLiveCoding: Display: C:\Projects\Acme\Source\Acme\Foo.cpp(42,7): error C2065: 'x': undeclared identifier";
        let d = msvc_line(l, ROOT, Source::Log).unwrap();
        assert_eq!(d.file.as_deref(), Some(r"C:\Projects\Acme\Source\Acme\Foo.cpp"));
        assert_eq!(d.line, Some(42));
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.text, "C2065: 'x': undeclared identifier");
        let rel = msvc_line("../../Source/Foo.h(3): warning C4100: unused", ROOT, Source::Ubt).unwrap();
        assert_eq!(rel.file.as_deref(), Some(r"C:\Source\Foo.h"));
        assert_eq!(rel.severity, Severity::Warning);
    }

    #[test]
    fn ue_error_line_has_no_file_and_msvc_wins() {
        let l = "[2026.10.04-06.51.00:000][ 1]LogTemp: Error: Boom at runtime";
        let d = diag_of(l, ROOT, Source::Log).unwrap();
        assert_eq!((d.file, d.line, d.text.as_str()), (None, None, "Boom at runtime"));
        let both = r"[2026.10.04-06.51.00:000][ 1]LogCompile: Error: C:\Projects\Acme\A.cpp(1): error C1: bad";
        assert_eq!(diag_of(both, ROOT, Source::Log).unwrap().line, Some(1));
    }

    #[test]
    fn text_is_capped_at_300_chars_not_bytes() {
        let long = "é".repeat(500);
        let l = format!("[2026.10.04-06.51.00:000][ 1]LogTemp: Error: {long}");
        let d = diag_of(&l, ROOT, Source::Log).unwrap();
        assert_eq!(d.text.chars().count(), TEXT_CAP);
        assert_eq!(truncate_chars("ab", 5), "ab");
    }

    #[test]
    fn stamp_is_utc_epoch_ms() {
        assert_eq!(stamp_ms("[1970.01.02-00.00.01:002][ 0]x"), Some(86_401_002));
        assert_eq!(stamp_ms("no stamp"), None);
    }

    #[test]
    fn relative_path_escaping_the_root_is_dropped() {
        assert_eq!(resolve_path("Foo.cpp", ROOT), None);
        assert_eq!(resolve_path("../../../../x.h", ROOT), None);
        assert_eq!(resolve_path("Source/a.h", ROOT).as_deref(), Some(r"C:\Projects\Acme\Source\a.h"));
    }

    #[test]
    fn unresolvable_path_keeps_the_diag_with_no_file() {
        let d = msvc_line("Foo.cpp(7): error C1: bad", ROOT, Source::Ubt).unwrap();
        assert_eq!((d.file, d.line, d.text.as_str()), (None, Some(7), "C1: bad"));
    }

    #[test]
    fn unc_paths_keep_their_leading_slashes() {
        assert_eq!(resolve_path("//srv/share/a/../b.h", ROOT).as_deref(), Some(r"\\srv\share\b.h"));
        assert_eq!(resolve_path("Source/a.h", r"\\srv\share\Proj").as_deref(), Some(r"\\srv\share\Proj\Source\a.h"));
    }

    #[test]
    fn ubt_header_growth_does_not_hide_the_project_line() {
        let mut log = "pad\n".repeat(100);
        log.push_str("Resolved project argument Acme to C:/Projects/Acme/Acme.uproject\nResult: Succeeded\n");
        assert!(scan_ubt(&log, r"C:\Projects\Acme\Acme.uproject", ROOT).is_some());
    }

    #[test]
    fn close_marker_needs_the_timestamp_prefix() {
        assert!(!scan_log("Log file closed, 04/10/26", ROOT).closed);
        assert!(!scan_log("\u{FEFF}Log file open, 10/04/26", ROOT).closed);
        assert!(scan_log("[2026.10.04-06.53.13:778][ 91]Log file closed, 10/04/26 06:53:13", ROOT).closed);
    }

    #[test]
    fn ubt_log_for_other_project_is_ignored() {
        let log = "x\nResolved project argument C:\\a\\Other.uproject to C:/Projects/Other Game/Other.uproject\nResult: Succeeded\nTotal execution time: 1s\n";
        assert!(scan_ubt(log, r"C:\Projects\Acme\Acme.uproject", ROOT).is_none());
        let mine = "x\nResolved project argument Acme to C:/Projects/Acme/Acme.uproject\nResult: Failed\nTotal execution time: 1s\n";
        let s = scan_ubt(mine, r"C:\Projects\Acme\Acme.uproject", ROOT).unwrap();
        assert_eq!(s.result, BuildResult::Failed);
        // a suffix that is not a whole path must not match
        let sneaky = "Resolved project argument a to C:/Projects/NotAcme/Acme.uproject\n";
        assert!(scan_ubt(sneaky, r"C:\Projects\Acme\Acme.uproject", ROOT).is_none());
    }

    #[test]
    fn live_coding_results_come_from_live_coding_lines() {
        let t = "[2026.10.04-06.50.00:000][ 1]LogLiveCoding: Display: Live coding compile succeeded\n[2026.10.04-06.50.09:000][ 2]LogLiveCoding: Error: Compilation failed\n";
        let s = scan_log(t, ROOT);
        assert_eq!(s.live.map(|l| l.0), Some(LiveResult::Failed));
    }
}
