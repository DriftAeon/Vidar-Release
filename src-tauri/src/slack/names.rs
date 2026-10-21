//! User-name cache (docs/projects/slack/inbox-tab-plan.md § Rust, C15). Keyed by `(team, user,
//! generation)`: a rekey clears it, and a worker holding a stale key cannot repopulate it. The cache
//! never sends: a caller takes `missing` (at most `LOOKUPS` ids) under the lock, releases it, fetches
//! `users.info` for each, then `put`s the names under the key it started with (a stale key stores nothing).

use std::collections::HashMap;

use serde_json::Value;

use super::api;
use super::parse::NAME_CAP;

pub const ENTRIES: usize = 2000;
pub const LOOKUPS: usize = 10;

/// Whose names these are: team id, user id and the connect generation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub team: String,
    pub user: String,
    pub generation: u64,
}

#[derive(Debug, Default)]
pub struct NameCache {
    key: Option<Key>,
    names: HashMap<String, String>,
}

impl NameCache {
    pub fn new() -> Self {
        NameCache::default()
    }

    /// Makes `key` current and returns true; a different key (another identity or a newer generation)
    /// clears the cache. Returns false and leaves the state untouched when the same team and user come
    /// back with a lower generation than the current key's (a late worker from before a reconnect).
    pub fn rekey(&mut self, key: Key) -> bool {
        if let Some(cur) = &self.key {
            if cur.team == key.team && cur.user == key.user && key.generation < cur.generation {
                return false;
            }
        }
        if self.key.as_ref() != Some(&key) {
            self.names.clear();
            self.key = Some(key);
        }
        true
    }

    /// Disconnect: no key, nothing cached, every outstanding worker stale.
    pub fn clear(&mut self) {
        self.key = None;
        self.names.clear();
    }

    pub fn is_current(&self, key: &Key) -> bool {
        self.key.as_ref() == Some(key)
    }

    pub fn get(&self, key: &Key, id: &str) -> Option<String> {
        if self.is_current(key) {
            self.names.get(id).cloned()
        } else {
            None
        }
    }

    /// Stores a name only for the current key and while under `ENTRIES`; returns whether it was kept.
    pub fn put(&mut self, key: &Key, id: &str, name: &str) -> bool {
        if !self.is_current(key) || !api::user_id_ok(id) || name.is_empty() {
            return false;
        }
        if self.names.len() >= ENTRIES && !self.names.contains_key(id) {
            return false;
        }
        self.names.insert(id.to_string(), name.to_string());
        true
    }

    /// Ids not cached yet, first-seen order, at most `cap` (use `LOOKUPS`).
    pub fn missing(&self, key: &Key, ids: &[String], cap: usize) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for id in ids {
            if out.len() >= cap {
                break;
            }
            if api::user_id_ok(id) && self.get(key, id).is_none() && !out.contains(id) {
                out.push(id.clone());
            }
        }
        out
    }
}

/// The C15 order from a `users.info` body: `profile.display_name`, then `real_name` (profile, then
/// user), then `name`; control characters dropped, at most `NAME_CAP` chars.
pub fn name_from_user_info(body: &Value) -> Option<String> {
    let user = body.get("user")?;
    [
        user.pointer("/profile/display_name"),
        user.pointer("/profile/real_name"),
        user.get("real_name"),
        user.get("name"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .map(|s| s.chars().filter(|c| !c.is_control()).take(NAME_CAP).collect::<String>().trim().to_string())
    .find(|s| !s.is_empty())
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key(generation: u64) -> Key {
        Key { team: "T0FIXTURE1".into(), user: "U0FIXTURE1".into(), generation }
    }

    fn info(display: &str, real: &str, name: &str) -> Value {
        json!({ "ok": true, "user": { "name": name, "real_name": real, "profile": { "display_name": display, "real_name": real } } })
    }

    #[test]
    fn cache_from_stale_generation_is_dropped() {
        let mut cache = NameCache::new();
        let old = key(1);
        cache.rekey(old.clone());
        assert!(cache.put(&old, "U0FIXTURE2", "Ada"));
        assert_eq!(cache.get(&old, "U0FIXTURE2").as_deref(), Some("Ada"));
        // Disconnect and reconnect: the generation moves on and the old names are gone.
        let new = key(2);
        cache.rekey(new.clone());
        assert_eq!(cache.get(&new, "U0FIXTURE2"), None);
        assert_eq!(cache.get(&old, "U0FIXTURE2"), None);
        // A worker still holding generation 1 cannot repopulate it.
        assert!(!cache.put(&old, "U0FIXTURE3", "Stale"));
        assert_eq!(cache.get(&new, "U0FIXTURE3"), None);
        // Another identity under the same generation also clears.
        let other = Key { user: "U0FIXTURE9".into(), ..new.clone() };
        assert!(cache.put(&new, "U0FIXTURE4", "Bo"));
        cache.rekey(other.clone());
        assert_eq!(cache.get(&other, "U0FIXTURE4"), None);
        cache.clear();
        assert!(!cache.put(&other, "U0FIXTURE4", "Bo"));
    }

    #[test]
    fn missing_caps_lookups_and_keeps_name_order() {
        let mut cache = NameCache::new();
        let k = key(1);
        cache.rekey(k.clone());
        let ids: Vec<String> = (0..15).map(|i| format!("U0FIX{i:04}")).chain(["bad id".to_string()]).collect();
        let first = cache.missing(&k, &ids, LOOKUPS);
        assert_eq!(first.len(), LOOKUPS);
        assert_eq!(first[0], "U0FIX0000");
        for id in &first {
            assert!(cache.put(&k, id, "Real Name"));
        }
        assert_eq!(cache.get(&k, "U0FIX0000").as_deref(), Some("Real Name"));
        assert_eq!(cache.missing(&k, &ids, LOOKUPS).len(), 5);
        // A stale key gets nothing to fetch and stores nothing.
        assert!(cache.missing(&key(0), &ids, LOOKUPS).len() == LOOKUPS);
        assert!(!cache.put(&key(0), "U0FIX0014", "Late"));
        assert_eq!(name_from_user_info(&info("Disp", "Real", "h")).as_deref(), Some("Disp"));
        assert_eq!(name_from_user_info(&info(" ", "", "h")).as_deref(), Some("h"));
        assert_eq!(name_from_user_info(&json!({ "ok": true })), None);
    }

    #[test]
    fn rekey_refuses_older_generation() {
        let mut cache = NameCache::new();
        assert!(cache.rekey(key(2)));
        assert!(cache.put(&key(2), "U0FIXTURE2", "Ada"));
        assert!(!cache.rekey(key(1)));
        assert!(cache.is_current(&key(2)));
        assert_eq!(cache.get(&key(2), "U0FIXTURE2").as_deref(), Some("Ada"));
        assert!(!cache.put(&key(1), "U0FIXTURE3", "Old"));
        // Same key and newer generations still go through.
        assert!(cache.rekey(key(2)));
        assert_eq!(cache.get(&key(2), "U0FIXTURE2").as_deref(), Some("Ada"));
        assert!(cache.rekey(key(3)));
        assert_eq!(cache.get(&key(3), "U0FIXTURE2"), None);
    }
}
