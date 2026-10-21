//! Codex server requests (JSON-RPC requests from the app-server to its
//! client) and how the host disposes of them, from the table the in-process
//! adapter reads too (`contracts/codex-server-requests.json`,
//! `src/agents/codex-methods.ts`).
//!
//! The host answers every request that is not a card at once, whether or not
//! a view is attached: a `refuse` method gets its refusal, an `error` method
//! and any method the table does not name get the unsupported error
//! (-32601). Each answer is written and journaled once per request id,
//! before the request line is published. Cards (approvals and questions) are
//! left alone here: `approvals.rs` tracks them as `PermissionState` and
//! answers them from the view's ops.

use crate::{journal::CodexRecord, process::WriteStatus};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::OnceLock};

pub(super) fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../contracts/codex-server-requests.json"
        ))
        .expect("contracts/codex-server-requests.json is JSON")
    })
}

/// What the table says about a server-request method.
#[derive(Debug, Clone, PartialEq)]
pub enum Disposition {
    /// Drawn as a card; the host does not answer it here.
    Card,
    /// Answered at once with this result.
    Refuse(Value),
    /// Answered at once with the unsupported error.
    Error,
    /// Not in the table: answered with the unsupported error.
    Unknown,
}

impl Disposition {
    fn name(&self) -> &'static str {
        match self {
            Self::Card => "card",
            Self::Refuse(_) => "refused",
            Self::Error => "error",
            Self::Unknown => "unknown",
        }
    }
}

/// The table's disposition for `method`. Method names hold `/`, so the
/// lookup is by key, never a JSON pointer.
pub fn disposition(method: &str) -> Disposition {
    let Some(entry) = contract()["requests"].get(method) else {
        return Disposition::Unknown;
    };
    match entry["disposition"].as_str() {
        Some("card") => Disposition::Card,
        Some("refuse") => match entry.get("refusal") {
            Some(refusal) => Disposition::Refuse(refusal.clone()),
            None => Disposition::Error,
        },
        _ => Disposition::Error,
    }
}

/// The request's id and method when `message` is a server request: a
/// `method` with an `id`. Notifications carry no id, responses no method.
pub fn server_request(message: &Value) -> Option<(&Value, &str)> {
    let method = message.get("method")?.as_str()?;
    let id = message.get("id").filter(|id| !id.is_null())?;
    Some((id, method))
}

/// The answer line for a request the host disposes of itself; `None` for a
/// card.
pub fn answer_line(id: &Value, method: &str, disposition: &Disposition) -> Option<Value> {
    match disposition {
        Disposition::Card => None,
        Disposition::Refuse(result) => {
            Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
        }
        Disposition::Error | Disposition::Unknown => {
            let unsupported = &contract()["unsupported"];
            let message = unsupported["message"]
                .as_str()
                .unwrap_or("{method} is not supported")
                .replace("{method}", method);
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": unsupported["code"].clone(), "message": message }
            }))
        }
    }
}

/// The card key a request id goes by (`sr:<id>`, as `codex-requests.ts`
/// names it), shared by the journal record and `PermissionState`.
pub fn request_key(id: &Value) -> String {
    match id {
        Value::String(id) => format!("sr:{id}"),
        other => format!("sr:{other}"),
    }
}

/// An answer the host owes Codex, claimed so it goes out only once.
#[derive(Debug, Clone, PartialEq)]
pub struct Claim {
    pub key: String,
    pub method: String,
    pub disposition: &'static str,
    pub line: Value,
}

impl Claim {
    /// The journal fact for this answer, after its write settled.
    pub fn record(self, status: &WriteStatus) -> CodexRecord {
        let (delivery, error) = match status {
            WriteStatus::Written => ("written", None),
            WriteStatus::NotWritten(error) => ("not-written", Some(error.clone())),
            WriteStatus::PossiblyDelivered(error) => ("possibly-delivered", Some(error.clone())),
        };
        CodexRecord::ServerRequestAnswered {
            request: self.key,
            method: self.method,
            disposition: self.disposition.into(),
            delivery: delivery.into(),
            error,
        }
    }
}

/// The request ids the host has already answered this session.
#[derive(Default)]
pub struct Requests {
    answered: HashSet<String>,
}

impl Requests {
    /// The answer to write for `message`, once per request id. `None` for a
    /// line that is not a server request, a card, or an id already answered.
    pub fn claim(&mut self, message: &Value) -> Option<Claim> {
        let (id, method) = server_request(message)?;
        let disposition = disposition(method);
        let line = answer_line(id, method, &disposition)?;
        let key = request_key(id);
        if !self.answered.insert(key.clone()) {
            return None;
        }
        Some(Claim {
            key,
            method: method.into(),
            disposition: disposition.name(),
            line,
        })
    }

