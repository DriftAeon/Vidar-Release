//! src-tauri\src\control\ask.rs — `ctl.ask`: a tab asks the **user** a typed
//! question through the approval card (`src/control/listen.ts`, `src/asks/approvals.ts`). Validates its own
//! shape, then hands off to `card::request` the same way `prompt`/`spawn` do.
//! A bare `app.emit` here would reuse the control
//! counter as the card id, colliding with real card ids and leaving an
//! abandoned ask with no `CardState` entry and no `CARD_TTL` bound. Going
//! through `card::request` gives ask a real card id, the 3-slot cap, and the
//! same TTL sweep every other card gets.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::card;
use super::policy::Requester;
use crate::open::valid_reason;

/// Up to 6 choices offered as one-click picks alongside the free-text
/// comment (the approval card's own row) — matches the CLI's `--choice a,b,c`.
const MAX_CHOICES: usize = 6;
/// Same bound `open.rs::valid_reason` gives a choice-worthy label: 1-40 chars
/// keeps a choice button from wrapping the row.
const MAX_CHOICE_LEN: usize = 40;

/// Shared validation for `ctl.ask` and `ctl.pend` (`pending_ask.rs`):
/// the question and its 0-6 choices.
pub(crate) fn parse_ask(payload: &Value) -> Result<(&str, Vec<&str>, Vec<&str>), String> {
    let question = payload.get("question").and_then(Value::as_str).filter(|s| valid_reason(s))
        .ok_or_else(|| "bad question".to_string())?;
    let choices: Vec<&str> = match payload.get("choices") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > MAX_CHOICES {
                return Err("too many choices".to_string());
            }
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let s = item.as_str().filter(|s| !s.trim().is_empty() && s.len() <= MAX_CHOICE_LEN
                    && s.bytes().all(|b| (0x20..0x7f).contains(&b)))
                    .ok_or_else(|| "bad choice".to_string())?;
                out.push(s);
            }
            out
        }
        Some(_) => return Err("bad choices".to_string()),
    };
    let details = parse_details(payload, choices.len())?;
    Ok((question, choices, details))
}

/// Longest one-line description a choice may carry.
const MAX_DETAIL_LEN: usize = 120;

/// The optional `details` of an ask: `details[i]` describes `choices[i]`. Only allowed with
/// choices, no longer than them (missing entries = no description), each entry printable
/// ASCII, at most 120 chars, may be empty.
fn parse_details(payload: &Value, choice_count: usize) -> Result<Vec<&str>, String> {
    let items = match payload.get("details") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("bad details".to_string()),
    };
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if choice_count == 0 {
        return Err("details need choices".to_string());
    }
    if items.len() > choice_count {
        return Err("more details than choices".to_string());
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let s = item.as_str().filter(|s| s.len() <= MAX_DETAIL_LEN
            && s.bytes().all(|b| (0x20..0x7f).contains(&b)))
            .ok_or_else(|| "bad detail".to_string())?;
        out.push(s);
    }
    Ok(out)
}

/// Longest `context` line a pending ask may carry.
pub(crate) const MAX_CONTEXT_LEN: usize = 80;

/// Checks a pending ask's optional `context` (printable ASCII, trimmed, 1-80
/// chars); absent, null or blank is `None`. Over-long or non-printable is an error.
pub(crate) fn check_context(raw: &str) -> Result<Option<&str>, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.len() > MAX_CONTEXT_LEN {
        return Err(format!("context over {MAX_CONTEXT_LEN} chars"));
    }
    if !s.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        return Err("context must be printable ASCII".to_string());
    }
    Ok(Some(s))
}

/// The optional `context` field of a `ctl.pend` payload.
pub(crate) fn parse_context(payload: &Value) -> Result<Option<&str>, String> {
    match payload.get("context") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => check_context(s),
        Some(_) => Err("bad context".to_string()),
    }
}

pub fn ask(app:&AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let (question, choices, details) = parse_ask(payload)?;
    let placeholder = match payload.get("placeholder") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str().filter(|s| valid_reason(s)).ok_or_else(|| "bad placeholder".to_string())?),
    };

    card::request(
        app,
        id,
        requester,
        "ask",
        json!({ "question": question, "choices": choices, "details": details, "placeholder": placeholder }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn details_pair_with_choices_and_validate() {
        let ok = json!({ "question": "Which one", "choices": ["a", "b"], "details": ["first", ""] });
        assert_eq!(parse_ask(&ok).unwrap().2, vec!["first", ""]);
        let short = json!({ "question": "Which one", "choices": ["a", "b"], "details": ["first"] });
        assert_eq!(parse_ask(&short).unwrap().2, vec!["first"]);
        let none = json!({ "question": "Which one", "choices": ["a"] });
        assert!(parse_ask(&none).unwrap().2.is_empty());
        let no_choices = json!({ "question": "Which one", "details": ["x"] });
        assert_eq!(parse_ask(&no_choices), Err("details need choices".to_string()));
        let too_many = json!({ "question": "Which one", "choices": ["a"], "details": ["x", "y"] });
        assert_eq!(parse_ask(&too_many), Err("more details than choices".to_string()));
        let too_long = json!({ "question": "Which one", "choices": ["a"], "details": ["x".repeat(121)] });
        assert_eq!(parse_ask(&too_long), Err("bad detail".to_string()));
        let at_limit = json!({ "question": "Which one", "choices": ["a"], "details": ["x".repeat(120)] });
        assert!(parse_ask(&at_limit).is_ok());
        let non_ascii = json!({ "question": "Which one", "choices": ["a"], "details": ["caf\u{e9}"] });
        assert!(parse_ask(&non_ascii).is_err());
        let not_array = json!({ "question": "Which one", "choices": ["a"], "details": "x" });
        assert_eq!(parse_ask(&not_array), Err("bad details".to_string()));
    }
}
