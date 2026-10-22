//! The read-only event connection: attach, replay the journal through the
//! attach cut, then stream live events in `agent.rs`'s envelope.

use std::{
    collections::HashMap,
    sync::{mpsc::sync_channel, Arc},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::connection::{reply_from_frame, request_frame, Connection};
use super::reader_control::ReaderControl;
// `falcon.rs` imports the shared protocol under a different root per build.
#[cfg(falcon_shell)]
use crate::protocol::{CAPABILITY_CODEX_QUERY, CAPABILITY_CODEX_SKILLS};
#[cfg(not(falcon_shell))]
use super::protocol::{CAPABILITY_CODEX_QUERY, CAPABILITY_CODEX_SKILLS};
use super::session_commands::forget_ctl_secret;
use super::{read_registry, AgentExit, Falcon, Op, REQUEST_TIMEOUT};

/// The inner event value of a hydrated journal record, or `None` if `body` is
/// not an `{"record":"event",...}` wrapper.
///
/// A hydrated record's event fields (`kind`, `line`, `bytes`, `code`) live one
/// level deeper than the live wire shape does — under `body.body`, not
/// `body` itself. Live frames arrive already flattened
/// (`protocol.rs::EventBody`'s `#[serde(flatten)]`), which is why matching
/// `body.get("kind")` directly works for live events but silently misses
/// every hydrated one.
pub(super) fn event_body(body: &Value) -> Option<&Value> {
    if body.get("record").and_then(Value::as_str) != Some("event") {
        return None;
    }
    body.get("body")
}

/// Replay a session's journalled agent output into this tab, oldest first.
///
/// Paged, because a long session's journal does not fit one frame and Falcon
/// refuses to truncate silently — `more` says whether another page is waiting.
/// A page that fails mid-way stops the replay with an error rather than
/// continuing: a transcript with a hole in the middle looks like a complete one.
///
/// Pages ride their own short-lived connection, never the shared control
/// pipe: a slow page there used to time out the control request, which drops
/// that connection and with it every hosted tab's lease. `hydrate` is a
/// read-only op the host answers on any negotiated connection, so this needs
/// no host change.
fn replay_history(
    app: &AppHandle,
    falcon: &Falcon,
    tab: &str,
    session: &str,
    generation: u64,
    through: u64,
    reader: &ReaderControl,
) -> Result<(), String> {
    let registry = read_registry(&falcon.paths)?;
    let mut pages = Connection::open(&registry)?;
    let mut batch = ReplayBatch::default();
    let result = replay_pages(app, &mut pages, tab, session, generation, through, reader, &mut batch);
    // Pending items go out before Ok or Err is returned, so nothing replayed is lost.
    let flushed = batch.flush(app, tab, generation);
    result.and(flushed)
}

/// Replayed `agent-event` payloads (minus `id`/`gen`) waiting to go out as one
/// `{ id, gen, batch: [...] }` emit: one JS task per 64 records, not per record.
#[derive(Default)]
struct ReplayBatch {
    items: Vec<Value>,
}

const REPLAY_BATCH: usize = 64;

impl ReplayBatch {
    /// Adds `item`; returns the full batch, in order, once it holds `REPLAY_BATCH` items.
    fn push_item(&mut self, item: Value) -> Option<Vec<Value>> {
        self.items.push(item);
        (self.items.len() >= REPLAY_BATCH).then(|| std::mem::take(&mut self.items))
    }

    fn push(&mut self, app: &AppHandle, tab: &str, generation: u64, item: Value) -> Result<(), String> {
        match self.push_item(item) {
            Some(full) => emit_batch(app, tab, generation, full),
            None => Ok(()),
        }
    }

    fn flush(&mut self, app: &AppHandle, tab: &str, generation: u64) -> Result<(), String> {
        if self.items.is_empty() {
            return Ok(());
        }
        emit_batch(app, tab, generation, std::mem::take(&mut self.items))
    }
}

fn emit_batch(app: &AppHandle, tab: &str, generation: u64, items: Vec<Value>) -> Result<(), String> {
    app.emit(
        "agent-event",
        json!({ "id": tab, "gen": generation, "batch": items }),
    )
    .map_err(|error| format!("emit falcon replay batch: {error}"))
}

#[allow(clippy::too_many_arguments)] // 8 args: connection, ids and replay state passed separately
fn replay_pages(
    app: &AppHandle,
    pages: &mut Connection,
    tab: &str,
    session: &str,
    generation: u64,
    through: u64,
    reader: &ReaderControl,
    batch: &mut ReplayBatch,
) -> Result<(), String> {
    let mut after = 0u64;
    let mut seen_states: HashMap<String, String> = HashMap::new();
    let (mut emitted, mut skipped) = (0u64, 0u64);
    let mut request = 1u64; // 1 was the negotiate
    loop {
        if reader.is_cancelled() {
            return Err("replay cancelled".into());
        }
        request += 1;
        let page = pages
            .request(
                request,
                Op::Hydrate {
                    session: session.to_string(),
                    after,
                    through,
                },
                REQUEST_TIMEOUT,
            )?
            .applied("hydrate")?;
        let records = page
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .ok_or("falcon hydration page has no records")?;
        if records.is_empty() {
            if page.get("more").and_then(Value::as_bool) == Some(true) {
                return Err("falcon hydration made no progress".into());
            }
            eprintln!("falcon: replay of {session} emitted {emitted} host records, skipped {skipped} repeat permission states");
            return Ok(());
        }
        for record in &records {
            let seq = record
                .get("seq")
                .and_then(Value::as_u64)
                .ok_or("falcon hydration record has no sequence")?;
            if seq <= after {
                return Err(format!(
                    "falcon hydration sequence did not advance after {after}"
                ));
            }
            after = seq;
            let body = record
                .get("body")
                .ok_or("falcon hydration record has no body")?;
            let Some(event) = event_body(body) else {
                if is_repeat_permission_state(&mut seen_states, body) {
                    skipped += 1;
                    continue;
                }
                emitted += 1;
                batch.push(app, tab, generation, json!({ "hostRecord": body }))?;
                continue;
            };
            match event.get("kind").and_then(Value::as_str) {
                Some("agent") => {
                    let line = event.get("line").ok_or("falcon agent record has no line")?;
                    let text = serde_json::to_string(line)
                        .map_err(|error| format!("encode falcon replay line: {error}"))?;
                    batch.push(app, tab, generation, json!({ "line": text, "replay": true }))?;
                }
                Some("overflow") => {
                    batch.push(
                        app,
                        tab,
                        generation,
                        json!({
                            "dropped": event.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                            "replay": true,
                        }),
                    )?;
                }
                Some("exit") => {
                    forget_ctl_secret(session);
                    batch.flush(app, tab, generation)?;
                    app.emit(
                        "agent-exit",
                        AgentExit {
                            id: tab.to_string(),
                            gen: generation,
                            code: event.get("code").and_then(Value::as_i64),
                        },
                    )
                    .map_err(|error| format!("emit falcon replay exit: {error}"))?;
                }
                other => {
                    eprintln!("falcon: replay ignored unknown event kind {other:?}");
                }
            }
        }
        batch.flush(app, tab, generation)?;
        if page.get("more").and_then(Value::as_bool) != Some(true) {
            eprintln!("falcon: replay of {session} emitted {emitted} host records, skipped {skipped} repeat permission states");
            return Ok(());
        }
    }
}

/// True when `body` is a `permission-state` record whose state equals the last
/// one seen for the same request (so replaying it tells the client nothing).
/// Records the state as seen; any other record, or a changed state, is `false`.
/// Journals written before the host deduped carry tens of thousands of repeats.
fn is_repeat_permission_state(seen: &mut HashMap<String, String>, body: &Value) -> bool {
    // Pointers, not `get` keys: the paths-contract scan reads a bare quoted
    // state field name as the runtime/state layout dir (tests/paths-contract.test.mjs).
    if body.pointer("/record").and_then(Value::as_str) != Some("permission-state") {
        return false;
    }
    let (Some(request), Some(state)) = (
        body.pointer("/request").and_then(Value::as_str),
        body.pointer("/state").and_then(Value::as_str),
    ) else {
        return false;
    };
    if seen.get(request).map(String::as_str) == Some(state) {
        return true;
    }
    seen.insert(request.to_string(), state.to_string());
    false
}

#[cfg(test)]
mod replay_batch_tests {
    use super::*;

    #[test]
    fn flushes_at_64_in_order() {
        let mut batch = ReplayBatch::default();
        let mut out: Vec<Vec<Value>> = Vec::new();
        for n in 0..130 {
            if let Some(full) = batch.push_item(json!({ "n": n })) {
                out.push(full);
            }
        }
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|b| b.len() == REPLAY_BATCH));
        assert_eq!(batch.items.len(), 2);
        let all: Vec<u64> = out
            .iter()
            .flatten()
            .chain(batch.items.iter())
            .map(|v| v["n"].as_u64().unwrap())
            .collect();
        assert_eq!(all, (0..130).collect::<Vec<u64>>());
    }
}

