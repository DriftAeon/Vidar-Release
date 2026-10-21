//! One Jira issue for the in-module view: `GET issue/{key}` plus the first comments page, and a later
//! comments page on its own. Pure functions over the `Transport` seam like `api`; the Tauri commands
//! (`jira_issue`, `jira_comments`) live in `commands`. The description and comment bodies are ADF, passed
//! through as JSON for the front end to render with its own allowlist; nothing here builds markup.

use serde::Serialize;
use serde_json::Value;

use super::api::{get_request, map_with, text, valid_key, ApiError, ErrorKind};
use super::http::Transport;

pub const COMMENTS_PAGE: u32 = 20;
/// A later page starts no further in than this; Rust refuses anything over it as a backstop.
pub const MAX_START_AT: u32 = 100_000;
/// The most items kept from one comments reply, whatever Jira sent.
const MAX_ITEMS: usize = 100;
const ISSUE_FIELDS: &str = "summary,status,issuetype,priority,assignee,updated,description,subtasks,parent";

/// A related issue: the parent, or one sub-task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub status_category: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Comment {
    pub author: String,
    pub created: String,
    /// ADF, as sent; `Null` when the comment has none.
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsPage {
    pub total: u64,
    pub start_at: u64,
    pub items: Vec<Comment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub key: String,
    pub url: String,
    pub summary: String,
    pub status: String,
    pub status_category: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub priority: String,
    pub updated: String,
    pub assignee: String,
    /// ADF, as sent; `None` when the issue has no description.
    pub description: Option<Value>,
    pub parent: Option<Ref>,
    pub subtasks: Vec<Ref>,
    pub comments: CommentsPage,
}

/// `{ issue }` or `{ error: { kind, message } }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum IssueReply {
    Issue { issue: Box<IssueDetail> },
    Error { error: ApiError },
}

/// `{ comments }` or `{ error: { kind, message } }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum CommentsReply {
    Comments { comments: CommentsPage },
    Error { error: ApiError },
}

impl From<ApiError> for IssueReply {
    fn from(error: ApiError) -> Self {
        IssueReply::Error { error }
    }
}

impl From<ApiError> for CommentsReply {
    fn from(error: ApiError) -> Self {
        CommentsReply::Error { error }
    }
}

fn issue_path(key: &str) -> String {
    format!("/rest/api/3/issue/{key}?fields={ISSUE_FIELDS}")
}

fn comments_path(key: &str, start_at: u32) -> String {
    format!("/rest/api/3/issue/{key}/comment?startAt={start_at}&maxResults={COMMENTS_PAGE}&orderBy=-created")
}

fn refused() -> ApiError {
    ApiError::new(ErrorKind::Endpoint, "not a valid issue key")
}

fn related(host: &str, raw: &Value) -> Option<Ref> {
    let key = raw.get("key").and_then(Value::as_str)?;
    if !valid_key(key) {
        return None;
    }
    let f = raw.get("fields").unwrap_or(&Value::Null);
    Some(Ref {
        key: key.to_string(),
        summary: text(f, &["summary"]),
        status: text(f, &["status", "name"]),
        status_category: text(f, &["status", "statusCategory", "key"]),
        url: format!("https://{host}/browse/{key}"),
    })
}

/// A 200 `GET comment` body `{ startAt, total, comments: [{ author, created, body }] }`.
pub fn parse_comments(body: &[u8]) -> Result<CommentsPage, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("comments reply is not JSON: {e}"))?;
    let raw = v.get("comments").and_then(Value::as_array).ok_or("comments reply has no comments array")?;
    let items: Vec<Comment> = raw
        .iter()
        .take(MAX_ITEMS)
        .map(|c| Comment { author: text(c, &["author", "displayName"]), created: text(c, &["created"]), body: c.get("body").cloned().unwrap_or(Value::Null) })
        .collect();
    let start_at = v.get("startAt").and_then(Value::as_u64).unwrap_or(0);
    let total = v.get("total").and_then(Value::as_u64).unwrap_or(start_at + items.len() as u64);
    Ok(CommentsPage { total, start_at, items })
}

/// A 200 `GET issue` body → the detail without comments yet (`comments` is empty; `issue` fills it).
pub fn parse_issue(site: &str, body: &[u8]) -> Result<IssueDetail, String> {
    let host = super::config::site_host(site)?;
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("issue reply is not JSON: {e}"))?;
    let key = v.get("key").and_then(Value::as_str).filter(|k| valid_key(k)).ok_or("issue reply has no valid key")?;
    let f = v.get("fields").unwrap_or(&Value::Null);
    let subtasks = f.get("subtasks").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| related(host, s)).collect()).unwrap_or_default();
    Ok(IssueDetail {
        key: key.to_string(),
        url: format!("https://{host}/browse/{key}"),
        summary: text(f, &["summary"]),
        status: text(f, &["status", "name"]),
        status_category: text(f, &["status", "statusCategory", "key"]),
        kind: text(f, &["issuetype", "name"]),
        priority: text(f, &["priority", "name"]),
        updated: text(f, &["updated"]),
        assignee: text(f, &["assignee", "displayName"]),
        description: f.get("description").filter(|d| d.is_object()).cloned(),
        parent: f.get("parent").and_then(|p| related(host, p)),
        subtasks,
        comments: CommentsPage { total: 0, start_at: 0, items: Vec::new() },
    })
}

