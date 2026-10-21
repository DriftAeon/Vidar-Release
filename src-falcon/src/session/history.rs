//! Serializes history page handling, its terminal outcome and a timeout.
//! The flow lock prevents a timeout racing a page already being published.

use super::{lock, AgentDriver, DeferredHistoryEvent, Session};
use crate::protocol::EventBody;
use serde_json::Value;

impl Session {
    /// History envelopes bypass the live-output barrier. The terminal envelope
    /// and queued output share this lock, so an attach sees one ordered cut.
    pub fn publish_history(&self, body: EventBody, finished: bool) -> bool {
        let mut barrier = lock(&self.history_barrier);
        if let Err(error) = self.publish_durable(body) {
            eprintln!("falcon {}: history journal append failed: {error}", self.id);
            return false;
        }
        if finished {
            if let Some(pending) = barrier.take() {
                for item in pending {
                    match item {
                        DeferredHistoryEvent::Event(body) => {
                            if let Err(error) = self.publish_durable(body) {
                                eprintln!("falcon {}: deferred event failed: {error}", self.id);
                            }
                        }
                        DeferredHistoryEvent::Record(body) => {
                            if let Err(error) = self.record(body) {
                                eprintln!("falcon {}: deferred record failed: {error}", self.id);
                            }
                        }
                    }
                }
            }
        }
        true
    }

    pub fn codex_history_line(&self, value: &Value) -> bool {
        let AgentDriver::Codex(driver) = &self.driver else {
            return false;
        };
        let _flow = lock(&self.history_flow);
        let Some(update) = driver.history_line(value, &self.child) else {
            return false;
        };
        self.publish_codex_history(update);
        true
    }

    pub fn codex_history_closed(&self) {
        let AgentDriver::Codex(driver) = &self.driver else {
            return;
        };
        let _flow = lock(&self.history_flow);
        if let Some(update) = driver.history_closed() {
            self.publish_codex_history(update);
        }
    }

    pub fn codex_history_failed(&self, reason: &str) {
        let AgentDriver::Codex(driver) = &self.driver else {
            return;
        };
        let _flow = lock(&self.history_flow);
        if let Some(update) = driver.history_failed(reason) {
            self.publish_codex_history(update);
        }
    }

    pub fn codex_history_timeout(&self) -> bool {
        let AgentDriver::Codex(driver) = &self.driver else {
            return true;
        };
        let _flow = lock(&self.history_flow);
        if let Some(update) = driver.history_timeout() {
            self.publish_codex_history(update);
        }
        driver.history_done()
    }

    fn publish_codex_history(&self, update: crate::codex::HistoryUpdate) {
        let AgentDriver::Codex(driver) = &self.driver else {
            return;
        };
        let last = update.lines.len().saturating_sub(1);
        for (index, line) in update.lines.into_iter().enumerate() {
            if !self.publish_history(EventBody::Agent { line }, update.finished && index == last) {
                self.child.terminate_tree();
                return;
            }
        }
        if update.finished {
            driver.history_was_published();
        }
    }
}
