//! The token shape check Slack and Notion share: 1-1024 bytes of printable ASCII, no whitespace.

use super::Secret;

pub const TOKEN_MAX_BYTES: usize = 1024;

/// The messages never echo the token.
pub fn printable(token: &Secret, max: usize) -> Result<(), String> {
    let t = token.expose().as_bytes();
    if t.is_empty() || t.len() > max {
        return Err(format!("token must be 1-{max} bytes"));
    }
    if !t.iter().all(|b| (0x21..=0x7e).contains(b)) {
        return Err("token must be printable ASCII with no spaces".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(text: &str) -> Result<(), String> {
        printable(&Secret::new(text.to_string()), TOKEN_MAX_BYTES)
    }

    #[test]
    fn printable_limits() {
        assert_eq!(check(""), Err("token must be 1-1024 bytes".to_string()));
        assert!(check(&"a".repeat(1024)).is_ok());
        assert_eq!(check(&"a".repeat(1025)), Err("token must be 1-1024 bytes".to_string()));
        let spaces = Err("token must be printable ASCII with no spaces".to_string());
        assert_eq!(check("ab cd"), spaces);
        assert_eq!(check("ab\u{7}cd"), spaces);
        assert_eq!(check("abé"), spaces);
    }
}
