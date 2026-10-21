//! The Issues tab's five commands (plan § D6). The token crosses IPC once, on Connect, straight
//! into a `Token`; no command returns it. Every request re-reads vidar.json, re-runs
//! `validate_settings` and checks the site binding (vidar.json's host equals the credential's
//! `Comment`) before any header is built, so an edited vidar.json cannot send the token to
//! another tenant. `jira_issues`, `jira_types` and `jira_projects` each get a
//! 20 s deadline past which they answer `network`.

use std::time::Duration;

use serde::Serialize;

use super::api::{self, ApiError, ErrorKind, Issue, ProjectOption, Scope, TypeOption};
use super::config::{self, JiraSettings};
use super::detail::{self, CommentsReply, IssueReply};
use super::http::{Token, Transport, WinHttpTransport};
use super::jql::{self, Filters};
use super::vault::{self, CredVault, Saved, Vault};
use crate::net::deadline::{self, Elapsed};

/// The whole `jira_issues` budget (plan § D4): WinHTTP's own timeouts cannot interrupt a blocked
/// call, so the reply is awaited against this and the worker abandoned past it.
pub const DEADLINE: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub site: Option<String>,
    pub email: Option<String>,
    pub jql: Option<String>,
    pub token_saved: bool,
}

/// `{ issues, nextPageToken }` or `{ error: { kind, message } }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum IssuesReply {
    Issues {
        issues: Vec<Issue>,
        #[serde(rename = "nextPageToken")]
        next_page_token: Option<String>,
    },
    Error { error: ApiError },
}

/// `{ types: [{ name, level }] }` or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum TypesReply {
    Types { types: Vec<TypeOption> },
    Error { error: ApiError },
}

/// `{ projects: [{ key, name }] }` or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ProjectsReply {
    Projects { projects: Vec<ProjectOption> },
    Error { error: ApiError },
}

impl From<ApiError> for TypesReply {
    fn from(error: ApiError) -> Self {
        TypesReply::Error { error }
    }
}

impl From<ApiError> for ProjectsReply {
    fn from(error: ApiError) -> Self {
        ProjectsReply::Error { error }
    }
}

impl From<ApiError> for IssuesReply {
    fn from(error: ApiError) -> Self {
        IssuesReply::Error { error }
    }
}

fn fail<T: From<ApiError>>(kind: ErrorKind, message: &str) -> T {
    ApiError::new(kind, message).into()
}

/// The site binding: the token goes only to the host it was saved for.
pub fn bound(site: Option<&str>, saved_host: &str) -> bool {
    match site.map(config::site_host) {
        Some(Ok(host)) => host == saved_host,
        _ => false,
    }
}

pub fn status_with(settings: &JiraSettings, saved: Option<&Saved>) -> Status {
    Status {
        site: settings.site.clone(),
        email: saved.map(|s| s.email.clone()),
        jql: Some(settings.jql.clone()).filter(|j| !j.trim().is_empty()),
        token_saved: saved.is_some_and(|s| bound(settings.site.as_deref(), &s.site_host)),
    }
}

/// Validates all three, then refuses unless vidar.json already names this exact site.
pub fn connect_with(settings_site: Option<&str>, site: &str, email: &str, token: Token, vault: &dyn Vault) -> Result<(), String> {
    let host = config::site_host(site)?;
    vault::validate_email(email)?;
    vault::validate_token(&token)?;
    match settings_site {
        None => Err("no Jira site is set in vidar.json".into()),
        Some(saved) if saved != site => Err("site differs from the one in vidar.json".into()),
        Some(_) => vault.write(email, host, &token),
    }
}

/// What every request needs: the site, the saved JQL, the credential's email and the token.
pub struct Connection {
    pub site: String,
    pub jql: String,
    pub email: String,
    pub token: Token,
}

/// The refusals shared by every command: `unset` when the settings fail validation, no site or
/// credential is saved, or the credential is bound to another host.
pub fn connection(settings: Result<JiraSettings, String>, vault: &dyn Vault) -> Result<Connection, ApiError> {
    let unset = |m: &str| ApiError::new(ErrorKind::Unset, m);
    let settings = settings.map_err(|e| unset(&e))?;
    let Some(site) = settings.site else { return Err(unset("no Jira site is set")) };
    let saved = match vault.read() {
        Ok(Some(saved)) => saved,
        Ok(None) => return Err(unset("no Jira token is saved")),
        Err(e) => return Err(unset(&e)),
    };
    if !bound(Some(&site), &saved.site_host) {
        return Err(unset("the saved token belongs to another site"));
    }
    Ok(Connection { site, jql: settings.jql, email: saved.email, token: saved.token })
}

