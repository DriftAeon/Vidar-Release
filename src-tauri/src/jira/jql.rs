//! JQL composition for the Jira tab: scope parts plus the filter bar's
//! `Filters`, built as text from validated pieces, never parsed. Every quoted string is escaped,
//! project keys are pattern-checked, and the bar's caps are enforced again here as a backstop.

use serde::Deserialize;

use super::api::{self, ApiError, ErrorKind, Scope};

/// Per-list cap and search-text cap; the bar enforces them first.
pub const MAX_LIST: usize = 20;
pub const MAX_TEXT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssigneeFilter {
    Any,
    Me,
    None,
}

/// The filter bar's state as it crosses IPC.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    pub projects: Vec<String>,
    pub types: Vec<String>,
    pub categories: Vec<i64>,
    pub assignee: AssigneeFilter,
    pub text: String,
}

/// A double-quoted JQL string: `\` and `"` escaped, control characters turned into spaces.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Lucene specials and control characters become spaces, so stray punctuation cannot turn the
/// list into a JQL error; the result is trimmed.
fn search_text(raw: &str) -> String {
    let mapped: String = raw.chars().map(|c| if c.is_control() || "+-&|!(){}[]^~*?:\\/\"".contains(c) { ' ' } else { c }).collect();
    mapped.trim().to_string()
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// The byte index of the last `\border\s+by\b` (case-insensitive) outside `'…'` and `"…"`
/// literals, honouring backslash escapes inside them.
fn order_by_start(jql: &str) -> Option<usize> {
    let b = jql.as_bytes();
    let mut quote: Option<u8> = None;
    let mut found = None;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == b'\\' {
            i += 2;
            continue;
        }
        if c == b'\'' || c == b'"' {
            quote = Some(c);
        } else if (c == b'o' || c == b'O') && (i == 0 || !is_word(b[i - 1])) && b.len() >= i + 5 && b[i..i + 5].eq_ignore_ascii_case(b"order") {
            let mut j = i + 5;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j > i + 5 && b.len() >= j + 2 && b[j..j + 2].eq_ignore_ascii_case(b"by") && (b.len() == j + 2 || !is_word(b[j + 2])) {
                found = Some(i);
            }
        }
        i += 1;
    }
    found
}

/// The JQL for `scope`, `saved_jql` and `filters`. `None`, and filters that build no clause,
/// give exactly `api::compose_jql`. Over-cap lists or text are refused as kind `jql`.
pub fn compose(scope: Scope, saved_jql: &str, filters: Option<&Filters>) -> Result<String, ApiError> {
    let Some(f) = filters else { return Ok(api::compose_jql(scope, saved_jql)) };
    if f.projects.len() > MAX_LIST || f.types.len() > MAX_LIST || f.categories.len() > MAX_LIST {
        return Err(ApiError::new(ErrorKind::Jql, format!("a filter list is over {MAX_LIST} entries")));
    }
    if f.text.chars().count() > MAX_TEXT {
        return Err(ApiError::new(ErrorKind::Jql, format!("search text is over {MAX_TEXT} characters")));
    }
    // A saved query that is just the default, however it is wrapped, counts as blank.
    let collapse = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
    let saved_jql = if collapse(saved_jql) == collapse(api::DEFAULT_JQL) { "" } else { saved_jql };
    let mut status: Option<String> = None;
    let categories: Vec<String> = f.categories.iter().filter(|c| matches!(c, 2..=4)).map(i64::to_string).collect();
    if !categories.is_empty() {
        status = Some(format!("statusCategory in ({})", categories.join(", ")));
    }
    let mut clauses: Vec<String> = Vec::new();
    let projects: Vec<&str> = f.projects.iter().map(String::as_str).filter(|k| api::valid_project_key(k)).collect();
    if !projects.is_empty() {
        let quoted: Vec<String> = projects.iter().map(|k| quote(k)).collect();
        clauses.push(format!("project in ({})", quoted.join(", ")));
    }
    let types: Vec<String> = f.types.iter().filter(|t| !t.trim().is_empty()).map(|t| quote(t)).collect();
    if !types.is_empty() {
        clauses.push(format!("issuetype in ({})", types.join(", ")));
    }
    match f.assignee {
        AssigneeFilter::Any => {}
        AssigneeFilter::Me => clauses.push("assignee = currentUser()".to_string()),
        AssigneeFilter::None => clauses.push("assignee is EMPTY".to_string()),
    }
    let text = search_text(&f.text);
    if !text.is_empty() {
        clauses.push(format!("text ~ {}", quote(&text)));
    }
    if status.is_none() && clauses.is_empty() {
        return Ok(api::compose_jql(scope, saved_jql));
    }
    let custom = scope == Scope::Mine && !saved_jql.trim().is_empty();
    if custom {
        // Status narrows a saved query like any other clause, in Jira's bar order.
        let narrowing: Vec<String> = status.into_iter().chain(clauses).collect();
        let joined = narrowing.join(" AND ");
        let (before, tail) = match order_by_start(saved_jql) {
            Some(at) => (saved_jql[..at].trim(), saved_jql[at..].trim()),
            None => (saved_jql.trim(), ""),
        };
        let body = if before.is_empty() { joined } else { format!("({before}) AND {joined}") };
        return Ok(if tail.is_empty() { body } else { format!("{body} {tail}") });
    }
    let mut parts: Vec<String> = Vec::new();
    if scope == Scope::Mine {
        parts.push(api::MINE_RESTRICTION.to_string());
    }
    parts.push(status.unwrap_or_else(|| api::STATUS_CLAUSE.to_string()));
    parts.extend(clauses);
    Ok(format!("{} {}", parts.join(" AND "), api::ORDER))
}

#[cfg(test)]
#[path = "jql_tests.rs"]
mod tests;
