//! Hosted Codex cards: the server requests the table draws as approval or
//! question cards (`card` rows of `contracts/codex-server-requests.json`),
//! tracked as `PermissionState` under the card key `sr:<id>` the view uses.
//!
//! - A card opens when its request line arrives, before the line is
//!   published, and stays open with no view attached; the journal's
//!   `PermissionState` records rebuild it for a view that adopts later.
//! - An answer comes from an op (`permission_response`), not the stdout
//!   reader. It is claimed under the lock (`Opened` to `Responded`), written
//!   with the lock released, then settled by the write's fate, so a card is
//!   answered at most once: a second answer, or one racing it, is refused
//!   with "no pending permission <key>" (the view reads that as already
//!   answered). A write that did not happen reopens the card; one that may
//!   have landed never does.
//! - Codex ends a card with `serverRequest/resolved`, or by completing the
//!   turn that raised it: `Settled`. The child exiting with a card still
//!   open: `CancelledByExit`. A terminal card never moves again.
//! - A file-change card whose diff arrives after the card (its item's start,
//!   completion or patch update) gets an `ApprovalDiff` record after that
//!   line, so the view can redraw the card from the item.

use super::{answers, lock, requests, CodexDriver};
use crate::{
    claude::PermissionState, journal::CodexRecord, process::WriteStatus, protocol::Outcome,
};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

const FILE_CHANGE: &str = "item/fileChange/requestApproval";

struct Card {
    /// The JSON-RPC id the answer goes back under, as Codex sent it.
    id: Value,
    method: String,
    /// The request's params, which the answer is built from; dropped once
    /// the card is terminal.
    params: Value,
    state: PermissionState,
    item: String,
    thread: String,
    turn: String,
    /// The diff the card last had (file-change cards only).
    changes: Option<Value>,
}

#[derive(Default)]
pub struct Approvals {
    cards: HashMap<String, Card>,
    /// The latest changes seen per file-change item, so a card raised after
    /// its item started opens with that diff.
    diffs: HashMap<String, Value>,
    records: Vec<CodexRecord>,
    /// Cards whose state moved since the stdout reader last asked
    /// (`take_changes`), so the reader journals only those: a long session's
    /// settled cards are never rebuilt and sorted on every child line.
    changed: BTreeSet<String>,
}

fn text<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

impl Approvals {
    /// One inbound line, in order, from the stdout reader.
    pub fn observe(&mut self, message: &Value) {
        let params = message.get("params").unwrap_or(&Value::Null);
        if let Some((id, method)) = requests::server_request(message) {
            if answers::is_card(method) {
                self.open(id, method, params);
            }
            return;
        }
        match message.get("method").and_then(Value::as_str) {
            Some("serverRequest/resolved") => {
                if let Some(id) = params.get("requestId").or_else(|| params.get("id")) {
                    self.settle(&requests::request_key(id));
                }
            }
            Some("turn/completed") => {
                let thread = text(params, "/threadId").to_string();
                let turn = text(params, "/turn/id").to_string();
                self.turn_completed(&thread, &turn);
            }
            Some("item/started" | "item/completed") => {
                if text(params, "/item/type") == "fileChange" {
                    let item = text(params, "/item/id").to_string();
                    self.diff(&item, params.pointer("/item/changes"));
                }
            }
            Some("item/fileChange/patchUpdated") => {
                let item = text(params, "/itemId").to_string();
                let changes = params
                    .get("changes")
                    .or_else(|| params.pointer("/item/changes"));
                self.diff(&item, changes);
            }
            _ => {}
        }
    }

    fn open(&mut self, id: &Value, method: &str, params: &Value) {
        let key = requests::request_key(id);
        // A repeated request line (or one replayed) never reopens a card.
        if self.cards.contains_key(&key) {
            return;
        }
        let item = text(params, "/itemId").to_string();
        let changes = (method == FILE_CHANGE)
            .then(|| self.diffs.get(&item).cloned())
            .flatten();
        self.changed.insert(key.clone());
        self.cards.insert(
            key,
            Card {
                id: id.clone(),
                method: method.into(),
                params: params.clone(),
                state: PermissionState::Opened,
                thread: text(params, "/threadId").into(),
                turn: text(params, "/turnId").into(),
                item,
                changes,
            },
        );
    }