/// One page of the scope's search, refused before any transport exists (see `connection`).
pub fn issues_with<F>(
    settings: Result<JiraSettings, String>,
    vault: &dyn Vault,
    transport: F,
    scope: Scope,
    filters: Option<&Filters>,
    page_token: Option<&str>,
) -> IssuesReply
where
    F: FnOnce(String, Token) -> Box<dyn Transport>,
{
    let c = match connection(settings, vault) {
        Ok(c) => c,
        Err(e) => return e.into(),
    };
    let jql = match jql::compose(scope, &c.jql, filters) {
        Ok(jql) => jql,
        Err(e) => return e.into(),
    };
    let t = transport(c.email, c.token);
    match api::search(t.as_ref(), &c.site, &jql, page_token) {
        Ok(page) => IssuesReply::Issues { issues: page.issues, next_page_token: page.next_page_token },
        Err(error) => error.into(),
    }
}

/// The issue types the user can browse, for the Type picker, with the same refusals.
pub fn types_with<F>(settings: Result<JiraSettings, String>, vault: &dyn Vault, transport: F) -> TypesReply
where
    F: FnOnce(String, Token) -> Box<dyn Transport>,
{
    let c = match connection(settings, vault) {
        Ok(c) => c,
        Err(e) => return e.into(),
    };
    let t = transport(c.email, c.token);
    match api::types(t.as_ref(), &c.site) {
        Ok(types) => TypesReply::Types { types },
        Err(error) => error.into(),
    }
}

/// The first page of projects, for the Project picker, with the same refusals.
pub fn projects_with<F>(settings: Result<JiraSettings, String>, vault: &dyn Vault, transport: F) -> ProjectsReply
where
    F: FnOnce(String, Token) -> Box<dyn Transport>,
{
    let c = match connection(settings, vault) {
        Ok(c) => c,
        Err(e) => return e.into(),
    };
    let t = transport(c.email, c.token);
    match api::projects(t.as_ref(), &c.site) {
        Ok(projects) => ProjectsReply::Projects { projects },
        Err(error) => error.into(),
    }
}

/// One issue with its first comments page, with the same refusals. Both GETs share the caller's one deadline.
pub fn issue_with<F>(settings: Result<JiraSettings, String>, vault: &dyn Vault, transport: F, key: &str) -> IssueReply
where
    F: FnOnce(String, Token) -> Box<dyn Transport>,
{
    let c = match connection(settings, vault) {
        Ok(c) => c,
        Err(e) => return e.into(),
    };
    let t = transport(c.email, c.token);
    match detail::issue(t.as_ref(), &c.site, key) {
        Ok(issue) => IssueReply::Issue { issue: Box::new(issue) },
        Err(error) => error.into(),
    }
}

/// A later comments page of one issue, with the same refusals.
pub fn comments_with<F>(settings: Result<JiraSettings, String>, vault: &dyn Vault, transport: F, key: &str, start_at: u32) -> CommentsReply
where
    F: FnOnce(String, Token) -> Box<dyn Transport>,
{
    let c = match connection(settings, vault) {
        Ok(c) => c,
        Err(e) => return e.into(),
    };
    let t = transport(c.email, c.token);
    match detail::comments(t.as_ref(), &c.site, key, start_at) {
        Ok(comments) => CommentsReply::Comments { comments },
        Err(error) => error.into(),
    }
}

/// Runs `work` on its own thread (`net::deadline`) and waits at most `deadline`; past it the
/// thread is abandoned and the reply is `network`. `name` is the thread name, `label` the word
/// in the messages ("search", "count").
pub fn with_deadline<T, F>(name: &'static str, label: &str, work: F, deadline: Duration) -> T
where
    T: From<ApiError> + Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    match deadline::with_deadline(name, deadline, work) {
        Ok(reply) => reply,
        Err(Elapsed::NoThread) => fail(ErrorKind::Network, &format!("{label} thread did not start")),
        Err(Elapsed::Timeout) => fail(ErrorKind::Network, &format!("no reply within {} s", deadline.as_secs_f64())),
        Err(Elapsed::Stopped) => fail(ErrorKind::Network, &format!("{label} stopped without a reply")),
    }
}

