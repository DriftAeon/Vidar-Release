//! src-falcon\src\protocol\agent_env.rs — the per-agent env names, one table for Falcon and Vidar.
//! Mounted by `#[path]` from `protocol.rs` (compiled by both crates), so it is a leaf: no `crate::`
//! references outside the test module. Every fn is an exhaustive match on `Agent`, no `_`.
//!
//! The PTY scrub (`pty::SCRUBBED_ENV`) takes `session_markers` only; the host scrub
//! (`process::SCRUBBED_ENV`) adds `host_scrub`. They are two sets on purpose: `host_scrub` holds
//! `ANTHROPIC_API_KEY`, which a PTY tab must keep.
#![allow(dead_code)] // read by the PTY and host scrub builders as they move onto it

use super::Agent;

impl Agent {
    /// Names an agent's CLI sets for the conversation it runs in; a child spawned from inside
    /// one must not inherit them. Codex's own markers ride through (left alone, pty.rs).
    pub const fn session_markers(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &[
                "CLAUDECODE",
                "CLAUDE_CODE_CHILD_SESSION",
                "CLAUDE_CODE_ENTRYPOINT",
                "CLAUDE_CODE_SESSION_ID",
                "CLAUDE_CODE_MESSAGING_SOCKET",
                "CLAUDE_CODE_MESSAGING_TOKEN",
                "CLAUDE_PID",
            ],
            Self::Codex => &[],
        }
    }

    /// Names only the Falcon host scrubs from a hosted child, beyond `session_markers`.
    pub const fn host_scrub(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["CLAUDE_CODE_SSE_PORT", "ANTHROPIC_API_KEY", "CLAUDE_CODE_EFFORT_LEVEL"],
            Self::Codex => &["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"],
        }
    }

    /// The prefix of the agent's own env names.
    pub const fn env_family(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE_CODE_",
            Self::Codex => "CODEX_",
        }
    }

    /// The env var naming the agent's home folder.
    pub const fn home_env(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE_CONFIG_DIR",
            Self::Codex => "CODEX_HOME",
        }
    }
}

/// The length `with_session_env` fills: `base` plus every agent's markers, plus `host_scrub` when `host`.
pub const fn session_env_len(base_len: usize, host: bool) -> usize {
    let mut n = base_len;
    let mut i = 0;
    while i < Agent::ALL.len() {
        n += Agent::ALL[i].session_markers().len();
        if host {
            n += Agent::ALL[i].host_scrub().len();
        }
        i += 1;
    }
    n
}

/// `base`, then every agent's `session_markers`, then (when `host`) every agent's `host_scrub`.
/// `N` must equal [`session_env_len`]; a mismatch fails the const evaluation. Callers keep
/// `pub const SCRUBBED_ENV: &[&str] = &BUILT;` over the array.
pub const fn with_session_env<const N: usize>(base: &[&'static str], host: bool) -> [&'static str; N] {
    let mut out = [""; N];
    let mut n = 0;
    let mut i = 0;
    while i < base.len() {
        out[n] = base[i];
        n += 1;
        i += 1;
    }
    let mut a = 0;
    while a < Agent::ALL.len() {
        let m = Agent::ALL[a].session_markers();
        let mut j = 0;
        while j < m.len() {
            out[n] = m[j];
            n += 1;
            j += 1;
        }
        a += 1;
    }
    if host {
        let mut a = 0;
        while a < Agent::ALL.len() {
            let h = Agent::ALL[a].host_scrub();
            let mut j = 0;
            while j < h.len() {
                out[n] = h[j];
                n += 1;
                j += 1;
            }
            a += 1;
        }
    }
    assert!(n == N, "with_session_env: N must equal session_env_len");
    out
}

// Golden: the builder reproduces each caller's live set. Two sets, one per caller; the PTY set
// must never hold a `host_scrub` name.
#[cfg(test)]
mod golden {
    use super::*;
    use std::collections::BTreeSet;

    const PTY_BASE: &[&str] = &[
        "NO_COLOR",
        "TERM",
        "COLORTERM",
        "VIDAR_CTL_TOKEN",
        "VIDAR_CTL_SECRET",
        "VIDAR_ROOT",
        "VIDAR_TAB_NAME",
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "FALCON_SESSION",
    ];
    const PROCESS_BASE: &[&str] = &[
        "VIDAR_TAB",
        "VIDAR_TAB_NAME",
        "VIDAR_CTL_TOKEN",
        "VIDAR_CTL_SECRET",
        "FALCON_SESSION",
        "NO_COLOR",
        "TERM",
        "COLORTERM",
        "VIDAR_ROOT",
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    ];

    const PTY_LEN: usize = session_env_len(9, false);
    const PROCESS_LEN: usize = session_env_len(10, true);

    fn set(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn no_dupes(v: &[&str]) {
        assert_eq!(set(v).len(), v.len(), "duplicate name in {v:?}");
    }

    #[test]
    fn pty_set_has_markers_and_never_host_scrub() {
        let built: [&str; PTY_LEN] = with_session_env(PTY_BASE, false);
        no_dupes(&built);
        for a in Agent::ALL {
            for h in a.host_scrub() {
                assert!(!built.contains(h), "PTY set must keep {h}");
            }
            for m in a.session_markers() {
                assert!(built.contains(m), "PTY set lacks {m}");
            }
        }
        #[cfg(not(falcon_shell))]
        assert_eq!(set(&built), set(crate::pty::SCRUBBED_ENV), "pty::SCRUBBED_ENV");
    }

    #[test]
    fn process_set_adds_host_scrub() {
        let built: [&str; PROCESS_LEN] = with_session_env(PROCESS_BASE, true);
        no_dupes(&built);
        for a in Agent::ALL {
            for n in a.host_scrub().iter().chain(a.session_markers()) {
                assert!(built.contains(n), "process set lacks {n}");
            }
        }
        #[cfg(falcon_shell)]
        assert_eq!(set(&built), set(crate::process::SCRUBBED_ENV), "process::SCRUBBED_ENV");
    }

    #[test]
    fn family_prefixes_cover_markers_and_host_scrub() {
        for a in Agent::ALL {
            for n in a.host_scrub().iter().chain(a.session_markers()) {
                // CLAUDECODE and CLAUDE_PID, API keys sit outside the family prefix by design.
                if n.starts_with("CLAUDE_CODE_") || n.starts_with("CODEX_") {
                    assert!(n.starts_with(a.env_family()), "{n} not in {}", a.env_family());
                }
            }
        }
    }
}
