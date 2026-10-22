// Composer of a Rendered body: submit, local /clear, sending a user message, the
// mid-turn queue, interrupt, and the textarea's key and input handling.

import type { AgentTransport } from "./transport";
import { denyWithin } from "./cards";
import { queuedBlock, settleQueuedBlock } from "./queued-block";
import type { RenderedState, StatusLine } from "./state";
import type { Bang } from "./bang";
import type { SendStick } from "./follow";

/** What the composer closes over in createRenderedBody. */
export interface ComposerDeps {
  transport: AgentTransport;
  textarea: HTMLTextAreaElement;
  palette: HTMLElement;
  sl: StatusLine;
  queued: { text: string; host: HTMLElement }[];
  approvals: Map<string, HTMLElement>;
  sendEncoded: (line: string | null) => Promise<boolean>;
  localCommand: (text: string) => boolean;
  /** deny every open card as Esc does (cards.ts), before an interrupt */
  denyPending: () => Promise<void>;
  stopAgent: (detach?: boolean) => Promise<void>;
  spawn: () => Promise<void>;
  resetTranscript: () => void;
  setInTurn: (on: boolean) => void;
  sealGroup: () => void;
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  userBlock: (text: string) => void;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  updatePalette: () => void;
  movePalette: (d: number) => void;
  pickPalette: () => void;
  hidePalette: () => void;
  bang: Bang;
  sendStick: SendStick;
}

/** falcon_steer's refusal when the running host predates the op (src-tauri falcon/ops.rs). */
const STEER_UNSUPPORTED = "does not serve steer-prompt";

/** Steer for a host-queued prompt: fold it into the running turn (falcon_steer) without
 *  interrupting it, so the turn and its background agents keep going. A transport without the
 *  op, or a host that predates it, gets the old Steer: the interrupt. Any other refusal (already
 *  dispatched, write failed) goes to `onError` and never interrupts: the turn may be the very
 *  one this prompt started. Esc and Stop keep the interrupt (an open card is denied first);
 *  they never come through here. */
export function steerHosted(
  transport: AgentTransport, tabId: string, gen: number, prompt: string,
  interrupt: () => void, onError: (error: unknown) => void,
): Promise<void> {
  if (!transport.steer) { interrupt(); return Promise.resolve(); }
  return transport.steer(tabId, gen, prompt).catch((error) => {
    if (String(error).includes(STEER_UNSUPPORTED)) interrupt();
    else onError(error);
  });
}

