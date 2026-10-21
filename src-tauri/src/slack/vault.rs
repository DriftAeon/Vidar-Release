//! The Slack user token in Windows Credential Manager (docs/projects/slack/inbox-tab-plan.md § Rust):
//! target `Vidar/Slack/<root key>`, UserName the Slack user id, Comment `"<team_id> <host>"`, blob the
//! token. `credman` holds no validators, so every field is checked here before a write, and a saved
//! entry that fails the same checks is never used.

use crate::credman::{Cred, CredStore, Store};
use crate::net::Secret;

use super::api::user_id_ok;
use super::parse::host_ok;

pub const TARGET_PREFIX: &str = "Vidar/Slack/";
pub const TOKEN_MAX_BYTES: usize = 1024;
const TOKEN_PREFIX: &str = "xoxp-";

/// The live store for this install root.
pub fn store() -> CredStore {
    CredStore::for_install(TARGET_PREFIX)
}

/// A user token (`xoxp-` then more), 1-1024 bytes of printable ASCII with no whitespace. The message
/// never echoes the token.
pub fn validate_token(token: &Secret) -> Result<(), String> {
    let t = token.expose();
    if t.is_empty() || t.len() > TOKEN_MAX_BYTES {
        return Err(format!("token must be 1-{TOKEN_MAX_BYTES} bytes"));
    }
    if !t.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("token must be printable ASCII with no spaces".to_string());
    }
    if !t.starts_with(TOKEN_PREFIX) || t.len() == TOKEN_PREFIX.len() {
        return Err("token must be a Slack user token".to_string());
    }
    Ok(())
}

/// `T` then 2-31 uppercase letters or digits (Enterprise Grid ids are out of scope).
pub fn team_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (3..=32).contains(&b.len()) && b[0] == b'T' && b.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

pub fn comment(team: &str, host: &str) -> String {
    format!("{team} {host}")
}

/// `"<team_id> <host>"` with one space; a bad team or a host failing `parse::host_ok` is `None`.
pub fn parse_comment(comment: &str) -> Option<(String, String)> {
    let (team, host) = comment.split_once(' ')?;
    (team_ok(team) && host_ok(host)).then(|| (team.to_string(), host.to_string()))
}

/// A saved connection: who, which workspace, which host, and the token.
#[derive(Debug)]
pub struct Saved {
    pub user: String,
    pub team: String,
    pub host: String,
    pub token: Secret,
}

/// Why a load failed: the store could not be read (transient), or an entry exists that this build
/// would not have written. Neither text carries credential data.
#[derive(Debug, PartialEq, Eq)]
pub enum LoadError {
    Read(String),
    Invalid(String),
}

#[cfg(test)]
impl LoadError {
    pub fn message(&self) -> &str {
        match self {
            LoadError::Read(m) | LoadError::Invalid(m) => m,
        }
    }
}

/// The saved connection, `None` when nothing is saved, `Err` when the read failed or an entry exists
/// that this build would not have written.
pub fn load(store: &dyn Store) -> Result<Option<Saved>, LoadError> {
    let Some(c) = store.read().map_err(LoadError::Read)? else { return Ok(None) };
    let bad = || LoadError::Invalid("saved Slack credential is not valid; connect again".to_string());
    let (team, host) = parse_comment(&c.comment).ok_or_else(bad)?;
    if !user_id_ok(&c.user) || validate_token(&c.blob).is_err() {
        return Err(bad());
    }
    Ok(Some(Saved { user: c.user, team, host, token: c.blob }))
}

pub fn save(store: &dyn Store, token: &Secret, user: &str, team: &str, host: &str) -> Result<(), String> {
    validate_token(token)?;
    if !user_id_ok(user) || !team_ok(team) || !host_ok(host) {
        return Err("workspace identity is not valid".to_string());
    }
    store.write(&Cred { user: user.to_string(), comment: comment(team, host), blob: Secret::new(token.expose().to_string()) })
}

#[cfg(test)]
pub mod memory {
    use super::*;
    use std::sync::Mutex;

    /// An in-memory `Store`, shareable across threads.
    #[derive(Default)]
    pub struct Memory {
        pub saved: Mutex<Option<(String, String, String)>>,
    }

    impl Memory {
        pub fn empty(&self) -> bool {
            self.saved.lock().unwrap().is_none()
        }
    }

    impl Store for Memory {
        fn read(&self) -> Result<Option<Cred>, String> {
            Ok(self.saved.lock().unwrap().as_ref().map(|(u, c, b)| Cred {
                user: u.clone(),
                comment: c.clone(),
                blob: Secret::new(b.clone()),
            }))
        }

