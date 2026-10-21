//! The one gate every mutation passes, and the recorded dispatch behind it.
//! Split from `serve.rs`: authorising a mutation and journalling its
//! acceptance and settlement is its own concern, shared by `dispatch.rs`'s
//! verbs and the unattended-permission watcher.

use std::sync::Arc;

use serde_json::{json, Value};

use super::Host;
use crate::{
    journal::Body,
    protocol::{Lease, Response},
    session::Session,
};

/// The checks every mutation shares: the session exists at this generation,
/// this caller holds the lease, and the child has not exited.
///
/// Factored out because `Submit` and `RetractPrompt` need exactly these gates
/// but not `command`'s write-and-wait. Two copies of an authorisation check is
/// how one of them ends up missing a clause.
pub(super) fn guard_mutation(
    host: &Arc<Host>,
    id: u64,
    session: &str,
    generation: u64,
    lease: &Lease,
) -> Result<Arc<Session>, Response> {
    // Resolved WITHOUT the generation, so the lease is checked first.
    //
    // This is ordering for its own sake, NOT an information-hiding measure: an
    // earlier comment here claimed it stopped an unauthorised caller learning
    // the session's generation, which is hollow -- `Op::List` hands any
    // negotiated client every session's generation with no lease at all. What
    // it does buy is that the refusal a caller gets names the actual problem:
    // "you do not hold the lease" rather than "your generation is stale", when
    // both are true. The generation check below reproduces `get_current`'s
    // message exactly, so a legitimate client sees no behaviour change.
    let found = host
        .registry
        .get(session)
        .ok_or_else(|| Response::failed(id, "no such session"))?;
    if let Err(refusal) = found.check_control(lease) {
        return Err(Response::failed(
            id,
            refusal.message(found.controller_revision()),
        ));
    }
    if found.generation != generation {
        return Err(Response::failed(
            id,
            format!(
                "stale generation {generation}; session {session} is at {}",
                found.generation
            ),
        ));
    }
    if found.exited().is_some() {
        return Err(Response::failed(id, "session has exited"));
    }
    // Durability is a precondition for accepting anything NEW, not a
    // nice-to-have. A session that cannot journal can still stream and still be
    // read, but telling a client "applied" for something no replay would ever
    // show is the lie the whole append-before-publish ordering exists to
    // prevent.
    //
    // `Close` and `Terminate` deliberately do NOT come through here and are not
    // gated by this: killing a session is how you get OUT of a degraded state,
    // and refusing it would leave a session that can neither accept work nor be
    // shut down.
    if let Some(why) = found.degraded() {
        return Err(Response::failed(
            id,
            format!("session is degraded and cannot accept mutations: {why}"),
        ));
    }
    Ok(found)
}

/// Resolve the session, check the lease and the generation, build the line,
/// then write it and wait for the sidecar's terminal outcome.
///
/// Every mutation on a live child comes through here, which is the point: one
/// gate, not one per operation. Two different staleness checks meet here and
/// they are not interchangeable — the lease says *who* may drive this session,
/// the generation says *which child* the caller still believes in. A client can
/// hold a perfectly good lease and still be talking to a replaced child.
///
/// The gates themselves live in [`guard_mutation`] and are called, not copied.
/// An earlier version inlined them here as well, which is precisely the
/// duplication `guard_mutation`'s own doc warns about.
pub(super) fn command(
    host: &Arc<Host>,
    id: u64,
    client_id: &str,
    session: &str,
    generation: u64,
    lease: &Lease,
    build: impl FnOnce(&Session) -> Result<Value, String>,
) -> Response {
    let found = match guard_mutation(host, id, session, generation, lease) {
        Ok(found) => found,
        Err(refusal) => return refusal,
    };
    let line = match build(&found) {
        Ok(line) => line,
        Err(error) => return Response::failed(id, error),
    };

    let settled = dispatch_recorded(&found, &format!("{client_id}#{id}"), line);
    match settled {
        (crate::protocol::Outcome::Applied, message) => {
            Response::applied(id, json!({ "applied": true, "message": message }))
        }
        (crate::protocol::Outcome::Failed, message) => {
            Response::failed(id, message.unwrap_or_else(|| "command failed".into()))
        }
        (crate::protocol::Outcome::DeliveryUnknown, message) => Response::delivery_unknown(
            id,
            message.unwrap_or_else(|| "the child never acknowledged this command".into()),
        ),
    }
}

/// Reserve a command id, journal its acceptance, dispatch it to the child,
/// and journal its settlement.
///
/// Factored out of [`command`] so the unattended-permission watcher can drive
/// exactly the same reserve/journal/dispatch/journal sequence — with no lease
/// to check and a synthetic `client_id` — rather than a second copy that
/// could drift from it.
///
/// Journalling the acceptance BEFORE the child can act on it is what lets a
/// reconnecting client see "this may have been delivered" rather than
/// nothing at all if Falcon dies in between. Settlement is fail-closed the
/// same way: a settlement that cannot be journalled degrades the answer to
/// `DeliveryUnknown` rather than reporting `Applied` on the strength of a
/// durability that was never recorded, or `Failed` — which would invite a
/// retry — for a command that really may have reached the child.
pub(super) fn dispatch_recorded(
    session: &Session,
    client_id: &str,
    line: Value,
) -> (crate::protocol::Outcome, Option<String>) {
    let kind = line
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    // One command identity, allocated by the driver and used for BOTH the
    // durable record and the dispatch. The client's request id is
    // per-connection and restarts at 1, so keying the journal on it lets two
    // clients — or one across a reconnect — silently overwrite each other's
    // acceptance and outcome. The request id is kept only as correlation.
    let command_id = session.driver.reserve_command();
    if let Err(error) = session.record(Body::CommandAccepted {
        command: command_id,
        client: client_id.to_string(),
        kind: kind.clone(),
        payload: line.clone(),
    }) {
        // Refuse rather than proceed: accepting a mutation we cannot record
        // would make the journal describe a session that never existed.
        return (
            crate::protocol::Outcome::Failed,
            Some(format!("cannot journal the command: {error}")),
        );
    }

    let settled = session.driver.command_as(command_id, &session.child, line);

    if let Err(error) = session.record(Body::CommandSettled {
        command: command_id,
        outcome: settled.0,
        message: settled.1.clone(),
    }) {
        eprintln!(
            "falcon {}: could not journal the outcome of command {command_id}: {error}",
            session.id
        );
        return (
            crate::protocol::Outcome::DeliveryUnknown,
            Some(format!(
                "outcome not durable ({error}); do not retry this command"
            )),
        );
    }

    settled
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    use crate::{protocol::Outcome, session::tests::codex_session};

    #[test]
    fn a_codex_setter_has_one_accepted_and_one_settlement_record() {
        let (_temp, session) = codex_session("policy-setter");
        let line = json!({"type":"set_model","model":"gpt-new"});
        assert_eq!(
            dispatch_recorded(&session, "owner#1", line),
            (Outcome::Applied, None)
        );
        let (records, _) = session
            .hydrate_from(0, session.journal_position(), 20, 1024 * 1024)
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(
            matches!(&records[0].body, Body::CommandAccepted { kind, .. } if kind == "set_model")
        );
        assert!(matches!(
            &records[1].body,
            Body::CommandSettled {
                outcome: Outcome::Applied,
                ..
            }
        ));
        session.child.terminate_tree();
    }
}
