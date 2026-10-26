//! The conversation ownership table, moved out of `session.rs` unchanged; nothing outside
//! [`Reservations`] touches the map (see the parent module's doc).

use std::collections::HashMap;

/// `(agent, conversation id) -> owning session id`, for every conversation this
/// host holds. Separate from `sessions` so a reservation can be taken before
/// the child exists and released independently of the session entry.
///
/// The value is never anonymous: [`super::Registry::reserve`] writes the id of the
/// session it is about to build, so a pending spawn's claim is as identifiable
/// as a committed one. Every mutation below is an ownership check.
#[derive(Default)]
pub(super) struct Reservations(HashMap<(&'static str, String), String>);

impl Reservations {
    /// Claim `key` for `holder`. Idempotent for the holder it already names,
    /// refused for anyone else: adoption fails closed instead of stealing, and
    /// the loser of a race learns who won.
    pub(super) fn claim(&mut self, key: (&'static str, String), holder: &str) -> Result<(), String> {
        if let Some(existing) = self.0.get(&key) {
            if existing == holder {
                return Ok(());
            }
            return Err(format!(
                "conversation {} is already hosted by session {existing}",
                key.1
            ));
        }
        self.0.insert(key, holder.to_string());
        Ok(())
    }

    /// Release one key, and only when `holder` owns it. Returns whether it did.
    pub(super) fn release_key(&mut self, key: &(&'static str, String), holder: &str) -> bool {
        if self.0.get(key).map(String::as_str) != Some(holder) {
            return false;
        }
        self.0.remove(key);
        true
    }

    /// Release every key `holder` owns. A session can own more than one: a CLI
    /// that reports a second conversation keeps the first (see
    /// [`super::Registry::adopt_conversation`]), and this is where those are freed.
    pub(super) fn release_all(&mut self, holder: &str) -> usize {
        let before = self.0.len();
        self.0.retain(|_, owner| owner.as_str() != holder);
        before - self.0.len()
    }

    #[cfg(test)]
    pub(super) fn holder(&self, agent: &'static str, conversation: &str) -> Option<String> {
        self.0.get(&(agent, conversation.to_string())).cloned()
    }
}