    /// `true` when the card moved (it was not terminal yet).
    fn finish(card: &mut Card, state: PermissionState) -> bool {
        if card.state.is_terminal() {
            return false;
        }
        card.state = state;
        card.params = Value::Null;
        true
    }

    fn settle(&mut self, key: &str) {
        if let Some(card) = self.cards.get_mut(key) {
            if Self::finish(card, PermissionState::Settled) {
                self.changed.insert(key.to_string());
            }
        }
    }

    /// The turn's cards are over. A card names its thread and turn; a
    /// completion of another thread's or another turn's turn leaves it open.
    /// A card with no turn (an elicitation between turns) belongs to no
    /// completion: only `serverRequest/resolved` or the exit ends it.
    fn turn_completed(&mut self, thread: &str, turn: &str) {
        let same_thread =
            |mine: &str, theirs: &str| mine.is_empty() || theirs.is_empty() || mine == theirs;
        for (key, card) in self.cards.iter_mut() {
            if same_thread(&card.thread, thread)
                && !card.turn.is_empty()
                && card.turn == turn
                && Self::finish(card, PermissionState::Settled)
            {
                self.changed.insert(key.clone());
            }
        }
        // Diffs only matter to cards still open.
        let open: Vec<&str> = self
            .cards
            .values()
            .filter(|card| !card.state.is_terminal())
            .map(|card| card.item.as_str())
            .collect();
        self.diffs.retain(|item, _| open.contains(&item.as_str()));
    }

    fn diff(&mut self, item: &str, changes: Option<&Value>) {
        let Some(changes) =
            changes.filter(|changes| changes.as_array().is_some_and(|list| !list.is_empty()))
        else {
            return;
        };
        if item.is_empty() {
            return;
        }
        self.diffs.insert(item.into(), changes.clone());
        let mut updated: Vec<String> = Vec::new();
        for (key, card) in self.cards.iter_mut() {
            if card.method == FILE_CHANGE
                && card.item == item
                && !card.state.is_terminal()
                && card.changes.as_ref() != Some(changes)
            {
                card.changes = Some(changes.clone());
                updated.push(key.clone());
            }
        }
        updated.sort();
        self.records.extend(
            updated
                .into_iter()
                .map(|request| CodexRecord::ApprovalDiff {
                    request,
                    item: item.into(),
                }),
        );
    }

    /// Claim card `key` for one answer carrying `decision`: the line to write.
    /// `Err` when the card is unknown or no longer awaiting a decision.
    fn claim(&mut self, key: &str, decision: &Value) -> Result<Value, String> {
        let refused = || format!("no pending permission {key}");
        let card = self.cards.get_mut(key).ok_or_else(refused)?;
        if card.state != PermissionState::Opened {
            return Err(refused());
        }
        let result = answers::result(&card.method, &card.params, decision)?;
        card.state = PermissionState::Responded;
        let line = json!({ "jsonrpc": "2.0", "id": card.id, "result": result });
        self.changed.insert(key.to_string());
        Ok(line)
    }

    /// The claimed answer's write settled.
    fn answered(&mut self, key: &str, status: &WriteStatus) -> (Outcome, Option<String>) {
        let card = self.cards.get_mut(key);
        let responded = |card: &Option<&mut Card>| {
            card.as_ref()
                .is_some_and(|card| card.state == PermissionState::Responded)
        };
        match status {
            WriteStatus::Written => {
                if responded(&card) {
                    // Delivered; Codex's `serverRequest/resolved` or the
                    // turn's end is what settles it.
                    card.unwrap().state = PermissionState::Returned;
                    self.changed.insert(key.to_string());
                }
                (Outcome::Applied, None)
            }
            // Nothing reached Codex, so the card awaits a decision again.
            WriteStatus::NotWritten(why) => {
                if responded(&card) {
                    card.unwrap().state = PermissionState::Opened;
                    self.changed.insert(key.to_string());
                }
                (Outcome::Failed, Some(why.clone()))
            }
            // It may have landed: never answered twice, so it stays claimed.
            WriteStatus::PossiblyDelivered(why) => (Outcome::DeliveryUnknown, Some(why.clone())),
        }
    }

