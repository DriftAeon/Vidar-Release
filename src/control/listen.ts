// src\control\listen.ts — the frontend half of the `ctl.*` bus surface
// Rust (`src-tauri\src\control`)
// resolves the requester and emits one `ctl-*` event per verb call, parking the
// bus reply; this module does the actual work through `registry.ts` and answers
// with `invoke("control_result", …)`. Registers its listeners at import time —
// main.ts needs only the one `import "./control/listen"` line.

import { listen as ipcListen, invoke } from "../ipc";
import { sessionTitle } from "../panels/sessions";
import { askGate, cancelAsk } from "../panels/askgate";
import {
  driveSnapshot, showDocument, showDisplay, focusTarget, resolveTab, requesterTabId, readTranscript, promptTab, spawnTab, hasRenderedAgent,
  hostedTab, tabPromptReady, tabBusy, tabDead, sendPromptTo, laneToast, hostedRenderedAgent,
} from "./registry";
import { EFFORT_LEVELS } from "../agents/protocol";
import type { Requester } from "./requester";
import { watchTab } from "./watch";
import { createLanes, laneDeliverTo, laneReport, type LaneLease } from "./lanes";
import type { ReplyDoneDetail } from "../panels/reply-events";
import { titleCase } from "../format";
import { briefRows } from "./brief-card";
import { cardText, laneRows } from "./lane-card";
import { handleFlowCard, listenFlowObserve } from "./flow";
import { startFlowApprovalRelay } from "../flow/approvals-relay";
import { promptTargetRefusal, promptDeliveryRefusal } from "./prompt-gate";

export type { Requester };

/** `{ kind: "falcon_session" }` needs a tab behind it before any verb runs:
 *  Rust names it when `falcon.hosted` holds the session
 *  (spawned hosted tabs), else the frontend's `sessions.ts` map must (adopted
 *  tabs). `{ kind: "token" }` was already resolved in Rust's token map. */
function requesterProblem(r: Requester): string | null {
  if (r.kind === "falcon_session" && !requesterTabId(r)) {
    return "no requester";
  }
  return null;
}

function reply(id: string, ok: boolean, line: string): void {
  void invoke("control_result", { id, ok, line });
}

type ProjectedTab = { id: string; kind: string; agent: string; title: string };

// Both the JSON and text ctl.state paths list every tab (a name is an address, so a tab left
// off the list could not be named); the JSON keeps full titles (exact match), only the one-line summary clamps.
function tabsLine(tabs: ProjectedTab[]): string {
  return tabs.map((t) => ({ ...t, title: t.title.slice(0, 48) })).map((t) => `${t.id} ${t.kind} ${t.agent} ${t.title}`).join(" | ");
}

// Never send driveSnapshot() over the bus — it carries falconSession/sessionId
// and each rendered tab's chips and pending cards.
// Explicit projection: only what a caller needs to name and pick a tab.
function projectState(snap: ReturnType<typeof driveSnapshot>): { active: string | null; tabs: ProjectedTab[] } {
  return {
    active: snap.activeId,
    tabs: snap.tabs.map((t) => ({ id: t.id, kind: t.body, agent: t.agent, title: t.title })),
  };
}

ipcListen<{ id: string; json: boolean; requester: Requester }>("ctl-state", (e) => {
  const { id, json, requester } = e.payload;
  const problem = requesterProblem(requester);
  if (problem) { reply(id, false, `err ${problem}`); return; }
  const proj = projectState(driveSnapshot());
  if (json) { reply(id, true, JSON.stringify(proj)); return; }
  reply(id, true, `active=${proj.active ?? "-"} tabs=${proj.tabs.length} ${tabsLine(proj.tabs)}`);
});

ipcListen<{ id: string; pane: "document" | "display"; path: string; focus: boolean; requester: Requester }>(
  "ctl-show",
  (e) => {
    const { id, pane, path, focus, requester } = e.payload;
    const problem = requesterProblem(requester);
    if (problem) { reply(id, false, `err ${problem}`); return; }
    const name = path.split("\\").pop() ?? path;
    const open = pane === "display" ? showDisplay(path, focus) : showDocument(path, focus);
    void open.then((r) => {
      reply(id, r.ok, r.ok ? `shown ${pane} ${name}` : `err ${r.reason ?? "open failed"}`);
    }).catch((err) => reply(id, false, `err ${err}`));
  },
);

