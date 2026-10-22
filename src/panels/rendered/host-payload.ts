// Host payloads of a Falcon-hosted Rendered body: disconnect, hydration start/end, and the
// host's own records (queued, dispatched and retracted prompts, permission and command state).

import type { HostPermissionState } from "../rendered-settle";
import type { AgentTransport } from "./transport";
import type { HostPayload } from "./host-router";
import { pretty } from "./format";
import { el } from "./dom";
import { connectionLostCard } from "./connection-lost";
import { queuedBlock, settleQueuedBlock } from "./queued-block";
import { steerHosted } from "./composer";
import type { RenderedOpts } from "./opts";
import type { Group, RenderedState, ToolRecord } from "./state";
import type { Follow } from "./follow";
import type { HydrateStats } from "./hydrate-stats";
import type { Bang } from "./bang";

/** The text blocks of an array prompt joined by newlines, or null when it has none. */
function textBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((b) => (b && b.type === "text" && typeof b.text === "string" ? [b.text] : []));
  return texts.length ? texts.join("\n") : null;
}

/** What the host payload handler closes over in createRenderedBody. */
export interface HostPayloadDeps {
  opts: RenderedOpts;
  transport: AgentTransport;
  root: HTMLElement;
  follow: Follow;
  textarea: HTMLTextAreaElement;
  approvals: Map<string, HTMLElement>;
  cancelApprovals: (reason: string) => void;
  alreadyAnswered: (text: string) => boolean;
  resetTranscript: () => void;
  resetCache: () => void;
  setInTurn: (on: boolean) => void;
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  sealGroup: () => void;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  refreshState: () => void;
  emitCharacterStatus: (fresh: boolean) => void;
  /** stops the running turn (composer.ts); a queued prompt's Steer when the host cannot fold */
  interrupt: () => void;
  stats: HydrateStats;
  /** opens the pill and group of each card attached during hydration that still awaits an answer */
  openHydratedCards: () => void;
  /** the body's tool pills and tool-pills' stale-marker: a closed hydration sweeps the pills still open */
  tools: ReadonlyMap<string, ToolRecord>;
  stalePill: (t: { details: HTMLDetailsElement; group: Group | null }) => void;
  bang: Bang;
}

/** Closes a hydration that will never see `hydration: end` (a failed replay, a dropped host
 *  connection): clears the flags, closes the meter, opens the still-pending cards. Also the body
 *  of the normal end. Returns whether a hydration was open. */
export function closeHydration(
  S: Pick<RenderedState, "hydrating" | "replaying"> & Partial<Pick<RenderedState, "inTurn">>,
  stats: Pick<HydrateStats, "end">,
  openHydratedCards: () => void,
  settleStalePills?: () => void,
): boolean {
  const was = S.hydrating;
  S.hydrating = false;
  S.replaying = false;
  if (was) {
    stats.end();
    openHydratedCards();
    // the replayed turn_done skipped its sweep (replaying): with no live turn, pills still open are over
    if (!S.inTurn) settleStalePills?.();
  }
  return was;
}

/** The `prompt-undelivered` reasons for a steer Codex never answered share this stem
 *  (`src-falcon/src/session/dispatch.rs`, `UNANSWERED_BY_TURN_END` / `UNANSWERED_BY_CLOSE`). */
const UNANSWERED_STEER = "the agent never answered the steer";

/** The notice a released steer's block carries, or null for any other undelivered reason. */
export function releasedSteerNotice(reason: string): string | null {
  if (!reason.startsWith(UNANSWERED_STEER)) return null;
  return reason.endsWith("before the session closed")
    ? "This steer may not have reached Codex: the session closed before Codex answered it."
    : "This steer may not have reached Codex: the turn ended before Codex answered it.";
}

/** The transcript's notice line, placed directly under the block it is about. */
function attachNotice(host: HTMLElement, text: string): void {
  const next = host.nextElementSibling;
  if (next?.classList.contains("blk-notice") && next.textContent === text) return;
  host.after(el("div", "blk blk-notice warn", text));
}