    /// The claimed answer was definitely not written: release the id so a
    /// repeat of the request is answered. Claimed before the write and held
    /// on a written or possibly delivered answer, like an approval card
    /// (`approvals.rs`): Codex never gets two answers to one request, and a
    /// child that is still alive is never left waiting on one that never left.
    pub fn release(&mut self, key: &str) {
        self.answered.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{codex::CodexDriver, journal::Body, protocol::SpawnParams};
    use std::cell::RefCell;

    fn driver() -> CodexDriver {
        CodexDriver::new(&SpawnParams {
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
        })
    }

    fn records(bodies: Vec<Body>) -> Vec<CodexRecord> {
        bodies
            .into_iter()
            .map(|body| match body {
                Body::Codex { codex } => codex,
                other => panic!("not a Codex record: {other:?}"),
            })
            .collect()
    }

    /// An unknown method gets -32601 under its own id, written once and
    /// journaled once, even when the same request line is seen again.
    #[test]
    fn an_unknown_method_gets_32601_journaled_once() {
        let driver = driver();
        let written = RefCell::new(Vec::new());
        let request = json!({ "id": 7, "method": "future/thing", "params": {} });
        let write = |line: &Value| {
            written.borrow_mut().push(line.clone());
            WriteStatus::Written
        };
        let first = records(driver.answer_request(&request, write));
        let again = records(driver.answer_request(&request, write));
        assert_eq!(
            *written.borrow(),
            vec![json!({
                "jsonrpc": "2.0",
                "id": 7,
                "error": { "code": -32601, "message": "future/thing is not supported by Vidar" }
            })]
        );
        assert_eq!(
            first,
            vec![CodexRecord::ServerRequestAnswered {
                request: "sr:7".into(),
                method: "future/thing".into(),
                disposition: "unknown".into(),
                delivery: "written".into(),
                error: None,
            }]
        );
        assert!(again.is_empty(), "journaled twice: {again:?}");
    }

    /// Refusals answer with the table's result and `error` methods with the
    /// unsupported error; cards, notifications and responses get nothing.
    #[test]
    fn the_table_decides_each_answer_and_cards_are_left_alone() {
        let driver = driver();
        let written = RefCell::new(Vec::new());
        let write = |line: &Value| {
            written.borrow_mut().push(line.clone());
            WriteStatus::Written
        };
        let call = json!({ "id": "a", "method": "item/tool/call", "params": {} });
        let time = json!({ "id": 2, "method": "currentTime/read" });
        let approval = json!({ "id": 3, "method": "item/commandExecution/requestApproval" });
        let notification = json!({ "method": "turn/started", "params": {} });
        let response = json!({ "id": 4, "result": {} });
        let answered: Vec<CodexRecord> = [call, time, approval, notification, response]
            .iter()
            .flat_map(|line| records(driver.answer_request(line, write)))
            .collect();
        let written = written.into_inner();
        assert_eq!(written.len(), 2, "{written:?}");
        assert_eq!(written[0]["id"], json!("a"));
        assert_eq!(written[0]["result"]["success"], json!(false));
        assert_eq!(written[1]["error"]["code"], json!(-32601));
        let dispositions: Vec<(String, String)> = answered
            .into_iter()
            .map(|record| match record {
                CodexRecord::ServerRequestAnswered {
                    request,
                    disposition,
                    ..
                } => (request, disposition),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            dispositions,
            vec![
                ("sr:a".to_string(), "refused".to_string()),
                ("sr:2".to_string(), "error".to_string())
            ]
        );
    }

    /// A failed write is journaled with its fate and releases the id: a
    /// repeat of the request is answered, once, and a written answer is never
    /// sent again.
    #[test]
    fn an_unwritten_answer_is_journaled_with_its_fate() {
        let driver = driver();
        let request = json!({ "id": 9, "method": "attestation/generate" });
        let failed = records(driver.answer_request(&request, |_| {
            WriteStatus::NotWritten("child is stopping".into())
        }));
        assert_eq!(
            failed,
            vec![CodexRecord::ServerRequestAnswered {
                request: "sr:9".into(),
                method: "attestation/generate".into(),
                disposition: "error".into(),
                delivery: "not-written".into(),
                error: Some("child is stopping".into()),
            }]
        );
        let retried = records(driver.answer_request(&request, |_| WriteStatus::Written));
        assert!(
            matches!(&retried[..], [CodexRecord::ServerRequestAnswered { delivery, .. }] if delivery == "written"),
            "{retried:?}"
        );
        let again = driver.answer_request(&request, |_| panic!("answered twice"));
        assert!(again.is_empty());

        let unsure = json!({ "id": 10, "method": "attestation/generate" });
        driver.answer_request(&unsure, |_| WriteStatus::PossiblyDelivered("timed out".into()));
        let again = driver.answer_request(&unsure, |_| panic!("possibly delivered, answered twice"));
        assert!(again.is_empty());
    }

    /// Every method the table names maps to its disposition, and the
    /// contract's own refusals are the answers the host sends. (Whether they
    /// satisfy Codex's response schemas: `tests/codex-schema-drift.test.mjs`.)
    #[test]
    fn every_contract_method_has_a_disposition_the_host_honours() {
        let requests = contract()["requests"].as_object().unwrap();
        assert!(!requests.is_empty());
        for (method, entry) in requests {
            let disposition = disposition(method);
            match entry["disposition"].as_str().unwrap() {
                "card" => assert_eq!(disposition, Disposition::Card, "{method}"),
                "refuse" => {
                    assert_eq!(disposition, Disposition::Refuse(entry["refusal"].clone()));
                    let line = answer_line(&json!(1), method, &disposition).unwrap();
                    assert_eq!(line["result"], entry["refusal"], "{method}");
                }
                "error" => assert_eq!(disposition, Disposition::Error, "{method}"),
                other => panic!("{method}: unknown disposition {other}"),
            }
        }
        assert_eq!(disposition("no/such/method"), Disposition::Unknown);
        assert_eq!(contract()["unsupported"]["code"], json!(-32601));
    }

    #[test]
    fn the_record_has_a_stable_wire_shape() {
        let record = Body::Codex {
            codex: CodexRecord::ServerRequestAnswered {
                request: "sr:7".into(),
                method: "future/thing".into(),
                disposition: "unknown".into(),
                delivery: "written".into(),
                error: None,
            },
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            json!({
                "record": "codex",
                "codex": {
                    "kind": "server-request-answered",
                    "request": "sr:7",
                    "method": "future/thing",
                    "disposition": "unknown",
                    "delivery": "written"
                }
            })
        );
    }
}
