//! Vocabulary every hosted driver shares: command timeout, permission states,
//! what the reader does with a child line, and the binary hash check.
//! Neither adapter owns it, so neither names the other to reach it.

use std::{path::Path, time::Duration};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// How long Falcon waits for the sidecar's terminal outcome before reporting
/// the delivery as unknown. Generous: the SDK's own control requests
/// (`setModel`, `setPermissionMode`) round-trip to the CLI.
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Where a permission request currently stands. Falcon keeps it pending until
/// something genuinely terminal happens, because a card the UI drops while the
/// CLI is still blocked on it strands the agent forever.
///
/// Only [`Settled`](PermissionState::Settled),
/// [`Cancelled`](PermissionState::Cancelled) and
/// [`CancelledByExit`](PermissionState::CancelledByExit) are terminal.
/// `Returned` is not: the sidecar's `canUseTool` callback returned a result,
/// which says nothing about the SDK then delivering it — the SDK writes the
/// control_response itself, after the callback returns, and drops that write
/// silently once its query has cleaned up. A response that failed to deliver
/// likewise stays pending (the sidecar's `failed` record maps back to
/// `Opened`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Opened,
    Responded,
    /// The callback returned; delivery to the CLI is unconfirmed.
    Returned,
    /// A terminal signal from the agent: the CLI consumed the decision, or the
    /// turn that opened the request ended.
    Settled,
    /// The SDK aborted the request, or the sidecar denied it as the session
    /// closed.
    Cancelled,
    /// The child exited with the request outstanding, so it can never be
    /// answered. Terminal, and deliberately not `Settled`: nobody decided this
    /// one, the process died under it.
    CancelledByExit,
}

impl PermissionState {
    /// Terminal states are the only ones that drop a request from pending.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            PermissionState::Settled
                | PermissionState::Cancelled
                | PermissionState::CancelledByExit
        )
    }
}

/// What the reader should do with a sidecar line after the driver has seen it.
pub enum Observed {
    /// Protocol bookkeeping; the client never sees it.
    Consumed,
    /// Forward verbatim to attached clients.
    Forward,
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
