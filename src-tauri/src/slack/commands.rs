//! The Slack tab's four commands (docs/projects/slack/inbox-tab-plan.md § Rust, § IPC): status, connect,
//! disconnect, inbox. Network commands run on a blocking task under a 20 s deadline; no command
//! returns the token.
//!
//! One `Mutex<State>` guards the connect generation, the name cache and every credential write or
//! delete, so check-then-write is atomic against Disconnect. It is never held across a send. A deadline
//! expiry bumps the generation, so abandoned connect work can never save.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use super::api::{self, endpoint, ApiError, Class, ErrorKind};
use super::hold::{self, Hold};
use super::names::{self, Key, NameCache};
use super::parse::{self, host_ok, Merged};
use super::vault::{self, team_ok, LoadError};
use crate::credman::Store;
use crate::net::{self, Limits, Reply, Request, Secret, SendError};

/// The whole budget of one command.
pub const DEADLINE: Duration = Duration::from_secs(20);
/// Fetches closer together than this return the last result (one refresh is up to 4 searches).
pub const SPACING: Duration = Duration::from_secs(30);

/// The send seam: `Live` is `net::send`; tests answer from a closure.
pub trait Transport: Send + Sync {
    fn send(&self, req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError>;
}

pub struct Live;

impl Transport for Live {
    fn send(&self, req: &Request, headers: &Secret, limits: Limits) -> Result<Reply, SendError> {
        net::send(req, headers, limits)
    }
}

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
    pub host: Option<String>,
    pub token_saved: bool,
    /// Set only when the credential store could not be read, so the view can tell that from Not Connected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Connected {
    pub host: String,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn network(message: &str) -> ApiError {
    ApiError::new(ErrorKind::Network, message)
}

fn unset(message: impl Into<String>) -> ApiError {
    ApiError::new(ErrorKind::Unset, message)
}

/// What is left of a command's time.
pub struct Budget {
    pub started: Instant,
    pub total: Duration,
}

impl Budget {
    pub fn new(total: Duration) -> Self {
        Budget { started: Instant::now(), total }
    }

    pub fn remaining(&self) -> Duration {
        self.total.saturating_sub(self.started.elapsed())
    }
}

struct State {
    generation: u64,
    names: NameCache,
}

/// The last good result; errors are never kept for the spacing window.
struct Cached {
    at: Instant,
    result: Merged,
}

#[derive(Default)]
struct Flight {
    running: bool,
    /// Sequence number of the latest flight started.
    seq: u64,
    last: Option<Cached>,
    /// The latest finished flight and its result, for the calls that joined it (and only those).
    done: Option<(u64, Result<Merged, ApiError>)>,
}

/// Everything the commands share: the lock, the rate hold and the single-flight slot.
pub struct Core {
    state: Mutex<State>,
    hold: Hold,
    flight: Mutex<Flight>,
    flight_done: Condvar,
}

/// Releases the single-flight slot and wakes joiners, even if the fetch panics.
struct FlightGuard<'a>(&'a Core);

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        lock(&self.0.flight).running = false;
        self.0.flight_done.notify_all();
    }
}

impl Default for Core {
    fn default() -> Self {
        Core::new()
    }
}

impl Core {
    pub fn new() -> Self {
        Core {
            state: Mutex::new(State { generation: 0, names: NameCache::new() }),
            hold: Hold::new(),
            flight: Mutex::new(Flight::default()),
            flight_done: Condvar::new(),
        }
    }

    fn generation(&self) -> u64 {
        lock(&self.state).generation
    }

    /// A deadline expired on a connect: nothing it still holds may save.
    fn abandon(&self) {
        lock(&self.state).generation += 1;
    }

    fn forget_last(&self) {
        lock(&self.flight).last = None;
    }

    /// One send, behind the hold and the time budget; a rate answer starts the hold.
    fn exchange(&self, net: &dyn Transport, token: &Secret, req: &Request, cap: usize, budget: &Budget) -> Result<Value, ApiError> {
        if let Some(left) = self.hold.held_for(Instant::now()) {
            let mut e = ApiError::new(ErrorKind::Rate, api::RATE_MESSAGE);
            e.retry_after = Some(left);
            return Err(e);
        }
        let left = budget.remaining();
        if left.is_zero() {
            return Err(network("no reply within 20 s"));
        }
        let reply = net
            .send(req, &api::headers(token), Limits { cap, body_deadline: left })
            .map_err(|e| api::send_error(&e, token))?;
        api::classify(reply.status, reply.retry_after, &reply.body, token).map_err(|mut e| {
            if e.kind == ErrorKind::Rate {
                e.retry_after = Some(self.hold.set(Instant::now(), e.retry_after.unwrap_or(hold::HOLD_DEFAULT_SECS)));
            }
            e
        })
    }