#[cfg(test)]
mod replay_dedupe_tests {
    use super::*;

    // A struct, not json!: see the paths-contract note on is_repeat_permission_state.
    #[derive(serde::Serialize)]
    struct Perm<'a> {
        record: &'a str,
        request: &'a str,
        state: &'a str,
    }

    fn perm(request: &str, state: &str) -> Value {
        serde_json::to_value(Perm { record: "permission-state", request, state }).unwrap()
    }

    #[test]
    fn skips_only_repeats_in_order() {
        let mut seen = HashMap::new();
        let records = [
            perm("a", "pending"),
            perm("b", "pending"),
            perm("a", "settled"),
            perm("a", "settled"),
            perm("b", "pending"),
            json!({ "record": "prompt-queued", "prompt": "p" }),
            json!({ "record": "prompt-queued", "prompt": "p" }),
            perm("a", "pending"),
            perm("a", "settled"),
            perm("b", "settled"),
        ];
        let kept: Vec<String> = records
            .iter()
            .filter(|body| !is_repeat_permission_state(&mut seen, body))
            .map(|body| body.to_string())
            .collect();
        let want: Vec<String> = [
            perm("a", "pending"),
            perm("b", "pending"),
            perm("a", "settled"),
            json!({ "record": "prompt-queued", "prompt": "p" }),
            json!({ "record": "prompt-queued", "prompt": "p" }),
            perm("a", "pending"),
            perm("a", "settled"),
            perm("b", "settled"),
        ]
        .iter()
        .map(Value::to_string)
        .collect();
        assert_eq!(kept, want);
    }
}

