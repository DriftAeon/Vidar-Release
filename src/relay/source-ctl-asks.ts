// `ctl.ask` as Relay question items (origin "ctl-ask"): the blocking ask no longer opens the askGate modal.
// listen.ts hands over the Rust card (id, deadline); the caller's reply line is written once, by `finish()`,
// whichever of answer, dismiss, expiry or cancel gets there first.

import { listen } from "../ipc";
import { ctlAskDeniedLine, ctlAskReplyLine, recordFromAskInput, type AskReply, type QuestionRecord } from "../asks/record";
import { setItems, type RelayItem, type RelayVerdict } from "./store";

const SOURCE = "ctl-asks";

export interface CtlAskInput {
  /** the Rust card id: the item id, and what `ctl-card-cancel` names */
  cardId: string;
  askerTab: string | null;
  question: string;
  choices?: string[];
  /** `details[i]` describes `choices[i]` */
  details?: string[];
  claimedAtMs: number;
  expiresAtMs: number;
}

interface Flight {
  asker: string;
  item: RelayItem;
  timer: ReturnType<typeof setTimeout>;
  done: (ok: boolean, line: string) => void;
}
/** card id -> ask in flight; at most one per asker, because the Rust card cap (3) is shared with approvals */
const flights = new Map<string, Flight>();
let cancelListening = false;

/** The message `askGate` gave a second ask of the same kind, so the caller's err line is unchanged. */
export const CTL_ASK_BUSY = 'an ask for "ctl-ask" is already on screen or queued; only one at a time is useful';
/** Hard steer: a hosted Claude tab has AskUserQuestion and `pending`, so a blocking ask is refused. */
export const CTL_ASK_STEER = "err use --pending or AskUserQuestion";

/** A plain blocking ask from a Falcon-hosted Claude Rendered tab (the shape of `driveSnapshot().tabs`). */
export function hostedClaudeAsker(tabs: { id: string; body?: string; agent?: string; hosted?: boolean }[], tab: string | null): boolean {
  const t = tab ? tabs.find((x) => x.id === tab) : undefined;
  return !!t && t.body === "rendered" && t.agent === "claude" && t.hosted === true;
}

function publish(): void {
  setItems(SOURCE, [...flights.values()].map((f) => f.item));
}

function finish(cardId: string, result: { ok: boolean; line: string } | null): boolean {
  const f = flights.get(cardId);
  if (!f) return false;
  clearTimeout(f.timer);
  flights.delete(cardId);
  publish();
  if (result) f.done(result.ok, result.line);
  return true;
}

function listenCancel(): void {
  if (cancelListening) return;
  cancelListening = true;
  // Rust already answered the caller; the item just leaves.
  void listen<{ cardId: string }>("ctl-card-cancel", (e) => { finish(e.payload.cardId, null); });
}

/** Publishes the ask; `done` gets the caller's reply once. Returns the refusal reason (no item made) or null. */
export function publishCtlAsk(input: CtlAskInput, done: (ok: boolean, line: string) => void): string | null {
  listenCancel();
  const asker = input.askerTab ?? "";
  for (const f of flights.values()) if (f.asker === asker) return CTL_ASK_BUSY;
  const options = (input.choices ?? []).map((label, i) => ({ label, description: input.details?.[i] }));
  const record: QuestionRecord = recordFromAskInput(
    { questions: [{ question: input.question, options }] },
    { key: input.cardId, origin: "ctl-ask", askerTab: input.askerTab, askedAtMs: input.claimedAtMs, expiresAtMs: input.expiresAtMs },
  );
  const item: RelayItem = {
    id: input.cardId,
    kind: "question",
    source: SOURCE,
    title: input.question.replace(/\s+/g, " ").trim(),
    sinceMs: input.claimedAtMs,
    view: { type: "question", record },
    askerTab: input.askerTab,
    async resolve(v: RelayVerdict) {
      if (!flights.has(input.cardId)) throw new Error("Already Answered");
      if (v.verdict !== "approve") { finish(input.cardId, { ok: false, line: ctlAskDeniedLine(v.comment) }); return; }
      const q = record.questions[0];
      const reply: AskReply = v.reply ?? { answers: q ? { [q.id]: v.choice ?? "" } : {}, notes: v.comment };
      finish(input.cardId, { ok: true, line: ctlAskReplyLine(record, reply) });
    },
  };
  const timer = setTimeout(() => { finish(input.cardId, { ok: false, line: "err expired" }); }, Math.max(0, input.expiresAtMs - Date.now()));
  flights.set(input.cardId, { asker, item, timer, done });
  publish();
  return null;
}

export function startCtlAskSource(): void {
  listenCancel();
}
