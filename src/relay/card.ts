// Relay card: one pending item in the stack (relay/stack.ts). Head (kind chip, title, unread dot; an ask or
// approval card wears the amber bar instead: mark, title, time, no chip or dot; a
// display or ask card adds icon-only Open Large right after the title, a display card also its file
// actions top right with its HH:MM on the file line, the others keep HH:MM in the head), then the body: a display item paints its own thumbnail through its own renderer and
// carries its own action strip, so its verdict binds to the bytes on this card; an ask carries its
// own form (relay/ask-view.ts): one click on a choice answers. Open Large shows the item in the
// left pane (relay/large.ts).
// The thumbnail paints lazily, when the card first scrolls into view.

import { createDisplayRenderer, type DisplayRenderer } from "../panels/display-render";
import { iconImg } from "../icon-img";
import { labelledMark } from "../panels/rendered/marks";
import { createAskForm, type AskForm } from "./ask-view";
import { createAskState, type AskState } from "./card-ask-state";
import { createCardForm, type CardForm } from "./card-view";
import { isUnread, type RelayItem } from "./store";
import { createRelayStrip, type RelayStrip } from "./strip";
import { fitThumb, type ThumbFit } from "./thumb";
import { relayViewKey, type RelayViewState } from "./view";

export interface RelayCardHooks {
  openLarge(id: string): void;
  /** the card came into view (or the DOM has no IntersectionObserver): the seen mark is the caller's */
  onVisible(id: string): void;
  /** Relay is really on screen (panels/relay.ts); absent, true */
  relayVisible?(): boolean;
  /** an ask card showed its answered state long enough: the stack drops it */
  onSettledDone?(id: string): void;
}

export interface RelayCard {
  el: HTMLElement;
  /** the view key the card was built for; a different key means a rebuild (relayViewKey) */
  key: string;
  /** `current`: this item is the one open large */
  update(item: RelayItem, current: boolean): void;
  /** an ask card whose item left the store without Relay answering it: the tab may still report the answer */
  lingers(): boolean;
  /** the card shows its answered state; its own timer removes it */
  settled(): boolean;
  dispose(): void;
}