ipcListen<{ id: string; bytes: number; requester: Requester }>("ctl-read", (e) => {
  const { id, bytes, requester } = e.payload;
  const problem = requesterProblem(requester);
  if (problem) { reply(id, false, `err ${problem}`); return; }
  const tabId = requesterTabId(requester);
  if (!tabId) { reply(id, false, "err no requester"); return; }
  const r = readTranscript(tabId, bytes);
  reply(id, r.ok, r.ok ? r.text : `err ${r.reason}`);
});

// One AbortController per live wait, keyed by control id. Rust emits
// `ctl-wait-cancel { id }` when it has already answered a wait itself
// (superseded by the same requester's next wait on that tab, or any later
// Rust-side end); the watcher stops polling and sends no reply.
const waitAborts = new Map<string, AbortController>();
listenFlowObserve(reply, requesterProblem);
startFlowApprovalRelay();
ipcListen<{ id: string }>("ctl-wait-cancel", (e) => {
  const { id } = e.payload;
  waitAborts.get(id)?.abort();
  waitAborts.delete(id);
});

// `ctl.wait`: no card, observe-only. A raw tab has no state chip to
// watch, and a tab waiting on itself could never see its own turn end.
ipcListen<{ id: string; tab: string; report: string | null; timeoutMs: number; requester: Requester }>("ctl-wait", (e) => {
  const { id, report, timeoutMs, requester } = e.payload;
  const problem = requesterProblem(requester);
  if (problem) { reply(id, false, `err ${problem}`); return; }
  const tab = resolveTab(e.payload.tab) ?? e.payload.tab; // an id or a name; unknown stays as given
  const requesterTab = requesterTabId(requester);
  if (requesterTab === tab) { reply(id, false, "err own tab"); return; }
  const target = driveSnapshot().tabs.find((t) => t.id === tab);
  if (target && target.body !== "rendered") { reply(id, false, "err raw tab"); return; }
  // A closed requester ends the wait (`err requester gone`) so its slot in
  // mod.rs's pending map frees now, not at timeout + sweep slack.
  const abort = new AbortController();
  waitAborts.set(id, abort);
  void watchTab(tab, timeoutMs, driveSnapshot, { requesterTab, signal: abort.signal }).then((v) => {
    waitAborts.delete(id);
    if (v === "cancelled") return;
    if (v === "done") reply(id, true, `done ${tab} report=${report ?? "-"}`);
    else if (v === "gone") reply(id, false, "err requester gone");
    else reply(id, false, `err ${v}`);
  });
});

ipcListen<{ id: string; target: string; requester: Requester }>("ctl-focus", (e) => {
  const { id, target, requester } = e.payload;
  const problem = requesterProblem(requester);
  if (problem) { reply(id, false, `err ${problem}`); return; }
  if (!focusTarget(target)) { reply(id, false, `err no tab "${target}"`); return; }
  reply(id, true, `focused ${target}`);
});

function requesterLabel(r: Requester): string {
  const tab = requesterTabId(r);
  return (tab && sessionTitle(tab)) ?? tab ?? r.session ?? "unknown";
}

function cardResult(id: string, cardId: string, ok: boolean, line: string, verdict?: string): void {
  const payload = { id, ok, line, cardId, verdict };
  void invoke("control_result", payload);
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// `--notify` subscriptions (lanes.ts); turn ends arrive as `vidar-reply-done`,
// which replay never fires (reply-events.ts).
const lanes = createLanes({
  send: sendPromptTo,
  ready: tabPromptReady,
  busy: tabBusy,
  dead: tabDead,
  toast: laneToast,
  now: Date.now,
  after: (ms, fn) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); },
});
document.addEventListener("vidar-reply-done", (e) => {
  lanes.turnDone((e as CustomEvent<ReplyDoneDetail>).detail.id);
});

/** An Approve with less than this left on the card does not act: the spawn, the readiness
 *  wait (up to 30 s) and the send could outlive the card (280 s TTL) and the client
 *  (300 s), so the caller would read a timeout for something that happened. */
const LATE_APPROVE_MS = 40_000;
/** The tab strip shows 60 chars of a title at most (vidar.mjs clamps the same). */
const MAX_TITLE = 60;

