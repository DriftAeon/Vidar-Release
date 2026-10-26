// LM Studio: is its local server up, and what is loaded.
//
// The proxy's `local-llm` backend is a stdio bridge that talks to LM Studio's
// OpenAI-compatible server (local-llm-mcp/server.py), so the rack can list its
// tools while inference is impossible. This module asks LM Studio itself:
// GET <origin>/api/v0/models, loopback only, 1.5 s. The origin comes from
// vidar.json's `lmstudioOrigin` key so a non-default port is user-set; absent
// or invalid, the documented default is used and the UI says which.
//
// Observation only: Vidar never starts, stops, loads or unloads anything here.

use std::sync::Once;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const DEFAULT_ORIGIN: &str = "http://127.0.0.1:1234";

static INVALID_ORIGIN_LOGGED: Once = Once::new();

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LmModel {
    pub id: String,
    /// "llm" | "vlm" | "embeddings" | "" as LM Studio reports it
    pub kind: String,
    /// "loaded" | "not-loaded" | ""
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LmStatus {
    pub origin: String,
    /// "config" (vidar.json `lmstudioOrigin`) | "default"
    pub source: String,
    /// "up" | "down" | "timeout" | "unsupported" | "off-loopback"
    pub state: String,
    pub models: Vec<LmModel>,
    /// the raw error or a note; hover detail, never row text
    pub detail: String,
}

/// An http(s) origin: scheme + host[:port], no path/query/fragment beyond an
/// optional trailing slash. Not a full RFC 3986 parse — just enough to keep a
/// stray path or typo out of a loopback GET.
fn is_valid_origin(s: &str) -> bool {
    let rest = match s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")) {
        Some(r) => r,
        None => return false,
    };
    if rest.contains(char::is_whitespace) {
        return false;
    }
    let host_port = rest.trim_end_matches('/');
    // '@' is userinfo: `http://127.0.0.1:1234@evil.example` is a request to evil.example.
    !host_port.is_empty() && !host_port.contains(['/', '?', '#', '@'])
}

/// vidar.json's `lmstudioOrigin`, validated. Absent or invalid = `DEFAULT_ORIGIN`;
/// an invalid value is logged once per process, never a panic.
pub(crate) fn configured_origin() -> (String, &'static str) {
    match crate::config::load().config.lmstudio_origin {
        Some(origin) if is_valid_origin(&origin) => {
            (origin.trim_end_matches('/').to_string(), "config")
        }
        Some(origin) => {
            INVALID_ORIGIN_LOGGED.call_once(|| {
                eprintln!(
                    "lmstudio: vidar.json lmstudioOrigin \"{origin}\" is not an http(s) origin; using default"
                );
            });
            (DEFAULT_ORIGIN.to_string(), "default")
        }
        None => (DEFAULT_ORIGIN.to_string(), "default"),
    }
}

/// A loopback http origin: the host, then nothing but an optional `:<digits>` port and one
/// optional trailing '/'. Anything else after the host (userinfo '@', a path) is not loopback.
pub(crate) fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    ["127.0.0.1", "localhost", "[::1]"].iter().any(|h| {
        rest.strip_prefix(h).is_some_and(|tail| {
            let tail = tail.strip_suffix('/').unwrap_or(tail);
            tail.is_empty()
                || tail.strip_prefix(':').is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        })
    })
}

fn models_from(body: &Value) -> Option<Vec<LmModel>> {
    let data = body.get("data")?.as_array()?;
    let mut out: Vec<LmModel> = data
        .iter()
        .filter_map(|m| {
            Some(LmModel {
                id: m.get("id")?.as_str()?.to_string(),
                kind: m.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
                state: m.get("state").and_then(Value::as_str).unwrap_or("").to_string(),
            })
        })
        .collect();
    // loaded first, then by id
    out.sort_by(|a, b| (b.state == "loaded").cmp(&(a.state == "loaded")).then(a.id.cmp(&b.id)));
    Some(out)
}