export function createComposer(S: RenderedState, deps: ComposerDeps) {
  const {
    transport, textarea, palette, sl, queued, approvals, sendEncoded, localCommand, denyPending, stopAgent, spawn,
    resetTranscript, setInTurn, sealGroup, append, userBlock, noticeBlock,
    updatePalette, movePalette, pickPalette, hidePalette, bang, sendStick,
  } = deps;

  /** False when the text was not taken (empty, dead, hydrating or disconnected: it stays in the
   *  composer); true once it is handled locally or queued. A durable tab resolves with the
   *  host's answer, so a refusal after the hand-off reads false (the text is back in the composer). */
  function submit(fromKey = false): boolean | Promise<boolean> {
    const text = textarea.value;
    if (!text.trim() || !S.isAlive || S.hydrating || S.disconnected) return false;
    // a `!` line runs only on a keyboard Enter (fromKey); anything else leaves it unsent here
    const banged = bang.handle(text.trim(), fromKey);
    if (banged !== null) { if (banged) { textarea.value = ""; hidePalette(); } return banged; }
    textarea.value = "";
    hidePalette();
    // /clear is a terminal-UI command: headless Claude Code has nothing to do with
    // it, so it is local — stop the agent, forget the session id, start fresh.
    if (text.trim() === "/clear") { bang.drop(); void clearSession(); return true; }
    if (localCommand(text.trim())) return true; // before the queue check, or it is queued as prose
    if (S.inTurn && !transport.durable) { queueMessage(text); return true; }
    if (fromKey) sendStick.arm(); // a keyed send's echo re-sticks the view; a bus write leaves it
    return sendUser(text);
  }
  /** Text from a card (a Codex async ask's answer) as an ordinary user message; the composer's draft is left alone. */
  function sendText(text: string): boolean | Promise<boolean> {
    if (!text.trim() || !S.isAlive || S.hydrating || S.disconnected) return false;
    if (S.inTurn && !transport.durable) { queueMessage(text); return true; }
    return sendUser(text);
  }
  async function clearSession() {
    // the stop/respawn drops the caret (2026-10-09: /clear then /catapult needed a click);
    // hand it back unless the user has since focused something else
    const hadFocus = document.activeElement === textarea;
    try {
      try { await stopAgent(); }
      catch (error) { noticeBlock(`Could not close session: ${String(error)}`, "error"); return; }
      S.sessionId = null;
      // the new session starts with an empty window; carrying the old number over
      // reads as "this context is already spent"
      sl.ctxTokens = 0;
      sl.ctxPct = null;
      resetTranscript();
      await spawn();
    } finally {
      const now = document.activeElement;
      if (hadFocus && textarea.isConnected && (now === null || now === document.body || now === textarea)) textarea.focus();
    }
  }
  function sendUser(text: string): boolean | Promise<boolean> {
    const { runs, wire } = bang.take(text); // held ! output rides in front of this message, once
    if (transport.durable) {
      return sendEncoded(S.adapter.encodeUser(wire)).then((ok) => {
        if (!ok) {
          sendStick.disarm();
          bang.hold(runs);
          textarea.value = textarea.value ? `${text}\n\n${textarea.value}` : text;
          noticeBlock("Prompt submission was not confirmed. Check the transcript before sending it again.", "error");
        }
        return ok;
      });
    }
    userBlock(text);
    setInTurn(true); // optimistic; turn_start confirms, turn_done clears
    void sendEncoded(S.adapter.encodeUser(wire)).then((ok) => { if (!ok) { sendStick.disarm(); bang.hold(runs); setInTurn(false); } });
    return true;
  }
  /** Hold a mid-turn message where the user can see it, and take it back on click.
   *  `.blk-queued` IS the recoverable flag — while it is on the block the text has not
   *  been confirmed delivered, so the click handler is live; flushQueue strips it only
   *  once agent_send has resolved ok. */
  function queueMessage(text: string) {
    sealGroup();
    const host = queuedBlock(text, interrupt); // turn end flushes the queue
    host.title = "Queued: click to undo";
    const rec = { text, host };
    host.addEventListener("click", () => {
      if (!host.classList.contains("blk-queued")) return; // delivered: an ordinary block now
      const i = queued.indexOf(rec);
      if (i >= 0) queued.splice(i, 1);
      host.remove();
      // in front of whatever is in the composer now: it was typed first
      textarea.value = textarea.value ? `${text}\n${textarea.value}` : text;
      textarea.focus();
      updatePalette();
    });
    queued.push(rec);
    append(host);
  }
  /** This text was never delivered. It keeps its pending block and its click-to-recover
   *  and says why — the one outcome this must never produce is silent loss. */
  function markUndelivered(host: HTMLElement, why: string) {
    host.classList.add("dropped");
    host.title = why;
  }
  /** The turn ended: everything typed during it goes as one message, in order. The
   *  pending blocks stay exactly where they are until agent_send resolves (review
   *  51492eb3) — clearing them first meant a rejected send left the text as an ordinary
   *  user block that nothing could mark undelivered or recover. On success they are
   *  promoted in place by dropping `.blk-queued`, so nothing is redrawn and there is no
   *  window in which the text exists in neither state. */
  function flushQueue() {
    if (S.hydrating || S.replaying || transport.durable) return;
    if (!queued.length || !S.isAlive || S.inTurn) return;
    const batch = queued.splice(0, queued.length);
    const text = batch.map((q) => q.text).join("\n\n");
    const { runs, wire } = bang.take(text);
    setInTurn(true); // optimistic; turn_start confirms, turn_done clears
    void sendEncoded(S.adapter.encodeUser(wire)).then((ok) => {
      if (!ok) {
        bang.hold(runs);
        setInTurn(false);
        for (const q of batch) markUndelivered(q.host, "Not sent — the send failed. Click to take it back.");
        return;
      }
      for (const q of batch) settleQueuedBlock(q.host);
    });
  }
  /** An open card is denied first (as Esc does): an interrupt while the agent waits on a
   *  permission makes the SDK throw (A7). With no card the interrupt goes out at once, as before.
   *  The deny waits DENY_WAIT_MS at most (a slow host, as stopAgent does), and a repeat press
   *  while it waits is ignored: the card reads responding by then, so a second deny returns at
   *  once and its interrupt would go out with the card still open (C2). */
  let denyingThenInterrupt = false;
  function interrupt() {
    if (!S.isAlive || !S.inTurn || denyingThenInterrupt) return;
    S.interruptSent = true;
    const send = () => { void sendEncoded(S.adapter.encodeInterrupt()).then((ok) => { if (!ok) S.interruptSent = false; }); };
    if (!S.pendingApproval) { send(); return; }
    denyingThenInterrupt = true;
    void denyWithin(denyPending).catch((e) => console.error("deny before interrupt:", e)).then(() => {
      denyingThenInterrupt = false;
      if (S.isAlive && S.inTurn) send();
    });
  }
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      if (!palette.classList.contains("hidden") && S.paletteSel) {
        ev.preventDefault();
        // Enter on a fully typed command sends it; Enter on a partial completes it.
        // Before, "/clear" + Enter only became "/clear " and needed a second Enter —
        // true of every command in the palette, not just clear.
        if (textarea.value.trim() === `/${S.paletteSel}`) { hidePalette(); submit(true); } else pickPalette();
        return;
      }
      ev.preventDefault();
      submit(true);
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      if (!palette.classList.contains("hidden")) { hidePalette(); return; }
      if (S.pendingApproval) {
        const card = approvals.get(S.pendingApproval) as (HTMLElement & { settle?: (d: { behavior: "deny" }) => void }) | undefined;
        card?.settle?.({ behavior: "deny" });
        return;
      }
      interrupt();
      return;
    }
    if (!palette.classList.contains("hidden")) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        movePalette(ev.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (ev.key === "Tab") { ev.preventDefault(); pickPalette(); return; }
    }
  });
  textarea.addEventListener("input", () => updatePalette());

  /** What a steered turn hands over: flushQueue sends the whole queue as one message. */
  const queuedHosts = () => queued.map((q) => q.host).filter((h) => h.classList.contains("blk-queued"));
  return { submit, sendText, flushQueue, markUndelivered, interrupt, queuedHosts };
}
