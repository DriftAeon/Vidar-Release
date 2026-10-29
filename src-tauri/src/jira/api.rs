//! Jira Cloud search, as pure functions over the `Transport` seam.
//! One request, `POST /rest/api/3/search/jql`, first page only; the reply maps to the D6 issue
//! shape or to an error kind. `unset` (no credential, or a site mismatch) is decided before
//! any request, in B1's commands.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http::{Request, SendError, Transport};

pub const SEARCH_PATH: &str = "/rest/api/3/search/jql";
pub const FIELDS: [&str; 6] = ["summary", "status", "issuetype", "priority", "updated", "parent"];
pub const MAX_RESULTS: u32 = 50;
/// Used when the saved JQL is blank.
pub const DEFAULT_JQL: &str = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const MESSAGE_CAP: usize = 300;

/// The built-in scope parts: composed, never parsed.
pub(super) const MINE_RESTRICTION: &str = "assignee = currentUser()";
pub(super) const STATUS_CLAUSE: &str = "statusCategory != Done";
pub(super) const ORDER: &str = "ORDER BY updated DESC";
pub const TYPES_PATH: &str = "/rest/api/3/issuetype";
/// First page of 100, the endpoint's maximum; later pages are not fetched.
pub const PROJECTS_PATH: &str = "/rest/api/3/project/search?maxResults=100&orderBy=key";

/// The head's two-way switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Mine,
    All,
}

/// The JQL for `scope`. Mine with a custom saved JQL sends it verbatim; a blank or
/// whitespace-only one resolves to Mine's parts. With filters, see `jql::compose`.
pub fn compose_jql(scope: Scope, saved_jql: &str) -> String {
    match scope {
        Scope::Mine if !saved_jql.trim().is_empty() => saved_jql.to_string(),
        Scope::Mine => format!("{MINE_RESTRICTION} AND {STATUS_CLAUSE} {ORDER}"),
        Scope::All => format!("{STATUS_CLAUSE} {ORDER}"),
    }
}

/// One row of the D6 `jira_issues` result. Missing or null remote fields become "".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub status_category: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub priority: String,
    pub updated: String,
    pub url: String,
    /// `issuetype.hierarchyLevel`; -1 for a sub-task without one, else 0 when missing.
    pub type_level: i64,
    /// `parent.key`, "" when missing or not a valid key.
    pub parent: String,
}

/// One page: the issues and the token for the next one, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub issues: Vec<Issue>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    /// No credential, its site differs from vidar.json's, or the settings fail validation.
    Unset,
    Auth,
    Jql,
    Rate,
    Endpoint,
    Site,
    Network,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApiError {
    pub kind: ErrorKind,
    pub message: String,
}

impl ApiError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        ApiError { kind, message: message.into() }
    }
}

/// The host of an `https://<name>.atlassian.net` site; anything else is refused here too, so no
/// caller can point the Basic header or an issue url at another host (one validator, `config`).
fn host_of(site: &str) -> Result<&str, String> {
    super::config::site_host(site)
}

/// The search request for `site` (must pass `config::validate_site`) and `jql` (blank → DEFAULT_JQL);
/// `page_token` continues a previous page, `None` is the first.
pub fn page_request(site: &str, jql: &str, page_token: Option<&str>) -> Result<Request, String> {
    let host = host_of(site)?;
    let jql = if jql.trim().is_empty() { DEFAULT_JQL } else { jql };
    let mut body = json!({ "jql": jql, "fields": FIELDS, "maxResults": MAX_RESULTS });
    if let Some(token) = page_token.filter(|t| !t.is_empty()) {
        body["nextPageToken"] = json!(token);
    }
    Ok(Request {
        method: "POST",
        host: host.to_string(),
        path: SEARCH_PATH.to_string(),
        body: serde_json::to_vec(&body).map_err(|e| e.to_string())?,
    })
}

