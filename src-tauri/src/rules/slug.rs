//! src-tauri\src\rules\slug.rs: the one home for turning a name into an id and for capitalising its first letter.

/// `value` lowercased to ASCII letters and digits, every other run one `-`, no leading or trailing `-`,
/// cut to `cap` characters (`usize::MAX` for no cap). Empty when nothing survives.
pub fn slug(value: &str, cap: usize) -> String {
    let mut out = String::new();
    for c in value.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let cut: String = out.chars().take(cap).collect();
    cut.trim_end_matches('-').to_string()
}

/// `slug` (no cap) as a rune id; `item` when that is no valid id.
#[cfg(test)]
pub fn rune_id(value: &str) -> String {
    let id = slug(value, usize::MAX);
    if super::rune::check_id(&id).is_ok() { id } else { "item".into() }
}

/// `s` with its first character uppercased.
pub fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_caps_and_trims() {
        assert_eq!(slug("Hello World", usize::MAX), "hello-world");
        assert_eq!(slug(&format!("{} x", "a".repeat(47)), 48), "a".repeat(47));
        assert_eq!(slug("!!!", 48), "");
    }

    #[test]
    fn rune_id_falls_back_to_item() {
        assert_eq!(rune_id("Hello World"), "hello-world");
        assert_eq!(rune_id("con"), "item");
        assert_eq!(rune_id(""), "item");
    }

    #[test]
    fn upper_first_handles_empty_and_non_ascii() {
        assert_eq!(upper_first("élan"), "Élan");
        assert_eq!(upper_first(""), "");
    }
}
