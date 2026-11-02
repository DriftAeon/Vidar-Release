//! The env keys a child must not inherit from Vidar (agent-session markers, the control token,
//! terminal colour hints). Used by the spawn builder (`.scrubbed()`), the PTY spawn, the swap
//! button and Flow.

// Child processes inherit Vidar's environment, and Vidar may itself have been
// launched FROM an agent's tool shell (tools\release\swap-release.ps1 run by a Claude
// or Codex session). Those shells mark themselves so tool output comes back
// plain: Claude exports NO_COLOR=1 plus its child-session markers; Codex's
// exec sandbox sets TERM=dumb and a blank COLORTERM (a
// Claude resumed from a Codex-launched Vidar came up in an all-white tab, because
// the child inherits its caller's env and only NO_COLOR was scrubbed).
//
// A terminal emulator's sessions must look like a fresh top-level shell, not
// like children of whatever happened to start the app. Scrubbed, not overridden:
// removing these restores normal detection rather than forcing colour on — a
// real Windows Terminal tab has neither TERM nor COLORTERM set, and chalk's
// detector picks truecolor on win32 once TERM=dumb is out of the way.
// Shared with agent.rs (the sidecar spawn). Codex's own markers (CODEX_CI,
// CODEX_SESSION_ID, CODEX_SANDBOX_*) also ride through; left alone until what a
// resumed codex does with them is known. VIDAR_ROOT is scrubbed like VIDAR_CTL_TOKEN:
// spawn_pty sets its own after the scrub, and nothing else should inherit a stale one
// (an adopted shell, the sidecar, the Falcon host, a Vidar started from a Vidar tab).
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS carries the DevTools port (swap-release -Debug); a Vidar
// started from a tab must not inherit it, since the port hands spawn_pty to any local process.
// The agents' own markers come from the table (`Agent::session_markers`), laid over `SCRUB_BASE`;
// `host_scrub` stays out (it holds ANTHROPIC_API_KEY, which a PTY tab keeps).
pub const SCRUBBED_ENV: &[&str] = &SCRUBBED_BUILT;

const SCRUBBED_LEN: usize = {
    let mut n = SCRUB_BASE.len();
    let mut a = 0;
    while a < crate::agent_spec::ALL.len() {
        n += crate::agent_spec::ALL[a].session_markers().len();
        a += 1;
    }
    n
};
const SCRUBBED_BUILT: [&str; SCRUBBED_LEN] = scrubbed_built();

const fn scrubbed_built() -> [&'static str; SCRUBBED_LEN] {
    let mut out = [""; SCRUBBED_LEN];
    let mut n = 0;
    while n < SCRUB_BASE.len() {
        out[n] = SCRUB_BASE[n];
        n += 1;
    }
    let mut a = 0;
    while a < crate::agent_spec::ALL.len() {
        let m = crate::agent_spec::ALL[a].session_markers();
        let mut j = 0;
        while j < m.len() {
            out[n] = m[j];
            n += 1;
            j += 1;
        }
        a += 1;
    }
    out
}

const SCRUB_BASE: &[&str] = &[
    "NO_COLOR",
    "TERM",
    "COLORTERM",
    "VIDAR_CTL_TOKEN",
    "VIDAR_CTL_SECRET",
    "VIDAR_ROOT",
    // The tab name rides beside VIDAR_TAB (set per spawn); never inherited from a parent tab.
    "VIDAR_TAB_NAME",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    // A Vidar started from a Falcon-hosted session carries that session's id;
    // a raw tab, the sidecar or a new Falcon host must not claim it.
    "FALCON_SESSION",
];
