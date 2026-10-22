// The settings modal: DOM construction, category rail, row rendering and the chord
// recorder. Reads and writes the shortcut/setting-row table through registry.ts; owns no
// keybinding dispatch of its own (that stays in shortcuts.ts).

import { focusActive } from "../panels/sessions";
import { chordOf } from "../shortcuts-core";
import { iconImg } from "../icon-img";
import { iconSlot } from "../panels/catalog-group-icon";
import { CATEGORY_ICONS } from "./category-icons";
import {
  categoryList,
  categoryOf,
  orderCategories,
  type CategoryEntry,
  commitChord,
  getCurrent,
  getRegistry,
  getSettingRows,
  rejection,
  type Shortcut,
} from "./registry";

let modalOpen = false;
let recording: Shortcut | null = null;

let backdrop: HTMLElement | null = null;
let modal: HTMLElement | null = null;
let rows: HTMLElement | null = null;
let closeBtn: HTMLButtonElement | null = null;

// Category rail: a search box, then every registered category sorted by label. Each category is
// its own page (other rows hide); typing in the search matches rows across every page and
// clears the rail highlight. Remembered for the session, starts on the first category.
let selectedCat = "";
const catBtns = new Map<string, HTMLButtonElement>();
let search: HTMLInputElement | null = null;

// Scroll position per page, kept for the session. The Agents page fills after an async read, so a
// restore that clamps short keeps watching the rows until the target fits or the user takes over.
const scrollByCat = new Map<string, number>();
let prevQuery = "";
let stopWatch: (() => void) | null = null;

function stopScrollWatch(): void {
  stopWatch?.();
  stopWatch = null;
}

/** Save the open page's position; skipped during a search (its rows are not the page) and while a
 *  restore is still pending (the clamped value would overwrite the saved one). */
function rememberScroll(): void {
  if (!rows || !search || search.value !== "" || stopWatch) return;
  scrollByCat.set(selectedCat, rows.scrollTop);
}

function restoreScroll(): void {
  stopScrollWatch();
  const r = rows!;
  const target = scrollByCat.get(selectedCat) ?? 0;
  r.scrollTop = target;
  if (target === 0 || r.scrollTop >= target) return;
  const mo = new MutationObserver(() => {
    r.scrollTop = target;
    if (r.scrollTop >= target) stopScrollWatch();
  });
  mo.observe(r, { childList: true, subtree: true });
  const events = ["wheel", "pointerdown", "keydown"] as const;
  for (const e of events) r.addEventListener(e, stopScrollWatch, { passive: true });
  stopWatch = () => {
    mo.disconnect();
    for (const e of events) r.removeEventListener(e, stopScrollWatch);
  };
}

export function isShortcutsModalOpen(): boolean {
  return modalOpen;
}

export function isRecording(): boolean {
  return recording !== null;
}

/** Loose match: every whitespace-separated term appears in the row's text, either as a
 *  substring or as an in-order subsequence ("tglwb" finds "Toggle Workbench"). */
function looseMatch(hay: string, query: string): boolean {
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => {
    if (hay.includes(term)) return true;
    let i = 0;
    for (const ch of hay) if (ch === term[i] && ++i === term.length) return true;
    return false;
  });
}

/** Rail order: core A-Z, then the module group (see orderCategories). */
function sortedCategories(): CategoryEntry[] {
  return orderCategories(categoryList());
}

/** A missing or unknown pick (including the retired "all") falls back to the first category. */
function resolveCategory(id: string): string {
  const list = sortedCategories();
  return list.some(([c]) => c === id) ? id : list[0]?.[0] ?? "";
}

function applyCategory() {
  const q = search?.value.trim() ?? "";
  for (const [id, b] of catBtns) b.classList.toggle("selected", id === selectedCat && !q);
  if (!rows) return;
  for (const el of Array.from(rows.children) as HTMLElement[]) {
    const show = q
      ? looseMatch(el.dataset.search ?? "", q)
      : el.dataset.cat === selectedCat;
    el.classList.toggle("off-page", !show);
  }
}