/// The issue, then its first comments page. A bad key is refused before any request.
pub fn issue(transport: &dyn Transport, site: &str, key: &str) -> Result<IssueDetail, ApiError> {
    if !valid_key(key) {
        return Err(refused());
    }
    let req = get_request(site, &issue_path(key)).map_err(|e| ApiError::new(ErrorKind::Site, e))?;
    let mut detail = map_with(transport.send(&req), |body| parse_issue(site, body))?;
    detail.comments = comments(transport, site, key, 0)?;
    Ok(detail)
}

/// One comments page from `start_at` (capped at `MAX_START_AT`), newest first.
pub fn comments(transport: &dyn Transport, site: &str, key: &str, start_at: u32) -> Result<CommentsPage, ApiError> {
    if !valid_key(key) {
        return Err(refused());
    }
    let req = get_request(site, &comments_path(key, start_at.min(MAX_START_AT))).map_err(|e| ApiError::new(ErrorKind::Site, e))?;
    map_with(transport.send(&req), parse_comments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jira::http::{Request, SendError};
    use std::cell::RefCell;

    const SITE: &str = "https://example.atlassian.net";
    const ISSUE: &str = include_str!("../../../tests/fixtures/jira/issue.json");
    const COMMENTS: &str = include_str!("../../../tests/fixtures/jira/comments.json");

    struct Stub {
        paths: RefCell<Vec<String>>,
        replies: RefCell<Vec<&'static str>>,
    }

    impl Transport for Stub {
        fn send(&self, req: &Request) -> Result<(u16, Vec<u8>), SendError> {
            self.paths.borrow_mut().push(req.path.clone());
            assert_eq!(req.method, "GET");
            let next = self.replies.borrow_mut().remove(0);
            Ok((200, next.as_bytes().to_vec()))
        }
    }

    fn stub(replies: Vec<&'static str>) -> Stub {
        Stub { paths: RefCell::new(Vec::new()), replies: RefCell::new(replies) }
    }

    #[test]
    fn issue_bad_key_refused_before_send() {
        for bad in ["../x", "ok-1", "", "ABC-0", "ABC-1/../x", "ABC-1?x=1"] {
            let t = stub(vec![ISSUE, COMMENTS]);
            assert!(issue(&t, SITE, bad).is_err(), "{bad:?}");
            assert!(comments(&t, SITE, bad, 0).is_err(), "{bad:?}");
            assert!(t.paths.borrow().is_empty(), "{bad:?} reached the transport");
        }
    }

    #[test]
    fn issue_fixture_parses_detail() {
        let t = stub(vec![ISSUE, COMMENTS]);
        let d = issue(&t, SITE, "DEMO-12").unwrap();
        assert_eq!(t.paths.borrow().len(), 2);
        assert!(t.paths.borrow()[0].starts_with("/rest/api/3/issue/DEMO-12?fields=summary,status,"));
        assert!(t.paths.borrow()[1].starts_with("/rest/api/3/issue/DEMO-12/comment?startAt=0&maxResults=20&orderBy=-created"));
        assert_eq!(d.key, "DEMO-12");
        assert_eq!(d.url, "https://example.atlassian.net/browse/DEMO-12");
        assert_eq!(d.status, "In Review");
        assert_eq!(d.status_category, "indeterminate");
        assert_eq!(d.kind, "Story");
        assert_eq!(d.assignee, "Ada Example");
        assert_eq!(d.description.as_ref().and_then(|v| v.get("type")).and_then(Value::as_str), Some("doc"));
        assert_eq!(d.parent.as_ref().map(|p| p.key.as_str()), Some("DEMO-1"));
        assert_eq!(d.subtasks.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(), ["DEMO-13"], "the sub-task with a bad key is dropped");
        assert_eq!(d.subtasks[0].status_category, "new");
        assert_eq!(d.comments.total, 3);
        assert_eq!(d.comments.items.len(), 2);
    }

    #[test]
    fn comments_page_parses() {
        let t = stub(vec![COMMENTS]);
        let page = comments(&t, SITE, "DEMO-12", 500_000).unwrap();
        assert!(t.paths.borrow()[0].contains("startAt=100000&"), "startAt is capped");
        assert_eq!(page.start_at, 0);
        assert_eq!(page.total, 3);
        assert_eq!(page.items[0].author, "Grace Example");
        assert_eq!(page.items[0].created, "2026-10-15T09:30:00.000+0000");
        assert_eq!(page.items[0].body.get("type").and_then(Value::as_str), Some("doc"));
        assert_eq!(page.items[1].author, "", "a missing author is empty; the view says Unknown");
    }
}
