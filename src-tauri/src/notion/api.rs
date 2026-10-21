//! Request builders and argument checks (plan § D5, delta S2). The host is fixed, the version is
//! one const, ids are checked and normalised before any request exists, and the header block is
//! built straight into a `Secret`. Status mapping follows § IPC's error table.

use serde::Serialize;
use serde_json::{json, Value};

use crate::net::{Request, Secret, SendError};

pub const HOST: &str = "api.notion.com";
pub const VERSION: &str = "2026-03-11";
pub const PAGE_SIZE: u32 = 100;
pub const CAP_LIST: usize = 2 * 1024 * 1024;
pub const CAP_ITEM: usize = 1024 * 1024;
pub const CAP_ME: usize = 64 * 1024;
pub const CURSOR_MAX: usize = 4096;
pub const PROPS_MAX: usize = 32;
pub const PROP_ID_MAX: usize = 64;
const MESSAGE_CAP: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Unset,
    Auth,
    Forbidden,
    Missing,
    Rate,
    Endpoint,
    Network,
    Parse,
}

/// `{ kind, message, retryAfter? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl ApiError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        ApiError { kind, message: message.into(), retry_after: None }
    }

    pub fn after(mut self, secs: Option<u64>) -> Self {
        self.retry_after = secs;
        self
    }
}

pub fn endpoint(message: impl Into<String>) -> ApiError {
    ApiError::new(ErrorKind::Endpoint, message)
}

/// 32 hex digits, bare or dashed 8-4-4-4-12; returns the lowercase dashed form.
pub fn normalise_id(id: &str) -> Option<String> {
    let bare: String = match id.len() {
        32 => id.to_string(),
        36 => {
            let b = id.as_bytes();
            if [8, 13, 18, 23].iter().any(|&i| b[i] != b'-') {
                return None;
            }
            id.chars().filter(|&c| c != '-').collect()
        }
        _ => return None,
    };
    if bare.len() != 32 || !bare.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let h = bare.to_ascii_lowercase();
    Some(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

pub fn check_id(id: &str) -> Result<String, ApiError> {
    normalise_id(id).ok_or_else(|| endpoint("id must be 32 hex digits"))
}

/// 1-4096 printable ASCII; None passes (first page).
pub fn check_cursor(cursor: Option<&str>) -> Result<Option<String>, ApiError> {
    match cursor {
        None => Ok(None),
        Some(c) if !c.is_empty() && c.len() <= CURSOR_MAX && c.bytes().all(|b| (0x20..=0x7e).contains(&b)) => {
            Ok(Some(c.to_string()))
        }
        Some(_) => Err(endpoint("cursor must be 1-4096 printable ASCII characters")),
    }
}

fn prop_id_ok(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= PROP_ID_MAX
        && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"%_.~:-".contains(&b))
}

/// At most 32 props; an id failing the character check is dropped, not an error (delta S2).
pub fn check_props(props: &[String]) -> Result<Vec<String>, ApiError> {
    if props.len() > PROPS_MAX {
        return Err(endpoint(format!("at most {PROPS_MAX} properties")));
    }
    Ok(props.iter().filter(|p| prop_id_ok(p)).cloned().collect())
}

/// `page` or `source` → the search filter value.
pub fn check_kind(kind: &str) -> Result<&'static str, ApiError> {
    match kind {
        "page" => Ok("page"),
        "source" => Ok("data_source"),
        _ => Err(endpoint("kind must be page or source")),
    }
}

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

/// The header block: Bearer, the pinned version, JSON accept; Content-Type on POST only.
pub fn headers(token: &Secret, method: &str) -> Secret {
    let mut h = format!(
        "Authorization: Bearer {}\r\nNotion-Version: {VERSION}\r\nAccept: application/json",
        token.expose()
    );
    if method == "POST" {
        h.push_str("\r\nContent-Type: application/json");
    }
    Secret::new(h)
}

fn get(path: String) -> Request {
    Request { method: "GET", host: HOST.to_string(), path, body: None }
}

fn post(path: String, body: &Value) -> Request {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    Request { method: "POST", host: HOST.to_string(), path, body: Some(bytes) }
}

pub fn users_me() -> Request {
    get("/v1/users/me".to_string())
}

