//! The live event bus: per-connection topic subscriptions and the fan-out
//! that pushes a published frame to every matching one.

use std::sync::{Arc, Mutex};

use super::{lock, Client};
use crate::protocol::{BusFrame, ServerFrame};

/// One connection's bus subscription: which patterns it wants, and where to
/// push a matching frame.
struct BusSub {
    conn: u64,
    patterns: Vec<String>,
    client: Arc<Client>,
}

/// Live-only pub/sub across every connection on this host. No journal, no
/// replay — see [`crate::protocol::Op::Publish`].
pub struct BusHub {
    subs: Mutex<Vec<BusSub>>,
}

impl BusHub {
    pub fn new() -> Self {
        Self {
            subs: Mutex::new(Vec::new()),
        }
    }

    /// `Subscribe` replaces this connection's existing patterns rather than
    /// adding to them, so a client that resends its topic list never
    /// accumulates duplicates.
    pub(super) fn subscribe(&self, conn: u64, client: &Arc<Client>, patterns: Vec<String>) {
        let mut subs = lock(&self.subs);
        subs.retain(|sub| sub.conn != conn);
        subs.push(BusSub {
            conn,
            patterns,
            client: Arc::clone(client),
        });
    }

    /// Drop every subscription this connection holds. Called from the same
    /// teardown step as the attach drain (`serve_session`), not RAII: an
    /// `Arc<Client>` held here would otherwise delay the writer drain the
    /// same way an undetached attach subscriber does.
    pub(super) fn unsubscribe(&self, conn: u64) {
        lock(&self.subs).retain(|sub| sub.conn != conn);
    }

    /// Fan `frame` out to every subscription whose pattern matches its topic,
    /// through the same non-blocking `client.send` the attach `Subscriber`
    /// uses. Returns how many subscribers it reached.
    pub(super) fn publish(&self, frame: &BusFrame) -> usize {
        let subs = lock(&self.subs);
        let mut delivered = 0usize;
        for sub in subs.iter() {
            if sub
                .patterns
                .iter()
                .any(|pattern| topic_matches(pattern, &frame.topic))
                && sub.client.send(ServerFrame::Bus(frame.clone())).is_ok()
            {
                delivered += 1;
            }
        }
        delivered
    }
}

impl Default for BusHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Exact match, or a pattern ending `.*` matching every topic with that
/// prefix followed by a `.` — `"ask.*"` matches `"ask.open"` but not
/// `"asking"`.
fn topic_matches(pattern: &str, topic: &str) -> bool {
    match pattern.strip_suffix(".*") {
        Some(prefix) => topic.starts_with(prefix) && topic[prefix.len()..].starts_with('.'),
        None => pattern == topic,
    }
}
