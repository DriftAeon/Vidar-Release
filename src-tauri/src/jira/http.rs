//! HTTPS for the Jira tab over the shared `net` layer: the system certificate store and the system
//! proxy. A `net::Request` carries no header text; `Client` builds `Authorization` itself from a
//! `Token` whose Debug is redacted and hands it to the `net::Transport` as a `Secret`, so no
//! `{:?}`, test failure or JoinError string can carry the token.

use std::time::Duration;

use base64::Engine as _;

use super::api::ApiError;
use crate::net::{self, Limits, Reply, Request, Secret, Transport};

/// Response bodies past this are refused, not truncated.
pub const BODY_CAP: usize = 1024 * 1024;
/// From send to the last body byte: a trickling body cannot outlive the commands' 20 s deadline
/// one 10 s ReadData wait at a time.
const BODY_DEADLINE: Duration = crate::net::tiers::COMMAND;
/// Jira's bounds, passed to the transport explicitly rather than relying on a shared default.
const LIMITS: Limits = Limits { cap: BODY_CAP, body_deadline: BODY_DEADLINE };

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

/// One credential over one `net::Transport`: Basic auth with the credential's email and token.
pub struct Client<'a> {
    transport: &'a dyn Transport,
    email: String,
    token: Token,
}

impl<'a> Client<'a> {
    pub fn new(transport: &'a dyn Transport, email: String, token: Token) -> Self {
        Client { transport, email, token }
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

    /// The reply as sent, or `endpoint` for an over-cap body and `network` for the rest
    /// (`net::send_error`, the token redacted).
    pub fn send(&self, req: &Request) -> Result<Reply, ApiError> {
        self.transport
            .send(req, &self.header_block(req.method), LIMITS)
            .map_err(|e| net::send_error(&e, &Secret::new(self.token.expose().to_string()), "Jira"))
    }
}

impl std::fmt::Debug for Client<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("token", &self.token).finish_non_exhaustive()
    }
}

/// Test doubles: a `net::Transport` that answers from fixtures and records what was sent.
#[cfg(test)]
pub mod fake {
    use super::*;
    use crate::net::SendError;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    pub struct Fake {
        fixed: Option<Result<Reply, SendError>>,
        queue: RefCell<VecDeque<&'static str>>,
        pub sent: RefCell<Vec<Request>>,
        pub headers: RefCell<Vec<String>>,
    }

    impl Fake {
        fn blank() -> Self {
            Fake { fixed: None, queue: RefCell::new(VecDeque::new()), sent: RefCell::new(Vec::new()), headers: RefCell::new(Vec::new()) }
        }

        /// Every send answers `status` and `body`.
        pub fn fixed(status: u16, body: &'static str) -> Self {
            Fake { fixed: Some(Ok(reply(status, body.as_bytes()))), ..Fake::blank() }
        }

        /// Every send answers 429 with `Retry-After` seconds.
        pub fn rate(retry_after: Option<u64>) -> Self {
            Fake { fixed: Some(Ok(Reply { status: 429, retry_after, body: Vec::new() })), ..Fake::blank() }
        }

        /// Every send fails with `e`.
        pub fn failing(e: SendError) -> Self {
            Fake { fixed: Some(Err(e)), ..Fake::blank() }
        }

        /// Each send pops the next body, answered 200.
        pub fn queue(bodies: Vec<&'static str>) -> Self {
            Fake { queue: RefCell::new(bodies.into()), ..Fake::blank() }
        }

        pub fn last(&self) -> Option<Request> {
            self.sent.borrow().last().cloned()
        }

        pub fn client(&self) -> Client<'_> {
            Client::new(self, "dev@example.com".to_string(), Token::new("tok".to_string()))
        }
    }

    pub fn reply(status: u16, body: &[u8]) -> Reply {
        Reply { status, retry_after: None, body: body.to_vec() }
    }

    impl Transport for Fake {
        fn send(&self, req: &Request, headers: &Secret, _limits: Limits) -> Result<Reply, SendError> {
            self.sent.borrow_mut().push(req.clone());
            self.headers.borrow_mut().push(headers.expose().to_string());
            match &self.fixed {
                Some(r) => r.clone(),
                None => Ok(reply(200, self.queue.borrow_mut().pop_front().expect("no queued reply").as_bytes())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Fake;
    use super::*;
    use crate::jira::api::ErrorKind;
    use crate::net::SendError;

    const FIXTURE_TOKEN: &str = "ATATT3xFixtureTokenDoNotLog0123456789";

    #[test]
    fn token_debug_is_redacted() {
        let token = Token::new(FIXTURE_TOKEN.to_string());
        let shown = format!("{token:?}");
        assert_eq!(shown, "Token(..)");
        let fake = Fake::fixed(200, "{}");
        let client = Client::new(&fake, "dev@example.com".to_string(), token);
        let shown = format!("{client:?}");
        assert!(!shown.contains(FIXTURE_TOKEN), "{shown}");
        assert!(!shown.contains("dev@example.com"), "{shown}");
        let req = crate::jira::api::page_request("https://example.atlassian.net", "project = DEMO", None).unwrap();
        let shown = format!("{req:?}");
        assert!(!shown.contains(FIXTURE_TOKEN), "{shown}");
        let t = Client::new(&fake, "dev@example.com".to_string(), Token::new(FIXTURE_TOKEN.to_string()));
        let shown = format!("{:?}", t.header_block("GET"));
        assert!(!shown.contains(FIXTURE_TOKEN) && !shown.contains("Basic"), "{shown}");
    }

    #[test]
    fn limits_keep_the_one_megabyte_cap_and_twenty_second_body_deadline() {
        assert_eq!(LIMITS.cap, 1024 * 1024);
        assert_eq!(LIMITS.body_deadline, Duration::from_secs(20)); // home-ok: pins the tier value
    }

    #[test]
    fn header_block_is_basic_auth_and_json() {
        let fake = Fake::fixed(200, "{}");
        let t = Client::new(&fake, "dev@example.com".to_string(), Token::new("tok".to_string()));
        let basic = base64::engine::general_purpose::STANDARD.encode("dev@example.com:tok");
        assert_eq!(
            t.header_block("POST").expose(),
            format!("Authorization: Basic {basic}\r\nAccept: application/json\r\nContent-Type: application/json\r\n")
        );
        assert!(!t.header_block("GET").expose().contains("Content-Type"));
        let req = Request { method: "GET", host: "example.atlassian.net".into(), path: "/x".into(), body: None };
        t.send(&req).unwrap();
        assert_eq!(fake.headers.borrow()[0], t.header_block("GET").expose());
    }

    #[test]
    fn send_failures_map_to_endpoint_and_network_with_the_token_redacted() {
        let kind = |e: SendError| {
            let f = Fake::failing(e);
            f.client().send(&Request { method: "GET", host: "h".into(), path: "/".into(), body: None }).unwrap_err()
        };
        let over = kind(SendError::OverCap);
        assert_eq!((over.kind, over.message.as_str()), (ErrorKind::Endpoint, "reply too large"));
        assert_eq!(kind(SendError::Timeout).kind, ErrorKind::Network);
        assert_eq!(kind(SendError::Connect("WinHttpConnect failed (12029)".into())).kind, ErrorKind::Network);
        let io = kind(SendError::Io("bad tok".into()));
        assert_eq!((io.kind, io.message.as_str()), (ErrorKind::Network, "bad ***"));
    }
}
