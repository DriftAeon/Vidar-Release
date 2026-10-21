//! Host-owned resume history. The stdout reader pages Codex and publishes
//! small, durable envelopes; no renderer sends app-server history requests.

use super::*;
use std::collections::HashSet;
use std::time::{Duration, Instant};

const PAGE_LIMIT: usize = 200;
const MAX_PAGES: usize = 10;
const MAX_TURNS: usize = 2_000;
// Leave room for the journal and client event wrappers as well as JSON escaping.
const HISTORY_LINE_CAP: usize = crate::process::LINE_CAP - 64 * 1024;
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct History {
    pub pending: Option<u64>,
    pending_since: Option<Instant>,
    pub done: bool,
    started: bool,
    pages: usize,
    count: usize,
    truncated: bool,
    cursors: HashSet<String>,
    turns: HashSet<String>,
}

pub(crate) struct Update {
    pub lines: Vec<Value>,
    pub finished: bool,
}

impl History {
    fn finish(&mut self, error: Option<String>) -> Update {
        self.done = true;
        self.pending = None;
        self.pending_since = None;
        Update {
            lines: vec![json!({"method":"falcon/history","params":{
                "phase":"end", "count":self.count,
                "truncated":self.truncated || error.is_some(), "error":error
            }})],
            finished: true,
        }
    }

    fn request(&mut self, driver: &CodexDriver, thread: &str, cursor: Option<&str>) -> Value {
        let id = driver.reserve_command();
        self.pending = Some(id);
        self.pending_since = Some(Instant::now());
        let mut params = json!({
            "threadId": thread, "itemsView":"full", "sortDirection":"asc", "limit":PAGE_LIMIT
        });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        json!({"jsonrpc":"2.0", "id":id, "method":"thread/turns/list", "params":params})
    }

    pub fn step(
        &mut self,
        driver: &CodexDriver,
        message: &Value,
        write: impl FnOnce(&Value) -> WriteStatus,
    ) -> Option<Update> {
        let id = message.get("id")?.as_u64()?;
        if id == THREAD_ID && !self.started && !self.done {
            let result = message.get("result")?;
            let thread = result.pointer("/thread/id")?.as_str()?;
            self.started = true;
            let mut lines = vec![json!({"method":"falcon/thread","params":{
                "result":{
                    "thread":{"id":thread, "model":result.pointer("/thread/model")},
                    "model":result.get("model"), "cwd":result.get("cwd"),
                    "reasoningEffort":result.get("reasoningEffort"),
                    "approvalsReviewer":result.get("approvalsReviewer")
                }, "resumed":driver.resume.is_some()
            }})];
            if driver.resume.is_none() {
                self.done = true;
                return Some(Update {
                    lines,
                    finished: false,
                });
            }
            lines.push(json!({"method":"falcon/history","params":{"phase":"start"}}));
            let request = self.request(driver, thread, None);
            if let Some(error) = write_error(write(&request)) {
                let ended = self.finish(Some(error));
                lines.extend(ended.lines);
                return Some(Update {
                    lines,
                    finished: true,
                });
            }
            return Some(Update {
                lines,
                finished: false,
            });
        }
        if self.done || self.pending != Some(id) {
            return None;
        }
        self.pending = None;
        self.pending_since = None;
        let Some(result) = message.get("result") else {
            let reason = message
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("history request failed");
            return Some(self.finish(Some(reason.into())));
        };
        let Some(data) = result.get("data").and_then(Value::as_array) else {
            return Some(self.finish(Some("invalid history page".into())));
        };
        let cursor = match result.get("nextCursor") {
            None | Some(Value::Null) => None,
            Some(Value::String(cursor)) if !cursor.is_empty() => Some(cursor.as_str()),
            Some(Value::String(_)) => None,
            _ => return Some(self.finish(Some("invalid history cursor".into()))),
        };
        if cursor.is_some_and(|next| self.cursors.contains(next)) {
            return Some(self.finish(Some("history cursor repeated".into())));
        }
        let mut lines = Vec::new();
        for turn in data {
            let Some(turn_id) = turn
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                let ended = self.finish(Some("invalid history turn".into()));
                lines.extend(ended.lines);
                return Some(Update {
                    lines,
                    finished: true,
                });
            };
            if !turn.get("items").is_some_and(Value::is_array) {
                let ended = self.finish(Some("invalid history turn items".into()));
                lines.extend(ended.lines);
                return Some(Update {
                    lines,
                    finished: true,
                });
            }
            if !self.turns.insert(turn_id.into()) {
                continue;
            }
            if self.turns.len() > MAX_TURNS {
                self.truncated = true;
                break;
            }
            let line = json!({"method":"falcon/history","params":{"phase":"turn","turn":turn}});
            if serde_json::to_vec(&line).map_or(true, |bytes| bytes.len() >= HISTORY_LINE_CAP) {
                self.truncated = true;
                continue;
            }
            self.count += 1;
            lines.push(line);
        }
        self.pages += 1;
        if let Some(cursor) =
            cursor.filter(|_| self.pages < MAX_PAGES && self.turns.len() <= MAX_TURNS)
        {
            self.cursors.insert(cursor.into());
            let thread = driver.thread().ok()?;
            let request = self.request(driver, &thread, Some(cursor));
            if let Some(error) = write_error(write(&request)) {
                let ended = self.finish(Some(error));
                lines.extend(ended.lines);
                return Some(Update {
                    lines,
                    finished: true,
                });
            }
            return Some(Update {
                lines,
                finished: false,
            });
        }
        self.truncated |= cursor.is_some();
        let ended = self.finish(None);
        lines.extend(ended.lines);
        Some(Update {
            lines,
            finished: true,
        })
    }

    pub fn closed(&mut self) -> Option<Update> {
        if self.done {
            None
        } else {
            Some(self.finish(Some("app-server stdout closed".into())))
        }
    }

    pub fn failed(&mut self, reason: &str) -> Option<Update> {
        if self.done {
            None
        } else {
            Some(self.finish(Some(reason.into())))
        }
    }

    pub fn timeout(&mut self) -> Option<Update> {
        if self.done
            || !self
                .pending_since
                .is_some_and(|at| at.elapsed() >= PAGE_TIMEOUT)
        {
            return None;
        }
        Some(self.finish(Some("history page timed out".into())))
    }
}

