//! One concern: which catalog `authCheck` value gets the Claude Code login check (`claude_auth.rs`).

use crate::agent_spec::{parse, Agent};

/// True when the `authCheck` value parses to the Claude agent id; an unknown value or another
/// agent's id checks no login.
pub(super) fn names_login_check(auth_check: Option<&str>) -> bool {
    let claude = [Agent::Claude];
    auth_check.and_then(parse).is_some_and(|a| claude.contains(&a))
}