fn issues_now(scope: Scope, filters: Option<Filters>, page_token: Option<String>) -> IssuesReply {
    let vault = CredVault::for_install();
    issues_with(
        config::read_settings(),
        &vault,
        |email, token| Box::new(WinHttpTransport::new(email, token)),
        scope,
        filters.as_ref(),
        page_token.as_deref(),
    )
}


fn types_now() -> TypesReply {
    types_with(config::read_settings(), &CredVault::for_install(), |email, token| Box::new(WinHttpTransport::new(email, token)))
}

fn projects_now() -> ProjectsReply {
    projects_with(config::read_settings(), &CredVault::for_install(), |email, token| Box::new(WinHttpTransport::new(email, token)))
}

fn issue_now(key: &str) -> IssueReply {
    issue_with(config::read_settings(), &CredVault::for_install(), |email, token| Box::new(WinHttpTransport::new(email, token)), key)
}

fn comments_now(key: &str, start_at: u32) -> CommentsReply {
    comments_with(config::read_settings(), &CredVault::for_install(), |email, token| Box::new(WinHttpTransport::new(email, token)), key, start_at)
}

/// Degrades like `issues_with`: a bad vidar.json `jira` reads as no settings and a vault read
/// error as no credential, so the tab still reaches its Connect form instead of an error.
pub fn status_from(settings: Result<JiraSettings, String>, vault: &dyn Vault) -> Status {
    let settings = settings.unwrap_or_default();
    let saved = vault.read().ok().flatten();
    status_with(&settings, saved.as_ref())
}

#[tauri::command]
pub fn jira_status() -> Result<Status, String> {
    Ok(status_from(config::read_settings(), &CredVault::for_install()))
}

#[tauri::command]
pub fn jira_connect(site: String, email: String, token: String) -> Result<(), String> {
    let token = Token::new(token);
    let settings = config::read_settings()?;
    connect_with(settings.site.as_deref(), &site, &email, token, &CredVault::for_install())
}

#[tauri::command]
pub fn jira_disconnect() -> Result<(), String> {
    CredVault::for_install().delete()
}

#[tauri::command]
pub async fn jira_issues(scope: Scope, filters: Option<Filters>, page_token: Option<String>) -> IssuesReply {
    // The JoinError is dropped, never formatted: its text is a panic payload.
    tauri::async_runtime::spawn_blocking(move || {
        with_deadline("jira-search", "search", move || issues_now(scope, filters, page_token), DEADLINE)
    })
    .await
    .unwrap_or_else(|_| fail(ErrorKind::Network, "search task failed"))
}

#[tauri::command]
pub async fn jira_types() -> TypesReply {
    tauri::async_runtime::spawn_blocking(move || with_deadline("jira-types", "types", types_now, DEADLINE))
        .await
        .unwrap_or_else(|_| fail(ErrorKind::Network, "types task failed"))
}

#[tauri::command]
pub async fn jira_projects() -> ProjectsReply {
    tauri::async_runtime::spawn_blocking(move || with_deadline("jira-projects", "projects", projects_now, DEADLINE))
        .await
        .unwrap_or_else(|_| fail(ErrorKind::Network, "projects task failed"))
}

#[tauri::command]
pub async fn jira_issue(key: String) -> IssueReply {
    tauri::async_runtime::spawn_blocking(move || with_deadline("jira-issue", "issue", move || issue_now(&key), DEADLINE))
        .await
        .unwrap_or_else(|_| fail(ErrorKind::Network, "issue task failed"))
}