/// `^[A-Z][A-Z0-9_]{0,9}$`, checked by hand.
pub fn valid_project_key(key: &str) -> bool {
    let b = key.as_bytes();
    (1..=10).contains(&b.len()) && b[0].is_ascii_uppercase() && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// `^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,9}$`, checked by hand.
pub fn valid_key(key: &str) -> bool {
    let Some((project, number)) = key.split_once('-') else { return false };
    let p = project.as_bytes();
    let n = number.as_bytes();
    (1..=32).contains(&p.len())
        && p[0].is_ascii_uppercase()
        && p[1..].iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
        && (1..=10).contains(&n.len())
        && (b'1'..=b'9').contains(&n[0])
        && n[1..].iter().all(u8::is_ascii_digit)
}

pub(super) fn text(v: &Value, path: &[&str]) -> String {
    let mut cur = v;
    for p in path {
        match cur.get(p) {
            Some(next) => cur = next,
            None => return String::new(),
        }
    }
    cur.as_str().unwrap_or_default().to_string()
}

/// The number at `path`, if there is one (`text` returns "" for numbers).
fn number(v: &Value, path: &[&str]) -> Option<i64> {
    let mut cur = v;
    for p in path {
        cur = cur.get(p)?;
    }
    cur.as_i64()
}

fn type_level(f: &Value) -> i64 {
    number(f, &["issuetype", "hierarchyLevel"]).unwrap_or_else(|| {
        if f.pointer("/issuetype/subtask").and_then(Value::as_bool) == Some(true) { -1 } else { 0 }
    })
}

/// A 200 body `{ issues: [{ key, fields }], nextPageToken?, isLast }` → D6 issues. Issues
/// with a key failing `valid_key` are dropped, since the key feeds `url`.
pub fn parse_search(site: &str, body: &[u8]) -> Result<Page, String> {
    let host = host_of(site)?;
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("search reply is not JSON: {e}"))?;
    let raw_issues = v.get("issues").and_then(Value::as_array).ok_or("search reply has no issues array")?;
    let next_page_token = v.get("nextPageToken").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string);
    let issues = raw_issues
        .iter()
        .filter_map(|raw| {
            let key = raw.get("key").and_then(Value::as_str)?;
            if !valid_key(key) {
                return None;
            }
            let f = raw.get("fields").unwrap_or(&Value::Null);
            Some(Issue {
                key: key.to_string(),
                summary: text(f, &["summary"]),
                status: text(f, &["status", "name"]),
                status_category: text(f, &["status", "statusCategory", "key"]),
                kind: text(f, &["issuetype", "name"]),
                priority: text(f, &["priority", "name"]),
                updated: text(f, &["updated"]),
                url: format!("https://{host}/browse/{key}"),
                type_level: type_level(f),
                parent: Some(text(f, &["parent", "key"])).filter(|p| valid_key(p)).unwrap_or_default(),
            })
        })
        .collect();
    Ok(Page { issues, next_page_token })
}

/// The first `errorMessages[]` entry, else the first value of the `errors` map (field errors),
/// capped at 300 characters.
fn first_error_message(body: &[u8]) -> String {
    let Ok(v) = serde_json::from_slice::<Value>(body) else { return String::new() };
    let listed = v.get("errorMessages").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str);
    let field = || v.get("errors").and_then(Value::as_object).and_then(|m| m.values().next()).and_then(Value::as_str);
    listed.or_else(field).map(|m| m.chars().take(MESSAGE_CAP).collect()).unwrap_or_default()
}

/// Maps a transport result to a parsed 200 body or an error kind. An over-cap body
/// is the endpoint misbehaving, not the network.
pub(super) fn map_with<T>(sent: Result<(u16, Vec<u8>), SendError>, parse: impl FnOnce(&[u8]) -> Result<T, String>) -> Result<T, ApiError> {
    let (status, body) = sent.map_err(|e| match e {
        SendError::OverCap => ApiError::new(ErrorKind::Endpoint, e.to_string()),
        SendError::Failed(message) => ApiError::new(ErrorKind::Network, message),
    })?;
    match status {
        200 => parse(&body).map_err(|e| ApiError::new(ErrorKind::Endpoint, e)),
        // 403 is a permission or allowlist refusal, not a bad token: it keeps the saved credential (F4)
        401 => Err(ApiError::new(ErrorKind::Auth, format!("HTTP {status}"))),
        400 => Err(ApiError::new(ErrorKind::Jql, first_error_message(&body))),
        429 => Err(ApiError::new(ErrorKind::Rate, format!("HTTP {status}"))),
        410 => Err(ApiError::new(ErrorKind::Endpoint, format!("HTTP {status}"))),
        300..=399 | 404 => Err(ApiError::new(ErrorKind::Site, format!("HTTP {status}"))),
        _ => Err(ApiError::new(ErrorKind::Endpoint, format!("HTTP {status}"))),
    }
}

