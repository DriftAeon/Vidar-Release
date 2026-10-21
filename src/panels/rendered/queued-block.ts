// A queued user message: dimmed text (click = take it back, wired by the caller) and a
// Steer button on the right. It interrupts the running turn so the queue flushes at once
// (2026-10-05), or, when the caller says `folds` (a Falcon transport with the steer op),
// adds the prompt to the running turn without stopping it. Shared by the
// in-process queue (composer.ts) and the Falcon host queue (host-payload.ts).
// A turn the queue cut short marks the prompt(s) that steered it (markSteered): a header
// strip over the message, in place of the turn's failure footer.

import { el } from "./dom";
import { iconImg } from "../../icon-img";
import { parseRelayAnswer, relayAnswerBlock } from "./relay-answer";
import { userText } from "./user-block";

export function queuedBlock(text: string, sendNow: () => void, folds = false): HTMLElement {
  // a Relay answer that lands mid-turn queues; it keeps the answered-Ask look, since the queued
  // block is promoted in place on delivery and never redrawn through userBlock (2026-10-05)
  const relay = parseRelayAnswer(text);
  const host = relay ? relayAnswerBlock(relay) : el("div", "blk blk-user");
  host.classList.add("blk-queued");
  if (!relay) {
    const span = el("span", "queued-text");
    userText(span, text);
    host.append(span);
  }
  // "Send Now" was too wordy (2026-10-05); Steer with the wheel (2026-10-11)
  const push = el("button", "agent-btn queued-send");
  push.append(iconImg("steer"), el("span", undefined, "Steer"));
  push.type = "button";
  push.title = folds ? "Add this to the running turn without stopping it" : "Stop the current turn and send this now";
  push.addEventListener("click", (ev) => {
    ev.stopPropagation(); // the block's own click retracts
    push.disabled = true;
    sendNow();
  });
  host.append(push);
  return host;
}

/** Delivered: an ordinary user block now, so the button goes with the queued look.
 *  A steer header (markSteered) stays. */
export function settleQueuedBlock(host: HTMLElement): void {
  host.classList.remove("blk-queued");
  host.title = "";
  host.querySelector(":scope > .queued-send")?.remove();
}

/** A turn that ended `error_during_execution` (Claude) or `interrupted` (Codex) while queued
 *  prompts were waiting was steered by them: no failure footer, the prompts carry the marker
 *  instead. Derived from the transcript alone, so a live turn and a replayed one draw the same. */
export function steeredTurn(subtype: string, pendingQueued: number): boolean {
  return (subtype === "error_during_execution" || subtype === "interrupted") && pendingQueued > 0;
}

/** The steer look (2026-10-11, variant C): a tinted strip with the wheel and
 *  "Steer" over the message. Idempotent; the Steer button goes, the turn is already over. */
export function markSteered(host: HTMLElement): void {
  if (host.classList.contains("blk-steered")) return;
  host.querySelector(":scope > .queued-send")?.remove();
  const text = host.querySelector<HTMLElement>(":scope > .queued-text");
  if (text) text.classList.add("steer-body");
  else {
    // a Relay answer: badge and answer move under the strip together
    const body = el("div", "steer-body");
    body.append(...Array.from(host.childNodes));
    host.append(body);
  }
  const head = el("div", "steer-head");
  head.append(iconImg("steer"), el("span", undefined, "Steer"));
  host.prepend(head);
  host.classList.add("blk-steered");
}