#[tauri::command]
pub async fn jira_comments(key: String, start_at: u32) -> CommentsReply {
    tauri::async_runtime::spawn_blocking(move || {
        with_deadline("jira-comments", "comments", move || comments_now(&key, start_at.min(detail::MAX_START_AT)), DEADLINE)
    })
    .await
    .unwrap_or_else(|_| fail(ErrorKind::Network, "comments task failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jira::http::Request;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    const SITE: &str = "https://example.atlassian.net";
    const HOST: &str = "example.atlassian.net";
    const SECRET: &str = "ATATT3xFixtureTokenDoNotLog0123456789";
    const EMPTY: &str = include_str!("../../../tests/fixtures/jira/search-jql-empty.json");

    #[derive(Default)]
    struct MemVault {
        saved: RefCell<Option<(String, String, String)>>,
        fail_read: bool,
    }

    impl MemVault {
        fn with(email: &str, host: &str) -> Self {
            MemVault { saved: RefCell::new(Some((email.into(), host.into(), SECRET.into()))), fail_read: false }
        }
    }

    impl Vault for MemVault {
        fn read(&self) -> Result<Option<Saved>, String> {
            if self.fail_read {
                return Err("CredReadW failed (5)".into());
            }
            Ok(self.saved.borrow().as_ref().map(|(e, h, t)| Saved { email: e.clone(), site_host: h.clone(), token: Token::new(t.clone()) }))
        }
        fn write(&self, email: &str, site_host: &str, token: &Token) -> Result<(), String> {
            *self.saved.borrow_mut() = Some((email.into(), site_host.into(), token.expose().into()));
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.saved.borrow_mut() = None;
            Ok(())
        }
    }

    /// Counts sends; answers 200 with the empty fixture after `sleep`.
    struct Stub {
        sends: Arc<AtomicUsize>,
        sleep: Duration,
    }

    impl Transport for Stub {
        fn send(&self, _req: &Request) -> Result<(u16, Vec<u8>), crate::jira::http::SendError> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.sleep);
            Ok((200, EMPTY.as_bytes().to_vec()))
        }
    }

    fn stub(sends: &Arc<AtomicUsize>, sleep: Duration) -> impl FnOnce(String, Token) -> Box<dyn Transport> {
        let sends = sends.clone();
        move |_, _| Box::new(Stub { sends, sleep })
    }

    fn settings(site: &str) -> Result<JiraSettings, String> {
        config::settings_from_root(&serde_json::json!({ "jira": { "site": site, "jql": "project = DEMO" } }))
    }

    fn kind(reply: &IssuesReply) -> Option<ErrorKind> {
        match reply {
            IssuesReply::Error { error } => Some(error.kind),
            IssuesReply::Issues { .. } => None,
        }
    }

    #[test]
    fn site_outside_atlassian_net_is_refused() {
        // Request path: a hand-edited bad site never reaches a transport, even with a credential
        // bound to that very host.
        for bad in ["https://evil.example", "https://example.atlassian.net.evil.com", "https://Example.atlassian.net", "https://example.atlassian.net:8443", "https://u@example.atlassian.net"] {
            let sends = Arc::new(AtomicUsize::new(0));
            let host = bad.trim_start_matches("https://");
            let reply = issues_with(settings(bad), &MemVault::with("dev@example.com", host), stub(&sends, Duration::ZERO), Scope::Mine, None, None);
            assert_eq!(kind(&reply), Some(ErrorKind::Unset), "{bad}");
            assert_eq!(sends.load(Ordering::SeqCst), 0, "{bad}");
            let v = MemVault::default();
            assert!(connect_with(Some(bad), bad, "dev@example.com", Token::new(SECRET.into()), &v).is_err(), "{bad}");
            assert!(v.saved.borrow().is_none());
        }
        let sends = Arc::new(AtomicUsize::new(0));
        let reply = issues_with(settings(SITE), &MemVault::with("dev@example.com", HOST), stub(&sends, Duration::ZERO), Scope::Mine, None, None);
        assert_eq!(reply, IssuesReply::Issues { issues: vec![], next_page_token: None });
        assert_eq!(sends.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn request_refused_when_site_differs_from_credential() {
        assert!(bound(Some(SITE), HOST));
        assert!(!bound(Some(SITE), "other.atlassian.net"));
        assert!(!bound(Some(SITE), ""));
        assert!(!bound(None, HOST));
        assert!(!bound(Some("https://evil.example"), "evil.example"));

        let sends = Arc::new(AtomicUsize::new(0));
        let other = MemVault::with("dev@example.com", "other.atlassian.net");
        let reply = issues_with(settings(SITE), &other, stub(&sends, Duration::ZERO), Scope::Mine, None, None);
        assert_eq!(kind(&reply), Some(ErrorKind::Unset));
        for (s, v) in [
            (Ok(JiraSettings::default()), MemVault::with("dev@example.com", HOST)),
            (settings(SITE), MemVault::default()),
            (settings(SITE), MemVault { fail_read: true, ..MemVault::default() }),
        ] {
            assert_eq!(kind(&issues_with(s, &v, stub(&sends, Duration::ZERO), Scope::Mine, None, None)), Some(ErrorKind::Unset));
        }
        assert_eq!(sends.load(Ordering::SeqCst), 0);
        let json = serde_json::to_value(&reply).unwrap();
        assert_eq!(json["error"]["kind"], "unset");
    }

    #[test]
    fn connect_refused_when_site_differs_from_settings() {
        let v = MemVault::default();
        let token = || Token::new(SECRET.into());
        assert!(connect_with(None, SITE, "dev@example.com", token(), &v).is_err());
        assert!(connect_with(Some("https://other.atlassian.net"), SITE, "dev@example.com", token(), &v).is_err());
        assert!(connect_with(Some(SITE), SITE, "dev", token(), &v).is_err());
        assert!(connect_with(Some(SITE), SITE, "dev@example.com", Token::new("a b".into()), &v).is_err());
        assert!(v.saved.borrow().is_none());
        for err in [
            connect_with(None, SITE, "dev@example.com", token(), &v).unwrap_err(),
            connect_with(Some(SITE), SITE, "dev@example.com", Token::new(format!("{SECRET} x")), &v).unwrap_err(),
        ] {
            assert!(!err.contains(SECRET), "{err}");
        }
        connect_with(Some(SITE), SITE, "dev@example.com", token(), &v).unwrap();
        assert_eq!(*v.saved.borrow(), Some(("dev@example.com".into(), HOST.into(), SECRET.into())));
    }

    #[test]
    fn issues_past_deadline_return_network() {
        let sends = Arc::new(AtomicUsize::new(0));
        let slow = sends.clone();
        let started = Instant::now();
        let reply = with_deadline(
            "jira-test", "search",
            move || issues_with(settings(SITE), &MemVault::with("dev@example.com", HOST), stub(&slow, Duration::from_secs(5)), Scope::Mine, None, None),
            Duration::from_millis(200),
        );
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        assert_eq!(kind(&reply), Some(ErrorKind::Network));
        let IssuesReply::Error { error } = &reply else { unreachable!() };
        assert_eq!(error.message, "no reply within 0.2 s");
        let fast = sends.clone();
        let reply = with_deadline(
            "jira-test", "search",
            move || issues_with(settings(SITE), &MemVault::with("dev@example.com", HOST), stub(&fast, Duration::ZERO), Scope::Mine, None, None),
            Duration::from_secs(5),
        );
        assert_eq!(reply, IssuesReply::Issues { issues: vec![], next_page_token: None });
        assert_eq!(kind(&with_deadline::<IssuesReply, _>("jira-test", "search", || panic!("worker died"), Duration::from_secs(5))), Some(ErrorKind::Network));
        assert_eq!(DEADLINE, Duration::from_secs(20));
    }

    #[test]
    fn issues_reply_serialises_the_page_token() {
        let none = IssuesReply::Issues { issues: vec![], next_page_token: None };
        assert_eq!(serde_json::to_value(&none).unwrap(), serde_json::json!({ "issues": [], "nextPageToken": null }));
        let some = IssuesReply::Issues { issues: vec![], next_page_token: Some("t".into()) };
        assert_eq!(serde_json::to_value(&some).unwrap(), serde_json::json!({ "issues": [], "nextPageToken": "t" }));
    }

    /// Records the JQL of every request body.
    struct Recorder {
        jql: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl Transport for Recorder {
        fn send(&self, req: &Request) -> Result<(u16, Vec<u8>), crate::jira::http::SendError> {
            let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            self.jql.lock().unwrap().push(body["jql"].as_str().unwrap().to_string());
            Ok((200, EMPTY.to_string().into_bytes()))
        }
    }

    fn recorder(jql: &Arc<std::sync::Mutex<Vec<String>>>) -> impl FnOnce(String, Token) -> Box<dyn Transport> {
        let jql = jql.clone();
        move |_, _| Box::new(Recorder { jql })
    }

    #[test]
    fn scope_decides_the_jql_sent() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let vault = MemVault::with("dev@example.com", HOST);
        let all = "statusCategory != Done ORDER BY updated DESC";
        issues_with(settings(SITE), &vault, recorder(&seen), Scope::All, None, None);
        issues_with(settings(SITE), &vault, recorder(&seen), Scope::Mine, None, None);
        assert_eq!(*seen.lock().unwrap(), vec![all.to_string(), "project = DEMO".to_string()]);
    }

    #[test]
    fn types_and_projects_refused_when_unset() {
        let sends = Arc::new(AtomicUsize::new(0));
        for (s, v) in [
            (Ok(JiraSettings::default()), MemVault::with("dev@example.com", HOST)),
            (settings(SITE), MemVault::default()),
            (settings(SITE), MemVault::with("dev@example.com", "other.atlassian.net")),
            (settings(SITE), MemVault { fail_read: true, ..MemVault::default() }),
        ] {
            let t = types_with(s.clone(), &v, stub(&sends, Duration::ZERO));
            let TypesReply::Error { error } = &t else { panic!("{t:?}") };
            assert_eq!(error.kind, ErrorKind::Unset);
            assert_eq!(serde_json::to_value(&t).unwrap()["error"]["kind"], "unset");
            let p = projects_with(s, &v, stub(&sends, Duration::ZERO));
            let ProjectsReply::Error { error } = &p else { panic!("{p:?}") };
            assert_eq!(error.kind, ErrorKind::Unset);
        }
        assert_eq!(sends.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn filters_reach_the_jql_sent_and_caps_refuse() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let vault = MemVault::with("dev@example.com", HOST);
        let f = Filters { projects: vec!["DEMO".into()], types: vec![], categories: vec![3], assignee: jql::AssigneeFilter::Any, text: String::new() };
        issues_with(settings(SITE), &vault, recorder(&seen), Scope::All, Some(&f), None);
        let want = "statusCategory in (3) AND project in (\"DEMO\") ORDER BY updated DESC".to_string();
        assert_eq!(*seen.lock().unwrap(), vec![want]);
        let over = Filters { text: "x".repeat(201), ..f };
        let sends = Arc::new(AtomicUsize::new(0));
        let reply = issues_with(settings(SITE), &vault, stub(&sends, Duration::ZERO), Scope::All, Some(&over), None);
        assert_eq!(kind(&reply), Some(ErrorKind::Jql));
        assert_eq!(sends.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn status_never_serialises_a_token() {
        let s = settings(SITE).unwrap();
        let v = MemVault::with("dev@example.com", HOST);
        let saved = v.read().unwrap();
        let status = status_with(&s, saved.as_ref());
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "site": SITE, "email": "dev@example.com", "jql": "project = DEMO", "tokenSaved": true })
        );
        assert!(!serde_json::to_string(&status).unwrap().contains(SECRET));
        assert!(!format!("{status:?} {saved:?}").contains(SECRET));

        let other = MemVault::with("dev@example.com", "other.atlassian.net").read().unwrap();
        assert!(!status_with(&s, other.as_ref()).token_saved);
        let none = status_with(&JiraSettings::default(), None);
        assert_eq!(serde_json::to_value(&none).unwrap(), serde_json::json!({ "site": null, "email": null, "jql": null, "tokenSaved": false }));
    }

    #[test]
    fn status_degrades_to_unset_on_a_bad_config_or_vault_error() {
        // Orion b9b1-r1: jira_status answered Err where jira_issues degrades to unset. Both now
        // give a Status with tokenSaved false, which is the state that shows the Connect form.
        let bad = config::settings_from_root(&serde_json::json!({ "jira": { "site": "https://evil.example", "jql": "x" } }));
        assert!(bad.is_err());
        let bad_shape = config::settings_from_root(&serde_json::json!({ "jira": 7 }));
        assert!(bad_shape.is_err());
        for s in [bad, bad_shape] {
            let status = status_from(s, &MemVault::with("dev@example.com", HOST));
            assert!(!status.token_saved);
            assert_eq!(status.site, None);
            let json = serde_json::to_string(&status).unwrap();
            assert!(!json.contains(SECRET), "{json}");
            assert!(json.contains(r#""tokenSaved":false"#), "{json}");
        }

        let status = status_from(settings(SITE), &MemVault { fail_read: true, ..MemVault::default() });
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({ "site": SITE, "email": null, "jql": "project = DEMO", "tokenSaved": false })
        );

        let ok = status_from(settings(SITE), &MemVault::with("dev@example.com", HOST));
        assert!(ok.token_saved);
    }
}
