// An ask card's two overlays (relay/card.ts): the scrim that points to the asker's tab while that tab is on
// screen, and the brief answered state after the tab answered. Both are local to the card; the stack decides
// when a settled card leaves.

import { ASK_FOCUS_EVENT, ASK_SETTLED_EVENT, type AskFocusDetail, type AskSettledDetail } from "../asks/record";
import { shown, subscribeShown } from "../panels/sessions/shown";
import { markSlot } from "../panels/rendered/marks";
import type { RelayItem } from "./store";

/** how long a settled card stays once it has been seen with Relay on screen */
export const SETTLED_MS = 4000;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface AskStateParts {
  card: HTMLElement;
  /** the card's body: the scrim sits over it */
  body: HTMLElement;
  /** bar pieces the answered state rewrites */
  mark: HTMLElement;
  title: HTMLElement;
  time: HTMLElement;
  /** bar pieces the answered state hides */
  hide: readonly (HTMLElement | null)[];
  item(): RelayItem;
  /** Relay itself is on screen (panels/relay.ts), not only the workbench that hosts it */
  relayVisible(): boolean;
  /** the settled card has been on screen for SETTLED_MS */
  onDone(): void;
  /** the answered state replaces the body: drop whatever drew it */
  onSettle(): void;
}

export interface AskState {
  /** re-evaluate the scrim and, once settled, the leave timer */
  sync(): void;
  settle(where: string, answer: string): void;
  settled(): boolean;
  dispose(): void;
}

function arrow(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icn");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  // points left, leading the label: the Rendered chat usually sits left of Relay
  p.setAttribute("d", "M19 12H5M11 6l-6 6 6 6");
  svg.appendChild(p);
  return svg;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type SessionsMod = typeof import("../panels/sessions");

export function createAskState(p: AskStateParts): AskState {
  let mod: SessionsMod | null = null;
  let loading = false;
  let lifted = false; // a click on the scrim: this item answers in Relay from here on
  let isSettled = false;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let overlay: HTMLElement | null = null;
  let go: HTMLButtonElement | null = null;
  let label: HTMLElement | null = null;

  // Loaded on first use: the session layer reaches back into Relay (tests/import-cycles.test.mjs).
  function load(): void {
    if (mod || loading) return;
    loading = true;
    void import("../panels/sessions").then((m) => { mod = m; if (!disposed) sync(); }, () => { loading = false; });
  }

  function tabName(tab: string): string {
    return mod?.sessionTitle(tab) ?? "";
  }

  /** the asker's tab is on screen and Rendered, and Relay is really visible */
  function covered(): boolean {
    const tab = p.item().askerTab;
    if (lifted || isSettled || !tab) return false;
    load();
    const s = shown();
    if (!p.relayVisible() || !s.relay || !s.tabs.includes(tab)) return false;
    return mod?.renderedBody(tab) != null; // a PTY tab has no card to point to
  }

  function build(): HTMLElement {
    const scrim = document.createElement("div");
    scrim.className = "relay-ask-scrim";
    scrim.addEventListener("click", () => { lifted = true; sync(); });
    go = document.createElement("button");
    go.type = "button";
    go.className = "relay-ask-go";
    label = document.createElement("span");
    go.append(arrow(), label);
    go.addEventListener("click", (e) => { e.stopPropagation(); void act(); });
    scrim.append(go);
    return scrim;
  }

  async function act(): Promise<void> {
    const tab = p.item().askerTab;
    const v = p.item().view;
    if (!tab || v.type !== "question" || !mod || !go) return;
    go.disabled = true;
    try {
      mod.activate(tab);
      const detail: AskFocusDetail = { tabId: tab, key: v.record.key };
      window.dispatchEvent(new window.CustomEvent(ASK_FOCUS_EVENT, { detail }));
    } finally {
      if (go) go.disabled = false;
    }
  }

  function sync(): void {
    if (disposed) return;
    const on = covered();
    if (on && !overlay) {
      overlay = build();
      p.body.append(overlay);
    } else if (!on && overlay) {
      overlay.remove();
      overlay = null;
    }
    if (on && label) {
      const tab = p.item().askerTab ?? "";
      label.textContent = `Answer in ${tabName(tab)}`.trimEnd();
    }
    p.card.classList.toggle("relay-ask-covered", on);
    // the leave timer runs only with Relay on screen
    if (isSettled && !doneTimer && p.relayVisible()) {
      doneTimer = setTimeout(() => { doneTimer = null; if (!disposed) p.onDone(); }, SETTLED_MS);
    } else if (isSettled && doneTimer && !p.relayVisible()) {
      clearTimeout(doneTimer);
      doneTimer = null;
    }
  }

  function settle(where: string, answer: string): void {
    if (isSettled || disposed) return;
    isSettled = true;
    overlay?.remove();
    overlay = null;
    p.card.classList.remove("relay-ask-covered");
    p.card.classList.add("relay-ask-settled");
    p.onSettle();
    p.mark.replaceWith(Object.assign(markSlot("answered"), { title: "Answered" }));
    p.title.textContent = `Answered in ${where}`;
    p.title.title = p.title.textContent;
    p.time.textContent = clock(Date.now());
    for (const e of p.hide) e?.classList.add("hidden");
    const v = p.item().view;
    const q = document.createElement("span");
    q.className = "relay-done-q";
    q.textContent = v.type === "question" ? v.record.questions.map((x) => x.text).join(" · ") : "";
    const a = document.createElement("span");
    a.className = "relay-done-a";
    a.textContent = answer;
    const line = document.createElement("div");
    line.className = "relay-done-line";
    line.append(q, a);
    p.body.replaceChildren(line);
    sync();
  }

  const off = subscribeShown(sync);
  const onFocus = () => sync();
  document.addEventListener("vidar-focus", onFocus);
  const onSettled = (ev: Event) => {
    const d = (ev as CustomEvent<AskSettledDetail>).detail;
    const v = p.item().view;
    if (d && v.type === "question" && d.key === v.record.key) settle(d.where, d.answer);
  };
  window.addEventListener(ASK_SETTLED_EVENT, onSettled);

  return {
    sync,
    settle,
    settled: () => isSettled,
    dispose() {
      disposed = true;
      off();
      document.removeEventListener("vidar-focus", onFocus);
      window.removeEventListener(ASK_SETTLED_EVENT, onSettled);
      if (doneTimer) clearTimeout(doneTimer);
      overlay?.remove();
    },
  };
}
