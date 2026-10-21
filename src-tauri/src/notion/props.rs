//! Page property values as text (plan § IPC `notion_page`) and as facet values (§ D3). Missing or
//! odd shapes give "" (or no facet value), never an error: the remote JSON is untrusted.

use serde_json::Value;

/// Types the card never shows as a field.
const SKIPPED: [&str; 5] = ["title", "button", "place", "verification", "unsupported"];
/// Types that carry chip values (§ D3).
const FACETS: [&str; 5] = ["status", "select", "multi_select", "people", "checkbox"];

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// The concatenated `plain_text` of a rich-text array.
pub fn plain(rich: Option<&Value>) -> String {
    rich.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|t| s(t, "plain_text")).collect())
        .unwrap_or_default()
}

/// The title of a page (its `title`-typed property) or a data source (its top-level `title`).
pub fn title_of(obj: &Value) -> String {
    if let Some(t) = obj.get("title").filter(|t| t.is_array()) {
        return plain(Some(t));
    }
    obj.get("properties")
        .and_then(Value::as_object)
        .and_then(|m| m.values().find(|p| s(p, "type") == Some("title")))
        .map(|p| plain(p.get("title")))
        .unwrap_or_default()
}

fn number(v: Option<&Value>) -> String {
    match v {
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        _ => String::new(),
    }
}

fn name(v: Option<&Value>) -> String {
    v.and_then(|o| s(o, "name")).unwrap_or_default().to_string()
}

fn person(v: &Value) -> String {
    s(v, "name").filter(|n| !n.is_empty()).unwrap_or("Unknown").to_string()
}

fn names(v: Option<&Value>, each: impl Fn(&Value) -> String) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(each).filter(|n| !n.is_empty()).collect()).unwrap_or_default()
}

fn date(v: Option<&Value>) -> String {
    let Some(d) = v.filter(|d| d.is_object()) else { return String::new() };
    match (s(d, "start"), s(d, "end")) {
        (Some(a), Some(b)) => format!("{a} – {b}"),
        (Some(a), None) => a.to_string(),
        _ => String::new(),
    }
}

fn yes_no(v: Option<&Value>) -> String {
    match v.and_then(Value::as_bool) {
        Some(true) => "Yes".into(),
        Some(false) => "No".into(),
        None => String::new(),
    }
}

/// "1 Page" or "{n} Pages"; "" for none.
pub fn pages(n: usize) -> String {
    match n {
        0 => String::new(),
        1 => "1 Page".into(),
        n => format!("{n} Pages"),
    }
}

/// A formula or rollup inner value, by its own `type`.
fn typed(v: &Value) -> String {
    let t = s(v, "type").unwrap_or("");
    let inner = v.get(t);
    match t {
        "string" => inner.and_then(Value::as_str).unwrap_or_default().to_string(),
        "number" => number(inner),
        "boolean" => yes_no(inner),
        "date" => date(inner),
        "array" => inner
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(element).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// A rollup array element: any property value, a title included.
fn element(e: &Value) -> Option<String> {
    if s(e, "type") == Some("title") {
        return Some(plain(e.get("title")));
    }
    text(e)
}

/// The text of one property value, or None for a type the card skips.
pub fn text(p: &Value) -> Option<String> {
    let t = s(p, "type")?;
    if SKIPPED.contains(&t) {
        return None;
    }
    let v = p.get(t);
    Some(match t {
        "rich_text" => plain(v),
        "number" => number(v),
        "select" | "status" => name(v),
        "multi_select" => names(v, |o| name(Some(o))).join(", "),
        "date" => date(v),
        "people" => names(v, person).join(", "),
        "checkbox" => yes_no(v),
        "url" | "email" | "phone_number" | "created_time" | "last_edited_time" => {
            v.and_then(Value::as_str).unwrap_or_default().to_string()
        }
        "created_by" | "last_edited_by" => v.filter(|o| o.is_object()).map(person).unwrap_or_default(),
        "formula" | "rollup" => v.map(typed).unwrap_or_default(),
        "relation" => pages(v.and_then(Value::as_array).map_or(0, Vec::len)),
        "files" => names(v, |f| name(Some(f))).join(", "),
        "unique_id" => match v.and_then(|u| u.get("number")).and_then(Value::as_i64) {
            Some(n) => match v.and_then(|u| s(u, "prefix")).filter(|p| !p.is_empty()) {
                Some(prefix) => format!("{prefix}-{n}"),
                None => n.to_string(),
            },
            None => String::new(),
        },
        _ => return None,
    })
}

/// Chip values of one property value, or None when its type carries no chips.
pub fn facet_values(p: &Value) -> Option<Vec<String>> {
    let t = s(p, "type")?;
    if !FACETS.contains(&t) {
        return None;
    }
    let v = p.get(t);
    Some(match t {
        "select" | "status" => Some(name(v)).filter(|n| !n.is_empty()).into_iter().collect(),
        "multi_select" => names(v, |o| name(Some(o))),
        "people" => names(v, person),
        "checkbox" => match v.and_then(Value::as_bool) {
            Some(true) => vec!["Checked".into()],
            Some(false) => vec!["Unchecked".into()],
            None => Vec::new(),
        },
        _ => Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relation_counts_are_plural_aware() {
        assert_eq!(pages(0), "");
        assert_eq!(pages(1), "1 Page");
        assert_eq!(pages(3), "3 Pages");
    }

    #[test]
    fn hostile_shapes_give_empty_text() {
        assert_eq!(text(&json!({"type": "number", "number": "7"})).as_deref(), Some(""));
        assert_eq!(text(&json!({"type": "people", "people": [{}]})).as_deref(), Some("Unknown"));
        assert_eq!(text(&json!({"type": "date", "date": null})).as_deref(), Some(""));
        assert_eq!(text(&json!({"type": "formula", "formula": {"type": "unsupported"}})).as_deref(), Some(""));
        assert_eq!(text(&json!({"type": "button", "button": {}})), None);
        assert_eq!(text(&json!({"type": "brand_new", "brand_new": {}})), None);
        assert_eq!(text(&json!("x")), None);
    }
}
