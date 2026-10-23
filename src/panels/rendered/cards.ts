// Approval and question cards of a Rendered body: building a card, mounting it in its
// tool pill, settling it (locally or from the host), and cancelling every pending one.

import { alreadyAnsweredId, hostSettleDecision, type HostPermissionState, type SentDecision } from "../rendered-settle";
import { DRIVE_CLASS } from "../rendered-drive";
import type { AgentTransport, RenderedAgent } from "./transport";
import { toolClass } from "./tool-class";
import { toolSummary } from "./format";
import { btn, el } from "./dom";
import { cardShell } from "./card-shell";
import { clearMark, labelledMark, setMark } from "./marks";
import { approvalDetail, approvalToolLabel } from "./approval-detail";
import { svgEl } from "./icons";
import { iconImg } from "../../icon-img";
import { questionForm } from "./question-form";
import { asyncAnswerText, asyncAskFormInput, type AsyncQuestion } from "../../agents/codex-async-ask";
import { mcpElicitationForm } from "./mcp-elicitation-form";
import { recordFromAskInput, updatedInputFromReply, type AskReply, type QuestionRecord } from "../../asks/record";
import type { Group, RenderedState, ToolRecord } from "./state";
import type { Follow } from "./follow";
import type { HydrateStats } from "./hydrate-stats";

/** What the cards close over in createRenderedBody. */
export interface CardsDeps {
  transport: AgentTransport;
  textarea: HTMLTextAreaElement;
  follow: Follow;
  tools: Map<string, ToolRecord>;
  approvals: Map<string, HTMLElement>;
  approvalQueue: string[];
  awaiting: Map<string, HTMLElement>;
  sendEncoded: (line: string | null) => Promise<boolean>;
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  sealGroup: () => void;
  groupRefresh: (g: Group) => void;
  stalePill: (t: { details: HTMLDetailsElement; group: Group | null }) => void;
  refreshState: () => void;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  agent: RenderedAgent;
  stats?: HydrateStats;
  /** sends text as an ordinary user message (composer.ts sendText); false when it was not taken */
  sendText?: (text: string) => boolean | Promise<boolean>;
}

/** Settle reasons with their own folded-card labels. */
const TURN_ENDED = "turn ended";
export const AGENT_EXITED = "agent exited";

/** A hosted deny can block up to its 40 s request timeout: Stop, Steer, Close and /clear wait
 *  this long at most before the interrupt goes out anyway (the sidecar backstops an open card). */
export const DENY_WAIT_MS = 2000;