        fn write(&self, c: &Cred) -> Result<(), String> {
            *self.saved.lock().unwrap() = Some((c.user.clone(), c.comment.clone(), c.blob.expose().to_string()));
            Ok(())
        }

        fn delete(&self) -> Result<(), String> {
            *self.saved.lock().unwrap() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn token_shape_refuses_non_user_tokens() {
        assert!(validate_token(&Secret::new("xoxp-1111-2222-fixture".into())).is_ok());
        assert!(validate_token(&Secret::new(format!("xoxp-{}", "a".repeat(1019)))).is_ok());
        let long = format!("xoxp-{}", "a".repeat(1020));
        for bad in [
            "",
            "xoxp-",
            "xoxb-1111-2222-fixture",
            "xoxe-1-2-fixture",
            "xapp-1-A0-fixture",
            "xoxp 1111",
            "xoxp-1111\n",
            "xoxp-\u{e9}",
            "XOXP-1111",
            long.as_str(),
        ] {
            let e = validate_token(&Secret::new(bad.into())).unwrap_err();
            assert!(bad.is_empty() || !e.contains(bad), "{e}");
        }
    }

    #[test]
    fn comment_parse_refuses_bad_team_or_host() {
        let ok = comment("T0FIXTURE1", "example.slack.com");
        assert_eq!(parse_comment(&ok), Some(("T0FIXTURE1".to_string(), "example.slack.com".to_string())));
        for bad in [
            "t0fixture1 example.slack.com",
            "X0FIXTURE1 example.slack.com",
            "T example.slack.com",
            "T0FIXTURE1 example.slack.com.evil.com",
            "T0FIXTURE1 evil.com",
            "T0FIXTURE1 slack.com",
            "T0FIXTURE1 -a.slack.com",
            "T0FIXTURE1 Example.slack.com",
            "T0FIXTURE1  example.slack.com",
            "T0FIXTURE1 example.slack.com extra",
            "T0FIXTURE1",
            "",
        ] {
            assert_eq!(parse_comment(bad), None, "{bad}");
        }
    }

    #[test]
    fn target_is_slack_keyed_by_root() {
        let t = crate::credman::target_for(TARGET_PREFIX, Path::new(r"C:\Example\Vidar"));
        assert!(t.starts_with("Vidar/Slack/"));
        assert_eq!(t.len(), "Vidar/Slack/".len() + 16);
    }

    #[test]
    fn load_refuses_an_entry_this_build_did_not_write() {
        let m = memory::Memory::default();
        assert!(load(&m).unwrap().is_none());
        let token = Secret::new("xoxp-1-2-fixture".into());
        save(&m, &token, "U0FIXTURE1", "T0FIXTURE1", "example.slack.com").unwrap();
        let s = load(&m).unwrap().unwrap();
        assert_eq!((s.user.as_str(), s.team.as_str(), s.host.as_str()), ("U0FIXTURE1", "T0FIXTURE1", "example.slack.com"));
        assert!(save(&m, &token, "bad", "T0FIXTURE1", "example.slack.com").is_err());
        assert!(save(&m, &Secret::new("xoxb-1".into()), "U0FIXTURE1", "T0FIXTURE1", "example.slack.com").is_err());
        *m.saved.lock().unwrap() = Some(("U0FIXTURE1".into(), "T0FIXTURE1 evil.com".into(), "xoxp-1-2-fixture".into()));
        let e = load(&m).unwrap_err();
        assert!(matches!(e, LoadError::Invalid(_)));
        assert!(!e.message().contains("xoxp"), "{e:?}");
    }

    /// Windows Credential Manager round trip on a disposable target, never the installed one.
    /// Run alone: `cargo test --bin vidar slack::vault -- --ignored`.
    #[test]
    #[ignore = "writes and deletes a real Credential Manager entry"]
    fn vault_round_trip_on_disposable_target() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let target = format!("{TARGET_PREFIX}test-{}-{nanos}", std::process::id());
        // Deletes the throwaway target on every path, a failed assert included.
        struct Cleanup(CredStore);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete();
            }
        }
        let cleanup = Cleanup(CredStore::new(target));
        let store = &cleanup.0;
        let token = Secret::new("xoxp-1-2-roundtrip".into());
        assert!(load(store).unwrap().is_none());
        save(store, &token, "U0FIXTURE1", "T0FIXTURE1", "example.slack.com").unwrap();
        let s = load(store).unwrap().unwrap();
        assert_eq!(s.token.expose(), "xoxp-1-2-roundtrip");
        assert_eq!((s.user.as_str(), s.host.as_str()), ("U0FIXTURE1", "example.slack.com"));
        store.delete().unwrap();
        assert!(load(store).unwrap().is_none());
    }
}