fn probe() -> LmStatus {
    let (origin, source) = configured_origin();
    let mut st = LmStatus { origin: origin.clone(), source: source.into(), state: "down".into(), models: vec![], detail: String::new() };
    if !is_loopback_http(&origin) {
        st.state = "off-loopback".into();
        st.detail = "configured origin is not loopback; not queried".into();
        return st;
    }
    query(&mut st, &origin);
    st
}

/// The models call itself, split from `probe` so a test can aim it at a local listener.
fn query(st: &mut LmStatus, origin: &str) {
    let agent = crate::mcp::loopback_agent(Duration::from_millis(1500));
    match agent.get(format!("{origin}/api/v0/models")).call() {
        Ok(resp) if crate::mcp::redirect_status(&resp).is_some() => {
            st.state = "unsupported".into();
            st.detail = format!("redirect refused (HTTP {}) from /api/v0/models", resp.status().as_u16());
        }
        Ok(mut resp) => match resp.body_mut().read_to_string().ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| models_from(&v)) {
            Some(models) => {
                st.state = "up".into();
                st.models = models;
            }
            None => {
                st.state = "unsupported".into();
                st.detail = "reply had no data[] — a different API version?".into();
            }
        },
        Err(ureq::Error::StatusCode(code)) => {
            st.state = "unsupported".into();
            st.detail = format!("HTTP {code} from /api/v0/models");
        }
        Err(e) => {
            let timed_out = match &e {
                ureq::Error::Timeout(_) => true,
                ureq::Error::Io(io) => io.kind() == std::io::ErrorKind::TimedOut,
                _ => false,
            };
            st.state = if timed_out { "timeout".into() } else { "down".into() };
            st.detail = e.to_string();
        }
    }
}

/// Async: the HTTP call runs off the webview's main thread.
#[tauri::command]
pub async fn lmstudio_status() -> Result<LmStatus, String> {
    tauri::async_runtime::spawn_blocking(probe)
        .await
        .map_err(|e| format!("lmstudio task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_validation() {
        // valid
        assert!(is_valid_origin("http://127.0.0.1:1234"));
        assert!(is_valid_origin("https://localhost:5555"));
        assert!(is_valid_origin("http://127.0.0.1:1234/")); // trailing slash tolerated
        // invalid
        assert!(!is_valid_origin("127.0.0.1:1234")); // no scheme
        assert!(!is_valid_origin("ftp://127.0.0.1:1234")); // wrong scheme
        assert!(!is_valid_origin("http://127.0.0.1:1234/v1")); // has a path
        assert!(!is_valid_origin("http://")); // empty host
        assert!(!is_valid_origin("http://127.0.0.1: 1234")); // whitespace
        assert!(!is_valid_origin("http://127.0.0.1:1234@evil.example")); // userinfo: host is evil.example
    }

    #[test]
    fn models_parse_and_sort() {
        let body: Value = serde_json::from_str(r#"{"data":[{"id":"b","type":"llm","state":"not-loaded"},{"id":"acme/acme-vl-8b","type":"vlm","state":"loaded"}]}"#).unwrap();
        let m = models_from(&body).unwrap();
        assert_eq!(m[0], LmModel { id: "acme/acme-vl-8b".into(), kind: "vlm".into(), state: "loaded".into() });
        assert_eq!(m[1].id, "b");
        assert!(models_from(&serde_json::json!({"object":"list"})).is_none());
    }

    #[test]
    fn loopback_gate() {
        assert!(is_loopback_http("http://127.0.0.1:1234"));
        assert!(!is_loopback_http("http://10.0.0.5:1234"));
        assert!(!is_loopback_http("https://127.0.0.1:1234"));
    }

    #[test]
    fn models_query_refuses_redirect() {
        use crate::mcp::tests::{redirect_server, RedirectTarget};
        let target = RedirectTarget::new();
        let (origin, server) = redirect_server(target.url("/api/v0/models"));
        let mut st = LmStatus { origin: origin.clone(), source: "test".into(), state: "down".into(), models: vec![], detail: String::new() };
        query(&mut st, &origin);
        server.join().unwrap();
        assert_eq!(st.state, "unsupported");
        assert!(st.detail.starts_with("redirect refused (HTTP 302)"), "{}", st.detail);
        assert!(st.models.is_empty());
        target.assert_untouched();
    }
}
