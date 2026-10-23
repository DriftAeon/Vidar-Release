// Relay pending-item store: what is waiting on the user, merged from every source. No DOM, no invoke.
// A source replaces its own slice; seen state is memory only.
import type { AskReply, QuestionRecord } from "../asks/record";
import type { NodeMatrix } from "../control/node-matrix";

export type RelayKind ="display" | "ask" | "card" | "question";
/** a pending ask as the source painted it; `sha256` is the content hash a claim/settle binds to */
export interface RelayAsk {
  id: string;
  session: string;
  question: string;
  choices: string[];
  /** `details[i]` describes `choices[i]`; absent on old records */
  details?: string[];
  askedAtMs: number;
  /** optional line saying what the ask is for (replaces the tab title in the header) */
  context?: string;
  sha256: string;
}
type RelayView =
  | { type: "display"; path: string; fileKind: "png" | "svg" | "html"; mtimeMs: number }
  | { type: "doc"; path: string }
  /** any ask as the shared record; `pend` is the stored entry behind a pend ask */
  | { type: "question"; record: QuestionRecord; pend?: RelayAsk }
  /** an approval card shown as label/value rows (the Run Flow card); Approve/Deny answer it */
  | { type: "card"; rows: [string, string][]; matrix?: NodeMatrix; comment?: boolean };
export interface RelayVerdict {
  verdict: "approve" | "deny" | "dismiss";
  comment: string;
  choice?: string;
  binding?: { path: string; sha256: string };
  /** a question item's picks and note */
  reply?: AskReply;
}
export interface RelayItem {
  id: string;
  kind: RelayKind;
  source: string;
  title: string;
  sinceMs: number;
  view: RelayView;
  /** the tab that asked, when the source knows it */
  askerTab?: string | null;
  error?: string;
  /** throws -> the strip shows the message */
  resolve(v: RelayVerdict): Promise<void>;
}

/** the file a display/doc view shows; "" for a question or a card */
export function viewPath(item: RelayItem | null): string {
  return !item || item.view.type === "card" || item.view.type === "question" ? "" : item.view.path;
}

const slices = new Map<string, readonly RelayItem[]>();
const seen = new Set<string>();
const listeners = new Set<(items: readonly RelayItem[]) => void>();
let merged: readonly RelayItem[] = [];

export function setItems(source: string, next: RelayItem[]): void {
  // ids in a source's first snapshot are seen: those were there before this launch;
  // an ask or approval card is never auto-seen, so a restart keeps its unread dot
  if (!slices.has(source)) for (const it of next) if (it.kind === "display") seen.add(it.id);
  slices.set(source, next);
  merged = [...slices.values()].flat().sort((a, b) => b.sinceMs - a.sinceMs);
  for (const fn of [...listeners]) fn(merged);
}

export function items(): readonly RelayItem[] {
  return merged;
}

export function subscribe(fn: (items: readonly RelayItem[]) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function markSeen(id: string): void {
  seen.add(id);
}

export function isUnread(id: string): boolean {
  return !seen.has(id);
}
