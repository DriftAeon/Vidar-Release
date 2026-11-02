//! Editor MCP, Rider MCP and RiderLink liveness for the Unreal tab, read through the :8399 proxy.
//!
//! The proxy's `/status` records how a backend was last listed, not whether it is up, so a
//! `tools/list` goes first (it refreshes that record). Known lag: the proxy caps an offline
//! list at 0.25 s and serves the cache for 30 s after a failure, so a pill can read Down for
//! about 60 s after the editor comes up (offline window plus the next probe).

use crate::mcp::{call_tool_blocking, list_tools_with, proxy_status_blocking, BackendStatus};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// The one proxy address, shared with the rack (`src/panels/rack-modules.ts`).
const PROXY_CONTRACT: &str = include_str!("../../../contracts/mcp-proxy.json");
const PROBE: Duration = Duration::from_secs(3);

pub(super) fn proxy_url() -> String {
    serde_json::from_str::<Value>(PROXY_CONTRACT)
        .ok()
        .and_then(|v| v.get("url").and_then(Value::as_str).map(str::to_owned))
        .expect("contracts/mcp-proxy.json carries a url")
}

/// `reason` is tooltip text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pill {
    pub up: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPills {
    pub editor_mcp: Pill,
    pub rider_mcp: Pill,
    /// None unless Rider MCP is up and the project root is known.
    pub rider_link: Option<Pill>,
}

fn pill(up: bool, reason: impl Into<String>) -> Pill {
    Pill { up, reason: reason.into() }
}

fn backend_pill(statuses: &[BackendStatus], name: &str) -> Pill {
    let Some(b) = statuses.iter().find(|b| b.name == name) else {
        return pill(false, "Not Configured in the Proxy");
    };
    if !b.enabled {
        return pill(false, "Disabled in the Proxy");
    }
    if b.last_list.starts_with("live") {
        return pill(true, format!("Listed Live: {}", b.last_list));
    }
    match &b.last_list_time {
        Some(t) => pill(false, format!("{} ({t})", b.last_list)),
        None => pill(false, b.last_list.clone()),
    }
}

/// Pure mapping of a `/status` read to the two backend pills.
pub fn pills_from_status(status: Result<Vec<BackendStatus>, String>) -> (Pill, Pill) {
    match status {
        Ok(s) => (backend_pill(&s, "unreal"), backend_pill(&s, "rider")),
        Err(_) => (pill(false, "Proxy Unreachable"), pill(false, "Proxy Unreachable")),
    }
}

fn rider_link_pill(url: &str, root: &str) -> Pill {
    match call_tool_blocking(url, "rider_ue_status", json!({"count": 0, "rootFolder": root}), PROBE) {
        Ok(v) if v.get("connected").and_then(Value::as_bool) == Some(true) => pill(true, "RiderLink Connected to the Editor"),
        Ok(_) => pill(false, "Rider Reports No Editor Link"),
        Err(e) => pill(false, e),
    }
}

pub fn mcp_status_at(url: &str, root: Option<&str>) -> McpPills {
    // The list result is ignored: it only refreshes the proxy's record that /status reads.
    let _ = list_tools_with(url, PROBE);
    let (editor_mcp, rider_mcp) = pills_from_status(proxy_status_blocking(url));
    let rider_link = match root.filter(|r| !r.is_empty()) {
        Some(r) if rider_mcp.up => Some(rider_link_pill(url, r)),
        _ => None,
    };
    McpPills { editor_mcp, rider_mcp, rider_link }
}

pub fn mcp_status_blocking(root: Option<&str>) -> McpPills {
    mcp_status_at(&proxy_url(), root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(name: &str, enabled: bool, last: &str, time: Option<&str>) -> BackendStatus {
        BackendStatus {
            name: name.into(),
            enabled,
            last_list: last.into(),
            last_list_time: time.map(str::to_owned),
            schema_cache: false,
        }
    }

    #[test]
    fn status_maps_to_pills_for_live_cache_disabled_and_unreachable() {
        let (e, r) = pills_from_status(Ok(vec![
            b("unreal", true, "live", None),
            b("rider", true, "offline, cache from 2026-10-30T16:42:07, 15/76 allowed", Some("2026-10-30T16:42:07")),
        ]));
        assert!(e.up && e.reason.contains("live"));
        assert!(!r.up && r.reason.contains("offline, cache from"));

        let (e, r) = pills_from_status(Ok(vec![b("unreal", false, "never", None)]));
        assert_eq!(e, pill(false, "Disabled in the Proxy"));
        assert_eq!(r, pill(false, "Not Configured in the Proxy"));

        let (e, r) = pills_from_status(Err("unreachable: refused".into()));
        assert_eq!((e.up, r.up), (false, false));
        assert_eq!(e.reason, "Proxy Unreachable");
    }

    #[test]
    fn a_dead_proxy_gives_down_pills_and_no_link() {
        // Bind then drop: the port is closed when the probe runs.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let p = mcp_status_at(&format!("http://127.0.0.1:{port}/mcp"), Some("C:\\Proj"));
        assert!(!p.editor_mcp.up && !p.rider_mcp.up);
        assert_eq!(p.rider_link, None);
    }

    #[test]
    fn the_proxy_url_is_the_contract_entry() {
        assert_eq!(proxy_url(), "http://127.0.0.1:8399/mcp");
    }
}
