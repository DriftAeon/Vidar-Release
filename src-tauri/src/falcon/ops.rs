//! Pure translation: lease payloads and sidecar lines into Falcon operations.

use serde_json::Value;

use super::{Agent, Hosted, Lease, Op, CAPABILITY_STEER};
// `falcon.rs` imports the shared protocol under a different root per build.
#[cfg(falcon_shell)]
use crate::protocol::{CAPABILITY_CODEX_QUERY, CAPABILITY_CODEX_TURNS};
#[cfg(not(falcon_shell))]
use super::protocol::{CAPABILITY_CODEX_QUERY, CAPABILITY_CODEX_TURNS};

pub(super) fn parse_lease(payload: Value) -> Result<Lease, String> {
    Ok(Lease {
        token: payload
            .get("token")
            .and_then(Value::as_str)
            .ok_or("falcon issued no lease token")?
            .to_string(),
        revision: payload
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or("falcon issued no lease revision")?,
    })
}

/// Translate one sidecar line into the Falcon operation that carries it.
///
/// Rendered sends the sidecar's own vocabulary — `{"type":"user",...}` — because
/// that is what `agent.rs` forwards verbatim. Falcon takes typed operations
/// instead, so the mapping lives here rather than changing what the UI emits.
/// An unknown `type` is refused by name: silently dropping a line the user
/// believes was sent is the failure this whole host exists to avoid.
///
/// A field the host types as a string is refused here when the line lacks one.
/// The hand-built frame sent `null` instead, which the host cannot parse; it
/// drops the whole connection on a bad frame, and every hosted tab's lease
/// with it.
pub(super) fn to_operation(line: &Value, hosted: &Hosted) -> Result<Op, String> {
    let kind = line
        .get("type")
        .and_then(Value::as_str)
        .ok_or("agent line has no type")?;
    let text = |field: &str| {
        line.get(field)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("a '{kind}' line needs a string '{field}'"))
    };
    let session = hosted.session.clone();
    let generation = hosted.host_generation;
    let lease = hosted.lease.clone();
    Ok(match kind {
        "user" => Op::Submit {
            session,
            generation,
            lease,
            content: line.get("content").cloned().unwrap_or(Value::Null),
        },
        "interrupt" => Op::Interrupt {
            session,
            generation,
            lease,
        },
        "permission_response" => Op::PermissionResponse {
            session,
            generation,
            lease,
            request: text("id")?,
            behavior: text("behavior")?,
            // An explicit `null` message was sent as `null` and read by the
            // host as absent; it is now omitted, which the host reads the same.
            message: match line.get("message") {
                None | Some(Value::Null) => None,
                Some(Value::String(message)) => Some(message.clone()),
                Some(_) => return Err("a 'permission_response' message must be a string".into()),
            },
            // Kept as-is, `null` included: `Some(Value::Null)` still serialises
            // as `"updated_input":null`.
            updated_input: line.get("updatedInput").cloned(),
        },
        "set_model" => Op::SetModel {
            session,
            generation,
            lease,
            model: text("model")?,
        },
        "set_effort" => Op::SetEffort {
            session,
            generation,
            lease,
            level: text("level")?,
        },
        "set_permission_mode" => Op::SetPermissionMode {
            session,
            generation,
            lease,
            mode: text("mode")?,
        },
        other => return Err(format!("falcon has no operation for a '{other}' line")),
    })
}

pub(super) fn steer_operation(hosted: &Hosted, prompt: &str) -> Op {
    Op::SteerPrompt {
        session: hosted.session.clone(),
        generation: hosted.host_generation,
        lease: hosted.lease.clone(),
        prompt: prompt.to_string(),
    }
}

/// The negotiate capability an op needs, if any (protocol.rs `CAPABILITIES`).
fn required_capability(op: &Op) -> Option<&'static str> {
    match op {
        Op::SteerPrompt { .. } => Some(CAPABILITY_STEER),
        Op::Query { .. } => Some(CAPABILITY_CODEX_QUERY),
        _ => None,
    }
}

/// Refuse, before a byte is written, an op the connected host did not
/// advertise: a host that cannot parse a request drops the whole connection
/// and every hosted lease on it. The frontend matches `does not serve
/// steer-prompt` to fall back to an interrupt; keep the phrase.
pub(super) fn capability_refusal(op: &Op, host_capabilities: &[String]) -> Option<String> {
    let needed = required_capability(op)?;
    (!host_capabilities.iter().any(|held| held == needed)).then(|| {
        format!(
            "falcon host does not serve {}; it predates the '{needed}' capability",
            op.name()
        )
    })
}

/// Refuse, before a spawn or adopt, a hosted Codex tab on a host that did not
/// list `codex_turns`: `supported_agents` alone says the runtime exists, not
/// that the host runs its turns (protocol.rs `CAPABILITY_CODEX_TURNS`). Claude
/// needs nothing. The frontend may match `cannot run hosted Codex` to fall
/// back to an in-process tab; keep the phrase.
pub(super) fn agent_refusal(agent: Agent, host_capabilities: &[String]) -> Option<String> {
    let needed = match agent {
        Agent::Claude => return None,
        Agent::Codex => CAPABILITY_CODEX_TURNS,
    };
    (!host_capabilities.iter().any(|held| held == needed)).then(|| {
        format!("falcon host cannot run hosted Codex; it predates the '{needed}' capability")
    })
}

pub(super) fn retract_operation(hosted: &Hosted, prompt: &str) -> Op {
    Op::RetractPrompt {
        session: hosted.session.clone(),
        generation: hosted.host_generation,
        lease: hosted.lease.clone(),
        prompt: prompt.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steer() -> Op {
        Op::SteerPrompt {
            session: "s1".into(),
            generation: 1,
            lease: Lease {
                token: "t".into(),
                revision: 1,
            },
            prompt: "p".into(),
        }
    }

    #[test]
    fn steer_is_refused_client_side_unless_the_host_advertises_it() {
        let refusal = capability_refusal(&steer(), &[]).expect("an older host lists none");
        assert!(refusal.contains("does not serve steer-prompt"), "{refusal}");
        assert!(capability_refusal(&steer(), &["other".into()]).is_some());
        assert_eq!(capability_refusal(&steer(), &["steer".into()]), None);
        let interrupt = Op::Interrupt {
            session: "s1".into(),
            generation: 1,
            lease: Lease {
                token: "t".into(),
                revision: 1,
            },
        };
        assert_eq!(capability_refusal(&interrupt, &[]), None, "base ops need nothing");
        let query = Op::Query {
            session: "s1".into(),
            generation: 1,
            method: "model/list".into(),
            params: serde_json::json!({}),
        };
        assert!(capability_refusal(&query, &[]).is_some());
        assert_eq!(capability_refusal(&query, &[CAPABILITY_CODEX_QUERY.into()]), None);
    }

    #[test]
    fn hosted_codex_needs_the_codex_turns_capability_and_claude_needs_none() {
        let refusal = agent_refusal(Agent::Codex, &["steer".into()]).expect("no codex_turns");
        assert!(refusal.contains("cannot run hosted Codex"), "{refusal}");
        assert!(refusal.contains("'codex_turns'"), "{refusal}");
        assert!(agent_refusal(Agent::Codex, &[]).is_some(), "an older host lists none");
        assert_eq!(agent_refusal(Agent::Codex, &["steer".into(), "codex_turns".into()]), None);
        assert_eq!(agent_refusal(Agent::Claude, &[]), None);
        assert_eq!(CAPABILITY_CODEX_TURNS, "codex_turns");
    }
}