/// Request ids on the event connection: 1 is the attach, 2 every detach.
const FIRST_MODEL_QUERY: u64 = 3;
/// The catalog is a handful of rows; a cursor that keeps going is a loop.
const MAX_MODEL_PAGES: usize = 10;

/// The Codex model catalog for a hosted tab: the `model/list` an in-process
/// tab sends after initialize (`src/agents/codex.ts`), asked through the
/// host's read-only `query` op (dispatch.rs `query`).
///
/// The host answers a query only on a connection attached to the session, and
/// the control pipe never attaches, so the ask rides this event connection.
/// Its frame is written directly and its reply is picked out of the read loop
/// by request id, never through `Connection::request`, which would skip (and
/// so drop) the live events interleaved with it. Each attach asks again, so a
/// re-adopted or reattached tab gets the catalog without host state. Pages
/// reach the adapter as a `falcon/models` line (`src/agents/codex-hosted.ts`).
pub(super) struct CodexQueries {
    session: String,
    host_generation: u64,
    next_id: u64,
    pending: Option<u64>,
    pages: usize,
    done: bool,
    skills: Option<SkillsAsk>,
}

/// The skills catalog ask (`skills/list` for the session's cwd), kept only
/// when the host lists `codex_skills`. One reply, no pages.
struct SkillsAsk {
    cwd: String,
    pending: Option<u64>,
    done: bool,
}