/** The Notify/Report/Deliver To rows and, when on, the capacity slot — taken
 *  before the card, so `err busy` precedes any action. A string is the refusal. */
function laneSlot(
  details: Record<string, unknown>,
  deliverTo: string | null,
  target: string | null,
): { lease: LaneLease | null; rows: [string, string][] } | string {
  const notify = details.notify === true;
  const report = laneReport(details.report);
  if (report === undefined) return "bad report";
  const rows = laneRows(notify, report, deliverTo);
  if (!notify) return { lease: null, rows };
  // The line goes in by the host transport, so both ends must be Falcon-hosted tabs.
  if (!deliverTo || !hostedTab(deliverTo)) return "notify needs a hosted requester";
  if (target !== null && target === deliverTo) return "own tab";
  if (target !== null && !hostedTab(target)) return "not a hosted tab";
  const lease = lanes.reserve(deliverTo, report);
  return lease ? { lease, rows } : "busy";
}

// Each card carries its own deadline, `expiresAtMs` (card.rs::card_payload: minted
// instant + CARD_TTL). The frontend's expiry timers below run to it, since the Rust sweep
// only runs inside card::request — a card with no later Act verb behind it would otherwise
// sit rendered forever.

// A card that expired server-side (`card.rs::expire_pending` sweep) before
// the user acted on it (Approve on a stale modal
// would still run `promptTab`/`spawnTab`). Fed by `ctl-card-cancel`;
// consulted right before each Approve branch acts. Only cards with an ask in
// flight (`live`) are recorded, and settleCard removes both entries when that
// ask resolves (answered, self-answered or expired), so neither set can grow
// from cards nobody answers.
const live = new Set<string>();
const cancelled = new Set<string>();
ipcListen<{ cardId: string }>("ctl-card-cancel", (e) => {
  const { cardId } = e.payload;
  if (live.has(cardId)) cancelled.add(cardId);
});
/** The card's ask resolved: forget it; true if it was cancelled server-side meanwhile. */
function settleCard(cardId: string): boolean {
  live.delete(cardId);
  return cancelled.delete(cardId);
}

