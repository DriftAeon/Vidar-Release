//! Paging a session's journal out to a client rebuilding state. Split from
//! `session.rs`: the page bounds and the lock discipline are their own concern.

use super::{lock, Session};
use crate::journal::{Body, JournalError, Record, LONE_RECORD_CAP};
use crate::protocol::EventBody;

impl Session {
    /// Records after `after`, up to `through`, bounded by BOTH a count and an
    /// encoded byte budget, for a client rebuilding state.
    ///
    /// A count alone is not a bound. Records are individually legal up to the
    /// journal's append cap ([`LONE_RECORD_CAP`]), so a page of a few large diagnostic lines can
    /// exceed the wire frame limit even though every record in it is valid —
    /// and an over-sized frame is not a clean error: the writer fails, exits,
    /// and the client is left with no hydration response at all.
    ///
    /// The first record of a page is carried even when it alone passes
    /// `byte_budget`, so every page makes progress. A record that cannot fit a
    /// wire frame on its own ([`LONE_RECORD_CAP`]) is replaced by an
    /// `Overflow` at the same seq rather than silently skipped: dropping it
    /// would hand the client a history it believes is complete and is not.
    pub fn hydrate_from(
        &self,
        after: u64,
        through: u64,
        limit: usize,
        byte_budget: usize,
    ) -> Result<(Vec<Record>, bool), JournalError> {
        // Only the page's position is taken under the lock; the read, digest
        // and parse run after it is released, so a reconnecting client never
        // stalls the stdout reader appending to this journal.
        let window = lock(&self.journal).window(after, through, limit, byte_budget);
        let available = window.read()?;

        let mut records = Vec::new();
        let mut used = 0usize;
        let mut more = false;
        for record in available.into_iter().filter(|record| record.seq <= through) {
            if records.len() >= limit {
                more = true;
                break;
            }
            let (record, size) = within_frame(record);
            // The first record always goes, even past the budget: refusing it
            // made every retry fail the same way, and that session could never
            // rehydrate again. `within_frame` already bounded it to a frame.
            if !records.is_empty() && used + size > byte_budget {
                // Not this page, but it will be the first of the next one.
                more = true;
                break;
            }
            used += size;
            records.push(record);
        }
        // The window already stopped at the count and the budget by the
        // journal's own byte sizes; this loop re-checks against the
        // re-encoded size and only ever trims further.
        Ok((records, more || window.more))
    }
}

/// `record` and its encoded size, or, when it cannot ride a wire frame on its
/// own, an `Overflow` naming its size in its place (same seq, generation and
/// time).
///
/// Append refuses such records now, but journals written before that cap
/// existed (847b995) can hold one up to `MAX_RECORD`. Failing hydrate on it
/// failed every retry the same way, so that session could never rehydrate;
/// the Overflow tells the client a record was lost without stopping the rest.
fn within_frame(record: Record) -> (Record, usize) {
    let size = encoded_len(&record);
    if size <= LONE_RECORD_CAP {
        return (record, size);
    }
    // A queued prompt keeps its record, with its content swapped for a marker: an
    // Overflow in its place would leave the `PromptDispatched` that follows naming a
    // prompt the client never saw, and a queued block would never settle.
    let body = match &record.body {
        Body::PromptQueued { prompt, .. } => Body::PromptQueued {
            prompt: prompt.clone(),
            content: serde_json::Value::String(oversized_prompt_marker(size)),
        },
        // Same for a prompt put back in the queue: its block must come back.
        Body::PromptRequeued { prompt, at, .. } => Body::PromptRequeued {
            prompt: prompt.clone(),
            content: serde_json::Value::String(oversized_prompt_marker(size)),
            at: *at,
        },
        _ => Body::Event {
            body: EventBody::Overflow { bytes: size as u64 },
        },
    };
    let substitute = Record { body, ..record };
    let size = encoded_len(&substitute);
    (substitute, size)
}

/// What a Rendered tab shows for a queued prompt too large to replay.
pub(crate) fn oversized_prompt_marker(bytes: usize) -> String {
    format!(
        "[A {:.1} MiB prompt is too large to replay]",
        bytes as f64 / 1_048_576.0
    )
}

fn encoded_len(record: &Record) -> usize {
    serde_json::to_vec(record)
        .map(|encoded| encoded.len())
        .unwrap_or(usize::MAX)
}