impl CodexQueries {
    /// The queries to ask for, when the attached session is Codex and the host
    /// lists `codex_query`: an older host drops a connection on an op it
    /// cannot parse, and this is the tab's event stream. The skills catalog
    /// rides along only on a host that also lists `codex_skills` and a
    /// session that names its cwd.
    pub(super) fn for_attach(session: &str, cut: &Value, capabilities: &[String]) -> Option<Self> {
        let summary = cut.get("session")?;
        if summary.get("agent").and_then(Value::as_str) != Some("codex") {
            return None;
        }
        let listed = |name: &str| capabilities.iter().any(|held| held == name);
        if !listed(CAPABILITY_CODEX_QUERY) {
            return None;
        }
        let skills = summary
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty() && listed(CAPABILITY_CODEX_SKILLS))
            .map(|cwd| SkillsAsk {
                cwd: cwd.to_string(),
                pending: None,
                done: false,
            });
        Some(Self {
            session: session.to_string(),
            host_generation: summary.get("generation").and_then(Value::as_u64)?,
            next_id: FIRST_MODEL_QUERY,
            pending: None,
            pages: 0,
            done: false,
            skills,
        })
    }

    fn frame(&mut self, method: &str, params: Value) -> Option<(u64, Value)> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = request_frame(
            id,
            &Op::Query {
                session: self.session.clone(),
                generation: self.host_generation,
                method: method.into(),
                params,
            },
        )
        .ok()?;
        Some((id, frame))
    }

    fn ask(&mut self, cursor: Option<&str>) -> Option<Value> {
        let params = match cursor {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let (id, frame) = self.frame("model/list", params)?;
        self.pending = Some(id);
        Some(frame)
    }

    /// `skills/list` for the session's cwd; `reload` asks Codex to rescan.
    /// Replaces any ask in flight: its reply no longer matches and is dropped.
    fn ask_skills(&mut self, reload: bool) -> Option<Value> {
        let cwd = self.skills.as_ref()?.cwd.clone();
        let params = if reload {
            json!({ "cwds": [cwd], "forceReload": true })
        } else {
            json!({ "cwds": [cwd] })
        };
        let (id, frame) = self.frame("skills/list", params)?;
        let skills = self.skills.as_mut()?;
        skills.pending = Some(id);
        skills.done = false;
        Some(frame)
    }

    /// The first asks (models, then skills), each unless one is out or its
    /// catalog is in. Every frame is written.
    pub(super) fn start(&mut self) -> Vec<Value> {
        let mut frames = Vec::new();
        if !self.done && self.pending.is_none() {
            self.pages = 0;
            frames.extend(self.ask(None));
        }
        if self
            .skills
            .as_ref()
            .is_some_and(|skills| !skills.done && skills.pending.is_none())
        {
            frames.extend(self.ask_skills(false));
        }
        frames
    }

    /// A live `falcon/thread` means the app-server has initialized: an ask
    /// that failed because the attach beat a fresh spawn's initialize goes
    /// again here. `skills/changed` re-asks the skills catalog with a reload.
    pub(super) fn on_line(&mut self, line: &Value) -> Vec<Value> {
        match line.get("method").and_then(Value::as_str) {
            Some("falcon/thread") => self.start(),
            Some("skills/changed") => self.ask_skills(true).into_iter().collect(),
            _ => Vec::new(),
        }
    }

    /// For a response frame answering an ask in flight: the line to emit, if
    /// the reply came back, and the frame asking for the next page. `None` for
    /// any other frame. A refusal or an app-server error emits nothing and
    /// leaves the catalog open for `on_line`.
    pub(super) fn on_response(&mut self, frame: &Value) -> Option<(Option<Value>, Option<Value>)> {
        if let Some(id) = self.skills.as_ref().and_then(|skills| skills.pending) {
            if let Some(reply) = reply_from_frame(frame, id) {
                let skills = self.skills.as_mut()?;
                skills.pending = None;
                let result = reply
                    .applied("query")
                    .ok()
                    .and_then(|payload| payload.pointer("/response/result").cloned())
                    .filter(Value::is_object);
                let Some(result) = result else {
                    return Some((None, None));
                };
                skills.done = true;
                let line = json!({ "method": "falcon/skills", "params": { "result": result } });
                return Some((Some(line), None));
            }
        }
        let id = self.pending?;
        let reply = reply_from_frame(frame, id)?;
        self.pending = None;
        let Ok(payload) = reply.applied("query") else {
            return Some((None, None));
        };
        let Some(result) = payload.pointer("/response/result").and_then(Value::as_object) else {
            return Some((None, None));
        };
        let mut result = result.clone();
        self.pages += 1;
        let cursor = match result.get("nextCursor") {
            Some(Value::String(cursor)) if !cursor.is_empty() && self.pages < MAX_MODEL_PAGES => {
                Some(cursor.clone())
            }
            _ => None,
        };
        if cursor.is_none() {
            // The last page the tab gets reads as the last page (codex.ts `models`).
            result.remove("nextCursor");
            self.done = true;
        }
        let line = json!({ "method": "falcon/models", "params": { "result": result } });
        let next = cursor.and_then(|cursor| self.ask(Some(&cursor)));
        Some((Some(line), next))
    }
}