function ensureModal() {
  if (modal) return;
  backdrop = document.createElement("div");
  backdrop.id = "shortcuts-backdrop";
  backdrop.className = "hidden";
  backdrop.addEventListener("click", closeShortcutsModal);

  modal = document.createElement("div");
  modal.id = "shortcuts-modal";
  modal.className = "hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Settings");
  // a click inside must not reach the document handlers that close menus
  modal.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "sc-head";
  const title = document.createElement("span");
  title.textContent = "Settings";
  closeBtn = document.createElement("button");
  closeBtn.className = "sc-close";
  closeBtn.title = "Close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.appendChild(iconImg("close"));
  closeBtn.addEventListener("click", closeShortcutsModal);
  head.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "sc-body";
  const cats = document.createElement("div");
  cats.className = "sc-cats";
  search = document.createElement("input");
  search.className = "sc-search";
  search.type = "search";
  search.setAttribute("aria-label", "Search");
  search.spellcheck = false;
  search.addEventListener("input", () => {
    const q = search!.value;
    if (prevQuery === "" && q !== "" && !stopWatch) scrollByCat.set(selectedCat, rows!.scrollTop);
    prevQuery = q;
    stopScrollWatch();
    applyCategory();
    rows!.scrollTop = 0;
  });
  const searchWrap = document.createElement("div");
  searchWrap.className = "sc-search-wrap";
  const searchIcon = iconImg("search");
  searchIcon.classList.add("sc-search-icn");
  searchWrap.append(searchIcon, search);
  cats.appendChild(searchWrap);
  let prevGroup: "module" | undefined;
  for (const [id, label, group] of sortedCategories()) {
    if (group === "module" && prevGroup !== "module" && cats.children.length > 1) {
      const sep = document.createElement("div");
      sep.className = "sc-cat-sep";
      sep.setAttribute("role", "separator");
      cats.appendChild(sep);
    }
    prevGroup = group;
    const b = document.createElement("button");
    b.className = "sc-cat";
    const nm = document.createElement("span");
    nm.textContent = label;
    b.append(iconSlot(CATEGORY_ICONS[id] ?? null), nm);
    b.addEventListener("click", () => {
      rememberScroll();
      stopScrollWatch();
      selectedCat = id;
      search!.value = ""; // a page pick ends the search
      prevQuery = "";
      applyCategory();
      restoreScroll();
    });
    cats.appendChild(b);
    catBtns.set(id, b);
  }
  rows = document.createElement("div");
  rows.className = "sc-rows";
  body.append(cats, rows);
  modal.append(head, body);
  document.body.append(backdrop, modal);
}

interface RowRefs {
  key: HTMLButtonElement;
  reset: HTMLButtonElement;
  err: HTMLElement;
}
const rowRefs = new Map<string, RowRefs>();

function renderRows() {
  rows!.innerHTML = "";
  rowRefs.clear();
  for (const s of getRegistry()) {
    const row = document.createElement("div");
    row.className = "sc-row";

    const text = document.createElement("div");
    text.className = "sc-text";
    const name = document.createElement("div");
    name.className = "sc-name";
    name.textContent = s.name;
    const err = document.createElement("div");
    err.className = "sc-err";
    text.append(name);
    if (s.description) {
      const desc = document.createElement("div");
      desc.className = "sc-desc";
      desc.textContent = s.description;
      text.append(desc);
    }
    text.append(err);
    if (s.tip) row.title = s.tip;

    const bind = document.createElement("div");
    bind.className = "sc-bind";
    const key = document.createElement("button");
    key.className = "sc-key";
    key.title = "Press a New Shortcut";
    key.addEventListener("click", () => {
      if (recording === s) stopRecording();
      else startRecording(s);
    });
    const reset = document.createElement("button");
    reset.className = "sc-reset";
    reset.title = `Reset to ${s.defaultKeys}`;
    reset.textContent = "↺";
    reset.addEventListener("click", () => void acceptChord(s, s.defaultKeys, true));
    bind.append(key, reset);

    row.dataset.cat = categoryOf(s);
    row.dataset.search = `${s.name} ${s.description ?? ""} ${s.tip ?? ""} ${getCurrent().get(s.id) ?? s.defaultKeys}`.toLowerCase();
    row.append(text, bind);
    rows!.appendChild(row);
    rowRefs.set(s.id, { key, reset, err });
    paintRow(s);
  }
  for (const sr of getSettingRows()) {
    const row = document.createElement("div");
    row.className = "sc-row";
    row.dataset.cat = sr.category;
    row.dataset.search = `${sr.name} ${sr.description ?? ""} ${sr.tip ?? ""} ${sr.keywords?.() ?? ""}`.toLowerCase();
    if (sr.wide) row.classList.add("sc-row-wide");
    const text = document.createElement("div");
    text.className = "sc-text";
    const name = document.createElement("div");
    name.className = "sc-name";
    name.textContent = sr.name;
    // on the name, not the row: a row title bleeds onto every child of a wide list-editor row
    if (sr.tip) name.title = sr.tip;
    const err = document.createElement("div");
    err.className = "sc-err";
    text.append(name);
    if (sr.description || sr.restartRequired) {
      const desc = document.createElement("div");
      desc.className = "sc-desc";
      desc.textContent = sr.restartRequired ? `${sr.description ?? ""} Applies after a restart.`.trim() : sr.description!; // note-ok: docs/reference/settings.md
      text.append(desc);
    }
    text.append(err);
    const bind = document.createElement("div");
    bind.className = "sc-bind";
    bind.appendChild(sr.control((msg) => { err.textContent = msg; }));
    row.append(text, bind);
    rows!.appendChild(row);
  }
  applyCategory();
}

