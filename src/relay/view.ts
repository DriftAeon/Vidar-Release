// Relay view pane: the Open Large body (relay/large.ts), one per window. A display view goes
// through its own display-render instance (never Display's or a card's, so none cancels another's
// staging); a doc view is read_document + renderMarkdownOrText. Owns the painting/error/note state
// the Large bar's strip reads; that strip's verdict binds to relayCurrent().

import type { QuestionRecord } from "../asks/record";
import { invoke } from "../ipc";
import { createDisplayRenderer, sourcePre, type DisplayRenderer, type Painted } from "../panels/display-render";
import { renderMarkdownOrText } from "../panels/markdown-build";
import { createAskForm, type AskForm } from "./ask-view";
import { createCardForm } from "./card-view";
import type { RelayItem } from "./store";

export interface RelayViewState { painting: boolean; error: string; note: string }

let hostEl: HTMLElement;
let renderer: DisplayRenderer;
let onChange: () => void = () => {};
let onAskNote: (msg: string) => void = () => {};
/** the ask form on screen; dropped (with its poll slot) when anything else is shown */
let askForm: AskForm | null = null;
/** guards every async paint (display and doc alike) against a newer showRelayItem */
let seq = 0;
/** what the pane was last asked to show; a repeat of the same key does not repaint */
let shownKey: string | null = null;
let state: RelayViewState = { painting: false, error: "", note: "" };

function set(next: Partial<RelayViewState>) {
  state = { ...state, ...next };
  onChange();
}

/** What a paint of `item` depends on; a change repaints the view and rebuilds its card. */
export function relayViewKey(item: RelayItem): string {
  const v = item.view;
  // a question repaints on a hash of its questions and options: a changed question rebuilds the form it was answered on
  return v.type === "display" ? `${item.id}|${v.mtimeMs}` : v.type === "card" ? `${item.id}|card` : v.type === "question" ? `${item.id}|${questionHash(v.record)}` : `${item.id}|doc`;
}

/** djb2 over the record's question ids, texts, flags and option labels */
function questionHash(record: QuestionRecord): string {
  const text = JSON.stringify(record.questions.map((q) => [q.id, q.text, q.multi, q.other, q.secret, q.options.map((o) => [o.label, o.description ?? ""])]));
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function mountRelayView(host: HTMLElement, opts: { onChange?(): void; onAskNote?(msg: string): void } = {}): HTMLElement {
  hostEl = host;
  onChange = opts.onChange ?? (() => {});
  onAskNote = opts.onAskNote ?? (() => {});
  renderer = createDisplayRenderer(host, { onNote: (n) => set({ note: n }) });
  return host;
}

/** Paints `item` (null clears). Same item and same file mtime: no repaint. */
export async function showRelayItem(item: RelayItem | null): Promise<void> {
  const key = item ? relayViewKey(item) : null;
  if (key === shownKey) return;
  shownKey = key;
  const s = ++seq;
  askForm?.dispose();
  askForm = null;
  if (!item) {
    renderer.clear();
    set({ painting: false, error: "", note: "" });
    return;
  }
  const v = item.view;
  if (v.type === "question") {
    renderer.clear(); // drops any display render and its staging; the host is ours
    askForm = createAskForm(hostEl, item, { onNote: (m) => onAskNote(m) });
    set({ painting: false, error: "", note: "" });
    return;
  }
  if (v.type === "card") {
    renderer.clear();
    createCardForm(hostEl, item, { onNote: (m) => onAskNote(m) });
    set({ painting: false, error: "", note: "" });
    return;
  }
  set({ painting: true, error: "", note: "" });
  if (v.type === "display") {
    const r = await renderer.show({ path: v.path, kind: v.fileKind, mtime_ms: v.mtimeMs });
    if (s !== seq || r === null) return; // a newer show owns the pane and the state
    if ("error" in r) renderer.clear(); // the last item's render must not sit under this row
    set({ painting: false, error: "error" in r ? r.error : "" });
    return;
  }
  renderer.clear(); // drops any display render and its staging; the host is ours
  try {
    const doc = await invoke("read_document", { path: v.path });
    if (s !== seq) return;
    const built = renderMarkdownOrText(doc.name, doc.text);
    hostEl.replaceChildren(built.fellBack ? sourcePre(doc.text) : built.el);
    set({ painting: false, note: built.fellBack ? built.fellBack.reason : "" });
  } catch (e) {
    if (s !== seq) return;
    hostEl.replaceChildren();
    set({ painting: false, error: String(e) });
  }
}

/** The display read on screen (what a verdict binds to); null for a doc view or nothing painted. */
export function relayCurrent(): Painted | null {
  return renderer?.current() ?? null;
}

export function relayViewState(): RelayViewState {
  return state;
}
