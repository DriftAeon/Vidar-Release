//! Request builders, the envelope classifier and the search adapter (docs/projects/slack/inbox-tab-plan.md
//! § Rust, § Decisions From P0). The host is fixed, arguments go on the query string through `pct`, and the
//! header block is built straight into a `Secret`. Search sits behind `MentionSource` plus one `search()`
//! (D6), so a move to `assistant.search.context` changes this file only.

use serde::Serialize;
use serde_json::Value;

use crate::net::{Request, Secret, SendError};

use super::parse;

pub const HOST: &str = "slack.com";
/// The one text for a rate refusal, from Slack or from the local hold.
pub const RATE_MESSAGE: &str = "ratelimited";
pub const CAP_SEARCH: usize = 2 * 1024 * 1024;
pub const CAP_AUTH: usize = 64 * 1024;
pub const CAP_USER: usize = 64 * 1024;
/// Matches asked for per mention query (one page each).
pub const MENTION_COUNT: u32 = 50;
/// Matches asked for per DM page, and the page limit.
pub const DM_COUNT: u32 = 100;
pub const DM_PAGES: u32 = 2;
/// DM matches that end paging early (the reserved share of the list).
pub const DM_ENOUGH: usize = 25;
/// The DM query looks this many days back. `after:` is exclusive and Slack reads the date in the
/// user's zone, so 8 days back in UTC still covers 7 full days plus today wherever the user is.
pub const DM_DAYS: u64 = 8;
const MESSAGE_CAP: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Unset,
    Auth,
    Scope,
    Rate,
    Endpoint,
    Network,
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
}

pub fn endpoint(message: impl Into<String>) -> ApiError {
    ApiError::new(ErrorKind::Endpoint, message)
}

/// Percent-encodes everything outside the RFC 3986 unreserved set. Copied from notion/api.rs, not
/// imported.
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

/// The header block: Bearer and JSON accept.
pub fn headers(token: &Secret) -> Secret {
    Secret::new(format!("Authorization: Bearer {}\r\nAccept: application/json", token.expose()))
}

fn get(method: &str, args: &[(&str, String)]) -> Request {
    let mut path = format!("/api/{method}");
    for (i, (k, v)) in args.iter().enumerate() {
        path.push(if i == 0 { '?' } else { '&' });
        path.push_str(k);
        path.push('=');
        path.push_str(&pct(v));
    }
    Request { method: "GET", host: HOST.to_string(), path, body: None }
}

/// `U…`/`W…` user ids: `U` or `W` then 2-31 uppercase letters or digits.
pub fn user_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (3..=32).contains(&b.len())
        && matches!(b[0], b'U' | b'W')
        && b.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

pub fn auth_test() -> Request {
    get("auth.test", &[])
}

/// `None` for an id failing `user_id_ok`.
pub fn users_info(id: &str) -> Option<Request> {
    user_id_ok(id).then(|| get("users.info", &[("user", id.to_string())]))
}

/// Which share of the merged list a source's matches belong to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Direct,
    Dm,
    Broadcast,
}

/// One `search.messages` source (P0: `<@uid>`, `@here`, `@channel`, and the recent-DM query).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MentionSource {
    Direct { user: String },
    Dms { after: String },
    Here,
    Channel,
}

impl MentionSource {
    pub fn query(&self) -> String {
        match self {
            MentionSource::Direct { user } => format!("<@{user}>"),
            MentionSource::Dms { after } => format!("after:{after}"),
            MentionSource::Here => "@here".to_string(),
            MentionSource::Channel => "@channel".to_string(),
        }
    }

    pub fn class(&self) -> Class {
        match self {
            MentionSource::Direct { .. } => Class::Direct,
            MentionSource::Dms { .. } => Class::Dm,
            MentionSource::Here | MentionSource::Channel => Class::Broadcast,
        }
    }

    fn count(&self) -> u32 {
        match self {
            MentionSource::Dms { .. } => DM_COUNT,
            _ => MENTION_COUNT,
        }
    }
}

/// The sources for one refresh, direct first so a DM that also mentions you is the copy that wins the dedupe.
/// `None` when `user` fails `user_id_ok`. `now` is Unix seconds.
pub fn sources(user: &str, now: u64) -> Option<Vec<MentionSource>> {
    if !user_id_ok(user) {
        return None;
    }
    Some(vec![
        MentionSource::Direct { user: user.to_string() },
        MentionSource::Dms { after: date_days_ago(now, DM_DAYS) },
        MentionSource::Here,
        MentionSource::Channel,
    ])
}