// Shared by `prompt`/`spawn`/`ask`: one event, one modal shape
// (`askGate`, the same component the Astra ask card uses), branching on
// `verb` only for what Approve does with the details.
ipcListen<{ id: string; cardId: string; verb: string; requester: Requester; details: Record<string, unknown>; claimedAtMs: number; expiresAtMs: number }>(
  "ctl-card",
  async (e) => {
    const { id, cardId, verb, requester, details, claimedAtMs, expiresAtMs } = e.payload;
    const problem = requesterProblem(requester);
    if (problem) { cardResult(id, cardId, false, `err ${problem}`); return; }
    if (verb === "flow") {
      handleFlowCard(e.payload, { cardResult, label: requesterLabel, problem: requesterProblem, live, settle: settleCard });
      return;
    }
    if (verb === "prompt") {
      const tabRef = String(details.tab ?? "");
      const tab = resolveTab(tabRef) ?? tabRef; // an id or a name; unknown stays as given
      const text = String(details.text ?? "");
      // kind + claimedAtMs: without them an unanswered card sits in the shared
      // ask queue forever and blocks every later ask.
      // claimedAtMs now comes from Rust (the instant the card was minted),
      // same source `card.rs::request` stamps for every verb.
      // A closed or raw tab can never accept: refuse before the card, so no approval is wasted.
      const refused = promptTargetRefusal(driveSnapshot().tabs, tab);
      if (refused) { cardResult(id, cardId, false, refused); return; }
      const slot = laneSlot(details, laneDeliverTo(details.deliver_to, () => requesterTabId(requester)), tab);
      if (typeof slot === "string") { cardResult(id, cardId, false, `err ${slot}`); return; }
      const { lease } = slot; // frozen with the approved values; released on every non-arming exit
      let promptTimer: ReturnType<typeof setTimeout>;
      live.add(cardId);
      void askGate({
        permission: true,
        // Full text, never cut; the lane rows only when a subscription was asked for.
        details: [["Asked By",requesterLabel(requester)], ["Tab", `${sessionTitle(tab) ?? tab} · ${tab}`], ["Text", text], ...(lease ? slot.rows : [])],
        question: "",
        id: cardId, // drive's state.cards / `card <id>` name it by this
        tab,
        claimedAtMs,
        expiresAtMs,
      }, "ctl-prompt").then(({ approved, shown, comment, reason }) => {
        clearTimeout(promptTimer);
        const wasCancelled = settleCard(cardId);
        if (!shown || reason === "expired" || wasCancelled || !approved) lanes.release(lease);
        if (!shown) { cardResult(id, cardId, false, `err ${reason ?? "self-answered"}`); return; }
        // The expiry timer below already sent the "err expired" reply.
        if (reason === "expired") return;
        if (wasCancelled) return;
        if (!approved) { cardResult(id, cardId, false, `denied ${comment}`); return; }
        if (expiresAtMs - Date.now() < LATE_APPROVE_MS) { lanes.release(lease); cardResult(id, cardId, false, "err expired"); return; }
        // --notify: one composer-less send that arms the subscription; else the composer path as before.
        // Checked first: a not-ready write leaves the text unsent in the composer, and a caller
        // retrying on that err would type it twice.
        const late = lease ? promptTargetRefusal(driveSnapshot().tabs, tab) : promptDeliveryRefusal(driveSnapshot().tabs, tab, tabPromptReady);
        if (late) { lanes.release(lease); cardResult(id, cardId, false, late); return; }
        const sent: Promise<boolean | void> = lease ? lanes.promptOnce(tab, text, lease) : promptTab(tab, text);
        void sent.then(
          (ok) => ok === false
            // Only the composer path returns false (host refused after hand-off); notify sends reject with their error text.
            ? cardResult(id, cardId, false, "err not delivered")
            : cardResult(id, cardId, true, `delivered ${tab}${lease ? " notify" : ""}`),
          (err) => cardResult(id, cardId, false, `err ${errText(err)}`),
        );
      }).catch(() => { settleCard(cardId); lanes.release(lease); });
      promptTimer = setTimeout(() => {
        if (cancelAsk("ctl-prompt", "expired")) cardResult(id, cardId, false, "err expired");
      }, Math.max(0, expiresAtMs - Date.now()));
      return;
    }
    if (verb === "spawn") {
      const agent = String(details.agent ?? "");
      const model = typeof details.model === "string" ? details.model.trim() : "";
      const cwd = typeof details.cwd === "string" && details.cwd ? details.cwd : undefined;
      // Rust already refused a level outside the contract; this narrows the type and drops anything else.
      const effort = EFFORT_LEVELS.find((level) => level === details.effort);
      // The card always names the model; a request without one never reaches the user.
      if (!model) { cardResult(id, cardId, false, "err model is required"); return; }
      // Refuse before showing the modal: `spawnTab` would
      // have refused this anyway, but only after the user already approved it.
      if (!hasRenderedAgent(agent)) { cardResult(id, cardId, false, `err no rendered variant for agent "${agent}"`); return; }
      // The prompt is required: a request without text never reaches the user.
      const text = typeof details.text === "string" ? details.text : "";
      if (!text) { cardResult(id, cardId, false, "err text is required"); return; }
      const title = typeof details.title === "string" && details.title ? details.title.slice(0, MAX_TITLE) : undefined;
      // Only a Falcon-hosted body takes a composer-less prompt (rendered.ts `sendPrompt`); refuse before the card.
      if (!hostedRenderedAgent(agent)) { cardResult(id, cardId, false, "err not a hosted agent"); return; }
      // target null: the child does not exist yet; it is a hosted tab only if the agent is (checked at send).
      const slot = laneSlot(details, laneDeliverTo(details.deliver_to, () => requesterTabId(requester)), null);
      if (typeof slot === "string") { cardResult(id, cardId, false, `err ${slot}`); return; }
      const { lease } = slot;
      // Title, Brief and the lane rows sit above the Text block, which runs whole (scrolls in the card).
      const promptRows: [string, string][] = [...briefRows(details.brief, text), ...slot.rows, ["Text", cardText(text)]];
      // Cwd and Title show only when set; Agent stays because the spawned agent can differ from the asker.
      const optionalRows: [string, string][] = [
        ...(cwd ? [["Cwd", cwd] as [string, string]] : []),
        ...(title ? [["Title", title] as [string, string]] : []),
      ];
      // Same kind + claimedAtMs requirement as "prompt" above.
      let spawnTimer: ReturnType<typeof setTimeout>;
      live.add(cardId);
      void askGate({
        permission: true,
        details: [
          // agent, model and effort read as one value (2026-10-10: lean card, no row per field)
          ["Asked By", requesterLabel(requester)], ["Agent", [titleCase(agent), model, effort && titleCase(effort)].filter(Boolean).join(" · ")],
          ...optionalRows, ...promptRows,
        ],
        question: "",
        variant: "ask-spawn",
        id: cardId,
        claimedAtMs,
        expiresAtMs,
      }, "ctl-spawn").then(({ approved, shown, comment, reason }) => {
        clearTimeout(spawnTimer);
        const wasCancelled = settleCard(cardId);
        if (!shown || reason === "expired" || wasCancelled || !approved) lanes.release(lease);
        if (!shown) { cardResult(id, cardId, false, `err ${reason ?? "self-answered"}`); return; }
        if (reason === "expired") return;
        if (wasCancelled) return;
        if (!approved) { cardResult(id, cardId, false, `denied ${comment}`); return; }
        if (expiresAtMs - Date.now() < LATE_APPROVE_MS) { lanes.release(lease); cardResult(id, cardId, false, "err expired"); return; }
        void spawnTab({ agent, model, effort, cwd, title }).then(
          (tabId) => {
            // One send once the new tab's transport takes it; never retried after it resolved.
            void lanes.promptOnce(tabId, text, lease).then(
              () => cardResult(id, cardId, true, `spawned ${tabId} prompted${lease ? " notify" : ""}`),
              (err) => cardResult(id, cardId, false, `err prompt ${errText(err)} (spawned ${tabId})`),
            );
          },
          (err) => { lanes.release(lease); cardResult(id, cardId, false, `err ${errText(err)}`); },
        );
      }).catch(() => { settleCard(cardId); lanes.release(lease); });
      spawnTimer = setTimeout(() => {
        if (cancelAsk("ctl-spawn", "expired")) cardResult(id, cardId, false, "err expired");
      }, Math.max(0, expiresAtMs - Date.now()));
      return;
    }
    if (verb === "ask") {
      // Arrives through the same ctl-card path as prompt/spawn:
      // its own card id (not the control id), its details
      // still carry question/choices/placeholder.
      const question = String(details.question ?? "");
      const choices = Array.isArray(details.choices) ? details.choices.map(String) : undefined;
      const choiceDetails = Array.isArray(details.details) ? details.details.map(String) : undefined;
      const placeholder = typeof details.placeholder === "string" ? details.placeholder : undefined;
      // Fixed kind, not per-question: one `ctl.ask` in flight at a time is the bound, not one
      // per distinct question, or a wedged ask would silently swallow the
      // dedup on the next one instead of queuing behind it.
      let askTimer: ReturnType<typeof setTimeout>;
      live.add(cardId);
      void askGate({
        title: "Question", // the Asked By row names the tab (2026-10-10: "A tab has a question" read poorly)
        details: [["Asked By",requesterLabel(requester)]],
        question,
        choices,
        choiceDetails,
        placeholder,
        id: cardId,
        tab: requesterTabId(requester) ?? undefined,
        claimedAtMs,
        expiresAtMs,
      }, "ctl-ask").then(({ approved, shown, comment, reason, choice }) => {
        clearTimeout(askTimer);
        const wasCancelled = settleCard(cardId);
        if (!shown) { cardResult(id, cardId, false, `err ${reason ?? "self-answered"}`); return; }
        if (reason === "expired") return;
        if (wasCancelled) return;
        if (!approved) { cardResult(id, cardId, false, `denied ${comment}`); return; }
        cardResult(id, cardId, true, `answered choice=${choice ?? "-"} comment="${comment}"`);
      }).catch(() => { settleCard(cardId); });
      askTimer = setTimeout(() => {
        if (cancelAsk("ctl-ask", "expired")) cardResult(id, cardId, false, "err expired");
      }, Math.max(0, expiresAtMs - Date.now()));
      return;
    }
    cardResult(id, cardId, false, `err verb "${verb}" has no card yet`);
  },
);