export function createHostPayload(S: RenderedState, deps: HostPayloadDeps) {
  const {
    opts, transport, root, follow, textarea, approvals, cancelApprovals, alreadyAnswered,
    resetTranscript, resetCache, setInTurn, append, sealGroup, noticeBlock, refreshState, emitCharacterStatus, interrupt, stats, openHydratedCards, tools, stalePill, bang,
  } = deps;
  const settleStalePills = () => {
    for (const t of tools.values()) {
      const c = t.details.classList;
      if (c.contains("running") || c.contains("pending") || c.contains("awaiting")) stalePill(t);
    }
  };
  const hostedPrompts = new Map<string, { text: string; host: HTMLElement }>();
  /** The last `prompt-dispatched` that was not a steer: it set in-turn for a turn of its own, so its
   *  `prompt-requeued` (the write refused outright, no turn running; it follows its dispatch, as
   *  journal.rs says) ends that in-turn state. A requeued steer leaves the running turn alone. */
  let plainDispatch: string | null = null;

  /** A host-queued prompt's block, registered under its id: click retracts, Steer folds it in. */
  function queuedHostBlock(prompt: string, content: unknown): HTMLElement {
    // held ! output rides in front of the user's text: show only the text; runs this body did
    // not compose (a bus prompt) are drawn live, and all are redrawn on a replay
    // a skill prompt is [text, skill] blocks: the user typed the text block ("/name args")
    const shown = typeof content === "string" ? content : textBlocks(content) ?? pretty(content);
    const { runs, text } = bang.fromRecord(shown, S.hydrating);
    // the host dispatches it once the turn ends; Steer folds it into the running turn now
    const host = queuedBlock(text, () => {
      void steerHosted(transport, opts.tabId, S.gen, prompt, interrupt, (error) => {
        const button = host.querySelector<HTMLButtonElement>(":scope > .queued-send");
        if (button) button.disabled = false;
        noticeBlock(`Could not steer: ${String(error)}`, "error");
      });
    }, !!transport.steer); // same gate as steerHosted: no steer op means the interrupt
    host.title = "Queued: click to undo";
    hostedPrompts.set(prompt, { text, host });
    host.addEventListener("click", () => {
      if (S.hydrating || S.disconnected || !host.classList.contains("blk-queued")) return;
      void transport.retract?.(opts.tabId, S.gen, prompt).then(() => {
        bang.hold(runs);
        textarea.value = textarea.value ? `${text}\n\n${textarea.value}` : text;
        textarea.focus();
      }).catch((error) => noticeBlock(`Could not retract: ${String(error)}`, "error"));
    });
    return host;
  }

  function hostPayload(payload: HostPayload) {
    if (payload.disconnected) {
      S.disconnected = true;
      S.characterTurnOpen = false; // else syncCharacterActive keeps the character animating
      setInTurn(false); // keeps isBusy in sync; a stuck busy flag reads as a running turn
      // a replay that fails mid-way ends in `disconnected`, never `hydration: end`
      // A disconnect outside hydration ends the turn the same way: no live turn is left to
      // finish its tool pills, so the ones still open settle here.
      if (!closeHydration(S, stats, openHydratedCards, settleStalePills)) settleStalePills();
      root.inert = false;
      sealGroup();
      append(connectionLostCard(payload.disconnected));
      refreshState();
      return;
    }
    if (payload.hydration === "start") {
      stats.start();
      S.hydrating = true;
      S.replaying = true;
      S.disconnected = false;
      root.inert = true;
      cancelApprovals("view restored");
      resetTranscript();
      hostedPrompts.clear();
      plainDispatch = null;
      S.costTotal = 0;
      setInTurn(false);
      S.characterTurnOpen = false;
      resetCache();
    }
    stats.record();
    const record = payload.hostRecord;
    const body = (record?.body ?? record) as Record<string, unknown> | undefined;
    if (body) {
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      switch (body.record) {
        case "prompt-queued": {
          if (hostedPrompts.has(prompt)) break;
          append(queuedHostBlock(prompt, body.content));
          break;
        }
        case "prompt-requeued": {
          // dispatched, then never taken (a refused steer or write): queued again, in place of its
          // settled block; the Map keeps its first-queued order, which is the host's queue order
          const old = hostedPrompts.get(prompt)?.host;
          const host = queuedHostBlock(prompt, body.content);
          if (old?.isConnected) old.replaceWith(host);
          else append(host);
          // a steer folded into a running turn leaves that turn running; a plain dispatch never started one
          if (prompt && plainDispatch === prompt) {
            plainDispatch = null;
            setInTurn(false);
          }
          break;
        }
        case "prompt-undelivered": {
          // `pump` took it and the write was refused (no turn started): the block goes. A steer the
          // agent never answered was released, possibly while a later turn runs: Codex may have
          // applied it, so the block stays and says so. The host no longer holds either.
          // Only the prompt's own plain dispatch set in-turn for it, so only that one ends it.
          const host = hostedPrompts.get(prompt)?.host;
          const notice = releasedSteerNotice(typeof body.reason === "string" ? body.reason : "");
          if (notice === null) host?.remove();
          else if (host?.parentElement) attachNotice(host, notice);
          else noticeBlock(notice, "warn");
          hostedPrompts.delete(prompt);
          if (prompt && plainDispatch === prompt) {
            plainDispatch = null;
            setInTurn(false);
          }
          break;
        }
        case "prompt-dispatched": {
          const held = hostedPrompts.get(prompt);
          if (held) settleQueuedBlock(held.host);
          // a steer joins the running turn and never starts one: in-turn stays as it is (the
          // turn it named may already have ended, and its requeue then finds nothing to clear)
          if (body.steered !== true) {
            plainDispatch = prompt;
            setInTurn(true);
          }
          break;
        }
        case "prompt-retracted":
          hostedPrompts.get(prompt)?.host.remove();
          hostedPrompts.delete(prompt);
          break;
        case "permission-state": {
          // a card folded on delivery has left `approvals` but still takes its host record
          const card = (approvals.get(String(body.request))
            ?? root.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(String(body.request))}"]`)) as (HTMLElement & { hostSettle?: (state: HostPermissionState) => void }) | undefined;
          card?.hostSettle?.(String(body.state));
          break;
        }
        case "command-settled":
          if (body.outcome === "failed" && alreadyAnswered(String(body.message ?? ""))) break;
          if (body.outcome === "failed" || body.outcome === "delivery-unknown") {
            noticeBlock(`Command ${String(body.outcome)}: ${String(body.message ?? "No further detail")}`, "error");
          }
          break;
      }
    }
    if (payload.hydration === "end") {
      // Idempotent: a hydration already closed (by a disconnect) keeps its meter's t1.
      closeHydration(S, stats, openHydratedCards, settleStalePills);
      root.inert = false;
      refreshState();
      emitCharacterStatus(false);
      follow.jump(); // a restored view lands at the end, no glide
    }
  }
  /** The host's oldest prompt still waiting: the one it dispatches when this turn ends
   *  (`pump` takes one per turn end), so the one a steered turn hands over. */
  function nextHostedPrompt(): HTMLElement[] {
    for (const held of hostedPrompts.values()) if (held.host.classList.contains("blk-queued")) return [held.host];
    return [];
  }
  return { hostPayload, nextHostedPrompt };
}
