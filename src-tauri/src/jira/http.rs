//! HTTPS for the Jira tab over the shared `net::https` WinHTTP request: the system
//! certificate store and the system proxy. `Request` carries no header text; `WinHttpTransport`
//! builds `Authorization` itself from a `Token` whose Debug is redacted and hands it to `net` as a
//! `Secret`, so no `{:?}`, test failure or JoinError string can carry the token.

use std::time::Duration;

use base64::Engine as _;

use crate::net::{self, Limits, Secret};

/// Response bodies past this are refused, not truncated.
pub const BODY_CAP: usize = 1024 * 1024;
/// The text of `SendError::OverCap`.
pub const BODY_OVER_CAP: &str = "response over 1 MB";
/// From send to the last body byte: a trickling body cannot outlive the commands' 20 s deadline
/// one 10 s ReadData wait at a time.
const BODY_DEADLINE: Duration = Duration::from_secs(20);
/// Jira's bounds, passed to `net::send` explicitly rather than relying on a shared default.
const LIMITS: Limits = Limits { cap: BODY_CAP, body_deadline: BODY_DEADLINE };

/// One HTTPS request to `host:443`. Holds no header text: the transport adds Accept,
/// Content-Type and Authorization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: &'static str,
    pub host: String,
    pub path: String,
    pub body: Vec<u8>,
}

/// A transport failure. `OverCap` is a body past `BODY_CAP`, which `api::map_response` maps to
/// `endpoint`; everything else is `Failed` and maps to `network`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    OverCap,
    Failed(String),
}

impl From<String> for SendError {
    fn from(message: String) -> Self {
        SendError::Failed(message)
    }
}

impl From<net::SendError> for SendError {
    fn from(e: net::SendError) -> Self {
        match e {
            net::SendError::OverCap => SendError::OverCap,
            net::SendError::Timeout => SendError::Failed("request timed out (12002)".to_string()),
            net::SendError::Connect(message) | net::SendError::Io(message) => SendError::Failed(message),
        }
    }
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::OverCap => f.write_str(BODY_OVER_CAP),
            SendError::Failed(message) => f.write_str(message),
        }
    }
}

/// The seam tests run fixtures through: status and raw body, or a transport failure.
pub trait Transport {
    fn send(&self, req: &Request) -> Result<(u16, Vec<u8>), SendError>;
}

/// A Jira API token. Debug prints `Token(..)`; there is no Display.
pub struct Token(String);

impl Token {
    pub fn new(secret: String) -> Self {
        Token(secret)
    }

    /// For the header block and the vault's validator and blob only; never formatted.
    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(..)")
    }
}

/// The live transport: Basic auth with the credential's email and token.
pub struct WinHttpTransport {
    email: String,
    token: Token,
}

impl WinHttpTransport {
    pub fn new(email: String, token: Token) -> Self {
        WinHttpTransport { email, token }
    }

    fn header_block(&self, method: &str) -> Secret {
        let pair = format!("{}:{}", self.email, self.token.expose());
        let basic = base64::engine::general_purpose::STANDARD.encode(pair.as_bytes());
        let mut text = format!("Authorization: Basic {basic}\r\nAccept: application/json\r\n");
        if method == "POST" {
            text.push_str("Content-Type: application/json\r\n");
        }
        Secret::new(text)
    }
}

impl std::fmt::Debug for WinHttpTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WinHttpTransport").field("token", &self.token).finish_non_exhaustive()
    }
}

impl Transport for WinHttpTransport {
    fn send(&self, req: &Request) -> Result<(u16, Vec<u8>), SendError> {
        let shared = net::Request {
            method: req.method,
            host: req.host.clone(),
            path: req.path.clone(),
            body: (!req.body.is_empty()).then(|| req.body.clone()),
        };
        let reply = net::send(&shared, &self.header_block(req.method), LIMITS)?;
        Ok((reply.status, reply.body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_TOKEN: &str = "ATATT3xFixtureTokenDoNotLog0123456789";

    #[test]
    fn token_debug_is_redacted() {
        let token = Token::new(FIXTURE_TOKEN.to_string());
        let shown = format!("{token:?}");
        assert_eq!(shown, "Token(..)");
        let transport = WinHttpTransport::new("dev@example.com".to_string(), token);
        let shown = format!("{transport:?}");
        assert!(!shown.contains(FIXTURE_TOKEN), "{shown}");
        assert!(!shown.contains("dev@example.com"), "{shown}");
        let req = crate::jira::api::page_request("https://example.atlassian.net", "project = DEMO", None).unwrap();
        let shown = format!("{req:?}");
        assert!(!shown.contains(FIXTURE_TOKEN), "{shown}");
        let t = WinHttpTransport::new("dev@example.com".to_string(), Token::new(FIXTURE_TOKEN.to_string()));
        let shown = format!("{:?}", t.header_block("GET"));
        assert!(!shown.contains(FIXTURE_TOKEN) && !shown.contains("Basic"), "{shown}");
    }

    #[test]
    fn limits_keep_the_one_megabyte_cap_and_twenty_second_body_deadline() {
        assert_eq!(LIMITS.cap, 1024 * 1024);
        assert_eq!(LIMITS.body_deadline, Duration::from_secs(20));
    }

    #[test]
    fn shared_errors_map_to_jira_kinds() {
        assert_eq!(SendError::from(net::SendError::OverCap), SendError::OverCap);
        assert!(matches!(SendError::from(net::SendError::Timeout), SendError::Failed(_)));
        assert_eq!(
            SendError::from(net::SendError::Connect("WinHttpConnect failed (12029)".into())),
            SendError::Failed("WinHttpConnect failed (12029)".into())
        );
        assert_eq!(
            SendError::from(net::SendError::Io("WinHttpReadData failed (12030)".into())),
            SendError::Failed("WinHttpReadData failed (12030)".into())
        );
    }

    #[test]
    fn header_block_is_basic_auth_and_json() {
        let t = WinHttpTransport::new("dev@example.com".to_string(), Token::new("tok".to_string()));
        let basic = base64::engine::general_purpose::STANDARD.encode("dev@example.com:tok");
        assert_eq!(
            t.header_block("POST").expose(),
            format!("Authorization: Basic {basic}\r\nAccept: application/json\r\nContent-Type: application/json\r\n")
        );
        assert!(!t.header_block("GET").expose().contains("Content-Type"));
    }
}
