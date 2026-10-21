//! Shared network plumbing (docs/projects/notion/plan.md § Shared Rust): `https` is one WinHTTP
//! request to `host:443`, `deadline` runs work on its own thread under a wall-clock limit, and
//! `Secret` holds text that must never be formatted (header blocks, tokens). Notion, Slack and
//! Jira (through `jira/http.rs`) consume it.

pub mod deadline;
pub mod https;

pub use deadline::{with_deadline, Elapsed};
pub use https::{send, Limits, Reply, Request, SendError};

/// Text that must not leak into `{:?}`, logs or error strings. Debug prints `Secret(***)`;
/// there is no Display.
pub struct Secret(String);

impl Secret {
    pub fn new(text: String) -> Self {
        Secret(text)
    }

    /// For the header block, the credential blob and validators only; never formatted.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_is_redacted() {
        let secret = Secret::new("ntn_FixtureSecretDoNotLog0123456789".to_string());
        assert_eq!(format!("{secret:?}"), "Secret(***)");
        assert_eq!(format!("{:?}", Some(&secret)), "Some(Secret(***))");
        assert_eq!(secret.expose(), "ntn_FixtureSecretDoNotLog0123456789");
    }
}
