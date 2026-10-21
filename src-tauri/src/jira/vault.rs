//! The Jira API token in Windows Credential Manager (plan § D3) through the shared
//! `credman::CredStore`: `CRED_TYPE_GENERIC`, target `Vidar/Jira/<install-root key>` (the key Bare
//! homes use, so installs and sandbox roots stay apart), `UserName` = email, `Comment` = the site
//! host the token was saved for, blob = token as UTF-8. The target name is unchanged from the
//! module's own store, so a token saved before the move still loads.
//! The token is read into a `Token` at once and never formatted; errors carry codes only.

use std::path::Path;

use crate::credman::{self, Cred, CredStore, Store};
use crate::net::Secret;

use super::http::Token;

pub const TARGET_PREFIX: &str = "Vidar/Jira/";
pub const EMAIL_MAX_BYTES: usize = 254;
pub const TOKEN_MAX_BYTES: usize = 1024;

/// `Vidar/Jira/<root_suffix>`, the same per-install key as `%LOCALAPPDATA%\Vidar\homes\<key>`.
pub fn target_for(root: &Path) -> String {
    credman::target_for(TARGET_PREFIX, root)
}

/// At most 254 bytes, exactly one `@`, no `:` (it would split the Basic pair), no control chars.
pub fn validate_email(email: &str) -> Result<(), String> {
    let ok = !email.is_empty()
        && email.len() <= EMAIL_MAX_BYTES
        && email.matches('@').count() == 1
        && !email.contains(':')
        && !email.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err("email must be one address of at most 254 bytes, with no colon".into())
    }
}

/// 1 to 1024 bytes of UTF-8, no whitespace or control characters. The message never echoes it.
pub fn validate_token(token: &Token) -> Result<(), String> {
    let t = token.expose();
    let ok = !t.is_empty() && t.len() <= TOKEN_MAX_BYTES && !t.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok {
        Ok(())
    } else {
        Err("token must be 1 to 1024 bytes with no spaces or control characters".into())
    }
}

/// One saved credential.
#[derive(Debug)]
pub struct Saved {
    pub email: String,
    /// The site host the token was saved for (`Comment`).
    pub site_host: String,
    pub token: Token,
}

/// The credential store seam: `CredVault` is the live one; tests use an in-memory stand-in.
pub trait Vault {
    fn read(&self) -> Result<Option<Saved>, String>;
    fn write(&self, email: &str, site_host: &str, token: &Token) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// Credential Manager under one target name.
pub struct CredVault {
    store: CredStore,
}

impl CredVault {
    pub fn new(target: String) -> Self {
        CredVault { store: CredStore::new(target) }
    }

    /// The vault for this install root.
    pub fn for_install() -> Self {
        CredVault::new(target_for(&crate::paths::root()))
    }
}

/// A stored entry as Jira's `Saved`: `UserName` = email, `Comment` = site host, blob = token.
fn saved_from(c: Cred) -> Saved {
    Saved { email: c.user, site_host: c.comment, token: Token::new(c.blob.expose().to_string()) }
}

/// The entry `write` stores for these parts.
fn cred_from(email: &str, site_host: &str, token: &Token) -> Cred {
    Cred { user: email.to_string(), comment: site_host.to_string(), blob: Secret::new(token.expose().to_string()) }
}

impl Vault for CredVault {
    fn read(&self) -> Result<Option<Saved>, String> {
        Ok(self.store.read()?.map(saved_from))
    }

    fn write(&self, email: &str, site_host: &str, token: &Token) -> Result<(), String> {
        validate_email(email)?;
        validate_token(token)?;
        self.store.write(&cred_from(email, site_host, token))
    }

    fn delete(&self) -> Result<(), String> {
        self.store.delete()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_target_is_keyed_by_install_root() {
        let a = target_for(Path::new(r"D:\Tools\Vidar"));
        let suffix = a.strip_prefix(TARGET_PREFIX).expect("prefix");
        assert_eq!(suffix, crate::falcon::host_names::root_suffix(Path::new(r"D:\Tools\Vidar")));
        assert_eq!(suffix.len(), 16);
        assert_eq!(a, target_for(Path::new(r"d:/tools/vidar/")));
        assert_ne!(a, target_for(Path::new(r"D:\Tools\Vidar2")));
    }

    /// The move keeps the saved token loadable: the target is the string the module's own store
    /// built (`Vidar/Jira/` + the root suffix), and an entry written the old way decodes to the
    /// same email, host and token. Encode and decode only; the real vault is never touched.
    #[test]
    fn target_and_entry_match_what_the_old_store_wrote() {
        let root = Path::new(r"D:\Tools\Vidar");
        let old_way = format!("Vidar/Jira/{}", crate::falcon::host_names::root_suffix(root));
        assert_eq!(target_for(root), old_way);
        assert_eq!(TARGET_PREFIX, "Vidar/Jira/");

        // Old write: UserName = email, Comment = site host, blob = token as UTF-8 bytes.
        let stored = Cred {
            user: "dev@example.com".into(),
            comment: "example.atlassian.net".into(),
            blob: Secret::new(String::from_utf8(b"ATATT3xOldWayToken0123".to_vec()).unwrap()),
        };
        let saved = saved_from(stored);
        assert_eq!(saved.email, "dev@example.com");
        assert_eq!(saved.site_host, "example.atlassian.net");
        assert_eq!(saved.token.expose(), "ATATT3xOldWayToken0123");

        // New write encodes the same three fields.
        let c = cred_from("dev@example.com", "example.atlassian.net", &Token::new("ATATT3xOldWayToken0123".into()));
        assert_eq!(c.user, "dev@example.com");
        assert_eq!(c.comment, "example.atlassian.net");
        assert_eq!(c.blob.expose().as_bytes(), b"ATATT3xOldWayToken0123");
    }

    #[test]
    fn email_and_token_shapes() {
        assert!(validate_email("dev@example.com").is_ok());
        for bad in ["", "dev", "a@b@c", "dev:x@example.com", "dev@exa\nmple.com", &format!("{}@x.io", "a".repeat(250))] {
            assert!(validate_email(bad).is_err(), "{bad:?}");
        }
        assert!(validate_token(&Token::new("ATATT3xFixture=0123".into())).is_ok());
        assert!(validate_token(&Token::new("a".repeat(TOKEN_MAX_BYTES))).is_ok());
        for bad in [String::new(), "a b".into(), "a\tb".into(), "a\u{7}".into(), "a".repeat(TOKEN_MAX_BYTES + 1)] {
            let err = validate_token(&Token::new(bad.clone())).unwrap_err();
            assert!(bad.is_empty() || !err.contains(&bad), "{err}");
        }
    }

    /// Writes, reads and deletes a real Credential Manager entry under a throwaway target.
    /// The user's: `cargo test --manifest-path src-tauri/Cargo.toml cred_vault_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn cred_vault_round_trip() {
        let v = CredVault::new(format!("{TARGET_PREFIX}round-trip-test"));
        v.delete().unwrap();
        assert!(v.read().unwrap().is_none());
        v.write("dev@example.com", "example.atlassian.net", &Token::new("ATATT3xRoundTrip0123".into())).unwrap();
        let got = v.read().unwrap().expect("saved");
        assert_eq!(got.email, "dev@example.com");
        assert_eq!(got.site_host, "example.atlassian.net");
        assert_eq!(got.token.expose(), "ATATT3xRoundTrip0123");
        v.delete().unwrap();
        assert!(v.read().unwrap().is_none());
        v.delete().unwrap();
    }
}
