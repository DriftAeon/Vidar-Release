//! Text helpers shared by the integrations.

use super::Secret;

const MESSAGE_CAP: usize = 200;

/// Percent-encodes everything outside the RFC 3986 unreserved set.
pub fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Control characters stripped and `token` replaced by `***` before the 200-char cap.
pub fn clean_redacted(s: &str, token: &Secret) -> String {
    let stripped: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = token.expose();
    let redacted = if t.is_empty() { stripped } else { stripped.replace(t, "***") };
    redacted.chars().take(MESSAGE_CAP).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pct_keeps_unreserved_and_encodes_the_rest() {
        assert_eq!(pct("aZ09-._~"), "aZ09-._~");
        assert_eq!(pct("<@U1> é"), "%3C%40U1%3E%20%C3%A9");
    }

    #[test]
    fn clean_redacted_strips_redacts_and_caps() {
        let token = Secret::new("tok-secret".to_string());
        assert_eq!(clean_redacted("a\nb tok-secret c", &token), "ab *** c");
        assert_eq!(clean_redacted("x", &Secret::new(String::new())), "x");
        assert_eq!(clean_redacted(&"y".repeat(500), &token).chars().count(), MESSAGE_CAP);
    }
}