#[cfg(test)]
mod codex_queries_tests {
    use super::*;

    fn cut(agent: &str) -> Value {
        json!({ "session": { "session": "s1", "generation": 7, "agent": agent }, "through": 0 })
    }

    fn codex() -> CodexQueries {
        CodexQueries::for_attach("s1", &cut("codex"), &[CAPABILITY_CODEX_QUERY.into()])
            .expect("a codex session on a codex_query host asks")
    }

    fn applied(request: &Value, response: Value) -> Value {
        json!({ "t": "response", "request": request["id"], "outcome": "applied",
                "payload": { "response": response } })
    }

    #[test]
    fn only_a_codex_session_on_a_codex_query_host_asks() {
        assert!(CodexQueries::for_attach("s1", &cut("claude"), &[CAPABILITY_CODEX_QUERY.into()])
            .is_none());
        assert!(CodexQueries::for_attach("s1", &cut("codex"), &[]).is_none(), "an older host");
        assert!(CodexQueries::for_attach("s1", &json!({}), &[CAPABILITY_CODEX_QUERY.into()])
            .is_none());
    }

    #[test]
    fn the_ask_is_a_model_list_query_for_the_host_generation() {
        let mut catalog = codex();
        let frame = catalog.start().pop().expect("asks");
        assert_eq!(frame["op"], "query");
        assert_eq!(frame["session"], "s1");
        assert_eq!(frame["generation"], 7);
        assert_eq!(frame["method"], "model/list");
        assert_eq!(frame["params"], json!({}));
        assert_eq!(frame["id"], FIRST_MODEL_QUERY);
        assert!(catalog.start().is_empty(), "one ask in flight");
    }

    #[test]
    fn pages_follow_the_cursor_and_the_last_reads_final() {
        let mut catalog = codex();
        let first = catalog.start().remove(0);
        let event = json!({ "t": "event", "kind": "agent", "line": {} });
        assert!(catalog.on_response(&event).is_none(), "events are not the reply");
        let (line, next) = catalog
            .on_response(&applied(&first, json!({ "id": 9, "result": {
                "data": [{ "model": "gpt-a" }], "nextCursor": "c2" } })))
            .unwrap();
        let line = line.unwrap();
        assert_eq!(line["method"], "falcon/models");
        assert_eq!(line["params"]["result"]["data"][0]["model"], "gpt-a");
        assert_eq!(line["params"]["result"]["nextCursor"], "c2");
        let next = next.expect("asks for page two");
        assert_eq!(next["params"], json!({ "cursor": "c2" }));
        assert_ne!(next["id"], first["id"]);
        let (line, next) = catalog
            .on_response(&applied(&next, json!({ "id": 10, "result": {
                "data": [{ "model": "gpt-b" }], "nextCursor": null } })))
            .unwrap();
        assert!(line.unwrap()["params"]["result"].get("nextCursor").is_none());
        assert!(next.is_none());
        assert!(catalog.start().is_empty(), "the catalog is in");
        assert!(catalog.on_line(&json!({ "method": "falcon/thread" })).is_empty());
    }

    #[test]
    fn a_failed_ask_goes_again_when_the_thread_opens() {
        let mut catalog = codex();
        let first = catalog.start().remove(0);
        let error = applied(&first, json!({ "id": 9, "error": { "message": "Not initialized" } }));
        assert_eq!(catalog.on_response(&error).map(|(l, n)| (l.is_none(), n.is_none())), Some((true, true)));
        let refused = catalog.on_line(&json!({ "method": "falcon/thread" })).pop().expect("asks again");
        let failed = json!({ "t": "response", "request": refused["id"], "outcome": "failed",
                             "error": "session has exited" });
        assert_eq!(catalog.on_response(&failed).map(|(l, _)| l.is_none()), Some(true));
        assert!(catalog.on_line(&json!({ "method": "turn/started" })).is_empty());
    }