const KIND_CHIP = { display: "Display", ask: "Ask", card: "Approval", question: "Ask" } as const;

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function div(cls: string, text?: string): HTMLElement {
  const e = document.createElement("div");
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function span(cls: string, text?: string): HTMLElement {
  const e = document.createElement("span");
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createRelayCard(first: RelayItem, hooks: RelayCardHooks): RelayCard {
  let item = first;
  const id = item.id;
  const el = div("relay-card");
  el.dataset.kind = item.kind;
  el.dataset.id = id;

  const dot = span("relay-dot");
  const title = span("relay-card-title");
  const time = span("relay-card-time");
  const head = div("relay-card-head");
  // the chip leads, flush with the thumb's left edge; the unread dot rides the right end (2026-10-11)
  const isDisplay = item.view.type === "display";
  // a display or ask card shows icon-only Open Large right after the title (2026-10-11); a spacer then
  // pushes the rest right: a display card's file actions (its time is on the file line), an ask card's time.
  // A single-question ask fits its card, so only a multi-question ask gets it.
  const roomy = item.view.type === "question" && item.view.record.questions.length > 1;
  const openHost = isDisplay || roomy ? span("relay-card-actions relay-card-open") : null;
  const cluster = isDisplay ? div("relay-card-actions") : null;
  // an ask card's head is the amber title bar (2026-10-22): mark, Question, For <tab>, Open Large, time; no chip, no dot
  const isAsk = item.view.type === "question";
  const isApproval = item.view.type === "card";
  const forTab = span("relay-card-for");
  const askMark = labelledMark("awaiting", "Question");
  const sep = span("relay-card-sep");
  if (isAsk) {
    el.classList.add("relay-ask-card");
    title.textContent = "Question";
    head.append(askMark, title, sep, forTab);
  } else if (isApproval) {
    // an approval card wears the ask shell: amber bar, mark, title, time; no chip, no dot
    el.classList.add("relay-ask-card");
    head.append(labelledMark("awaiting", "Approval"), title);
  } else {
    head.append(span("relay-chip", KIND_CHIP[item.kind]), title);
  }
  if (openHost) head.append(openHost);
  head.append(span("relay-card-gap"));
  if (!isDisplay) head.append(time);
  if (cluster) head.append(cluster);
  if (!isAsk && !isApproval) head.append(dot);
  el.append(head);

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.dataset.act = "open-large";
  openBtn.addEventListener("click", () => hooks.openLarge(id));
  if (openHost) {
    // icon-only, the file actions' look
    openBtn.className = "icon-btn file-action relay-act relay-open-icon";
    openBtn.title = "Open Large";
    openBtn.setAttribute("aria-label", "Open Large");
    // note-ok: user, 2026-10-11 — Noto cyclone is the full-colour Open Large exception.
    openBtn.appendChild(iconImg("open-large"));
  } else {
    openBtn.className = "relay-open-large";
    openBtn.textContent = "Open Large";
  }

  let renderer: DisplayRenderer | null = null;
  let thumbFit: ThumbFit | null = null;
  let askForm: AskForm | null = null;
  let askState: AskState | null = null;
  let answeredHere = false; // Relay's own form sent the verdict: the card leaves with its item
  let cardForm: CardForm | null = null;
  let strip: RelayStrip | null = null;
  let state: RelayViewState = { painting: false, error: "", note: "" };
  let started = false;
  let disposed = false;
  const v = item.view;
  if (v.type === "display") {
    const thumb = div("relay-thumb");
    const file = div("relay-card-file", v.path.split("\\").pop() ?? v.path);
    file.title = v.path;
    const fileLine = div("relay-card-fileline");
    fileLine.append(file, time);
    el.append(thumb, fileLine);
    renderer = createDisplayRenderer(thumb, { onNote: (n) => { state = { ...state, note: n }; } });
    thumbFit = fitThumb(thumb);
    const row = div("relay-card-row");
    strip = createRelayStrip(row, { selected: () => item, current: () => renderer?.current() ?? null, view: () => state, actionsHost: cluster ?? undefined });
    openHost?.append(openBtn);
    el.append(row);
  } else if (v.type === "question") {
    const body = div("relay-card-ask");
    el.append(body);
    const mine: RelayItem = { ...item, resolve: (verdict) => { answeredHere = true; return item.resolve(verdict); } };
    askForm = createAskForm(body, mine, {
      compact: true,
      onFor: (t) => { forTab.textContent = t; forTab.title = t; forTab.classList.toggle("hidden", !t); },
    });
    openHost?.append(openBtn);
    askState = createAskState({
      card: el, body, mark: askMark, title, time, hide: [sep, forTab, openHost],
      item: () => item,
      relayVisible: () => hooks.relayVisible?.() ?? true,
      onDone: () => hooks.onSettledDone?.(id),
      onSettle: () => { askForm?.dispose(); askForm = null; }, // its poll would unhide the For label
    });
  } else if (v.type === "card") {
    // the rows already show everything on the card: no Open Large
    const body = div("relay-card-ask");
    el.append(body);
    cardForm = createCardForm(body, item);
  } else {
    const row = div("relay-card-row");
    row.append(openBtn);
    el.append(row);
  }

  /** first time in view: paint the thumbnail (once; the renderer keeps it until the card goes) */
  async function paintThumb(): Promise<void> {
    if (started || !renderer || item.view.type !== "display") return;
    started = true;
    const dv = item.view;
    state = { ...state, painting: true };
    strip?.paint();
    const r = await renderer.show({ path: dv.path, kind: dv.fileKind, mtime_ms: dv.mtimeMs });
    if (disposed || r === null) return;
    if ("error" in r) renderer.clear();
    thumbFit?.fit();
    state = { ...state, painting: false, error: "error" in r ? r.error : "" };
    strip?.paint();
  }

  let io: IntersectionObserver | null = null;
  const seen = () => {
    void paintThumb();
    hooks.onVisible(id);
  };
  if (typeof IntersectionObserver === "undefined") {
    queueMicrotask(() => { if (!disposed) seen(); }); // test DOM: no observer, so in view at once
  } else {
    io = new IntersectionObserver((entries) => {
      if (!disposed && entries.some((e) => e.isIntersecting)) seen();
    });
    io.observe(el);
  }

  function update(next: RelayItem, current: boolean): void {
    item = next;
    if (!isAsk) {
      title.textContent = item.title;
      title.title = item.title;
    }
    if (!askState?.settled()) time.textContent = clock(item.sinceMs);
    dot.classList.toggle("unread", isUnread(id));
    el.classList.toggle("current", current);
    openBtn.classList.toggle("on", current);
    openBtn.setAttribute("aria-pressed", String(current));
    strip?.paint();
    askState?.sync();
  }

  update(item, false);
  return {
    el,
    key: relayViewKey(first),
    update,
    lingers: () => isAsk && !answeredHere && !askState?.settled(),
    settled: () => askState?.settled() ?? false,
    dispose() {
      disposed = true;
      askState?.dispose();
      io?.disconnect();
      thumbFit?.dispose();
      askForm?.dispose();
      cardForm?.dispose();
      renderer?.clear();
      strip?.dispose();
      el.remove();
    },
  };
}