/// `filter` is `page` or `data_source` (from `check_kind`).
pub fn search(filter: &str, cursor: Option<&str>) -> Request {
    let mut body = json!({
        "filter": { "property": "object", "value": filter },
        "sort": { "timestamp": "last_edited_time", "direction": "descending" },
        "page_size": PAGE_SIZE,
    });
    if let Some(c) = cursor {
        body["start_cursor"] = json!(c);
    }
    post("/v1/search".to_string(), &body)
}

/// `id` already normalised.
pub fn source(id: &str) -> Request {
    get(format!("/v1/data_sources/{id}"))
}

/// `props` already checked; sent as given on the query string (delta S2).
pub fn query(id: &str, cursor: Option<&str>, props: &[String]) -> Request {
    let mut path = format!("/v1/data_sources/{id}/query");
    for (i, p) in props.iter().enumerate() {
        path.push(if i == 0 { '?' } else { '&' });
        path.push_str("filter_properties=");
        path.push_str(p);
    }
    let mut body = json!({
        "sorts": [{ "timestamp": "last_edited_time", "direction": "descending" }],
        "page_size": PAGE_SIZE,
    });
    if let Some(c) = cursor {
        body["start_cursor"] = json!(c);
    }
    post(path, &body)
}

pub fn page(id: &str) -> Request {
    get(format!("/v1/pages/{id}"))
}

pub fn blocks(id: &str, cursor: Option<&str>) -> Request {
    let mut path = format!("/v1/blocks/{id}/children?page_size={PAGE_SIZE}");
    if let Some(c) = cursor {
        path.push_str("&start_cursor=");
        path.push_str(&pct(c));
    }
    get(path)
}

/// Control characters stripped, at most 200 chars.
pub fn clean_message(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(MESSAGE_CAP).collect()
}

/// `clean_message`, with the token replaced by `***` after the strip and before the cap, so
/// neither a control character inside it nor the cap can leave a part of it that no longer
/// matches.
pub fn clean_redacted(s: &str, token: &Secret) -> String {
    let stripped: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = token.expose();
    let redacted = if t.is_empty() { stripped } else { stripped.replace(t, "***") };
    redacted.chars().take(MESSAGE_CAP).collect()
}

fn body_str<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// The wait a 429/529 asks for: the header, else `additional_data.retry_after`, else none
/// (the caller then holds the minimum; delta S5).
pub fn wait_secs(header: Option<u64>, body: &Value) -> Option<u64> {
    header.or_else(|| {
        let v = body.get("additional_data")?.get("retry_after")?;
        v.as_u64().or_else(|| v.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f.ceil() as u64))
    })
}

/// What a reply means. `Ok` holds the parsed 200 body. `hold` is set for a 429 (not
/// `public_api_request_blocked`) or a 529: the caller starts the pacer hold with it.
pub struct Outcome {
    pub result: Result<Value, ApiError>,
    pub hold: Option<Option<u64>>,
}

/// `token` is redacted from the remote message before it is capped.
pub fn classify(status: u16, retry_after: Option<u64>, body: &[u8], token: &Secret) -> Outcome {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let null = Value::Null;
    let b = parsed.as_ref().unwrap_or(&null);
    let message = || clean_redacted(body_str(b, "message").unwrap_or(""), token);
    let plain = |result| Outcome { result, hold: None };
    match status {
        200 => match parsed {
            Some(v) if v.is_object() => plain(Ok(v)),
            _ => plain(Err(ApiError::new(ErrorKind::Parse, "reply is not a JSON object"))),
        },
        401 => plain(Err(ApiError::new(ErrorKind::Auth, message()))),
        403 => plain(Err(ApiError::new(ErrorKind::Forbidden, message()))),
        404 => plain(Err(ApiError::new(ErrorKind::Missing, message()))),
        429 if body_str(b, "code") == Some("public_api_request_blocked") => plain(Err(endpoint(message()))),
        429 => {
            let wait = wait_secs(retry_after, b);
            Outcome { result: Err(ApiError::new(ErrorKind::Rate, message())), hold: Some(wait) }
        }
        529 => {
            let wait = wait_secs(retry_after, b);
            Outcome { result: Err(endpoint(message()).after(wait)), hold: Some(wait) }
        }
        400 | 409 => plain(Err(endpoint(message()))),
        500 | 502 | 503 | 504 => plain(Err(endpoint(message()).after(retry_after))),
        300..=399 => plain(Err(endpoint("redirect refused"))),
        other => plain(Err(endpoint(format!("unexpected status {other}")))),
    }
}