    #[test]
    fn a_cursor_that_never_ends_stops_at_the_page_cap() {
        let mut catalog = codex();
        let mut ask = catalog.start().pop();
        let mut pages = 0;
        while let Some(frame) = ask {
            let (line, next) = catalog
                .on_response(&applied(&frame, json!({ "id": 1, "result": {
                    "data": [], "nextCursor": "again" } })))
                .unwrap();
            assert!(line.is_some());
            pages += 1;
            ask = next;
        }
        assert_eq!(pages, MAX_MODEL_PAGES);
    }

    fn cut_with_cwd() -> Value {
        json!({ "session": { "session": "s1", "generation": 7, "agent": "codex", "cwd": "C:/work" },
                "through": 0 })
    }

    fn with_skills() -> CodexQueries {
        CodexQueries::for_attach(
            "s1",
            &cut_with_cwd(),
            &[CAPABILITY_CODEX_QUERY.into(), CAPABILITY_CODEX_SKILLS.into()],
        )
        .unwrap()
    }

    fn skills_reply(request: &Value) -> Value {
        applied(request, json!({ "id": 1, "result": { "data": [{ "cwd": "C:/work", "skills": [] }] } }))
    }

    #[test]
    fn skills_are_asked_after_models_only_with_the_capability() {
        let frames = with_skills().start();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["method"], "model/list");
        assert_eq!(frames[0]["id"], FIRST_MODEL_QUERY);
        assert_eq!(frames[1]["method"], "skills/list");
        assert_eq!(frames[1]["id"], FIRST_MODEL_QUERY + 1);
        assert_eq!(frames[1]["params"], json!({ "cwds": ["C:/work"] }));
        for held in [vec![CAPABILITY_CODEX_QUERY.to_string()], vec![]] {
            let queries = CodexQueries::for_attach("s1", &cut_with_cwd(), &held);
            let frames = queries.map(|mut q| q.start()).unwrap_or_default();
            assert!(frames.iter().all(|frame| frame["method"] != "skills/list"));
            assert_eq!(frames.len(), held.len());
        }
        // No cwd: nothing to scope the catalog to.
        let held = [CAPABILITY_CODEX_QUERY.to_string(), CAPABILITY_CODEX_SKILLS.to_string()];
        let frames = CodexQueries::for_attach("s1", &cut("codex"), &held).unwrap().start();
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn the_skills_reply_reaches_the_tab_as_a_skills_line() {
        let mut queries = with_skills();
        let frames = queries.start();
        let (line, next) = queries.on_response(&skills_reply(&frames[1])).unwrap();
        let line = line.unwrap();
        assert_eq!(line["method"], "falcon/skills");
        assert_eq!(line["params"]["result"]["data"][0]["cwd"], "C:/work");
        assert!(next.is_none());
        assert!(queries.on_line(&json!({ "method": "falcon/thread" })).len() <= 1);
        let again = queries.on_line(&json!({ "method": "falcon/thread" }));
        assert!(again.iter().all(|frame| frame["method"] != "skills/list"), "skills are in");
    }

    #[test]
    fn skills_changed_reasks_and_the_superseded_reply_is_dropped() {
        let mut queries = with_skills();
        let frames = queries.start();
        let stale = skills_reply(&frames[1]);
        let reask = queries.on_line(&json!({ "method": "skills/changed" }));
        assert_eq!(reask.len(), 1);
        assert_eq!(reask[0]["method"], "skills/list");
        assert_eq!(reask[0]["params"], json!({ "cwds": ["C:/work"], "forceReload": true }));
        assert!(queries.on_response(&stale).is_none(), "the superseded reply is dropped");
        let (line, _) = queries.on_response(&skills_reply(&reask[0])).unwrap();
        assert_eq!(line.unwrap()["method"], "falcon/skills");
        // Models reply still matches its own id.
        assert!(queries
            .on_response(&applied(&frames[0], json!({ "id": 2, "result": { "data": [] } })))
            .is_some());
    }