fn write_error(status: WriteStatus) -> Option<String> {
    match status {
        WriteStatus::Written => None,
        WriteStatus::NotWritten(error) | WriteStatus::PossiblyDelivered(error) => Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_pages_history_with_bounded_lines_and_one_terminal_outcome() {
        let driver = CodexDriver::new(&crate::codex::driver::tests::params(Some("thread-1")));
        driver.ready_for_test("thread-1");
        let mut history = History::default();
        let mut requests = Vec::new();
        let started = history
            .step(
                &driver,
                &json!({"id":THREAD_ID,"result":{"thread":{"id":"thread-1"}}}),
                |line| {
                    requests.push(line.clone());
                    WriteStatus::Written
                },
            )
            .unwrap();
        assert_eq!(started.lines[0]["method"], "falcon/thread");
        assert_eq!(started.lines[1]["params"]["phase"], "start");
        assert_eq!(requests[0]["params"]["limit"], PAGE_LIMIT);
        let first_id = requests[0]["id"].clone();
        let first = history.step(&driver,
            &json!({"id":first_id,"result":{"data":[{"id":"a","items":[]}],"nextCursor":"next"}}),
            |line| { requests.push(line.clone()); WriteStatus::Written }).unwrap();
        assert!(!first.finished);
        assert_eq!(first.lines[0]["params"]["turn"]["id"], "a");
        assert_eq!(requests[1]["params"]["cursor"], "next");
        let second_id = requests[1]["id"].clone();
        let last = history.step(&driver,
            &json!({"id":second_id,"result":{"data":[{"id":"a","items":[]},{"id":"b","items":[]}]}}),
            |_| panic!("last page sends no request")).unwrap();
        assert!(last.finished);
        assert_eq!(last.lines.len(), 2, "duplicate turn is skipped");
        assert_eq!(last.lines[0]["params"]["turn"]["id"], "b");
        assert_eq!(last.lines[1]["params"]["count"], 2);
        assert!(last
            .lines
            .iter()
            .all(|line| serde_json::to_vec(line).unwrap().len() < crate::process::LINE_CAP));
    }

    #[test]
    fn an_oversized_turn_is_skipped_and_the_outcome_names_truncation() {
        let driver = CodexDriver::new(&crate::codex::driver::tests::params(Some("thread-1")));
        driver.ready_for_test("thread-1");
        let mut history = History::default();
        let mut request = Value::Null;
        history
            .step(
                &driver,
                &json!({"id":THREAD_ID,"result":{"thread":{"id":"thread-1"}}}),
                |line| {
                    request = line.clone();
                    WriteStatus::Written
                },
            )
            .unwrap();
        let result = history
            .step(
                &driver,
                &json!({"id":request["id"],"result":{"data":[{"id":"large","items":[{
                    "type":"agentMessage", "text":"x".repeat(crate::process::LINE_CAP)
                }]}]}}),
                |_| panic!("one page sends no next request"),
            )
            .unwrap();
        assert!(result.finished);
        assert_eq!(result.lines.len(), 1, "oversized turn is never published");
        assert_eq!(result.lines[0]["params"]["truncated"], true);
    }

    #[test]
    fn a_page_that_never_replies_gets_a_terminal_failure() {
        let driver = CodexDriver::new(&crate::codex::driver::tests::params(Some("thread-1")));
        driver.ready_for_test("thread-1");
        let mut history = History::default();
        history
            .step(
                &driver,
                &json!({"id":THREAD_ID,"result":{"thread":{"id":"thread-1"}}}),
                |_| WriteStatus::Written,
            )
            .unwrap();
        history.pending_since = Some(Instant::now() - PAGE_TIMEOUT);
        let outcome = history.timeout().unwrap();
        assert!(outcome.finished);
        assert_eq!(
            outcome.lines[0]["params"]["error"],
            "history page timed out"
        );
        assert!(history.timeout().is_none(), "the outcome is emitted once");
    }
}