/// True for a 400 whose body code is `validation_error` (the one retry, delta S1).
pub fn is_validation_error(status: u16, body: &[u8]) -> bool {
    status == 400
        && serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|v| v.get("code").and_then(Value::as_str).map(|c| c == "validation_error"))
            .unwrap_or(false)
}

/// Transport failures: OverCap → endpoint; the rest → network (delta S4). `token` is redacted
/// before the cap.
pub fn send_error(e: &SendError, token: &Secret) -> ApiError {
    match e {
        SendError::OverCap => endpoint("reply too large"),
        SendError::Timeout => ApiError::new(ErrorKind::Network, "Notion did not answer in time"),
        SendError::Connect(m) | SendError::Io(m) => ApiError::new(ErrorKind::Network, clean_redacted(m, token)),
    }
}

/// Keep an https url on a Notion host; otherwise rebuild it from the id.
pub fn page_url(url: Option<&str>, id: &str) -> String {
    if let Some(u) = url.filter(|u| notion_url(u)) {
        return u.to_string();
    }
    let bare: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    format!("https://www.notion.so/{bare}")
}

fn notion_url(u: &str) -> bool {
    let Some(rest) = u.strip_prefix("https://") else { return false };
    if u.len() > 2000 || !u.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return false;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    matches!(&rest[..end], "www.notion.so" | "notion.so" | "app.notion.com")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_normalise_and_refuse() {
        let dashed = "00000000-0000-0000-0000-0000000000ab";
        assert_eq!(normalise_id("000000000000000000000000000000AB").as_deref(), Some(dashed));
        assert_eq!(normalise_id(dashed).as_deref(), Some(dashed));
        for bad in ["", "0000", "00000000-0000-0000-0000-0000000000zz", "000000000-000-0000-0000-0000000000ab", "../v1/users/me"] {
            assert_eq!(normalise_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn url_rule_keeps_notion_https_only() {
        let id = "00000000-0000-0000-0000-000000000001";
        let rebuilt = "https://www.notion.so/00000000000000000000000000000001";
        assert_eq!(page_url(Some("https://www.notion.so/Example-1"), id), "https://www.notion.so/Example-1");
        assert_eq!(page_url(Some("https://app.notion.com/p/1"), id), "https://app.notion.com/p/1");
        assert_eq!(page_url(Some("https://notion.so"), id), "https://notion.so");
        for bad in [
            "http://www.notion.so/x",
            "https://www.notion.so.evil.example/x",
            "https://evil.example/www.notion.so",
            "https://www.notion.so@evil.example/",
            "https://www.notion.so:8443/x",
            "javascript:alert(1)",
            "https://www.notion.so/a b",
        ] {
            assert_eq!(page_url(Some(bad), id), rebuilt, "{bad}");
        }
        assert_eq!(page_url(None, id), rebuilt);
    }

    #[test]
    fn query_path_carries_props_as_given() {
        let r = query("00000000-0000-0000-0000-000000000001", Some("c1"), &["title".into(), "a%3Ab".into()]);
        assert_eq!(r.path, "/v1/data_sources/00000000-0000-0000-0000-000000000001/query?filter_properties=title&filter_properties=a%3Ab");
        let body: Value = serde_json::from_slice(r.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["start_cursor"], "c1");
        assert_eq!(body["page_size"], 100);
        assert_eq!(check_props(&["ok".into(), "bad id".into(), "x&y=z".into()]).unwrap(), vec!["ok".to_string()]);
        assert!(check_props(&vec!["p".to_string(); 33]).is_err());
    }

    #[test]
    fn blocks_cursor_is_percent_encoded() {
        let r = blocks("00000000-0000-0000-0000-000000000001", Some("a b&c=d"));
        assert_eq!(r.path, "/v1/blocks/00000000-0000-0000-0000-000000000001/children?page_size=100&start_cursor=a%20b%26c%3Dd");
    }
}