    #[test]
    fn a_skills_error_keeps_the_ask_open_for_the_thread() {
        let mut queries = with_skills();
        let frames = queries.start();
        let error = applied(&frames[1], json!({ "id": 9, "error": { "message": "Not initialized" } }));
        assert_eq!(queries.on_response(&error).map(|(l, n)| (l.is_none(), n.is_none())), Some((true, true)));
        let again = queries.on_line(&json!({ "method": "falcon/thread" }));
        let skills: Vec<_> = again.iter().filter(|frame| frame["method"] == "skills/list").collect();
        assert_eq!(skills.len(), 1, "re-asks on falcon/thread");
        assert_eq!(skills[0]["params"], json!({ "cwds": ["C:/work"] }));
    }
}

/// Attach a read-only connection, replay the history, then stream live events —
/// all in `agent.rs`'s envelope.
///
/// The ordering is the attach-cut contract and is not rearrangeable:
///
/// 1. **Attach** on the event connection. It returns `through`, a journal
///    position: the exact boundary between "replay this from the journal" and
///    "this will arrive live". Events published from this instant are already
///    being buffered for this connection.
/// 2. **Hydrate** through that cut — on a dedicated page connection
///    (`replay_history`), not this one and not the shared control pipe.
///    Issuing a request on the event connection would make its reply arrive
///    interleaved with buffered events, and this client's `request` skips
///    frames that are not its reply, so it would silently discard exactly the
///    events it is here to deliver.
/// 3. **Stream**, only after the replay has been emitted, so history cannot
///    appear after the live output that followed it.
///
/// Only step 1 runs before this returns; steps 2-3 run on the reader thread.
/// A spawn/adopt therefore resolves once its lease is held and its attach is
/// in, and a batch of re-adopts (`src/launcher/readopt.ts`) attaches every
/// session before any long hydration runs, rather than leaving later sessions
/// unattached behind earlier replays past the host's orphan grace. A replay
/// failure reaches the tab as `disconnected`, the same as a lost stream.
///
/// Nothing filters live events against `through`. They are on different number
/// lines — `through` is a journal position, `seq` is a dense event count — and
/// comparing them drops events. Falcon's own protocol doc says so at
/// `protocol.rs`; this is the consumer that would have been bitten.
pub(super) fn start_event_reader(
    app: AppHandle,
    falcon: &Arc<Falcon>,
    tab: String,
    session: String,
    generation: u64,
    reader: Arc<ReaderControl>,
) -> Result<(), String> {
    let registry = read_registry(&falcon.paths)?;
    let mut connection = Connection::open(&registry)?;
    // Attached here, on this thread, so a failure is reported to the caller
    // rather than surfacing later as a silently eventless tab.
    let cut = connection
        .request(
            1,
            Op::Attach {
                session: session.clone(),
            },
            REQUEST_TIMEOUT,
        )?
        .applied("attach")?;
    let through = cut.get("through").and_then(Value::as_u64).unwrap_or(0);
    app.emit(
        "agent-event",
        json!({
            "id": tab,
            "gen": generation,
            "hydration": "start",
            "summary": cut.get("session"),
            "snapshot": cut.get("snapshot"),
            "through": through,
        }),
    )
    .map_err(|error| format!("emit falcon hydration start: {error}"))?;
    let mut catalog = CodexQueries::for_attach(&session, &cut, &connection.capabilities);

    let (ready, started) = sync_channel(1);
    let reader_thread = Arc::clone(&reader);
    let falcon = Arc::clone(falcon);
    std::thread::Builder::new()
        .name(format!("falcon-events-{tab}"))
        .spawn(move || {
            let _finished = match reader_thread.enter() {
                Ok(finished) => finished,
                // Cancelled before it started: detach as the loop would have.
                Err(_) if reader_thread.is_cancelled() => {
                    let _ = connection.request(
                        2,
                        Op::Detach {
                            session: session.clone(),
                        },
                        REQUEST_TIMEOUT,
                    );
                    let _ = ready.send(Ok(()));
                    return;
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            if ready.send(Ok(())).is_err() {
                return;
            }
            let replayed =
                replay_history(&app, &falcon, &tab, &session, generation, through, &reader_thread)
                    .and_then(|()| {
                        app.emit(
                            "agent-event",
                            json!({ "id": tab, "gen": generation, "hydration": "end", "through": through }),
                        )
                        .map_err(|error| format!("emit falcon hydration end: {error}"))
                    });
            drop(falcon);
            if let Err(error) = replayed {
                if !reader_thread.is_cancelled() {
                    let _ = app.emit(
                        "agent-event",
                        json!({ "id": tab, "gen": generation, "disconnected": error }),
                    );
                }
                let _ = connection.request(
                    2,
                    Op::Detach {
                        session: session.clone(),
                    },
                    REQUEST_TIMEOUT,
                );
                return;
            }
            // After the replay, so the catalog cannot land ahead of the history.
            // A failed write leaves the read below to report the broken pipe.
            for ask in catalog.as_mut().map(CodexQueries::start).unwrap_or_default() {
                let _ = connection.write_frame(&ask);
            }
            loop {
                if reader_thread.is_cancelled() {
                    let _ = connection.request(
                        2,
                        Op::Detach {
                            session: session.clone(),
                        },
                        REQUEST_TIMEOUT,
                    );
                    return;
                }
                let frame = match connection.read_frame() {
                    Ok(frame) => frame,
                    // The host went away or the pipe broke. The child may well
                    // still be alive and hosted, so this is NOT reported as an
                    // agent exit — that would draw a dead tab for a session
                    // that is running.
                    Err(error) => {
                        if !reader_thread.is_cancelled() {
                            let _ = app.emit(
                                "agent-event",
                                json!({ "id": tab, "gen": generation, "disconnected": error }),
                            );
                        }
                        return;
                    }
                };
                if reader_thread.is_cancelled() {
                    let _ = connection.request(
                        2,
                        Op::Detach {
                            session: session.clone(),
                        },
                        REQUEST_TIMEOUT,
                    );
                    return;
                }
                if let Some((line, next)) =
                    catalog.as_mut().and_then(|catalog| catalog.on_response(&frame))
                {
                    if let Some(text) = line.and_then(|line| serde_json::to_string(&line).ok()) {
                        let _ = app.emit(
                            "agent-event",
                            json!({ "id": tab, "gen": generation, "line": text }),
                        );
                    }
                    if let Some(next) = next {
                        let _ = connection.write_frame(&next);
                    }
                    continue;
                }
                if frame.get("t").and_then(Value::as_str) != Some("event") {
                    continue;
                }
                match frame.get("kind").and_then(Value::as_str) {
                    // Falcon's `agent` events carry the sidecar's stdout line
                    // verbatim, so this is the same string agent.rs forwards.
                    Some("agent") => {
                        let Some(line) = frame.get("line") else {
                            continue;
                        };
                        let Ok(text) = serde_json::to_string(line) else {
                            continue;
                        };
                        let _ = app.emit(
                            "agent-event",
                            json!({ "id": tab, "gen": generation, "line": text }),
                        );
                        for ask in catalog
                            .as_mut()
                            .map(|catalog| catalog.on_line(line))
                            .unwrap_or_default()
                        {
                            let _ = connection.write_frame(&ask);
                        }
                    }
                    Some("overflow") => {
                        let bytes = frame.get("bytes").and_then(Value::as_u64).unwrap_or(0);
                        let _ = app.emit(
                            "agent-event",
                            json!({ "id": tab, "gen": generation, "dropped": bytes }),
                        );
                    }
                    Some("record") => {
                        let Some(body) = frame.get("body") else {
                            continue;
                        };
                        let _ = app.emit(
                            "agent-event",
                            json!({ "id": tab, "gen": generation, "hostRecord": body }),
                        );
                    }
                    Some("exit") => {
                        forget_ctl_secret(&session);
                        let code = frame.get("code").and_then(Value::as_i64);
                        let _ = app.emit(
                            "agent-exit",
                            AgentExit {
                                id: tab.clone(),
                                gen: generation,
                                code,
                            },
                        );
                        return;
                    }
                    _ => {}
                }
            }
        })
        .map_err(|error| format!("falcon event reader: {error}"))?;
    started
        .recv()
        .map_err(|_| "falcon event reader stopped before initialization".to_string())?
}