function paintRow(s: Shortcut) {
  const r = rowRefs.get(s.id);
  if (!r) return;
  const c = getCurrent().get(s.id) ?? s.defaultKeys;
  r.key.textContent = recording === s ? "Press keys…" : c;
  r.key.classList.toggle("recording", recording === s);
  r.reset.hidden = c === s.defaultKeys;
}

function startRecording(s: Shortcut) {
  const prev = recording;
  recording = s;
  if (prev) paintRow(prev);
  paintRow(s);
  rowRefs.get(s.id)?.key.focus();
}

function stopRecording() {
  const was = recording;
  recording = null;
  if (was) paintRow(was);
}

/** The recorder eats everything while armed: a rejected Ctrl+F must not reach the
 * WebView2 find bar just because we said no to it. Called by shortcuts.ts's keydown
 * listener while `isRecording()` is true. */
export function handleRecordingKey(e: KeyboardEvent) {
  // Typing into a setting row's own field (General) is not a chord: let it reach the field.
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopRecording();
    return;
  }
  const chord = chordOf(e);
  if (!chord) return; // bare modifier — keep waiting
  if (recording) void acceptChord(recording, chord);
}

async function acceptChord(s: Shortcut, chord: string, isReset = false) {
  const r = rowRefs.get(s.id);
  if (!isReset) {
    const why = rejection(chord, s.id);
    if (why) {
      if (r) {
        r.err.textContent = `${chord}: ${why}`;
        r.key.classList.remove("reject");
        void r.key.offsetWidth; // restart the flash animation
        r.key.classList.add("reject");
      }
      return; // stay armed
    }
  }
  recording = null;
  if (r) r.err.textContent = "";
  // `commitChord` sets the new chord into the registry synchronously before its
  // first `await` (registry.ts), so calling it and painting immediately —
  // before awaiting the returned promise — shows the new chord right away,
  // same as the pre-refactor order; the second `paintRow` reflects the
  // rollback `commitChord` already applied if the save failed.
  const pending = commitChord(s, chord);
  paintRow(s);
  const saveErr = await pending;
  paintRow(s);
  if (saveErr && r) r.err.textContent = saveErr;
}

/** `category` preselects a rail entry (the settings menu's destinations); omitted = keep
 *  the session's last pick. */
export function openShortcutsModal(category?: string) {
  selectedCat = resolveCategory(category ?? selectedCat);
  ensureModal();
  search!.value = "";
  prevQuery = "";
  renderRows();
  backdrop!.classList.remove("hidden");
  modal!.classList.remove("hidden");
  modalOpen = true;
  // Focus must leave the terminal, or every keystroke behind the backdrop
  // still lands in the pty.
  closeBtn!.focus();
  restoreScroll();
}

/** Event a setting row's control receives when Escape closes the modal while it has focus:
 *  put the saved value back, so the blur-change that follows the close saves nothing. */
export const REVERT_EVENT = "settings-revert";

/** Escape (shortcuts.ts): revert the focused setting field, then close. Other close paths
 *  (backdrop, ×, inspect) keep blur-to-save. */
export function escapeShortcutsModal() {
  const a = document.activeElement;
  if (a && modal?.contains(a)) a.dispatchEvent(new Event(REVERT_EVENT));
  closeShortcutsModal();
}

export function closeShortcutsModal() {
  if (!modalOpen) return;
  stopRecording();
  rememberScroll();
  stopScrollWatch();
  backdrop!.classList.add("hidden");
  modal!.classList.add("hidden");
  modalOpen = false;
  focusActive();
}
