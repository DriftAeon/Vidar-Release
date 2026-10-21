//! Read-only app-server requests. The requesting connection waits for its own
//! response; the stdout reader consumes the reply without publishing a line.

use super::{lock, CodexDriver};
use crate::{claude::COMMAND_TIMEOUT, process::WriteStatus, protocol::Outcome};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::mpsc};

#[derive(Default)]
pub(super) struct Queries {
    pub pending: HashMap<u64, mpsc::Sender<Value>>,
}

pub(super) fn allowed(method: &str) -> bool {
    matches!(method, "model/list" | "skills/list" | "account/read")
}

impl CodexDriver {
    pub fn query_with(
        &self,
        method: &str,
        params: Value,
        write: impl FnOnce(&Value) -> WriteStatus,
    ) -> Result<Value, (Outcome, String)> {
        if !allowed(method) {
            return Err((
                Outcome::Failed,
                format!("Codex query method {method} is not allowed"),
            ));
        }
        if !params.is_object() {
            return Err((
                Outcome::Failed,
                "Codex query params must be an object".into(),
            ));
        }
        let id = self.reserve_command();
        let (sender, receiver) = mpsc::channel();
        lock(&self.queries).pending.insert(id, sender);
        lock(&self.host_replies).insert(id);
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        match write(&line) {
            WriteStatus::Written => {}
            WriteStatus::NotWritten(why) => {
                lock(&self.queries).pending.remove(&id);
                lock(&self.host_replies).remove(&id);
                return Err((Outcome::Failed, why));
            }
            WriteStatus::PossiblyDelivered(why) => {
                lock(&self.queries).pending.remove(&id);
                return Err((Outcome::DeliveryUnknown, why));
            }
        }
        match receiver.recv_timeout(COMMAND_TIMEOUT) {
            Ok(response) => Ok(response),
            Err(error) => {
                lock(&self.queries).pending.remove(&id);
                Err((
                    Outcome::DeliveryUnknown,
                    format!("no answer to {method} query {id}: {error}"),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        claude::Observed,
        protocol::{Agent, SpawnParams},
    };
    use std::{sync::Arc, time::Duration};

    fn driver() -> Arc<CodexDriver> {
        Arc::new(CodexDriver::new(&SpawnParams {
            agent: Some(Agent::Codex),
            cwd: "C:/work".into(),
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
        }))
    }

    #[test]
    fn only_the_asking_query_receives_its_reply() {
        let driver = driver();
        let (writes, lines) = mpsc::channel();
        let mut waiters = Vec::new();
        for method in ["model/list", "skills/list"] {
            let driver = Arc::clone(&driver);
            let writes = writes.clone();
            waiters.push(std::thread::spawn(move || {
                driver.query_with(method, json!({}), |line| {
                    writes.send(line.clone()).unwrap();
                    WriteStatus::Written
                })
            }));
        }
        let first = lines.recv_timeout(Duration::from_secs(2)).unwrap();
        let second = lines.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_ne!(first["id"], second["id"]);
        assert!(matches!(
            driver
                .observe(&json!({ "id": first["id"], "result": { "tag": first["method"] } }))
                .0,
            Observed::Consumed
        ));
        assert!(matches!(
            driver
                .observe(&json!({ "id": second["id"], "result": { "tag": second["method"] } }))
                .0,
            Observed::Consumed
        ));
        let replies: Vec<_> = waiters
            .into_iter()
            .map(|waiter| waiter.join().unwrap().unwrap())
            .collect();
        assert_eq!(replies[0]["result"]["tag"], "model/list");
        assert_eq!(replies[1]["result"]["tag"], "skills/list");
        assert!(lock(&driver.queries).pending.is_empty());
        assert!(driver.take_records().is_empty());
    }

    #[test]
    fn a_method_off_the_allowlist_never_touches_the_child() {
        let driver = driver();
        let result = driver.query_with("thread/start", json!({}), |_| panic!("child write"));
        assert!(matches!(result, Err((Outcome::Failed, _))));
        assert!(lock(&driver.queries).pending.is_empty());
    }
}