    /// Validates the token, takes a new generation (clearing names), checks it with `auth.test`, and
    /// saves only while the generation is still the one it took and the budget has time left. A save
    /// clears the hold and bumps the generation again, so inbox results fetched meanwhile are dropped.
    pub fn connect_with(&self, store: &dyn Store, net: &dyn Transport, token: Secret, budget: &Budget) -> Result<Connected, ApiError> {
        vault::validate_token(&token).map_err(endpoint)?;
        let mine = {
            let mut s = lock(&self.state);
            s.generation += 1;
            s.names.clear();
            s.generation
        };
        self.forget_last();
        let body = self.exchange(net, &token, &api::auth_test(), api::CAP_AUTH, budget)?;
        let (user, team, host) = auth_fields(&body)?;
        let mut s = lock(&self.state);
        if s.generation != mine {
            return Err(endpoint("connect was superseded"));
        }
        if budget.remaining().is_zero() {
            return Err(network("no reply within 20 s"));
        }
        vault::save(store, &token, &user, &team, &host).map_err(|e| endpoint(api::clean_redacted(&e, &token)))?;
        s.generation += 1;
        s.names.clear();
        self.hold.clear();
        drop(s);
        self.forget_last();
        Ok(Connected { host })
    }

    /// Bumps the generation, clears hold, names and the last result, and deletes the credential.
    pub fn disconnect(&self, store: &dyn Store) -> Result<(), String> {
        let result = {
            let mut s = lock(&self.state);
            s.generation += 1;
            s.names.clear();
            self.hold.clear();
            store.delete()
        };
        self.forget_last();
        result
    }

    /// Single flight: a call while a fetch runs waits for it and returns its result, whatever it is; a
    /// call within `SPACING` of the last good fetch (`now` is when the call started) returns that
    /// result. An error is only ever returned to the calls that joined the flight that produced it.
    pub fn inbox(&self, store: &dyn Store, net: &dyn Transport, now: Instant, budget: &Budget) -> Result<Merged, ApiError> {
        let mut f = lock(&self.flight);
        let mut joined: Option<u64> = None;
        let mine = loop {
            if let (Some(j), Some((seq, r))) = (joined, &f.done) {
                if *seq == j {
                    return r.clone();
                }
            }
            if joined.is_some_and(|j| j != f.seq) {
                joined = None;
            }
            if f.running {
                joined.get_or_insert(f.seq);
                let left = budget.remaining();
                if left.is_zero() {
                    return Err(network("no reply within 20 s"));
                }
                f = self.flight_done.wait_timeout(f, left).unwrap_or_else(|e| e.into_inner()).0;
                continue;
            }
            if let Some(c) = &f.last {
                if now.saturating_duration_since(c.at) < SPACING {
                    return Ok(c.result.clone());
                }
            }
            f.seq += 1;
            f.running = true;
            break f.seq;
        };
        drop(f);
        let guard = FlightGuard(self);
        let generation = self.generation();
        let result = self.fetch_inbox(store, net, budget);
        {
            let mut f = lock(&self.flight);
            f.last = match &result {
                Ok(m) if self.generation() == generation => Some(Cached { at: now, result: m.clone() }),
                _ => None,
            };
            f.done = Some((mine, result.clone()));
        }
        drop(guard);
        result
    }