    pub fn pending(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .cards
            .iter()
            .filter(|(_, card)| card.state == PermissionState::Opened)
            .map(|(key, _)| key.clone())
            .collect();
        keys.sort();
        keys
    }

    pub fn is_opened(&self, key: &str) -> bool {
        self.cards
            .get(key)
            .is_some_and(|card| card.state == PermissionState::Opened)
    }

    pub fn states(&self) -> Vec<(String, PermissionState)> {
        let mut states: Vec<(String, PermissionState)> = self
            .cards
            .iter()
            .map(|(key, card)| (key.clone(), card.state))
            .collect();
        states.sort_by(|a, b| a.0.cmp(&b.0));
        states
    }

    /// The current state of every card that moved since the last call, in
    /// key order: what the stdout reader journals after each line. A card
    /// that moved twice in between reports where it stands now.
    pub fn take_changes(&mut self) -> Vec<(String, PermissionState)> {
        std::mem::take(&mut self.changed)
            .into_iter()
            .filter_map(|key| {
                let state = self.cards.get(&key)?.state;
                Some((key, state))
            })
            .collect()
    }

    /// The child exited: every card still open can never be answered.
    pub fn abandon(&mut self) -> Vec<String> {
        let mut cancelled = Vec::new();
        for (key, card) in self.cards.iter_mut() {
            if !card.state.is_terminal() {
                Self::finish(card, PermissionState::CancelledByExit);
                cancelled.push(key.clone());
            }
        }
        cancelled.sort();
        cancelled
    }

    pub fn take_records(&mut self) -> Vec<CodexRecord> {
        std::mem::take(&mut self.records)
    }
}

/// The card key when `message` raises a card, for the unattended watcher.
pub fn card_request(message: &Value) -> Option<String> {
    let (id, method) = requests::server_request(message)?;
    answers::is_card(method).then(|| requests::request_key(id))
}

