// Pure decision logic for the host's `permission-state` event (rendered.ts
// `permission-state` handler + the approval card's `settle`). Kept separate
// so the state → outcome mapping is unit-testable without the DOM.

export type HostPermissionState = "settled" | "cancelled" | "cancelled-by-exit" | string;

export type SentDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message?: string };

export type HostSettle =
  | { decision: { behavior: "allow" | "deny"; message?: string }; label: string; cls: "allow" | "deny" | "settled" }
  | null;

/** The sidecar refuses a second response to one permission id by design
 *  (tools\claude-sidecar.mjs, `no pending permission <id>`). That refusal reaches
 *  the panel three ways: a `command-settled` failure, a rejected send
 *  (`falcon mutation: …`) and the sidecar's own error notice. Returns the id when
 *  `text` is that refusal, so the card reads as already answered, not as an error. */
export function alreadyAnsweredId(text: string): string | null {
  const m = /no pending permission (\S+)/.exec(text);
  return m ? m[1] : null;
}

export function hostSettleDecision(state: HostPermissionState, sent: SentDecision | null, isQuestion: boolean): HostSettle {
  if (state === "settled") {
    if (sent === null) {
      return { decision: { behavior: "deny", message: "settled" }, label: "Settled by the agent", cls: "settled" };
    }
    if (sent.behavior === "allow") {
      return { decision: { behavior: "allow" }, label: isQuestion ? "Answered" : "Allowed", cls: "allow" };
    }
    const why = sent.message ? `: ${sent.message}` : "";
    return { decision: { behavior: "deny", message: sent.message }, label: `Denied${why}`, cls: "deny" };
  }
  if (state === "cancelled") {
    return { decision: { behavior: "deny", message: state }, label: "Cancelled by the agent", cls: "deny" };
  }
  if (state === "cancelled-by-exit") {
    return { decision: { behavior: "deny", message: state }, label: "Cancelled: the agent exited", cls: "deny" };
  }
  return null;
}