    /// Credential, searches, names, merge. The lock is taken three times and never held across a send.
    fn fetch_inbox(&self, store: &dyn Store, net: &dyn Transport, budget: &Budget) -> Result<Merged, ApiError> {
        let saved = match vault::load(store) {
            Ok(Some(s)) => s,
            Ok(None) => return Err(unset("no Slack token is saved")),
            Err(LoadError::Read(e)) => return Err(endpoint(e)),
            Err(LoadError::Invalid(e)) => return Err(unset(e)),
        };
        let key = {
            let mut s = lock(&self.state);
            let key = Key { team: saved.team.clone(), user: saved.user.clone(), generation: s.generation };
            s.names.rekey(key.clone());
            key
        };
        let sources = api::sources(&saved.user, unix_now()).ok_or_else(|| endpoint("saved user id is not valid"))?;
        let mut found = Vec::new();
        let mut capped = false;
        for source in &sources {
            let f = api::search(source, |req, cap| self.exchange(net, &saved.token, req, cap, budget))?;
            capped |= f.capped;
            found.push((source.class(), f));
        }
        let all: Vec<Value> = found.iter().flat_map(|(_, f)| f.matches.iter().cloned()).collect();
        let ids = parse::user_ids(&all);
        let todo = lock(&self.state).names.missing(&key, &ids, names::LOOKUPS);
        let mut fetched = Vec::new();
        for id in &todo {
            let Some(req) = api::users_info(id) else { continue };
            match self.exchange(net, &saved.token, &req, api::CAP_USER, budget) {
                Ok(body) => fetched.extend(names::name_from_user_info(&body).map(|n| (id.clone(), n))),
                Err(e) if e.kind == ErrorKind::Rate => break,
                Err(_) => {}
            }
        }
        let (known, current) = {
            let mut s = lock(&self.state);
            if s.generation == key.generation {
                for (id, name) in &fetched {
                    s.names.put(&key, id, name);
                }
            }
            let known: HashMap<String, String> =
                ids.iter().filter_map(|id| s.names.get(&key, id).map(|n| (id.clone(), n))).collect();
            (known, s.generation == key.generation)
        };
        if !current {
            return Err(endpoint("connection changed, try again"));
        }
        let lookup = |id: &str| known.get(id).cloned();
        let (mut direct, mut broadcast) = (Vec::new(), Vec::new());
        for (class, f) in &found {
            let rows = parse::parse_matches(&f.matches, *class, &saved.host, &lookup);
            if *class == Class::Broadcast {
                broadcast.extend(rows);
            } else {
                direct.extend(rows);
            }
        }
        Ok(parse::merge(direct, broadcast, &saved.user, capped))
    }
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// `(user_id, team_id, host)` from an `auth.test` body, each checked.
fn auth_fields(body: &Value) -> Result<(String, String, String), ApiError> {
    let field = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or("");
    let host = field("url").strip_prefix("https://").map(|h| h.trim_end_matches('/')).unwrap_or("");
    if !api::user_id_ok(field("user_id")) || !team_ok(field("team_id")) || !host_ok(host) {
        return Err(endpoint("auth.test did not return a workspace this build can use"));
    }
    Ok((field("user_id").to_string(), field("team_id").to_string(), host.to_string()))
}

pub fn status_with(store: &dyn Store) -> Status {
    match vault::load(store) {
        Ok(Some(s)) => Status { host: Some(s.host), token_saved: true, error: None },
        Err(LoadError::Read(e)) => Status { host: None, token_saved: false, error: Some(endpoint(e)) },
        _ => Status { host: None, token_saved: false, error: None },
    }
}

fn elapsed_error(e: net::Elapsed) -> ApiError {
    match e {
        net::Elapsed::Timeout => network("no reply within 20 s"),
        _ => network("request stopped without a reply"),
    }
}

/// Connect on its own thread under `deadline`; an expiry bumps the generation so the abandoned work
/// can never save.
pub fn connect_deadline(
    core: Arc<Core>,
    store: Arc<dyn Store + Send + Sync>,
    net: Arc<dyn Transport>,
    token: Secret,
    deadline: Duration,
) -> Answer<Connected> {
    let worker = core.clone();
    let budget = Budget::new(deadline);
    let done = net::with_deadline("slack-connect", deadline, move || worker.connect_with(&*store, &*net, token, &budget));
    match done {
        Ok(result) => result.into(),
        Err(e) => {
            core.abandon();
            Answer::Error { error: elapsed_error(e) }
        }
    }
}

fn inbox_deadline(core: Arc<Core>, store: Arc<dyn Store + Send + Sync>, net: Arc<dyn Transport>, deadline: Duration) -> Answer<Merged> {
    let budget = Budget::new(deadline);
    let now = budget.started;
    match net::with_deadline("slack-inbox", deadline, move || core.inbox(&*store, &*net, now, &budget)) {
        Ok(result) => result.into(),
        Err(e) => Answer::Error { error: elapsed_error(e) },
    }
}

fn core() -> &'static Arc<Core> {
    static CORE: OnceLock<Arc<Core>> = OnceLock::new();
    CORE.get_or_init(|| Arc::new(Core::new()))
}

fn live_store() -> Arc<dyn Store + Send + Sync> {
    Arc::new(vault::store())
}

#[tauri::command]
pub fn slack_status() -> Status {
    status_with(&vault::store())
}

#[tauri::command]
pub async fn slack_connect(token: String) -> Answer<Connected> {
    let token = Secret::new(token);
    let joined = tauri::async_runtime::spawn_blocking(move || {
        connect_deadline(core().clone(), live_store(), Arc::new(Live), token, DEADLINE)
    })
    .await;
    // The JoinError is dropped, never formatted: its text is a panic payload.
    joined.unwrap_or_else(|_| Answer::Error { error: network("request task failed") })
}

#[tauri::command]
pub fn slack_disconnect() -> Result<(), String> {
    core().disconnect(&vault::store())
}

#[tauri::command]
pub async fn slack_inbox() -> Answer<Merged> {
    let joined = tauri::async_runtime::spawn_blocking(move || inbox_deadline(core().clone(), live_store(), Arc::new(Live), DEADLINE)).await;
    joined.unwrap_or_else(|_| Answer::Error { error: network("request task failed") })
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
