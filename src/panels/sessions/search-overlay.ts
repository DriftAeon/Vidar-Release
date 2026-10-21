// Scrollback search overlay for terminal tabs: the find bar and next/previous over the focused
// tab's SearchAddon. sessions.ts binds its tab map, focused id and focus seam in.
import type { TerminalSession } from "./types";
import { iconImg } from "../../icon-img";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let getActiveId: () => string | null = () => null;
let focusBody: (s: TerminalSession | undefined) => void = () => {};
let overlayEl: HTMLElement;
let searchInput: HTMLInputElement;

/** sessions.ts, at load: the tab map, the focused tab id and the focus seam. */
export function bindSearchOverlay(deps: { sessions: ReadonlyMap<string, TerminalSession>; getActiveId: () => string | null; focusBody: (s: TerminalSession | undefined) => void }) {
  sessions = deps.sessions;
  getActiveId = deps.getActiveId;
  focusBody = deps.focusBody;
}

/* ---- scrollback search ---- */

export function buildSearchOverlay(viewEl: HTMLElement) {
  overlayEl = document.createElement("div");
  overlayEl.id = "search-overlay";
  overlayEl.className = "hidden";
  overlayEl.innerHTML = `
    <input id="search-input" placeholder="find…" spellcheck="false" />
    <button id="search-prev" title="Previous (Shift+Enter)">‹</button>
    <button id="search-next" title="Next (Enter)">›</button>
    <button id="search-close" title="Close (Esc)">×</button>`;
  viewEl.appendChild(overlayEl);
  searchInput = overlayEl.querySelector<HTMLInputElement>("#search-input")!;

  overlayEl.querySelector("#search-next")!.addEventListener("click", () => findActive(true));
  overlayEl.querySelector("#search-prev")!.addEventListener("click", () => findActive(false));
  const searchClose = overlayEl.querySelector<HTMLButtonElement>("#search-close")!;
  searchClose.textContent = "";
  searchClose.setAttribute("aria-label", "Close");
  searchClose.appendChild(iconImg("close"));
  searchClose.addEventListener("click", closeSearch);
  searchInput.addEventListener("input", () => findActive(true, true));
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      findActive(!ev.shiftKey);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeSearch();
    } else if ((ev.key === "f" || ev.key === "F") && ev.ctrlKey) {
      ev.preventDefault();
    }
  });
}

function findActive(forward: boolean, incremental = false) {
  const activeId = getActiveId();
  const s = activeId ? sessions.get(activeId) : undefined;
  if (!s?.search || !searchInput.value) return; // rendered body: no scrollback search
  if (forward) s.search.findNext(searchInput.value, { incremental });
  else s.search.findPrevious(searchInput.value, { incremental });
}

export function openSearch() {
  overlayEl.classList.remove("hidden");
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  const activeId = getActiveId();
  overlayEl.classList.add("hidden");
  if (activeId) focusBody(sessions.get(activeId));
}
