//! One concern: reading a single value out of `HKCU\Environment` via `reg query`.
//! Used by `flow.rs` (vendor model keys). It matches the name case-insensitively and
//! accepts both `REG_SZ` and `REG_EXPAND_SZ`, so a key set via the System Properties dialog,
//! or by a vendor installer that writes `REG_EXPAND_SZ`, still reads back.

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

/// Same flag every spawning module in this crate sets: without it, `reg query` flashes
/// a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Reads one value out of `HKCU\Environment` by name. `None` on any failure to spawn,
/// a non-zero exit (value not set) or a value that doesn't parse.
pub fn registry_value(name: &str) -> Option<String> {
    let output = Command::new("reg")
        .args(["query", "HKCU\\Environment", "/v", name])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_reg_query_value(&String::from_utf8_lossy(&output.stdout), name)
}

/// `reg query` prints one matching line like
/// `    NAME    REG_SZ    <value>` (columns separated by runs of whitespace).
/// The name token is matched case-insensitively (a key set via the System Properties
/// dialog, or an installer, may not match a call site's literal case); the value
/// column accepts either `REG_SZ` or `REG_EXPAND_SZ`.
pub fn parse_reg_query_value(text: &str, name: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        let mut head = trimmed.splitn(2, char::is_whitespace);
        let Some(col_name) = head.next() else { continue };
        if !col_name.eq_ignore_ascii_case(name) {
            continue;
        }
        let rest = head.next().unwrap_or("").trim_start();
        let mut tail = rest.splitn(2, char::is_whitespace);
        let Some(col_type) = tail.next() else { continue };
        if col_type != "REG_SZ" && col_type != "REG_EXPAND_SZ" {
            continue;
        }
        let value = tail.next().unwrap_or("").trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_reg_sz_line() {
        let text = "\nHKEY_CURRENT_USER\\Environment\n    TYPESAFE_API_KEY    REG_SZ    abc123\n\n";
        assert_eq!(parse_reg_query_value(text, "TYPESAFE_API_KEY"), Some("abc123".to_string()));
    }

    #[test]
    fn parses_a_reg_expand_sz_line() {
        let text = "\nHKEY_CURRENT_USER\\Environment\n    ACME_API_KEY    REG_EXPAND_SZ    xyz789\n\n";
        assert_eq!(parse_reg_query_value(text, "ACME_API_KEY"), Some("xyz789".to_string()));
    }

    #[test]
    fn matches_the_name_case_insensitively() {
        let text = "\nHKEY_CURRENT_USER\\Environment\n    typesafe_api_key    REG_SZ    abc123\n\n";
        assert_eq!(parse_reg_query_value(text, "TYPESAFE_API_KEY"), Some("abc123".to_string()));
    }

    #[test]
    fn a_missing_value_is_none() {
        let text = "\nHKEY_CURRENT_USER\\Environment\n\nERROR: The system was unable to find the specified registry key.\n";
        assert_eq!(parse_reg_query_value(text, "TYPESAFE_API_KEY"), None);
    }
}
