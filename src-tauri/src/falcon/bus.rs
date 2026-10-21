//! Vidar's side of the Falcon bus: publish on the control connection, and a
//! dedicated subscriber connection with its own reconnect loop. Split from
//! `falcon.rs`; Vidar-only (`cfg(not(falcon_shell))` on the `mod` line), and it
//! reaches the parent through `super::` only (`.claude\rules\falcon-rs.md`).

use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

use serde_json::Value;

use super::{
    host_alive, read_registry, Connection, Falcon, Op, Outcome, REQUEST_TIMEOUT,
};

impl Falcon {
    /// True when a publish would not launch a host: a control connection is cached,
    /// or the registered host is alive. Racy by one syscall; good enough for the exit drain.
    pub fn bus_reachable_without_launch(&self) -> bool {
        if self.control.lock().map(|g| g.is_some()).unwrap_or(false) {
            return true;
        }
        read_registry(&self.paths).map(|r| host_alive(&r)).unwrap_or(false)
    }

    /// Publish on the bus through the existing `control()` path: the cached,
    /// long-lived control connection under `self.control`'s mutex, opened on
    /// demand and reused across calls — not a fresh connection per publish
    /// (a single connection cannot read
    /// and write, so publish never shares the *subscriber's* connection,
    /// which is the second, dedicated one `bus_subscribe` opens).
    pub fn bus_publish(
        &self,
        topic: &str,
        id: &str,
        payload: Value,
        reply_to: Option<&str>,
    ) -> Result<Value, String> {
        self.control(Op::Publish {
            topic: topic.to_string(),
            id: id.to_string(),
            payload,
            reply_to: reply_to.map(str::to_string),
        })
    }

    /// Open a SECOND, dedicated connection (never the control connection —
    /// same reason as `bus_publish`), subscribe `topics` on it, and loop
    /// turning `t:"bus"` frames into `on_frame` calls for Vidar's lifetime.
    /// Any other frame or a read error ends this pass and the thread
    /// reconnects after 2s (the host may restart); responses (the subscribe
    /// ack) are consumed by `request` before the loop starts and otherwise
    /// ignored. Started once, unconditionally, from `main.rs` setup — asks
    /// must always reach the card, so this pins the host for Vidar's
    /// lifetime.
    pub fn bus_subscribe<F>(self: &Arc<Self>, topics: Vec<String>, on_frame: F)
    where
        F: Fn(Value) + Send + 'static,
    {
        let falcon = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name("falcon-bus-sub".into())
            .spawn(move || {
                const MIN_BACKOFF: Duration = Duration::from_secs(2);
                const MAX_BACKOFF: Duration = Duration::from_secs(30);
                let mut backoff = MIN_BACKOFF;
                let mut failing = false;
                while !falcon.bus_stop.load(Ordering::SeqCst) {
                    match falcon.bus_connect_and_subscribe(&topics) {
                        Ok(mut connection) => {
                            if failing {
                                eprintln!("falcon-bus-sub: subscribe recovered on {topics:?}");
                                failing = false;
                            }
                            backoff = MIN_BACKOFF;
                            loop {
                                match connection.read_frame() {
                                    Ok(frame) => {
                                        if frame.get("t").and_then(Value::as_str) == Some("bus") {
                                            on_frame(frame);
                                            continue;
                                        }
                                        if frame.get("t").and_then(Value::as_str)
                                            == Some("response")
                                        {
                                            continue;
                                        }
                                        break; // unexpected frame type: reconnect
                                    }
                                    Err(_) => break,
                                }
                            }
                        }
                        Err(error) => {
                            if !failing {
                                eprintln!("falcon-bus-sub: subscribe failed, retrying: {error}");
                                failing = true;
                            }
                        }
                    }
                    if falcon.bus_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            });
    }

    /// Ends the `bus_subscribe` reconnect loop. Called from Vidar's exit path
    /// (`main.rs` `RunEvent::Exit`); a build that never reaches it simply
    /// never sets this, and the loop runs for the process's lifetime as
    /// before.
    pub fn stop_bus_subscribe(&self) {
        self.bus_stop.store(true, Ordering::SeqCst);
    }

    fn bus_connect_and_subscribe(&self, topics: &[String]) -> Result<Connection, String> {
        let alive = read_registry(&self.paths)
            .map(|registry| host_alive(&registry))
            .unwrap_or(false);
        if !alive {
            self.ensure_host()?;
        }
        let registry = read_registry(&self.paths)?;
        let mut connection = Connection::open(&registry)?;
        let id = self.next_id();
        let reply = connection.request(
            id,
            Op::Subscribe {
                topics: topics.to_vec(),
            },
            REQUEST_TIMEOUT,
        )?;
        if reply.outcome != Outcome::Applied {
            return Err(format!(
                "bus subscribe refused: {}",
                reply.error.unwrap_or_else(|| "no reason given".into())
            ));
        }
        Ok(connection)
    }
}
