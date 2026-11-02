//! `{ kind, message, retryAfter? }` and the `T | { error }` answer, shared by the integrations. Each
//! service keeps its own `ErrorKind` and implements `NetKind` for the two transport kinds.

use std::time::Duration;

use serde::Serialize;

use super::text::clean_redacted;
use super::{Secret, SendError};

/// The kinds the shared helpers construct.
pub trait NetKind: Copy {
    const ENDPOINT: Self;
    const NETWORK: Self;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError<K> {
    pub kind: K,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl<K> ApiError<K> {
    pub fn new(kind: K, message: impl Into<String>) -> Self {
        ApiError { kind, message: message.into(), retry_after: None }
    }

    pub fn after(mut self, retry_after: Option<u64>) -> Self {
        self.retry_after = retry_after;
        self
    }
}

impl<K: NetKind> ApiError<K> {
    pub fn endpoint(message: impl Into<String>) -> Self {
        Self::new(K::ENDPOINT, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(K::NETWORK, message)
    }
}

/// `T` or `{ error: { kind, message, retryAfter? } }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Answer<T, K> {
    Ok(T),
    Error { error: ApiError<K> },
}

impl<T, K> From<Result<T, ApiError<K>>> for Answer<T, K> {
    fn from(r: Result<T, ApiError<K>>) -> Self {
        match r {
            Ok(v) => Answer::Ok(v),
            Err(error) => Answer::Error { error },
        }
    }
}

/// Transport failures: OverCap → endpoint; the rest → network. `token` is redacted before the cap.
pub fn send_error<K: NetKind>(e: &SendError, token: &Secret, service: &str) -> ApiError<K> {
    match e {
        SendError::OverCap => ApiError::endpoint("reply too large"),
        SendError::Timeout => ApiError::network(format!("{service} did not answer in time")),
        SendError::Connect(m) | SendError::Io(m) => ApiError::network(clean_redacted(m, token)),
    }
}

/// `no reply within 20 s`; fractions survive (`0.2`).
pub fn timeout_message(d: Duration) -> String {
    format!("no reply within {} s", d.as_secs_f64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::tiers::COMMAND;
    use serde_json::json;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "lowercase")]
    enum Kind {
        Rate,
        Endpoint,
        Network,
    }

    impl NetKind for Kind {
        const ENDPOINT: Self = Kind::Endpoint;
        const NETWORK: Self = Kind::Network;
    }

    #[test]
    fn wire_shape_with_and_without_retry_after() {
        let plain = ApiError::new(Kind::Rate, "slow down");
        assert_eq!(serde_json::to_value(&plain).unwrap(), json!({"kind": "rate", "message": "slow down"}));
        let held = plain.after(Some(7));
        assert_eq!(
            serde_json::to_value(&held).unwrap(),
            json!({"kind": "rate", "message": "slow down", "retryAfter": 7})
        );
    }

    #[test]
    fn answer_is_untagged() {
        let ok: Answer<u32, Kind> = Ok(3).into();
        assert_eq!(serde_json::to_value(&ok).unwrap(), json!(3));
        let err: Answer<u32, Kind> = Err(ApiError::endpoint("bad")).into();
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({"error": {"kind": "endpoint", "message": "bad"}})
        );
    }

    #[test]
    fn send_error_maps_kinds_and_redacts() {
        let token = Secret::new("tok-secret".to_string());
        let over: ApiError<Kind> = send_error(&SendError::OverCap, &token, "Slack");
        assert_eq!((over.kind, over.message.as_str()), (Kind::Endpoint, "reply too large"));
        let slow: ApiError<Kind> = send_error(&SendError::Timeout, &token, "Notion");
        assert_eq!((slow.kind, slow.message.as_str()), (Kind::Network, "Notion did not answer in time"));
        let io: ApiError<Kind> = send_error(&SendError::Io("bad tok-secret".into()), &token, "Slack");
        assert_eq!((io.kind, io.message.as_str()), (Kind::Network, "bad ***"));
    }

    #[test]
    fn timeout_message_text() {
        assert_eq!(timeout_message(COMMAND), "no reply within 20 s");
        assert_eq!(timeout_message(Duration::from_millis(200)), "no reply within 0.2 s");
    }
}
