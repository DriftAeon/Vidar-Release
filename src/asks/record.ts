// The one shape every ask takes on its way to Relay or a tab card (Claude and Codex questions, MCP
// elicitation, pend, ctl.ask), with the pure mappers between it and each wire form. No DOM, no invoke.

export type AskOrigin = "claude" | "codex" | "codex-async" | "mcp" | "pend" | "ctl-ask";
export interface AskQuestionItem {
  /** Claude: index + text, so identical texts never collide; Codex: the question's own id */
  id: string;
  text: string;
  options: { label: string; description?: string }[];
  multi: boolean;
  /** a free-text "Other" row is offered */
  other: boolean;
  secret: boolean;
}
/** `answers` is keyed by `AskQuestionItem.id`; each value is the joined pick text, as `collect()` builds it */
export interface AskReply { answers: Record<string, string>; notes: string }
export interface QuestionRecord {
  key: string;
  origin: AskOrigin;
  askerTab: string | null;
  askerSession: string | null;
  context?: string;
  questions: AskQuestionItem[];
  /** a free note beside the picks (pend, ctl-ask, codex-async) */
  notes: boolean;
  /** the answer is delivered as a user message (pend, codex-async) */
  needsPrompt: boolean;
  dismiss: "deny" | "settle" | null;
  /** false: Relay shows the question with an Answer In Tab button instead of a form */
  inline: boolean;
  askedAtMs: number;
  expiresAtMs?: number;
}

/** window events between Relay and the asker's tab, keyed by `QuestionRecord.key`: Relay's overlay action asks the
 *  tab to scroll to and focus that question's card; a tab answer tells Relay where and what, for its brief settled state */
export const ASK_FOCUS_EVENT = "vidar-ask-focus";
export const ASK_SETTLED_EVENT = "vidar-ask-settled";
export interface AskFocusDetail { tabId: string; key: string }
export interface AskSettledDetail { key: string; where: string; answer: string }

/** what the caller knows about the ask beyond its question input */
export interface AskBase {
  key: string;
  origin: AskOrigin;
  askerTab?: string | null;
  askerSession?: string | null;
  context?: string;
  askedAtMs: number;
  expiresAtMs?: number;
  /** overrides the per-origin default */
  dismiss?: QuestionRecord["dismiss"];
}

type RawQuestion = { id?: string; question?: string; options?: unknown; multiSelect?: boolean; isOther?: boolean; isSecret?: boolean };
const rawQuestions = (input: unknown): unknown[] => {
  const qs = (input && typeof input === "object" ? input : {}) as { questions?: unknown };
  return Array.isArray(qs.questions) ? qs.questions : [];
};
const asRaw = (raw: unknown): RawQuestion => (raw && typeof raw === "object" ? raw : {}) as RawQuestion;

const NOTES: ReadonlySet<AskOrigin> = new Set(["pend", "ctl-ask", "codex-async"]);
const PROMPT: ReadonlySet<AskOrigin> = new Set(["pend", "codex-async"]);
const DISMISS: Record<AskOrigin, QuestionRecord["dismiss"]> = { claude: "deny", codex: "deny", "codex-async": null, mcp: "deny", pend: "settle", "ctl-ask": "deny" };

/** AskUserQuestion input (Claude keyed by text, Codex keyed by `id`) to a record; the per-question
 *  `other` flag copies question-form.ts: Claude always, Codex on `isOther` or a free-text question */
export function recordFromAskInput(input: unknown, base: AskBase): QuestionRecord {
  const questions = rawQuestions(input).map((r, i): AskQuestionItem => {
    const q = asRaw(r);
    const codex = typeof q.id === "string";
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => {
      const oo = (o && typeof o === "object" ? o : {}) as { label?: string; description?: string };
      return oo.description ? { label: oo.label ?? "", description: oo.description } : { label: oo.label ?? "" };
    });
    const text = q.question ?? "";
    return {
      id: codex ? (q.id as string) : `${i}:${text}`,
      text,
      options,
      multi: q.multiSelect === true,
      other: !codex || q.isOther === true || options.length === 0,
      secret: q.isSecret === true,
    };
  });
  const rec: QuestionRecord = {
    key: base.key,
    origin: base.origin,
    askerTab: base.askerTab ?? null,
    askerSession: base.askerSession ?? null,
    questions,
    notes: NOTES.has(base.origin),
    needsPrompt: PROMPT.has(base.origin),
    dismiss: base.dismiss === undefined ? DISMISS[base.origin] : base.dismiss,
    inline: !(base.origin === "codex" && questions.some((q) => q.secret)),
    askedAtMs: base.askedAtMs,
  };
  if (base.context) rec.context = base.context;
  if (base.expiresAtMs !== undefined) rec.expiresAtMs = base.expiresAtMs;
  return rec;
}

/** a reply to the `updatedInput` the SDK/Codex answer carries; `questions` is the raw array
 *  `questionForm.collect()` returns, and answers are keyed as it keys them (Codex id, else the text) */
export function updatedInputFromReply(questions: unknown, record: QuestionRecord, reply: AskReply): { questions: unknown; answers: Record<string, string> } {
  const answers: Record<string, string> = {};
  const raw = Array.isArray(questions) ? questions : [];
  raw.forEach((r, i) => {
    const q = asRaw(r);
    const item = record.questions[i];
    answers[q.id ?? q.question ?? ""] = item ? (reply.answers[item.id] ?? "") : "";
  });
  return { questions, answers };
}

/** pend and ctl-ask carry one question: a listed pick is the `choice`, an Other text is the comment
 *  unless the note box has text, which wins */
export function pendReplyParts(record: QuestionRecord, reply: AskReply): { choice: string | null; comment: string } {
  const item = record.questions[0];
  const picked = item ? (reply.answers[item.id] ?? "").trim() : "";
  const listed = !!item && item.options.some((o) => o.label === picked);
  const notes = reply.notes.trim();
  return { choice: listed ? picked : null, comment: notes || (listed ? "" : picked) };
}

/** the line `ctl.ask` returns to the caller, as listen.ts writes it for an answered card */
export function ctlAskReplyLine(record: QuestionRecord, reply: AskReply): string {
  const { choice, comment } = pendReplyParts(record, reply);
  return `answered choice=${choice ?? "-"} comment="${comment}"`;
}

/** the line for a denied or dismissed card */
export const ctlAskDeniedLine = (comment: string): string => `denied ${comment}`;