/// `YYYY-MM-DD` (UTC) for `now` minus `days`.
pub fn date_days_ago(now: u64, days: u64) -> String {
    let z = (now / 86_400).saturating_sub(days) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// One `search.messages` page, newest first, no highlight markers.
pub fn search_request(source: &MentionSource, page: u32) -> Request {
    get(
        "search.messages",
        &[
            ("query", source.query()),
            ("count", source.count().to_string()),
            ("page", page.to_string()),
            ("sort", "timestamp".to_string()),
            ("sort_dir", "desc".to_string()),
            ("highlight", "false".to_string()),
        ],
    )
}

/// Raw matches from one source; `capped` when more existed than were read.
#[derive(Debug, Default)]
pub struct Found {
    pub matches: Vec<Value>,
    pub capped: bool,
}

fn pages_of(body: &Value) -> u64 {
    body.pointer("/messages/paging/pages")
        .or_else(|| body.pointer("/messages/pagination/page_count"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
}

fn matches_of(body: &Value) -> Result<&Vec<Value>, ApiError> {
    body.pointer("/messages/matches")
        .and_then(Value::as_array)
        .ok_or_else(|| endpoint("search reply has no matches list"))
}

/// Runs one source. `fetch(req, cap)` sends, classifies and returns the `ok:true` body. Mention sources
/// read one page; the DM source reads up to `DM_PAGES` while fewer than `DM_ENOUGH` matches are DMs.
pub fn search<F>(source: &MentionSource, mut fetch: F) -> Result<Found, ApiError>
where
    F: FnMut(&Request, usize) -> Result<Value, ApiError>,
{
    let last = if source.class() == Class::Dm { DM_PAGES } else { 1 };
    let mut found = Found::default();
    let mut dms = 0usize;
    for page in 1..=last {
        let body = fetch(&search_request(source, page), CAP_SEARCH)?;
        let matches = matches_of(&body)?;
        let is_dm = source.class() == Class::Dm;
        if is_dm {
            // The recent-messages query returns channel traffic too; only DM rows belong to this source.
            let kept = matches.iter().filter(|m| parse::dm_label(m).is_some());
            let before = found.matches.len();
            found.matches.extend(kept.cloned());
            dms += found.matches.len() - before;
        } else {
            found.matches.extend(matches.iter().cloned());
        }
        let more = pages_of(&body) > u64::from(page);
        let enough = is_dm && dms >= DM_ENOUGH;
        if !more || enough || page == last {
            // A DM source is capped only when it found enough DMs and more pages existed.
            found.capped = more && (!is_dm || dms >= DM_ENOUGH);
            break;
        }
    }
    Ok(found)
}

/// Control characters stripped and `token` replaced by `***` before the 200-char cap.
pub fn clean_redacted(s: &str, token: &Secret) -> String {
    let stripped: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = token.expose();
    let redacted = if t.is_empty() { stripped } else { stripped.replace(t, "***") };
    redacted.chars().take(MESSAGE_CAP).collect()
}

const AUTH_CODES: [&str; 8] = [
    "not_authed",
    "invalid_auth",
    "account_inactive",
    "token_revoked",
    "token_expired",
    "no_permission",
    "org_login_required",
    "team_access_not_granted",
];

/// What a reply means (C2, C3, C17): 429 → `rate` with `retryAfter`; other non-200 → `endpoint`;
/// 200 envelope `ok:true` → the body; auth codes → `auth`; `missing_scope` → `scope` with
/// `needs <needed>`; `ratelimited` → `rate`; anything else, or a non-JSON body → `endpoint`.
pub fn classify(status: u16, retry_after: Option<u64>, body: &[u8], token: &Secret) -> Result<Value, ApiError> {
    if status == 429 {
        let mut e = ApiError::new(ErrorKind::Rate, RATE_MESSAGE);
        e.retry_after = retry_after;
        return Err(e);
    }
    if status != 200 {
        return Err(endpoint(format!("unexpected status {status}")));
    }
    let Some(v) = serde_json::from_slice::<Value>(body).ok().filter(Value::is_object) else {
        return Err(endpoint("reply is not a JSON object"));
    };
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(v);
    }
    let code = clean_redacted(v.get("error").and_then(Value::as_str).unwrap_or("unknown_error"), token);
    let kind = match code.as_str() {
        c if AUTH_CODES.contains(&c) => ErrorKind::Auth,
        "missing_scope" => {
            let needed = clean_redacted(v.get("needed").and_then(Value::as_str).unwrap_or(""), token);
            let message = if needed.is_empty() { code } else { format!("needs {needed}") };
            return Err(ApiError::new(ErrorKind::Scope, message));
        }
        "ratelimited" => {
            let mut e = ApiError::new(ErrorKind::Rate, code);
            e.retry_after = retry_after;
            return Err(e);
        }
        _ => ErrorKind::Endpoint,
    };
    Err(ApiError::new(kind, code))
}

/// Transport failures: OverCap → endpoint; the rest → network.
pub fn send_error(e: &SendError, token: &Secret) -> ApiError {
    match e {
        SendError::OverCap => endpoint("reply too large"),
        SendError::Timeout => ApiError::new(ErrorKind::Network, "Slack did not answer in time"),
        SendError::Connect(m) | SendError::Io(m) => ApiError::new(ErrorKind::Network, clean_redacted(m, token)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN: &str = "xoxp-0000000000-fixture-DoNotLog";

    #[test]
    fn request_holds_no_token_and_encodes_query() {
        let token = Secret::new(TOKEN.to_string());
        let src = MentionSource::Direct { user: "U0FIXTURE1".into() };
        let r = search_request(&src, 1);
        assert_eq!(r.method, "GET");
        assert_eq!(r.host, "slack.com");
        assert_eq!(
            r.path,
            "/api/search.messages?query=%3C%40U0FIXTURE1%3E&count=50&page=1&sort=timestamp&sort_dir=desc&highlight=false"
        );
        assert_eq!(search_request(&MentionSource::Here, 1).path.split('&').next(), Some("/api/search.messages?query=%40here"));
        let dm = search_request(&MentionSource::Dms { after: "2026-10-11".into() }, 2);
        assert!(dm.path.starts_with("/api/search.messages?query=after%3A2026-10-11&count=100&page=2&"), "{}", dm.path);
        for req in [r, dm, auth_test(), users_info("U0FIXTURE2").unwrap()] {
            assert!(!format!("{req:?}").contains(TOKEN));
            assert!(req.body.is_none());
        }
        assert_eq!(users_info("U0FIXTURE2").unwrap().path, "/api/users.info?user=U0FIXTURE2");
        assert!(users_info("U0&x=1").is_none());
        let h = headers(&token);
        assert_eq!(h.expose(), format!("Authorization: Bearer {TOKEN}\r\nAccept: application/json"));
        assert_eq!(format!("{h:?}"), "Secret(***)");
        assert!(sources("not-an-id", 0).is_none());
        // 2026-10-18T00:00:00Z.
        assert_eq!(date_days_ago(1_792_281_600, 7), "2026-10-11");
        assert_eq!(date_days_ago(1_792_281_600 + 86_399, 0), "2026-10-18");
        let s = sources("U0FIXTURE1", 1_792_281_600).unwrap();
        assert_eq!(s[1], MentionSource::Dms { after: "2026-10-10".into() });
    }

    #[test]
    fn envelope_maps_to_kind() {
        let token = Secret::new(TOKEN.to_string());
        let kind = |status: u16, body: &str| classify(status, Some(30), body.as_bytes(), &token).map_err(|e| e.kind);
        assert!(kind(200, r#"{"ok":true,"url":"https://example.slack.com/"}"#).is_ok());
        for code in ["invalid_auth", "not_authed", "token_revoked", "account_inactive"] {
            assert_eq!(kind(200, &format!(r#"{{"ok":false,"error":"{code}"}}"#)), Err(ErrorKind::Auth), "{code}");
        }
        assert_eq!(kind(200, r#"{"ok":false,"error":"ratelimited"}"#), Err(ErrorKind::Rate));
        assert_eq!(kind(200, r#"{"ok":false,"error":"internal_error"}"#), Err(ErrorKind::Endpoint));
        assert_eq!(kind(200, "<html>"), Err(ErrorKind::Endpoint));
        assert_eq!(kind(200, "[1]"), Err(ErrorKind::Endpoint));
        assert_eq!(kind(500, "{}"), Err(ErrorKind::Endpoint));
        let scope = classify(200, None, br#"{"ok":false,"error":"missing_scope","needed":"search:read"}"#, &token).unwrap_err();
        assert_eq!((scope.kind, scope.message.as_str()), (ErrorKind::Scope, "needs search:read"));
        let rate = classify(429, Some(30), b"", &token).unwrap_err();
        assert_eq!((rate.kind, rate.retry_after), (ErrorKind::Rate, Some(30)));
        let leaked = classify(200, None, format!(r#"{{"ok":false,"error":"bad {TOKEN}"}}"#).as_bytes(), &token).unwrap_err();
        assert!(!leaked.message.contains(TOKEN));
        assert_eq!(send_error(&SendError::OverCap, &token).kind, ErrorKind::Endpoint);
        assert_eq!(send_error(&SendError::Timeout, &token).kind, ErrorKind::Network);
        let io = send_error(&SendError::Io(format!("x {TOKEN}")), &token);
        assert_eq!((io.kind, io.message.contains(TOKEN)), (ErrorKind::Network, false));
    }

    fn page(dms: usize, others: usize, pages: u64) -> Value {
        let mut matches = Vec::new();
        for i in 0..dms {
            matches.push(json!({ "type": "im", "channel": { "id": format!("D0FIX{i:04}"), "is_im": true } }));
        }
        for i in 0..others {
            matches.push(json!({ "type": "message", "channel": { "id": format!("C0FIX{i:04}"), "is_im": false } }));
        }
        json!({ "ok": true, "messages": { "matches": matches, "paging": { "pages": pages } } })
    }

    fn run(src: &MentionSource, replies: Vec<Value>) -> (Found, Vec<String>) {
        let mut queue = replies.into_iter();
        let mut seen = Vec::new();
        let found = search(src, |req, cap| {
            assert_eq!(cap, CAP_SEARCH);
            seen.push(req.path.clone());
            queue.next().ok_or_else(|| endpoint("no reply queued"))
        })
        .unwrap();
        (found, seen)
    }

    #[test]
    fn dm_paging_stops_at_25_or_two_pages() {
        let dms = MentionSource::Dms { after: "2026-10-11".into() };
        let (f, seen) = run(&dms, vec![page(25, 5, 4)]);
        assert_eq!((seen.len(), f.matches.len(), f.capped), (1, 25, true));
        let (f, seen) = run(&dms, vec![page(5, 95, 4), page(3, 97, 4)]);
        assert_eq!((seen.len(), f.matches.len(), f.capped), (2, 8, false));
        assert!(seen[1].contains("&page=2&"));
        let (f, seen) = run(&dms, vec![page(5, 2, 1)]);
        assert_eq!((seen.len(), f.capped), (1, false));
        let (f, seen) = run(&dms, vec![page(5, 95, 2), page(1, 3, 2)]);
        assert_eq!((seen.len(), f.capped), (2, false));
        let (f, seen) = run(&MentionSource::Here, vec![page(0, 50, 3)]);
        assert_eq!((seen.len(), f.capped), (1, true));
    }

    #[test]
    fn dm_capped_only_when_enough_dms() {
        let dms = MentionSource::Dms { after: "2026-10-10".into() };
        // Two full pages, few DMs: more pages exist but the share is not full, so not capped.
        let (f, _) = run(&dms, vec![page(2, 98, 9), page(2, 98, 9)]);
        assert!(!f.capped);
        // Enough DMs on page 2 with more pages left: capped.
        let (f, seen) = run(&dms, vec![page(10, 90, 9), page(15, 85, 9)]);
        assert_eq!((seen.len(), f.matches.len(), f.capped), (2, 25, true));
    }

    #[test]
    fn dm_source_keeps_only_dm_rows() {
        let dms = MentionSource::Dms { after: "2026-10-10".into() };
        let (f, _) = run(&dms, vec![page(3, 7, 1)]);
        assert_eq!(f.matches.len(), 3);
        assert!(f.matches.iter().all(|m| parse::dm_label(m).is_some()));
        let (f, _) = run(&MentionSource::Here, vec![page(3, 7, 1)]);
        assert_eq!(f.matches.len(), 10);
    }

    #[test]
    fn pages_fall_back_to_pagination() {
        let mut body = page(0, 1, 1);
        body["messages"].as_object_mut().unwrap().remove("paging");
        assert_eq!(pages_of(&body), 1);
        body["messages"]["pagination"] = json!({ "page_count": 4 });
        assert_eq!(pages_of(&body), 4);
        body["messages"]["paging"] = json!({ "pages": 2 });
        assert_eq!(pages_of(&body), 2);
    }
}