impl CodexDriver {
    /// Answer card `message.id` once with the view's decision
    /// (`{type:"permission_response", id, behavior, message?|updatedInput?}`).
    /// Codex sends nothing back for an answer, so the write's fate is the
    /// outcome.
    pub(super) fn respond_with(
        &self,
        message: &Value,
        write: impl FnOnce(&Value) -> WriteStatus,
    ) -> (Outcome, Option<String>) {
        let Some(key) = message.get("id").and_then(Value::as_str) else {
            return (
                Outcome::Failed,
                Some("a permission response names no request".into()),
            );
        };
        let line = match lock(&self.approvals).claim(key, message) {
            Ok(line) => line,
            Err(why) => return (Outcome::Failed, Some(why)),
        };
        let status = write(&line);
        lock(&self.approvals).answered(key, &status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{codex::CodexDriver, journal::Body, protocol::SpawnParams};
    use std::cell::RefCell;

    fn driver() -> CodexDriver {
        let driver = CodexDriver::new(&SpawnParams {
            agent: Some(crate::protocol::Agent::Codex),
            cwd: r"C:\work".into(),
            model: None,
            effort: None,
            permission_mode: "default".into(),
            resume: None,
            ctl_secret: None,
            rules_file: None,
            tab_name: None,
            gateway: None,
            profile: None,
            payload_file: None,
            row_key: None,
            set_plugin_dirs: Vec::new(),
        });
        driver.ready_for_test("thread-1");
        driver
    }

    fn command_card(id: u64, turn: &str) -> Value {
        json!({
            "id": id,
            "method": "item/commandExecution/requestApproval",
            "params": { "threadId": "thread-1", "turnId": turn, "itemId": "i1", "command": "ls" }
        })
    }

    fn response(key: &str, behavior: &str) -> Value {
        json!({ "type": "permission_response", "id": key, "behavior": behavior })
    }

    fn states(driver: &CodexDriver) -> Vec<(String, PermissionState)> {
        driver.permission_states()
    }

    /// One answer goes out under the request's own id; a second answer, and
    /// a repeat of the request line, change nothing.
    #[test]
    fn a_card_is_answered_once_under_its_own_id() {
        let driver = driver();
        driver.observe(&command_card(5, "t1"));
        assert_eq!(driver.pending_permissions(), vec!["sr:5".to_string()]);
        assert!(driver.is_opened("sr:5"));
        let written = RefCell::new(Vec::new());
        let write = |line: &Value| {
            written.borrow_mut().push(line.clone());
            WriteStatus::Written
        };
        assert_eq!(
            driver.respond_with(&response("sr:5", "allow"), write),
            (Outcome::Applied, None)
        );
        assert_eq!(
            written.borrow().as_slice(),
            [json!({ "jsonrpc": "2.0", "id": 5, "result": { "decision": "accept" } })]
        );
        assert_eq!(
            states(&driver),
            vec![("sr:5".into(), PermissionState::Returned)]
        );
        assert!(!driver.is_opened("sr:5"));

        driver.observe(&command_card(5, "t1"));
        let again = driver.respond_with(&response("sr:5", "deny"), |_| panic!("answered twice"));
        assert_eq!(
            again,
            (Outcome::Failed, Some("no pending permission sr:5".into()))
        );
        let unknown = driver.respond_with(&response("sr:9", "deny"), |_| panic!("no such card"));
        assert_eq!(unknown.0, Outcome::Failed);
        assert_eq!(
            states(&driver),
            vec![("sr:5".into(), PermissionState::Returned)]
        );
    }

    /// A write that did not happen reopens the card for a retry; one that
    /// may have landed keeps it claimed, so it is never answered twice.
    #[test]
    fn a_failed_write_reopens_and_an_unknown_one_never_answers_again() {
        let driver = driver();
        driver.observe(&command_card(1, "t1"));
        let refused = driver.respond_with(&response("sr:1", "deny"), |_| {
            WriteStatus::NotWritten("pipe closed".into())
        });
        assert_eq!(refused, (Outcome::Failed, Some("pipe closed".into())));
        assert!(driver.is_opened("sr:1"));
        let unknown = driver.respond_with(&response("sr:1", "deny"), |line| {
            assert_eq!(line["result"], json!({ "decision": "decline" }));
            WriteStatus::PossiblyDelivered("timed out".into())
        });
        assert_eq!(
            unknown,
            (Outcome::DeliveryUnknown, Some("timed out".into()))
        );
        assert_eq!(
            states(&driver),
            vec![("sr:1".into(), PermissionState::Responded)]
        );
        let again = driver.respond_with(&response("sr:1", "allow"), |_| panic!("answered twice"));
        assert_eq!(again.0, Outcome::Failed);
    }

    /// Codex settles a card by resolving it or completing its turn; another
    /// turn's completion leaves it open, and a terminal card stays terminal.
    #[test]
    fn resolved_or_its_turn_ending_settles_a_card_and_nothing_walks_it_back() {
        let driver = driver();
        driver.observe(&command_card(1, "t1"));
        driver.observe(&command_card(2, "t2"));
        driver.observe(&json!({
            "id": "q",
            "method": "item/tool/requestUserInput",
            "params": { "threadId": "thread-1", "turnId": "t2", "questions": [] }
        }));
        driver.observe(&json!({ "method": "serverRequest/resolved", "params": { "threadId": "thread-1", "requestId": 1 } }));
        driver.observe(&json!({ "method": "turn/completed", "params": { "threadId": "child", "turn": { "id": "t2" } } }));
        assert_eq!(
            states(&driver),
            vec![
                ("sr:1".into(), PermissionState::Settled),
                ("sr:2".into(), PermissionState::Opened),
                ("sr:q".into(), PermissionState::Opened),
            ],
            "another thread's turn ending leaves this thread's cards open"
        );
        driver.observe(&json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": "t1" } } }));
        assert_eq!(
            driver.pending_permissions().len(),
            2,
            "an older turn's end settles nothing open"
        );
        driver.observe(&json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": "t2" } } }));
        assert!(driver.pending_permissions().is_empty());
        assert!(
            driver.abandon("exit").is_empty(),
            "nothing open is left to cancel"
        );
        driver.observe(&command_card(2, "t2"));
        assert_eq!(
            states(&driver)[1],
            ("sr:2".into(), PermissionState::Settled)
        );
        let late = driver.respond_with(&response("sr:2", "allow"), |_| panic!("a settled card"));
        assert_eq!(late.0, Outcome::Failed);
    }

    /// A card that names no turn stays open across an unrelated turn's end
    /// and is still answerable; only its resolution settles it.
    #[test]
    fn a_turnless_card_outlives_an_unrelated_turn_end() {
        let driver = driver();
        driver.observe(&json!({
            "id": "e",
            "method": "mcpServer/elicitation/request",
            "params": { "threadId": "thread-1", "serverName": "s", "message": "m" }
        }));
        driver.observe(&command_card(1, "t1"));
        driver.observe(&json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": "t1" } } }));
        assert_eq!(driver.pending_permissions(), vec!["sr:e".to_string()]);
        driver
            .observe(&json!({ "method": "serverRequest/resolved", "params": { "requestId": "e" } }));
        assert!(driver.pending_permissions().is_empty());
    }

    /// An allowed form whose content does not fit is refused with the
    /// reason, nothing is written, and the card waits for a corrected answer.
    #[test]
    fn an_allow_that_does_not_fit_the_form_is_refused_and_the_card_stays_open() {
        let driver = driver();
        driver.observe(&json!({
            "id": 7,
            "method": "mcpServer/elicitation/request",
            "params": { "threadId": "thread-1", "turnId": "t1", "mode": "form",
                "requestedSchema": { "type": "object", "required": ["name"],
                    "properties": { "name": { "type": "string" } } } }
        }));
        // The form field built by pointer (`answers::CONTENT`'s reason).
        let form = |name: Value| {
            let mut input = json!({});
            input["/content"[1..].to_string()] = json!({ "name": name });
            json!({ "type": "permission_response", "id": "sr:7", "behavior": "allow",
                "updatedInput": input })
        };
        let misfit = form(json!(3));
        let refused = driver.respond_with(&misfit, |_| panic!("a misfit is never written"));
        assert_eq!(
            refused,
            (Outcome::Failed, Some(answers::FORM_MISFIT.to_string()))
        );
        assert!(driver.is_opened("sr:7"));
        let fits = form(json!("x"));
        let written = driver.respond_with(&fits, |line| {
            assert_eq!(line["result"]["action"], "accept");
            WriteStatus::Written
        });
        assert_eq!(written, (Outcome::Applied, None));
    }

    /// A child exit cancels every card not yet terminal, answered or not.
    #[test]
    fn an_exit_cancels_open_and_answered_cards() {
        let driver = driver();
        driver.observe(&command_card(1, "t1"));
        driver.observe(&command_card(2, "t1"));
        driver.observe(&command_card(3, "t1"));
        driver
            .observe(&json!({ "method": "serverRequest/resolved", "params": { "requestId": 3 } }));
        driver.respond_with(&response("sr:2", "allow"), |_| WriteStatus::Written);
        assert_eq!(
            driver.abandon("exit"),
            vec!["sr:1".to_string(), "sr:2".to_string()]
        );
        assert_eq!(
            states(&driver),
            vec![
                ("sr:1".into(), PermissionState::CancelledByExit),
                ("sr:2".into(), PermissionState::CancelledByExit),
                ("sr:3".into(), PermissionState::Settled),
            ]
        );
    }

    /// The reader is handed only the cards that moved since it last asked,
    /// at the state they reached, so settled cards cost nothing per line.
    #[test]
    fn only_moved_cards_are_reported_to_the_reader() {
        let driver = driver();
        driver.observe(&command_card(1, "t1"));
        driver.observe(&command_card(2, "t1"));
        assert_eq!(
            driver.permission_changes(),
            vec![
                ("sr:1".into(), PermissionState::Opened),
                ("sr:2".into(), PermissionState::Opened),
            ]
        );
        assert!(driver.permission_changes().is_empty(), "nothing moved");
        driver.respond_with(&response("sr:1", "allow"), |_| WriteStatus::Written);
        driver
            .observe(&json!({ "method": "serverRequest/resolved", "params": { "requestId": 1 } }));
        assert_eq!(
            driver.permission_changes(),
            vec![("sr:1".into(), PermissionState::Settled)],
            "moved twice, reported once where it stands"
        );
        driver.observe(&json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": "t1" } } }));
        assert_eq!(
            driver.permission_changes(),
            vec![("sr:2".into(), PermissionState::Settled)],
            "an already settled card does not move again"
        );
        driver.observe(&command_card(1, "t1"));
        assert!(driver.permission_changes().is_empty(), "a repeat reopens nothing");
        assert_eq!(states(&driver).len(), 2, "the full view still lists both");
    }

    fn diff_records(driver: &CodexDriver) -> Vec<CodexRecord> {
        driver
            .take_records()
            .into_iter()
            .filter_map(|body| match body {
                Body::Codex {
                    codex: record @ CodexRecord::ApprovalDiff { .. },
                } => Some(record),
                _ => None,
            })
            .collect()
    }

    /// The approval can come before its item's start: the diff that arrives
    /// later is recorded for the card, once per change, and a card raised
    /// after its diff gets no record.
    #[test]
    fn a_diff_that_arrives_after_its_card_is_recorded_for_it() {
        let driver = driver();
        let card = |id: u64, item: &str| {
            json!({
                "id": id,
                "method": FILE_CHANGE,
                "params": { "threadId": "thread-1", "turnId": "t1", "itemId": item }
            })
        };
        let started = |item: &str, path: &str| {
            json!({
                "method": "item/started",
                "params": { "threadId": "thread-1", "turnId": "t1",
                    "item": { "type": "fileChange", "id": item, "changes": [{ "path": path }] } }
            })
        };
        driver.observe(&card(1, "f1"));
        driver.observe(&started("f1", "a.rs"));
        let one = CodexRecord::ApprovalDiff {
            request: "sr:1".into(),
            item: "f1".into(),
        };
        assert_eq!(diff_records(&driver), vec![one.clone()]);
        driver.observe(&json!({
            "method": "item/completed",
            "params": { "item": { "type": "fileChange", "id": "f1", "changes": [{ "path": "a.rs" }] } }
        }));
        assert!(
            diff_records(&driver).is_empty(),
            "the same diff again is no update"
        );
        driver.observe(&json!({
            "method": "item/fileChange/patchUpdated",
            "params": { "itemId": "f1", "changes": [{ "path": "a.rs" }, { "path": "b.rs" }] }
        }));
        assert_eq!(diff_records(&driver), vec![one]);
        driver.observe(&json!({
            "method": "item/fileChange/patchUpdated",
            "params": { "itemId": "f1", "changes": [] }
        }));
        assert!(
            diff_records(&driver).is_empty(),
            "an empty patch is not a diff"
        );

        driver.observe(&started("f2", "c.rs"));
        driver.observe(&card(2, "f2"));
        driver.observe(&started("f2", "c.rs"));
        assert!(
            diff_records(&driver).is_empty(),
            "the card opened with its diff"
        );

        driver
            .observe(&json!({ "method": "serverRequest/resolved", "params": { "requestId": 1 } }));
        driver.observe(&started("f1", "z.rs"));
        assert!(
            diff_records(&driver).is_empty(),
            "a settled card takes no update"
        );
    }

    #[test]
    fn only_card_requests_are_unattended_targets() {
        assert_eq!(card_request(&command_card(4, "t1")), Some("sr:4".into()));
        assert_eq!(
            card_request(&json!({ "id": 4, "method": "item/tool/call" })),
            None
        );
        assert_eq!(
            card_request(&json!({ "method": FILE_CHANGE, "params": {} })),
            None,
            "a notification is no request"
        );
    }

    #[test]
    fn the_diff_record_has_a_stable_wire_shape() {
        let record = Body::Codex {
            codex: CodexRecord::ApprovalDiff {
                request: "sr:1".into(),
                item: "f1".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            json!({ "record": "codex", "codex": { "kind": "approval-diff", "request": "sr:1", "item": "f1" } })
        );
    }
}