/// Maps a transport result to a page of issues or an error kind. An over-cap body
/// is the endpoint misbehaving, not the network.
pub fn map_response(site: &str, sent: Result<(u16, Vec<u8>), SendError>) -> Result<Page, ApiError> {
    map_with(sent, |body| parse_search(site, body))
}

/// Builds the search request, sends it and maps the reply.
pub fn search(transport: &dyn Transport, site: &str, jql: &str, page_token: Option<&str>) -> Result<Page, ApiError> {
    let req = page_request(site, jql, page_token).map_err(|e| ApiError::new(ErrorKind::Site, e))?;
    map_response(site, transport.send(&req))
}

/// One issue type for the Type picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TypeOption {
    pub name: String,
    pub level: i64,
}

/// One project for the Project picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectOption {
    pub key: String,
    pub name: String,
}

pub(super) fn get_request(site: &str, path: &str) -> Result<Request, String> {
    Ok(Request { method: "GET", host: host_of(site)?.to_string(), path: path.to_string(), body: Vec::new() })
}

pub fn types_request(site: &str) -> Result<Request, String> {
    get_request(site, TYPES_PATH)
}

pub fn projects_request(site: &str) -> Result<Request, String> {
    get_request(site, PROJECTS_PATH)
}

/// A 200 `GET issuetype` body (an array) → distinct names, level from `hierarchyLevel` (else -1
/// for `subtask`, else 0), sorted level descending then name A-Z. The first level
/// seen wins for a repeated name.
pub fn parse_types(body: &[u8]) -> Result<Vec<TypeOption>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("types reply is not JSON: {e}"))?;
    let raw = v.as_array().ok_or("types reply is not an array")?;
    let mut out: Vec<TypeOption> = Vec::new();
    for t in raw {
        let name = text(t, &["name"]).trim().to_string();
        if name.is_empty() || out.iter().any(|o| o.name == name) {
            continue;
        }
        out.push(TypeOption { name, level: type_level(&json!({ "issuetype": t })) });
    }
    out.sort_by(|a, b| b.level.cmp(&a.level).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// A 200 `GET project/search` body `{ values: [{ key, name }] }` → projects whose key passes
/// `valid_project_key`, in reply order.
pub fn parse_projects(body: &[u8]) -> Result<Vec<ProjectOption>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("projects reply is not JSON: {e}"))?;
    let raw = v.get("values").and_then(Value::as_array).ok_or("projects reply has no values array")?;
    Ok(raw
        .iter()
        .filter_map(|p| {
            let key = text(p, &["key"]);
            valid_project_key(&key).then(|| ProjectOption { name: text(p, &["name"]), key })
        })
        .collect())
}

/// Builds the types request, sends it and maps the reply.
pub fn types(transport: &dyn Transport, site: &str) -> Result<Vec<TypeOption>, ApiError> {
    let req = types_request(site).map_err(|e| ApiError::new(ErrorKind::Site, e))?;
    map_with(transport.send(&req), parse_types)
}