/** `deny()` (denyPending), capped at DENY_WAIT_MS. */
export async function denyWithin(deny: () => Promise<void>, ms = DENY_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([deny(), new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** the folded check's tooltip for a question answered from Relay */
const RELAY_ANSWERED = "Answered in Relay";
/** the picked labels of an answer, joined, for the settled event (empty for a deny) */
function pickedText(d: { behavior: string; updatedInput?: unknown }): string {
  const a = d.behavior === "allow" && d.updatedInput && typeof d.updatedInput === "object" ? (d.updatedInput as { answers?: unknown }).answers : null;
  if (!a || typeof a !== "object") return "";
  return Object.values(a as Record<string, unknown>).filter((v): v is string => typeof v === "string" && v !== "").join(", ");
}

/** A pending question card as a record plus the ways to settle it (openQuestions). Both reject with
 *  "Already Answered", "Not Delivered" or a refusal text; `dismiss` is null where no deny exists. */
export interface QuestionHandle {
  key: string;
  record: QuestionRecord;
  answer(reply: AskReply): Promise<void>;
  dismiss: (() => Promise<void>) | null;
}

export function createCards(S: RenderedState, deps: CardsDeps) {
  const { transport, textarea, follow, tools, approvals, approvalQueue, awaiting, sendEncoded, append, sealGroup, groupRefresh, stalePill, refreshState, noticeBlock, agent, stats } = deps;
  /** tool ids whose card attached while hydrating (opening is deferred to hydration end) */
  const hydratedCards = new Set<string>();
  /** open question cards by request id / async item id, for openQuestions */
  const questionCards = new Map<string, { card: HTMLElement; handle: QuestionHandle }>();
  /** mount a card inside its pill: the pill opens, waits, and the card's fate becomes the pill's */
  function attachCard(toolUseId: string, card: HTMLElement) {
    const t = tools.get(toolUseId);
    if (!t) return;
    t.card = card;
    card.classList.add("in-pill");
    t.details.querySelector("summary")?.after(card);
    setMark(t.details, "awaiting");
    // the card is the record of what was approved; the pill's own raw-JSON input
    // preview would otherwise show the same payload a second time underneath it
    // (has-card stays set once the card settles — never un-hide it).
    t.details.classList.add("has-card");
    // a restoring view builds closed and quiet: openHydratedCards opens the still-pending ones at the end
    if (S.hydrating) { hydratedCards.add(toolUseId); return; }
    openForCard(t);
    follow.toBottom();
  }
  /** opened only so the card can be answered: settle folds it shut again, so the tool's
   *  output stays one click away instead of spilling under the answer (2026-10-05) */
  function openForCard(t: ToolRecord) {
    if (!t.details.open) t.details.dataset.cardOpened = "1";
    t.details.open = true;
    if (t.group) { if (!t.group.userToggled) { t.group.details.open = true; stats?.groupOpened(); } groupRefresh(t.group); }
  }
  /** hydration end: open the pill and group of every card attached meanwhile that still awaits an answer */
  function openHydratedCards() {
    for (const id of hydratedCards) {
      const t = tools.get(id);
      const card = t?.card;
      if (!t || !card || approvals.get(card.dataset.requestId ?? "") !== card) continue; // settled, or replaced
      openForCard(t);
    }
    hydratedCards.clear();
  }

  function approvalCard(requestId: string, toolUseId: string | undefined, tool: string, input: unknown, inputBytes: number, _suggestions: unknown[]) {
    const isQuestion = toolClass(tool, agent) === "ask";
    const isMcp = tool === "MCP Elicitation";
    const mcpInput = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const mcpFormMode = ["form", "openai/form", "openaiForm"].includes(String(mcpInput.mode));
    const mcpUnsupported = isMcp && (typeof mcpInput.unsupportedReason === "string" || (!mcpFormMode && mcpInput.mode !== "url"));
    // Lead with the decision, not the payload: "Approval needed" + what it is in
    // plain words; the exact command/diff under it; the buttons right there.
    // the question card names itself in its title; repeating the tool read as a stutter
    const shell = cardShell({
      root: "div",
      classes: `blk ${DRIVE_CLASS.card}${isQuestion ? " blk-question" : ""}`,
      parts: ["head", "title", "body", "actions"],
      title: isQuestion ? "Question" : isMcp ? "MCP Permission" : "Permission",
      partClasses: { head: "approval-head", title: "approval-title", body: "approval-body", actions: "approval-actions" },
    });
    const card = shell.root;
    // drive() (below) reads these two dataset stamps straight off the live DOM;
    // `approvals` (below) tracks pending requests only and is never consulted here.
    card.dataset.tool = tool;
    card.dataset.requestId = requestId;
    if (isQuestion) card.dataset.askKey = requestId; // Relay's focus event and the settled event find the card by it
    card.dataset.summary = toolSummary(tool, input); // Relay repeats it on the card's approval item (approval-relay.ts)
    const head = shell.head!;
    if (isQuestion) head.prepend(labelledMark("awaiting", "Question"));
    else { const sh = iconImg("shield"); sh.title = "Permission"; head.prepend(sh); }
    if (!isQuestion) head.appendChild(el("span", "tool-name", approvalToolLabel(tool, input)));
    // plain line first (toolSummary reads a Bash/PowerShell description before the command), raw detail below
    if (!isQuestion && !isMcp) {
      const summary = el("div", "approval-summary", toolSummary(tool, input));
      // no description: the summary is the command's own first line, which .approval-cmd shows below
      const cmd = (input && typeof input === "object" ? (input as Record<string, unknown>).command : null);
      const first = typeof cmd === "string" ? cmd.split("\n")[0].trim() : null;
      const text = (summary.textContent ?? "").trim();
      if (first !== null && text !== "" && (text === first || (text.endsWith("…") && first.startsWith(text.slice(0, -1))))) summary.hidden = true;
      head.after(summary);
    }
    const row = shell.actions!;
    const msg = el("input", DRIVE_CLASS.message);
    msg.setAttribute("aria-label", "Reason");
    msg.setAttribute("placeholder", "Notes");
    let form: { collect: () => unknown; answered: () => boolean } | null = null;
    const body = shell.body!;
    if (isQuestion) form = questionForm(body, input, (ok) => { allow.disabled = !ok; });
    else {
      body.append(...approvalDetail(tool, input, inputBytes));
      if (isMcp && mcpFormMode) form = mcpElicitationForm(body, input, (ok) => { allow.disabled = mcpUnsupported || !ok; });
      // a Write/Edit card shows the file path in .approval-path: don't say it twice
      const sum = card.querySelector<HTMLElement>(".approval-summary");
      const st = (sum?.textContent ?? "").trim();
      if (sum && st !== "" && Array.from(body.querySelectorAll(".approval-path")).some((p) => { const pt = (p.textContent ?? "").trim(); return pt === st || pt.startsWith(`${st} — `); })) sum.hidden = true; // Write appends " — N chars" to the path
    }
    // silent = the agent resolved it itself: mark the card, send nothing back
    let responding = false;
    // the decision this card sent to the host, if any — the host's own
    // `permission-state: settled` can land during (or instead of) that send,
    // and needs to know what was sent to label the card correctly
    let sent: SentDecision | null = null;
    const settle = async (
      decision: SentDecision,
      silent = false,
      host?: { label: string; cls: "allow" | "deny" | "settled" },
      cancelled = false
    ) => {
      if (!approvals.has(requestId)) return;
      if (!silent && S.hydrating) return;
      // a refused answer (Codex: a misfit form) is never sent: the card stays open with the reason
      const refused = silent ? null : S.adapter.permissionRefusal?.(requestId, decision) ?? null;
      if (refused) { noticeBlock(refused, "warn"); return; }
      let delivered = false;
      if (transport.durable && !silent) {
        if (responding) return;
        responding = true;
        sent = decision;
        const ok = await sendEncoded(S.adapter.encodePermission(requestId, decision));
        responding = false;
        if (!ok) { sent = null; return; } // A failed delivery leaves the request actionable.
        // Fold on delivery (2026-10-06): the host's terminal record only lands once the
        // tool has run, which kept the card live through the whole run. The record still
        // arrives; hostSettle below relabels the folded card if it contradicts what was sent.
        if (!approvals.has(requestId)) return; // the host settled it during the send
        delivered = true;
      }
      approvals.delete(requestId);
      const i = approvalQueue.indexOf(requestId);
      if (i >= 0) approvalQueue.splice(i, 1);
      if (S.pendingApproval === requestId) S.pendingApproval = approvalQueue[0] ?? null;
      const cls = host ? host.cls : decision.behavior;
      card.classList.add(DRIVE_CLASS.settled, cls);
      row.remove();
      const why = decision.behavior === "deny" && decision.message ? `: ${decision.message}` : "";
      const label = host
        ? host.label
        : cancelled && decision.behavior === "deny" && decision.message === AGENT_EXITED ? "Session Ended"
        : silent
          ? decision.behavior === "deny" && decision.message === TURN_ENDED ? "Interrupted" : `Resolved by the agent${why}`
          : decision.behavior === "allow" ? (isQuestion ? "Answered" : "Allowed") : `Denied${why}`;
      // The card folds to its head row: summary inline and dim, a denial's reason before the
      // outcome glyph at the right end. The glyph keeps DRIVE_CLASS.result and its <title> holds
      // the label, so `.approval-result` textContent still reads "Allowed" / "Denied: …" for drive().
      const userDenied = label.startsWith("Denied");
      const outcome = cls === "allow" ? "ok" : userDenied ? "no" : "dim";
      const reason = userDenied && label.startsWith("Denied: ") ? label.slice("Denied: ".length) : "";
      const sumEl = card.querySelector<HTMLElement>(".approval-summary");
      const inlineText = outcome === "dim" ? label : reason ? "" : (sumEl?.textContent ?? "");
      sumEl?.remove();
      head.appendChild(el("span", "approval-inline", inlineText));
      if (reason) { const w = el("span", "approval-why", reason); w.title = label; head.appendChild(w); }
      const glyph = el("span", `${DRIVE_CLASS.result} ${outcome}`);
      // an answer from Relay (the flag is set by the handle and approval-relay before the settle) says so in the tooltip
      const tip = isQuestion && outcome === "ok" && card.dataset.relayAnswer === "1" ? RELAY_ANSWERED : label;
      glyph.title = tip;
      glyph.setAttribute("aria-label", tip);
      glyph.appendChild(svgEl(outcome === "ok" ? "check" : outcome === "no" ? "x" : "minus", label));
      head.appendChild(glyph);
      if (isQuestion) card.dataset.askAnswer = pickedText(decision);
      // inside a pill the card folds to its head row; the pill carries the state on
      const t = toolUseId ? tools.get(toolUseId) : undefined;
      if (t && t.card === card) {
        body.remove();
        // a question has no run phase after Answer — it settles straight to its
        // own icon, same as denied does, instead of borrowing "running" (which
        // toolDone immediately overwrites with the styleless "done" class);
        // a neutral "settled" (host settled, no known decision) is neither
        if (cls === "allow") setMark(t.details, isQuestion ? "answered" : "running");
        else if (cls !== "settled") setMark(t.details, "denied");
        else clearMark(t.details, "awaiting");
        if (t.details.dataset.cardOpened) { delete t.details.dataset.cardOpened; t.details.open = false; }
        if (t.group) groupRefresh(t.group);
      } else if (!isQuestion) body.remove(); // no pill (a Codex MCP elicitation names no itemId): fold to the head row alone
      if (!silent && !delivered && !S.hydrating) void sendEncoded(S.adapter.encodePermission(requestId, decision));
      refreshState();
      // an answer from Relay (approval-relay.ts sets the flag before its click) leaves focus where the user is
      const fromRelay = card.dataset.relayAnswer === "1";
      delete card.dataset.relayAnswer;
      if (!S.hydrating && !fromRelay) textarea.focus();
    };
    const allow = btn(isQuestion ? "Answer" : "Allow", DRIVE_CLASS.allow, () => {
      if (form) { settle({ behavior: "allow", updatedInput: form.collect() }); return; }
      settle({ behavior: "allow" });
    });
    // nothing picked yet is not an answer: sending one reaches the model as
    // "The user did not answer", which reads as a deliberate refusal.
    // Computed, not hardcoded true — a card with no questions has nothing to gate on.
    if (form) allow.disabled = !form.answered();
    if (mcpUnsupported) allow.disabled = true;
    const deny = btn("Deny", DRIVE_CLASS.deny, () => settle({ behavior: "deny", message: msg.value.trim() || undefined }));
    // permission: reason field, then Allow, then Deny; the question card has no field, so Answer, Deny
    if (!isQuestion) row.appendChild(msg);
    row.append(allow, deny);
    // payload first, decision under it (the shell already ordered head, body, actions)
    approvals.set(requestId, card);
    approvalQueue.push(requestId);
    if (!S.pendingApproval) S.pendingApproval = requestId;
    (card as HTMLElement & { settle?: typeof settle; hostSettle?: (state: HostPermissionState) => void }).settle = settle;
    if (isQuestion) {
      const record = recordFromAskInput(input, { key: requestId, origin: agent === "codex" ? "codex" : "claude", askedAtMs: Date.now() });
      const rawQuestions = (input && typeof input === "object" ? (input as { questions?: unknown }).questions : undefined) ?? [];
      // the same checks and settle the Answer button runs; the card must have left `approvals` afterwards
      const run = async (decision: SentDecision) => {
        if (!approvals.has(requestId) || responding) throw new Error("Already Answered");
        const refused = S.adapter.permissionRefusal?.(requestId, decision) ?? null;
        if (refused) throw new Error(refused);
        card.dataset.relayAnswer = "1"; // settle reads and clears it: no composer focus for a Relay answer
        try { await settle(decision); } finally { delete card.dataset.relayAnswer; }
        if (approvals.has(requestId)) throw new Error("Not Delivered");
      };
      questionCards.set(requestId, { card, handle: {
        key: requestId,
        record,
        answer: (reply) => run({ behavior: "allow", updatedInput: updatedInputFromReply(rawQuestions, record, reply) }),
        dismiss: () => run({ behavior: "deny" }),
      } });
    }
    (card as HTMLElement & { hostSettle?: (state: HostPermissionState) => void }).hostSettle = (state) => {
      const r = hostSettleDecision(state, sent, isQuestion);
      if (!r) return;
      if (approvals.has(requestId)) { void settle(r.decision as SentDecision, true, { label: r.label, cls: r.cls }); return; }
      // folded on delivery: a record that agrees changes nothing; one that contradicts the sent
      // decision (the agent cancelled an Allow) relabels the card and the pill
      if (sent && r.cls !== sent.behavior) relabelFolded(r.label);
    };
    function relabelFolded(label: string) {
      card.classList.remove("allow");
      card.classList.add("deny");
      head.querySelector(".approval-why")?.remove();
      const inline = head.querySelector<HTMLElement>(".approval-inline");
      if (inline) inline.textContent = label;
      const glyph = head.querySelector<HTMLElement>(`.${DRIVE_CLASS.result}`);
      if (glyph) {
        glyph.className = `${DRIVE_CLASS.result} dim`;
        glyph.title = label;
        glyph.setAttribute("aria-label", label);
        glyph.replaceChildren(svgEl("minus", label));
      }
      const t = toolUseId ? tools.get(toolUseId) : undefined;
      if (t && t.card === card) { setMark(t.details, "denied"); if (t.group) groupRefresh(t.group); }
    }
    // Reconcile with the pill by tool id, either order (the pill usually comes
    // first — the assistant message precedes canUseTool). No id: standalone card.
    if (toolUseId && tools.has(toolUseId)) {
      attachCard(toolUseId, card);
    } else if (toolUseId) {
      awaiting.set(toolUseId, card);
      append(card);
    } else {
      sealGroup();
      append(card);
    }
    refreshState();
  }
  /** open Codex async asks by item id: outside `approvals`, so they never hold the composer, Esc or the state chip */
  const asyncAsks = new Map<string, () => void>();
  /** A Codex async ask (codex-async-ask.ts) as the Question card. Answer sends the picks as the
   *  next user message; any later user message (typed, or one from replayed history) answers it too. */
  function asyncAskCard(id: string, questions: AsyncQuestion[]) {
    if (asyncAsks.has(id)) return;
    const shell = cardShell({
      root: "div",
      classes: `blk ${DRIVE_CLASS.card} blk-question`,
      parts: ["head", "title", "body", "actions"],
      title: "Question",
      partClasses: { head: "approval-head", title: "approval-title", body: "approval-body", actions: "approval-actions" },
    });
    const card = shell.root, head = shell.head!, body = shell.body!, row = shell.actions!;
    card.dataset.tool = "AskUserQuestion";
    card.dataset.requestId = id;
    card.dataset.askKey = id;
    head.prepend(labelledMark("awaiting", "Question"));
    const form = questionForm(body, asyncAskFormInput(questions), (ok) => { answer.disabled = !ok; });
    const msg = el("input", DRIVE_CLASS.message);
    msg.setAttribute("aria-label", "Notes");
    msg.setAttribute("placeholder", "Notes");
    const fold = () => {
      if (!asyncAsks.has(id)) return;
      asyncAsks.delete(id);
      questionCards.delete(id);
      card.classList.add(DRIVE_CLASS.settled, "allow");
      row.remove();
      body.remove();
      head.appendChild(el("span", "approval-inline", ""));
      const glyph = el("span", `${DRIVE_CLASS.result} ok`);
      const tip = card.dataset.relayAnswer === "1" ? RELAY_ANSWERED : "Answered";
      glyph.title = tip;
      glyph.setAttribute("aria-label", tip);
      glyph.appendChild(svgEl("check", "Answered"));
      head.appendChild(glyph);
      refreshState();
    };
    let sending = false;
    /** the guarded send both the button and the handle run; true once folded */
    const deliver = async (answers: Record<string, string>, notes: string): Promise<boolean> => {
      if (sending || !asyncAsks.has(id) || !deps.sendText) return false;
      card.dataset.askAnswer = pickedText({ behavior: "allow", updatedInput: { answers } });
      const taken = deps.sendText(asyncAnswerText(questions, answers, notes));
      if (taken === true) { fold(); return true; }
      if (taken === false) return false;
      sending = true;
      const ok = await taken;
      sending = false;
      if (ok) fold();
      return ok;
    };
    const answer = btn("Answer", DRIVE_CLASS.allow, () => {
      if (!form.answered()) return;
      const { answers } = form.collect() as { answers: Record<string, string> };
      void deliver(answers, msg.value);
    });
    answer.disabled = !form.answered();
    row.append(msg, answer);
    asyncAsks.set(id, fold);
    const record = recordFromAskInput(asyncAskFormInput(questions), { key: id, origin: "codex-async", askedAtMs: Date.now() });
    questionCards.set(id, { card, handle: {
      key: id,
      record,
      answer: async (reply) => {
        if (sending || !asyncAsks.has(id)) throw new Error("Already Answered");
        card.dataset.relayAnswer = "1"; // fold reads it for the check's tooltip
        try {
          if (!(await deliver(reply.answers, reply.notes))) throw new Error("Not Delivered");
        } finally { delete card.dataset.relayAnswer; }
      },
      dismiss: null,
    } });
    sealGroup();
    append(card);
    refreshState();
  }
  /** a later user message reached the thread: every open async ask before it is answered */
  function settleAsyncAsks() {
    for (const fold of [...asyncAsks.values()]) fold();
  }
  /** the transcript was wiped: its async asks went with it, answered or not */
  function clearAsyncAsks() {
    for (const id of asyncAsks.keys()) questionCards.delete(id);
    asyncAsks.clear();
  }
  /** every question card still pending and in the document, oldest first */
  function openQuestions(): QuestionHandle[] {
    const out: QuestionHandle[] = [];
    for (const [key, { card, handle }] of questionCards) {
      if (approvals.get(key) !== card && !asyncAsks.has(key)) { questionCards.delete(key); continue; } // settled, or replaced
      if (card.isConnected) out.push(handle);
    }
    return out;
  }

  function cancelApprovals(reason: string) {
    for (const id of [...approvals.keys()]) {
      const card = approvals.get(id) as (HTMLElement & { settle?: (d: { behavior: "deny"; message?: string }, silent?: boolean, host?: undefined, cancelled?: boolean) => void }) | undefined;
      card?.settle?.({ behavior: "deny", message: reason }, S.hydrating || !!transport.durable, undefined, true);
    }
    approvals.clear();
    approvalQueue.length = 0;
    S.pendingApproval = null;
    awaiting.clear();
    // a pill still waiting on a card that just died will never run
    for (const t of tools.values()) if (t.details.classList.contains("awaiting")) stalePill(t);
    refreshState();
  }
  /** Deny every open card the way Esc does, oldest first, before a stop or interrupt: an
   *  interrupt that lands while the agent waits on a permission makes the SDK throw, and the
   *  session died with it (docs/explore/2026-10-16-jettison-cards.md). Resolves once each deny
   *  is sent (a hosted send is awaited); a failed send leaves its card open, unretried. */
  async function denyPending(): Promise<void> {
    for (const id of [...approvals.keys()]) {
      const card = approvals.get(id) as (HTMLElement & { settle?: (d: { behavior: "deny" }) => Promise<void> }) | undefined;
      await card?.settle?.({ behavior: "deny" });
    }
  }
  /** permission ids the sidecar already refused as answered: its one refusal can
   *  arrive up to three times (event, command-settled, rejected send) */
  const answeredElsewhere = new Set<string>();
  /** true when `text` is the sidecar's `no pending permission <id>` refusal. The
   *  request is settled on the host, so a pending card closes neutrally as
   *  "Already Answered" and nothing is drawn as an error; with no card left,
   *  one neutral line per id. */
  function alreadyAnswered(text: string): boolean {
    const id = alreadyAnsweredId(text);
    if (!id) return false;
    if (answeredElsewhere.has(id)) return true;
    answeredElsewhere.add(id);
    const card = approvals.get(id) as (HTMLElement & { settle?: (d: SentDecision, silent?: boolean, host?: { label: string; cls: "allow" | "deny" | "settled" }) => void }) | undefined;
    if (card?.settle) card.settle({ behavior: "allow" }, true, { label: "Already Answered", cls: "settled" });
    else noticeBlock("Already Answered", "info");
    return true;
  }

  return { attachCard, openHydratedCards, approvalCard, asyncAskCard, settleAsyncAsks, clearAsyncAsks, openQuestions, cancelApprovals, denyPending, alreadyAnswered, TURN_ENDED, AGENT_EXITED };
}
