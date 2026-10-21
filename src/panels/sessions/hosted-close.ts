// Close decision for a Falcon-hosted tab: whether a close may drop the tab locally without the
// host's acknowledgement. Pure, so the rule is testable without a Rendered body.

/** Errors that mean this view can no longer reach its hosted session: the control pipe broke
 *  (`connection.rs` read/write), was dropped after a failed request, or was replaced by a new
 *  connection whose epoch no longer matches the tab's lease (`falcon.rs` `hosted_request`).
 *  A timeout ("did not answer") is not here: delivery is unknown, so the tab stays for a retry. */
const UNREACHABLE = [
  "falcon control disconnected",
  "falcon control changed",
  "read from falcon:",
  "write to falcon:",
];

function hostedUnreachable(error: unknown): boolean {
  const text = String(error);
  return UNREACHABLE.some((marker) => text.includes(marker));
}

/** "remove": drop the tab now and tell Falcon best-effort; "keep": leave it attached with the
 *  failure in the tab menu. A tab whose host connection is already lost never waits on the host. */
export function hostedCloseDecision(state: { disconnected: boolean; error?: unknown }): "remove" | "keep" {
  if (state.disconnected) return "remove";
  if (state.error === undefined) return "remove";
  return hostedUnreachable(state.error) ? "remove" : "keep";
}
