// Relay card: one pending item in the stack (relay/stack.ts). Head (kind chip, title, unread dot; a
// display or ask card adds icon-only Open Large right after the title, a display card also its file
// actions top right with its HH:MM on the file line, the others keep HH:MM in the head), then the body: a display item paints its own thumbnail through its own renderer and
// carries its own action strip, so its verdict binds to the bytes on this card; an ask carries its
// own form (relay/ask-view.ts): one click on a choice answers. Open Large shows the item in the
// left pane (relay/large.ts).
// The thumbnail paints lazily, when the card first scrolls into view.

import { createDisplayRenderer, type DisplayRenderer } from "../panels/display-render";
import { iconImg } from "../icon-img";
import { createAskForm, type AskForm } from "./ask-view";
import { createCardForm, type CardForm } from "./card-view";
import { isUnread, type RelayItem } from "./store";
import { createRelayStrip, type RelayStrip } from "./strip";
import { fitThumb, type ThumbFit } from "./thumb";
import { relayViewKey, type RelayViewState } from "./view";

export interface RelayCardHooks {
  openLarge(id: string): void;
  /** the card came into view (or the DOM has no IntersectionObserver): the seen mark is the caller's */
  onVisible(id: string): void;
}

export interface RelayCard {
  el: HTMLElement;
  /** the view key the card was built for; a different key means a rebuild (relayViewKey) */
  key: string;
  /** `current`: this item is the one open large */
  update(item: RelayItem, current: boolean): void;
  dispose(): void;
}

const KIND_CHIP = { display: "Display", ask: "Ask", card: "Approval" } as const;

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
  // pushes the rest right: a display card's file actions (its time is on the file line), an ask card's time
  const openHost = isDisplay || item.view.type === "ask" ? span("relay-card-actions relay-card-open") : null;
  const cluster = isDisplay ? div("relay-card-actions") : null;
  head.append(span("relay-chip", KIND_CHIP[item.kind]), title);
  if (openHost) head.append(openHost);
  head.append(span("relay-card-gap"));
  if (!isDisplay) head.append(time);
  if (cluster) head.append(cluster);
  head.append(dot);
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
  } else if (v.type === "ask") {
    const body = div("relay-card-ask");
    el.append(body);
    askForm = createAskForm(body, item, { compact: true });
    openHost?.append(openBtn);
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
    title.textContent = item.title;
    title.title = item.title;
    time.textContent = clock(item.sinceMs);
    dot.classList.toggle("unread", isUnread(id));
    el.classList.toggle("current", current);
    openBtn.classList.toggle("on", current);
    openBtn.setAttribute("aria-pressed", String(current));
    strip?.paint();
  }

  update(item, false);
  return {
    el,
    key: relayViewKey(first),
    update,
    dispose() {
      disposed = true;
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
