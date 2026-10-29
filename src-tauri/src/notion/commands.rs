//! The Notion tab's eight commands. Order inside each: credential read (absent →
//! `unset`, no send), argument checks (bad → `endpoint`, no send), pacer turn, send. Each network
//! command runs on a blocking task under a 20 s `with_deadline`; no command returns the token.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::api::{self, endpoint, ApiError, ErrorKind};
use super::pace::{self, Pacer};
use super::parse::{self, Hit, Me, Page, Row, Source};
use super::transport::{Live, Transport};
use super::vault;
use crate::credman::Store;
use crate::net::{self, Limits, Request, Secret};

/// The whole budget of one command.
pub const DEADLINE: Duration = Duration::from_secs(20);

/// The connect generation: each connect takes a new one at its start and Disconnect bumps it, so
/// a connect that outlived its reply (or was overtaken) never saves.
pub static GENERATION: AtomicU64 = AtomicU64::new(0);

/// `T` or `{ error: { kind, message, retryAfter? } }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Answer<T> {
    Ok(T),
    Error { error: ApiError },
}

impl<T> From<Result<T, ApiError>> for Answer<T> {
    fn from(r: Result<T, ApiError>) -> Self {
        match r {
            Ok(v) => Answer::Ok(v),
            Err(error) => Answer::Error { error },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub token_saved: bool,
    pub workspace: Option<String>,
    pub kind: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hits {
    pub hits: Vec<Hit>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceOut {
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rows {
    pub rows: Vec<Row>,
    pub next: Option<String>,
    pub props_refused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageOut {
    pub page: Page,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocks {
    pub blocks: Vec<Value>,
    pub next: Option<String>,
}

/// What one command needs: the store, the pacer, the transport, the connect generation (live:
/// `GENERATION`) and when the command started, on the pacer's clock.
pub struct Ctx<'a> {
    pub store: &'a dyn Store,
    pub pacer: &'a Pacer,
    pub net: &'a dyn Transport,
    pub generation: &'a AtomicU64,
    pub started: Instant,
}

fn limits(cap: usize) -> Limits {
    Limits { cap, body_deadline: DEADLINE }
}

/// What is left of DEADLINE since the command started.
fn remaining(c: &Ctx) -> Duration {
    DEADLINE.saturating_sub(c.pacer.now().saturating_duration_since(c.started))
}

/// Step 1: the saved token, or `unset`. A read error also reads as `unset`; its text carries
/// codes only. A saved blob that fails the token rules (CR/LF would split a header) is never sent.
fn token(store: &dyn Store) -> Result<Secret, ApiError> {
    match store.read() {
        Ok(Some(c)) if vault::validate_token(&c.blob).is_ok() => Ok(c.blob),
        Ok(Some(_)) => Err(ApiError::new(ErrorKind::Unset, "saved Notion token is not valid; connect again")),
        Ok(None) => Err(ApiError::new(ErrorKind::Unset, "no Notion token is saved")),
        Err(e) => Err(ApiError::new(ErrorKind::Unset, api::clean_message(&e))),
    }
}

/// Never let the token reach a message, whatever a remote body echoes.
fn redact(mut e: ApiError, token: &Secret) -> ApiError {
    let t = token.expose();
    if !t.is_empty() && e.message.contains(t) {
        e.message = e.message.replace(t, "***");
    }
    e
}

/// One raw exchange: pacer turn, then send. Starts the hold a 429/529 asks for.
fn exchange(c: &Ctx, token: &Secret, req: &Request, cap: usize) -> Result<net::Reply, ApiError> {
    if let Err(left) = c.pacer.turn(remaining(c)) {
        return Err(ApiError::new(ErrorKind::Rate, format!("rate limited, try again in {left} s")).after(Some(left)));
    }
    let headers = api::headers(token, req.method);
    c.net.send(req, &headers, limits(cap)).map_err(|e| redact(api::send_error(&e, token), token))
}

/// Steps 3-4 and the status mapping.
fn call(c: &Ctx, token: &Secret, req: &Request, cap: usize) -> Result<Value, ApiError> {
    let reply = exchange(c, token, req, cap)?;
    settle(c, token, reply)
}

fn settle(c: &Ctx, token: &Secret, reply: net::Reply) -> Result<Value, ApiError> {
    let out = api::classify(reply.status, reply.retry_after, &reply.body, token);
    let mut result = out.result;
    if let Some(wait) = out.hold {
        let held = c.pacer.hold(wait.unwrap_or(pace::HOLD_MIN_SECS));
        if let Err(e) = &mut result {
            e.retry_after = Some(held);
        }
    }
    result.map_err(|e| redact(e, token))
}

pub fn status_with(store: &dyn Store) -> Status {
    match store.read() {
        Ok(Some(c)) => Status {
            token_saved: true,
            workspace: Some(c.comment).filter(|w| !w.is_empty()),
            kind: vault::saved_kind(&c.user),
        },
        _ => Status { token_saved: false, workspace: None, kind: None },
    }
}

/// Validates the token, clears the hold, checks it with `GET /v1/users/me`, saves only on 200
/// and only while no Disconnect or newer connect has moved the generation.
pub fn connect_with(c: &Ctx, token: Secret) -> Result<Me, ApiError> {
    vault::validate_token(&token).map_err(endpoint)?;
    let mine = c.generation.fetch_add(1, Ordering::SeqCst) + 1;
    c.pacer.clear();
    let body = call(c, &token, &api::users_me(), api::CAP_ME)?;
    let me = parse::me(&body);
    if c.generation.load(Ordering::SeqCst) != mine {
        return Err(endpoint("connect was superseded"));
    }
    vault::save(c.store, token, me.kind, me.workspace.as_deref().unwrap_or(""))
        .map_err(|e| endpoint(api::clean_message(&e)))?;
    Ok(me)
}

pub fn disconnect_with(store: &dyn Store, pacer: &Pacer, generation: &AtomicU64) -> Result<(), String> {
    generation.fetch_add(1, Ordering::SeqCst);
    pacer.clear();
    store.delete()
}

pub fn search_with(c: &Ctx, kind: &str, cursor: Option<&str>) -> Result<Hits, ApiError> {
    let token = token(c.store)?;
    let object = api::check_kind(kind)?;
    let cursor = api::check_cursor(cursor)?;
    let body = call(c, &token, &api::search(object, cursor.as_deref()), api::CAP_LIST)?;
    Ok(Hits { hits: parse::hits(&body, object), next: parse::next(&body) })
}

pub fn source_with(c: &Ctx, id: &str) -> Result<SourceOut, ApiError> {
    let token = token(c.store)?;
    let id = api::check_id(id)?;
    let body = call(c, &token, &api::source(&id), api::CAP_LIST)?;
    let source = parse::source(&body).ok_or_else(|| ApiError::new(ErrorKind::Parse, "data source has no valid id"))?;
    Ok(SourceOut { source })
}

/// The one retry (delta S1): a 400 `validation_error` while `filter_properties` were sent is
/// sent again without them, and the reply says so.
pub fn query_with(c: &Ctx, id: &str, cursor: Option<&str>, props: &[String]) -> Result<Rows, ApiError> {
    let token = token(c.store)?;
    let id = api::check_id(id)?;
    let cursor = api::check_cursor(cursor)?;
    let props = api::check_props(props)?;
    let first = exchange(c, &token, &api::query(&id, cursor.as_deref(), &props), api::CAP_LIST)?;
    let (reply, props_refused) = if !props.is_empty() && api::is_validation_error(first.status, &first.body) {
        (exchange(c, &token, &api::query(&id, cursor.as_deref(), &[]), api::CAP_LIST)?, true)
    } else {
        (first, false)
    };
    let body = settle(c, &token, reply)?;
    Ok(Rows { rows: parse::rows(&body), next: parse::next(&body), props_refused })
}

pub fn page_with(c: &Ctx, id: &str) -> Result<PageOut, ApiError> {
    let token = token(c.store)?;
    let id = api::check_id(id)?;
    let body = call(c, &token, &api::page(&id), api::CAP_ITEM)?;
    let page = parse::page(&body).ok_or_else(|| ApiError::new(ErrorKind::Parse, "page has no valid id"))?;
    Ok(PageOut { page })
}

pub fn blocks_with(c: &Ctx, id: &str, cursor: Option<&str>) -> Result<Blocks, ApiError> {
    let token = token(c.store)?;
    let id = api::check_id(id)?;
    let cursor = api::check_cursor(cursor)?;
    let body = call(c, &token, &api::blocks(&id, cursor.as_deref()), api::CAP_ITEM)?;
    Ok(Blocks { blocks: parse::blocks(&body), next: parse::next(&body) })
}

fn network(message: &str) -> ApiError {
    ApiError::new(ErrorKind::Network, message)
}

/// Runs `work` with the live store, pacer and transport on a blocking task, under DEADLINE.
async fn run<T, F>(name: &'static str, work: F) -> Answer<T>
where
    T: Send + 'static,
    F: FnOnce(&Ctx) -> Result<T, ApiError> + Send + 'static,
{
    let started = Instant::now();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        net::with_deadline(name, DEADLINE, move || {
            let store = vault::store();
            let ctx = Ctx { store: &store, pacer: pace::shared(), net: &Live, generation: &GENERATION, started };
            work(&ctx)
        })
    })
    .await;
    // The JoinError is dropped, never formatted: its text is a panic payload.
    match joined {
        Ok(Ok(result)) => result.into(),
        Ok(Err(net::Elapsed::Timeout)) => Answer::Error { error: network("no reply within 20 s") },
        Ok(Err(_)) => Answer::Error { error: network("request stopped without a reply") },
        Err(_) => Answer::Error { error: network("request task failed") },
    }
}

#[tauri::command]
pub fn notion_status() -> Status {
    status_with(&vault::store())
}

#[tauri::command]
pub async fn notion_connect(token: String) -> Answer<Me> {
    let token = Secret::new(token);
    let answer = run("notion-connect", move |c| connect_with(c, token)).await;
    // A connect the UI saw fail (a timeout included) must never save later.
    if matches!(answer, Answer::Error { .. }) {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    answer
}

#[tauri::command]
pub fn notion_disconnect() -> Result<(), String> {
    disconnect_with(&vault::store(), pace::shared(), &GENERATION)
}

#[tauri::command]
pub async fn notion_search(kind: String, cursor: Option<String>) -> Answer<Hits> {
    run("notion-search", move |c| search_with(c, &kind, cursor.as_deref())).await
}

#[tauri::command]
pub async fn notion_source(id: String) -> Answer<SourceOut> {
    run("notion-source", move |c| source_with(c, &id)).await
}

#[tauri::command]
pub async fn notion_query(id: String, cursor: Option<String>, props: Vec<String>) -> Answer<Rows> {
    run("notion-query", move |c| query_with(c, &id, cursor.as_deref(), &props)).await
}

#[tauri::command]
pub async fn notion_page(id: String) -> Answer<PageOut> {
    run("notion-page", move |c| page_with(c, &id)).await
}

#[tauri::command]
pub async fn notion_blocks(id: String, cursor: Option<String>) -> Answer<Blocks> {
    run("notion-blocks", move |c| blocks_with(c, &id, cursor.as_deref())).await
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