/// Builds the projects request, sends it and maps the reply.
pub fn projects(transport: &dyn Transport, site: &str) -> Result<Vec<ProjectOption>, ApiError> {
    let req = projects_request(site).map_err(|e| ApiError::new(ErrorKind::Site, e))?;
    map_with(transport.send(&req), parse_projects)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const SITE: &str = "https://example.atlassian.net";
    const SEARCH: &str = include_str!("../../../tests/fixtures/jira/search-jql.json");
    const EMPTY: &str = include_str!("../../../tests/fixtures/jira/search-jql-empty.json");
    const ERROR_400: &str = include_str!("../../../tests/fixtures/jira/error-400.json");
    const ISSUES: &str = include_str!("../../../tests/fixtures/jira/issues.json");

    struct Fixture {
        status: u16,
        body: &'static str,
        seen: RefCell<Option<Request>>,
    }

    impl Transport for Fixture {
        fn send(&self, req: &Request) -> Result<(u16, Vec<u8>), SendError> {
            *self.seen.borrow_mut() = Some(req.clone());
            Ok((self.status, self.body.as_bytes().to_vec()))
        }
    }

    fn fixture(status: u16, body: &'static str) -> Fixture {
        Fixture { status, body, seen: RefCell::new(None) }
    }

    const TYPES: &str = include_str!("../../../tests/fixtures/jira/issuetype.json");
    const PROJECTS: &str = include_str!("../../../tests/fixtures/jira/project-search.json");

    #[test]
    fn types_dedupe_by_name_and_sort_by_level() {
        let t = fixture(200, TYPES);
        let got = types(&t, SITE).unwrap();
        let want: Vec<(&str, i64)> = vec![("Epic", 1), ("Bug", 0), ("Chore", 0), ("Story", 0), ("Task", 0), ("Sub-task", -1), ("Technical Sub-task", -1)];
        assert_eq!(got.iter().map(|o| (o.name.as_str(), o.level)).collect::<Vec<_>>(), want);
        let seen = t.seen.borrow().clone().unwrap();
        assert_eq!((seen.method, seen.host.as_str(), seen.path.as_str()), ("GET", "example.atlassian.net", TYPES_PATH));
        assert!(seen.body.is_empty());
        assert_eq!(serde_json::to_value(&got[0]).unwrap(), json!({ "name": "Epic", "level": 1 }));
        assert_eq!(types(&fixture(200, "{}"), SITE).unwrap_err().kind, ErrorKind::Endpoint);
    }

    #[test]
    fn projects_page_parses_and_drops_bad_keys() {
        let t = fixture(200, PROJECTS);
        let got = projects(&t, SITE).unwrap();
        assert_eq!(
            got,
            vec![
                ProjectOption { key: "DEMO".into(), name: "Demo Project".into() },
                ProjectOption { key: "OPS".into(), name: "Operations".into() },
                ProjectOption { key: "WEB_2".into(), name: "Website".into() },
            ]
        );
        assert_eq!(t.seen.borrow().as_ref().unwrap().path, PROJECTS_PATH);
        assert!(PROJECTS_PATH.contains("maxResults=100"));
    }

    #[test]
    fn search_fixture_parses_to_issue_shape() {
        let t = fixture(200, SEARCH);
        let page = search(&t, SITE, "project = DEMO", None).unwrap();
        let got = serde_json::to_value(json!({ "issues": page.issues, "nextPageToken": page.next_page_token })).unwrap();
        let want: Value = serde_json::from_str(ISSUES).unwrap();
        assert_eq!(got, want);
        let empty = search(&fixture(200, EMPTY), SITE, "", None).unwrap();
        assert_eq!(empty, Page { issues: vec![], next_page_token: None });
    }

    #[test]
    fn request_carries_json_body_and_no_header_text() {
        let t = fixture(200, EMPTY);
        search(&t, SITE, "project = DEMO ORDER BY updated DESC", None).unwrap();
        let req = t.seen.borrow().clone().unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.host, "example.atlassian.net");
        assert_eq!(req.path, "/rest/api/3/search/jql");
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(
            body,
            json!({
                "jql": "project = DEMO ORDER BY updated DESC",
                "fields": ["summary", "status", "issuetype", "priority", "updated", "parent"],
                "maxResults": 50
            })
        );
        let shown = format!("{req:?}").to_ascii_lowercase();
        for needle in ["authorization", "basic", "accept", "content-type"] {
            assert!(!shown.contains(needle), "{needle} in {shown}");
        }
        let blank = page_request(SITE, "  ", None).unwrap();
        let body: Value = serde_json::from_slice(&blank.body).unwrap();
        assert_eq!(body["jql"], DEFAULT_JQL);
    }

    #[test]
    fn error_status_maps_to_kind() {
        let kind = |status, body: &'static str| search(&fixture(status, body), SITE, "x", None).unwrap_err();
        assert_eq!(kind(401, "").kind, ErrorKind::Auth);
        assert_eq!(kind(403, "").kind, ErrorKind::Endpoint);
        let jql = kind(400, ERROR_400);
        assert_eq!(jql.kind, ErrorKind::Jql);
        let want: Value = serde_json::from_str(ERROR_400).unwrap();
        assert_eq!(jql.message, want["errorMessages"][0].as_str().unwrap());
        assert_eq!(kind(410, "").kind, ErrorKind::Endpoint);
        assert_eq!(kind(429, "").kind, ErrorKind::Rate);
        assert_eq!(kind(302, "").kind, ErrorKind::Site);
        assert_eq!(kind(404, "").kind, ErrorKind::Site);
        assert_eq!(kind(200, "<html>").kind, ErrorKind::Endpoint);
        let net = map_response(SITE, Err("WinHttpSendRequest failed (12002)".to_string().into())).unwrap_err();
        assert_eq!(net.kind, ErrorKind::Network);

        let long = format!(r#"{{"errorMessages":["{}"]}}"#, "é".repeat(400));
        let capped = map_response(SITE, Ok((400, long.into_bytes()))).unwrap_err();
        assert_eq!(capped.message.chars().count(), 300);
        assert_eq!(serde_json::to_value(&capped).unwrap()["kind"], "jql");
    }

    #[test]
    fn site_off_atlassian_is_refused_before_send() {
        for bad in ["https://evil.example", "https://example.atlassian.net.evil.com", "https://Example.atlassian.net", "https://example.atlassian.net/x"] {
            let t = fixture(200, SEARCH);
            assert_eq!(search(&t, bad, "x", None).unwrap_err().kind, ErrorKind::Site, "{bad}");
            assert!(t.seen.borrow().is_none(), "{bad}");
            assert!(parse_search(bad, SEARCH.as_bytes()).is_err(), "{bad}");
        }
    }

    #[test]
    fn over_cap_body_maps_to_endpoint() {
        let e = map_response(SITE, Err(SendError::OverCap)).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Endpoint);
        assert_eq!(e.message, crate::jira::http::BODY_OVER_CAP);
        // The kind comes from the variant, never from matching the text.
        let e = map_response(SITE, Err(crate::jira::http::BODY_OVER_CAP.to_string().into())).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Network);
        let e = map_response(SITE, Err("body read past the deadline".to_string().into())).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Network);
    }

    #[test]
    fn jql_error_falls_back_to_the_errors_map() {
        let body = br#"{"errorMessages":[],"errors":{"jql":"Field 'x' does not exist.","other":"later"}}"#;
        let e = map_response(SITE, Ok((400, body.to_vec()))).unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Jql, "Field 'x' does not exist."));
        let both = br#"{"errorMessages":["listed"],"errors":{"jql":"field"}}"#;
        assert_eq!(map_response(SITE, Ok((400, both.to_vec()))).unwrap_err().message, "listed");
        assert_eq!(map_response(SITE, Ok((400, b"{}".to_vec()))).unwrap_err().message, "");
    }

    #[test]
    fn bad_issue_key_is_dropped() {
        for good in ["A-1", "DEMO-12", "A_B9-1234567890", &format!("A{}-9", "Z".repeat(31))] {
            assert!(valid_key(good), "{good}");
        }
        for bad in [
            "", "DEMO", "demo-1", "1DEMO-1", "DEMO-0", "DEMO-01", "DEMO-", "-1", "DEMO-1-2",
            "DE MO-1", "DEMO-12345678901", "DEMO-1/../x", "DEMO-1?x", &format!("A{}-9", "Z".repeat(32)),
        ] {
            assert!(!valid_key(bad), "{bad}");
        }
        let body = br#"{"issues":[{"key":"ok-1","fields":{}},{"key":"OK-1","fields":{}},{"fields":{}}],"isLast":true}"#;
        let issues = parse_search(SITE, body).unwrap().issues;
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].url, "https://example.atlassian.net/browse/OK-1");
    }

    #[test]
    fn parse_reads_type_level_and_parent() {
        let issues = parse_search(SITE, SEARCH.as_bytes()).unwrap().issues;
        let by = |k: &str| issues.iter().find(|i| i.key == k).unwrap();
        assert_eq!((by("DEMO-1").type_level, by("DEMO-1").parent.as_str()), (1, ""));
        assert_eq!((by("DEMO-12").type_level, by("DEMO-12").parent.as_str()), (0, "DEMO-1"));
        assert_eq!((by("DEMO-9").type_level, by("DEMO-9").parent.as_str()), (0, ""));
        let bad = br#"{"issues":[{"key":"OK-2","fields":{"parent":{"key":"bad/../key"}}}]}"#;
        assert_eq!(parse_search(SITE, bad).unwrap().issues[0].parent, "");
        let json = serde_json::to_value(by("DEMO-13")).unwrap();
        assert_eq!((json["typeLevel"].as_i64(), json["parent"].as_str()), (Some(-1), Some("DEMO-12")));
    }

    #[test]
    fn missing_level_on_subtask_reads_minus_one() {
        let body = br#"{"issues":[
            {"key":"A-1","fields":{"issuetype":{"name":"Sub-task","subtask":true}}},
            {"key":"A-2","fields":{"issuetype":{"name":"Task","subtask":false}}},
            {"key":"A-3","fields":{"issuetype":{"name":"Epic","subtask":false,"hierarchyLevel":1}}},
            {"key":"A-4","fields":{"issuetype":{"name":"Sub-task","subtask":true,"hierarchyLevel":-1}}},
            {"key":"A-5","fields":{}}]}"#;
        let levels: Vec<i64> = parse_search(SITE, body).unwrap().issues.iter().map(|i| i.type_level).collect();
        assert_eq!(levels, [-1, 0, 1, -1, 0]);
    }

    #[test]
    fn next_page_token_is_returned_and_sent() {
        let t = fixture(200, SEARCH);
        let page = search(&t, SITE, "x", None).unwrap();
        assert_eq!(page.next_page_token.as_deref(), Some("Ch0jU3RyaW5nJlJFVk5QVEU9JTNEJTNE"));
        let first: Value = serde_json::from_slice(&t.seen.borrow().clone().unwrap().body).unwrap();
        assert!(first.get("nextPageToken").is_none());
        assert_eq!(search(&fixture(200, EMPTY), SITE, "x", None).unwrap().next_page_token, None);

        search(&t, SITE, "x", Some("tok123")).unwrap();
        let second: Value = serde_json::from_slice(&t.seen.borrow().clone().unwrap().body).unwrap();
        assert_eq!(second["nextPageToken"], "tok123");
        assert_eq!(second["jql"], "x");
    }

    #[test]
    fn blank_saved_jql_uses_mine_parts() {
        for blank in ["", "   ", " \t\n "] {
            assert_eq!(compose_jql(Scope::Mine, blank), DEFAULT_JQL, "{blank:?}");
        }
    }

    #[test]
    fn custom_saved_jql_is_verbatim_without_filters() {
        let custom = "project = DEMO AND labels = x ORDER BY created ASC";
        assert_eq!(compose_jql(Scope::Mine, custom), custom);
        let t = fixture(200, EMPTY);
        search(&t, SITE, &compose_jql(Scope::Mine, custom), None).unwrap();
        let body: Value = serde_json::from_slice(&t.seen.borrow().clone().unwrap().body).unwrap();
        assert_eq!(body["jql"], custom);
    }

    #[test]
    fn all_scope_jql_is_the_broad_query() {
        let all = "statusCategory != Done ORDER BY updated DESC";
        assert_eq!(compose_jql(Scope::All, ""), all);
        assert_eq!(compose_jql(Scope::All, "project = DEMO"), all);
    }
}
