//! The Notion token in Windows Credential Manager (plan § D6): target `Vidar/Notion/<root_suffix>`,
//! UserName the owner kind (`connection` or `personal`), Comment the workspace name, blob the
//! token. `credman` holds no validators, so the token is checked here before any write or send.

use crate::credman::{Cred, CredStore, Store};
use crate::net::Secret;

pub const TARGET_PREFIX: &str = "Vidar/Notion/";
pub const TOKEN_MAX_BYTES: usize = 1024;
pub const WORKSPACE_MAX_UNITS: usize = 256;

/// The live store for this install root.
pub fn store() -> CredStore {
    CredStore::for_install(TARGET_PREFIX)
}

/// 1-1024 bytes of printable ASCII with no whitespace; no prefix parse (`secret_` and `ntn_` both
/// exist). The message never echoes the token.
pub fn validate_token(token: &Secret) -> Result<(), String> {
    let t = token.expose().as_bytes();
    if t.is_empty() || t.len() > TOKEN_MAX_BYTES {
        return Err(format!("token must be 1-{TOKEN_MAX_BYTES} bytes"));
    }
    if !t.iter().all(|b| (0x21..=0x7e).contains(b)) {
        return Err("token must be printable ASCII with no spaces".to_string());
    }
    Ok(())
}

/// The owner kind `bot.owner.type` names: `user` is a personal access token, anything else an
/// internal connection (plan § D9; any token is accepted).
pub fn kind_from_owner(owner_type: &str) -> &'static str {
    if owner_type == "user" {
        "personal"
    } else {
        "connection"
    }
}

/// The saved kind, or None when UserName holds something this build did not write.
pub fn saved_kind(user: &str) -> Option<&'static str> {
    match user {
        "personal" => Some("personal"),
        "connection" => Some("connection"),
        _ => None,
    }
}

/// Control characters stripped, at most 256 UTF-16 units (the Credential Manager comment
/// limit), cut on a char boundary.
pub fn clean_workspace(name: &str) -> String {
    let mut units = 0;
    name.chars()
        .filter(|c| !c.is_control())
        .take_while(|c| {
            units += c.len_utf16();
            units <= WORKSPACE_MAX_UNITS
        })
        .collect()
}

pub fn save(store: &dyn Store, token: Secret, kind: &str, workspace: &str) -> Result<(), String> {
    validate_token(&token)?;
    store.write(&Cred { user: kind.to_string(), comment: clean_workspace(workspace), blob: token })
}

#[cfg(test)]
pub mod memory {
    use super::*;
    use std::cell::RefCell;

    /// An in-memory `Store`; `fail_reads` makes every read an error.
    #[derive(Default)]
    pub struct Memory {
        pub saved: RefCell<Option<(String, String, String)>>,
        pub fail_reads: bool,
    }

    impl Memory {
        pub fn with_token(token: &str) -> Self {
            let m = Memory::default();
            *m.saved.borrow_mut() = Some(("connection".into(), "Example Workspace".into(), token.into()));
            m
        }
    }

    impl Store for Memory {
        fn read(&self) -> Result<Option<Cred>, String> {
            if self.fail_reads {
                return Err("CredReadW failed (5)".to_string());
            }
            Ok(self.saved.borrow().as_ref().map(|(u, c, b)| Cred {
                user: u.clone(),
                comment: c.clone(),
                blob: Secret::new(b.clone()),
            }))
        }

        fn write(&self, c: &Cred) -> Result<(), String> {
            *self.saved.borrow_mut() = Some((c.user.clone(), c.comment.clone(), c.blob.expose().to_string()));
            Ok(())
        }

        fn delete(&self) -> Result<(), String> {
            *self.saved.borrow_mut() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn target_is_notion_keyed_by_root() {
        let t = crate::credman::target_for(TARGET_PREFIX, Path::new(r"C:\Example\Vidar"));
        assert!(t.starts_with("Vidar/Notion/"));
        assert_eq!(t.len(), "Vidar/Notion/".len() + 16);
    }

    #[test]
    fn token_rules_never_echo_the_token() {
        assert!(validate_token(&Secret::new("ntn_abc123".into())).is_ok());
        assert!(validate_token(&Secret::new("secret_abc".into())).is_ok());
        assert!(validate_token(&Secret::new("x".repeat(1024))).is_ok());
        for bad in ["", "ntn abc", "ntn_abc\n", "ntn_\u{e9}", "ntn_\tx"] {
            let e = validate_token(&Secret::new(bad.into())).unwrap_err();
            assert!(bad.is_empty() || !e.contains(bad), "{e}");
        }
        assert!(validate_token(&Secret::new("x".repeat(1025))).is_err());
    }

    #[test]
    fn workspace_comment_is_cleaned_and_capped() {
        assert_eq!(clean_workspace("Example\u{7}\nWorkspace"), "ExampleWorkspace");
        assert_eq!(clean_workspace(&"w".repeat(300)).chars().count(), 256);
        let astral = clean_workspace(&"\u{1F600}".repeat(200));
        assert_eq!((astral.chars().count(), astral.encode_utf16().count()), (128, 256));
        let odd = clean_workspace(&format!("w{}", "\u{1F600}".repeat(200)));
        assert_eq!((odd.chars().count(), odd.encode_utf16().count()), (128, 255), "no half pair");
        assert!(odd.ends_with('\u{1F600}'));
        assert_eq!(kind_from_owner("workspace"), "connection");
        assert_eq!(kind_from_owner("user"), "personal");
    }
}
