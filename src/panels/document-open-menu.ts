// Document tab Open ▾ menu: folders with counts on the left, the selected
// folder's files newest first on the right (Runs: backend order, a slug heading per run), New Document in a footer.
// Split out of document.ts (size seam); document.ts re-exports setCatalog and DocEntry.
//
// Keyboard: the search field opens focused; Down enters its first match, or the selected folder
// with no query. Up from the first search result returns to the field. Up/Down otherwise move
// within the focused pane (Up wraps at the top; Down from the last item goes to the footer,
// Up from the footer back to the selected folder). Right from a folder goes to the open file's
// row or the first row; Left from a file goes to the selected folder; Left/Right move between
// the footer buttons. Focusing or clicking a folder selects it; hover never switches.
// Enter is the native button click; Esc clears a query here, then closes via dropdown.ts
// when empty. Tab closes and lets focus move on (dropdown.ts).

import "./document-open-menu.css";
import { getPref, setPref } from "../prefs";
import { prettyName } from "./display-name";
import { iconImg } from "../icon-img";
import { groupIcon, iconSlot } from "./catalog-group-icon";
import { enableReorder } from "./reorder";
import { dropdown, type Dropdown } from "./dropdown";
import { SHELF_KEY, isBottomShelf, splitShelf } from "./document-shelf-split";

/** Open ▾ values for the footer entries (never a real path) */
const NEW_VALUE = "__new__";
/** group: "Inbox" (docs\inbox\, newest 10), "Reviews" (bridge\display\reviews\, newest 10), "Display" (the top-level .svg/.html/.png of bridge\display, newest 10, opened read-only), "Run · <slug>" (one of the newest 5 run folders; the menu merges them into one "Runs" folder, a heading per slug) or "Docs · <top>"; absent for list_documents' raw window of bridge\display, which is not listed here */
// Wire shape of bridge.rs `DisplayEntry`: Rust sends no `name`; setCatalog derives it.
export interface DocEntry { path: string; name?: string; kind: string; mtime_ms: number; group?: string }
type CatalogInput = Omit<DocEntry, "kind">;
type CatalogEntry = CatalogInput & { name: string };

export interface OpenMenuHooks {
  onNew(): void;
  onOpen(path: string): void;
  /** the path of the open document, if any */
  openPath(): string | undefined;
}

let btn: HTMLButtonElement | undefined;
let hooks: OpenMenuHooks | undefined;
/** the #doc-om element while open (dropdown.ts creates it on open, removes it on close) */
let menu: HTMLDivElement | null = null;
let dd: Dropdown | undefined;
let catalog: CatalogEntry[] = [];
let documents: CatalogInput[] = [];
/** raw group label of the folder shown on the right; resolved on each open */
let selectedFolder: string | undefined;

export function mountOpenMenu(button: HTMLButtonElement, h: OpenMenuHooks) {
  btn = button;
  hooks = h;
  dd = dropdown({
    button,
    // the button, not #doc-bar: a wrapped bar would put its edge below the button
    anchor: button,
    build: (m, opening) => {
      menu = m;
      m.id = "doc-om";
      m.setAttribute("role", "menu");
      m.setAttribute("aria-label", "Open Document");
      if (opening) selectedFolder = resolveFolder(folders());
      renderOpenMenu(m);
    },
    onKey: onMenuKeydown,
    enter: (m) => m.querySelector<HTMLInputElement>(".doc-om-search")?.focus(),
  });
  updateButtonLabel();
}

export function setCatalog(entries: CatalogInput[]) {
  documents = entries;
  refreshCatalog();
}

function refreshCatalog() {
  // The IPC snapshot omits name; derive it for either path separator. An entry without a group
  // is list_documents' raw bridge\display window, not listed here; the "Display" group is
  // (document-display-group.test.mjs).
  catalog = documents.filter((e) => e.group !== undefined)
    .map((e) => ({ ...e, name: e.name ?? e.path.split(/[\\/]/).pop() ?? e.path }))
    .filter((e) => !/^review-workspace-.*\.md$/i.test(e.name));
  updateButtonLabel();
  // a late list_documents can land while the menu is open: re-render in place rather than close it
  dd?.rerender();
}

export function closeOpenMenu() {
  dd?.close();
}

/** the open document's raw name and path; unset = none open (label reads "Open") */
let openDoc: { name: string; path: string } | undefined;

/** Called by document.ts when a document opens: the button shows its title, the tooltip its path. */
export function setOpenDocLabel(name: string, path: string) {
  openDoc = { name, path };
  updateButtonLabel();
}

function updateButtonLabel() {
  if (!btn) return;
  // title left (ellipsised), file count right; no chevron, the box reads as the button (2026-10-04)
  const label = document.createElement("span");
  label.className = "doc-open-name";
  label.textContent = openDoc ? prettyName(openDoc.name) : " "; // blank keeps the height, like Display
  btn.title = openDoc?.path ?? "";
  const count = document.createElement("span");
  count.className = "doc-open-count";
  count.textContent = catalog.length ? String(catalog.length) : "";
  btn.replaceChildren(label, count);
}

/* ---- model ---- */

function isReadme(e: CatalogEntry): boolean {
  return e.name.toLowerCase() === "readme.md";
}

interface Folder { key: string; label: string; entries: CatalogEntry[] }

/** Folder key for the newest-runs folder: every "Run · <slug>" group lands here. */
const RUNS_KEY = "Runs";
const RUN_PREFIX = "Run · ";

/** One folder per group in backend order (Inbox, every Run · <slug> merged into "Runs", Docs · <top>…). */
function folders(): Folder[] {
  const order: string[] = [];
  const byKey = new Map<string, CatalogEntry[]>();
  for (const e of catalog) {
    const key = e.group?.startsWith(RUN_PREFIX) ? RUNS_KEY : e.group!;
    let arr = byKey.get(key);
    if (!arr) { arr = []; byKey.set(key, arr); order.push(key); }
    arr.push(e);
  }
  // saved drag order first; unlisted folders keep backend order after the known ones
  const saved = getPref("order.documentFolders") ?? [];
  const rank = (k: string) => {
    let i = saved.indexOf(orderKey(k));
    if (i < 0 && k === RUNS_KEY) i = saved.indexOf("Run"); // alias: the order saved before "Run" became "Runs"
    return i < 0 ? saved.length : i;
  };
  const keys = order
    .map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((x) => x.k);
  return keys.map((key) => ({
    key,
    label: folderLabel(key),
    // newest first, but a README.md always sorts last (2026-10-03); Runs keeps backend order
    // (newest run first, each run pinned then newest)
    entries: key === RUNS_KEY
      ? byKey.get(key)!
      : byKey.get(key)!.slice().sort((a, b) => Number(isReadme(a)) - Number(isReadme(b)) || b.mtime_ms - a.mtime_ms),
  }));
}

/** Key in the saved folder order; the key is already stable ("Runs"), so it passes through. */
function orderKey(key: string): string {
  return key;
}

/** "Docs · falcon-notes" → "Falcon Notes"; "Runs" and "Inbox" pass through. */
function folderLabel(key: string): string {
  if (key.startsWith("Docs · ")) {
    return key.slice("Docs · ".length).split(/[-_\s]+/).filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  }
  return key;
}

/** Run files keep their briefs/, reports/ or reviews/ prefix; Docs files keep their depth-2
 *  subfolder when it is not the top folder itself. */
function fileLabel(folderKey: string, e: CatalogEntry): string {
  const parts = e.path.split(/[\\/]/);
  const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
  const docsTop = folderKey.startsWith("Docs · ") ? folderKey.slice("Docs · ".length) : null;
  const shown = prettyName(e.name);
  if (folderKey === RUNS_KEY && /^(briefs|reports|reviews)$/.test(parent)) return `${parent}/${shown}`;
  if (folderKey === SHELF_KEY && isBottomShelf(e)) return shown; // sits under the divider
  if (docsTop && parent && parent !== docsTop) return `${parent}/${shown}`;
  return shown;
}

/** Mock B's time column: "N min" / "N h" today, "Yesterday", then "MM-DD". */
function menuTime(ms: number, now = new Date()): string {
  const date = new Date(ms);
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const age = Math.round((today - day) / 86_400_000);
  if (age <= 0) {
    const mins = Math.max(0, Math.floor((now.getTime() - ms) / 60_000));
    if (mins < 1) return "Now";
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h`;
  }
  if (age === 1) return "Yesterday";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The pref if that folder still exists, else the folder holding the open file, else the first. */
function resolveFolder(list: Folder[]): string | undefined {
  const saved = getPref("document.folder");
  if (saved && list.some((f) => f.key === saved)) return saved;
  const open = hooks?.openPath();
  if (open) {
    const holder = list.find((f) => f.entries.some((e) => e.path === open));
    if (holder) return holder.key;
  }
  return list[0]?.key;
}

/* ---- DOM ---- */

function pick(run: () => void) {
  btn?.focus();
  closeOpenMenu();
  run();
}

function selectFolder(key: string) {
  if (key === selectedFolder) return;
  selectedFolder = key;
  setPref("document.folder", key);
  const m = menu;
  if (!m) return;
  for (const b of m.querySelectorAll<HTMLElement>(".doc-om-fold")) {
    if (b.dataset.folder === key) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
  const pane = m.querySelector<HTMLElement>(".doc-om-files");
  if (pane) {
    const list = folders();
    renderFiles(pane, list.find((f) => f.key === key), list, m.querySelector<HTMLInputElement>(".doc-om-search")?.value ?? "");
    pane.scrollTop = 0; // a folder selection starts the visible list at its top
  }
}

function renderFiles(pane: HTMLElement, folder: Folder | undefined, list: Folder[], query: string) {
  pane.replaceChildren();
  pane.removeAttribute("aria-label");
  pane.classList.toggle("is-search", !!query);
  if (query) {
    pane.setAttribute("aria-label", "Search Results");
    const needle = query.toLowerCase();
    const matches = list.flatMap((f) => f.entries
      .filter((e) => fileLabel(f.key, e).toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle))
      .map((e) => ({ e, folder: f })));
    matches.sort((a, b) => b.e.mtime_ms - a.e.mtime_ms);
    for (const { e, folder: f } of matches) appendFileRow(pane, f, e, isBottomShelf(e) && f.key === SHELF_KEY ? "Bottom Shelf" : f.label);
    return;
  }
  if (!folder) return;
  // the group names itself; the visible title repeats it and is hidden from the tree
  pane.setAttribute("aria-label", folder.label);
  const addTitle = (text: string) => {
    const title = document.createElement("div");
    title.className = "doc-om-title";
    title.setAttribute("aria-hidden", "true");
    const h = document.createElement("span");
    h.className = "h";
    h.textContent = text;
    title.append(h);
    pane.appendChild(title);
  };
  // Runs shows one heading per run (its slug); every other folder repeats its own name once
  if (folder.key !== RUNS_KEY) addTitle(folder.label);
  let runGroup: string | undefined;
  let entries = folder.entries;
  let ruleAt = -1; // index of the first bottom-shelf row, when a divider goes before it
  if (folder.key === SHELF_KEY) {
    const { top, bottom } = splitShelf(entries);
    entries = [...top, ...bottom];
    if (top.length && bottom.length) ruleAt = top.length;
  }
  for (const [i, e] of entries.entries()) {
    if (i === ruleAt) {
      const rule = document.createElement("div");
      rule.className = "doc-om-rule";
      rule.setAttribute("role", "separator");
      pane.appendChild(rule);
      addTitle("Bottom Shelf");
    }
    if (folder.key === RUNS_KEY && e.group !== runGroup) {
      runGroup = e.group;
      addTitle((e.group ?? "").slice(RUN_PREFIX.length)); // copy-ok: run slug
    }
    appendFileRow(pane, folder, e, menuTime(e.mtime_ms));
  }
}

function appendFileRow(pane: HTMLElement, folder: Folder, e: CatalogEntry, secondary: string) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "doc-om-file";
  row.setAttribute("role", "menuitem");
  row.dataset.value = e.path;
  row.title = e.path;
  if (e.path === hooks?.openPath()) row.setAttribute("aria-current", "true");
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = fileLabel(folder.key, e);
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = secondary;
  row.append(nm, t);
  row.addEventListener("click", () => pick(() => hooks?.onOpen(e.path)));
  pane.appendChild(row);
}

function updateFilePane(m: HTMLDivElement, query: string) {
  const pane = m.querySelector<HTMLElement>(".doc-om-files");
  if (!pane) return;
  const list = folders();
  renderFiles(pane, list.find((f) => f.key === selectedFolder), list, query);
  pane.scrollTop = 0;
}

/** Rebuilds the menu from `catalog`. Safe while open (a late list_documents can land mid-browse):
 *  the search query and caret survive, and focused rows restore by path or folder. */
function renderOpenMenu(m: HTMLDivElement) {
  const active = document.activeElement as HTMLElement | null;
  const hadFocus = !!active && m.contains(active);
  const oldSearch = m.querySelector<HTMLInputElement>(".doc-om-search");
  const query = oldSearch?.value ?? "";
  const searchFocused = hadFocus && active === oldSearch;
  const caret = searchFocused ? oldSearch?.selectionStart : null;
  const selectionEnd = searchFocused ? oldSearch?.selectionEnd : null;
  const selectionDirection = searchFocused ? oldSearch?.selectionDirection : null;
  const focusValue = hadFocus ? active!.dataset.value : undefined;
  const focusFolder = hadFocus ? active!.dataset.folder : undefined;
  // keep both panes' scroll across a catalog re-render (mid-browse)
  const foldersTop = m.querySelector<HTMLElement>(".doc-om-folders")?.scrollTop ?? 0;
  const filesTop = m.querySelector<HTMLElement>(".doc-om-files")?.scrollTop ?? 0;
  const prevFolder = selectedFolder;
  m.replaceChildren();

  const list = folders();
  if (!selectedFolder || !list.some((f) => f.key === selectedFolder)) selectedFolder = resolveFolder(list);

  const search = document.createElement("input");
  search.className = "doc-om-search";
  search.type = "search";
  search.placeholder = "Search Documents";
  search.spellcheck = false;
  search.value = query;
  search.addEventListener("input", () => updateFilePane(m, search.value));
  const searchWrap = document.createElement("div");
  searchWrap.className = "doc-om-search-wrap";
  const searchIcon = iconImg("search");
  searchIcon.classList.add("doc-om-search-icn");
  searchWrap.append(searchIcon, search);

  // ARIA: menu > search, (body: none) > group "Folders" | group <folder label>, then
  // group "Actions"; every button is a menuitem, the visible hints aria-hidden.
  const body = document.createElement("div");
  body.className = "doc-om-body";
  body.setAttribute("role", "none");
  const left = document.createElement("div");
  left.className = "doc-om-folders";
  left.setAttribute("role", "group");
  left.setAttribute("aria-label", "Folders");
  for (const f of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "doc-om-fold";
    b.setAttribute("role", "menuitem");
    b.dataset.folder = f.key;
    b.dataset.key = orderKey(f.key); // reorder.ts
    b.title = f.key;
    if (f.key === selectedFolder) b.setAttribute("aria-current", "true");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = f.label;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(f.entries.length);
    // same group art as the Display picker
    b.append(iconSlot(groupIcon(f.key)), nm, n);
    b.addEventListener("focus", () => selectFolder(f.key));
    b.addEventListener("click", () => selectFolder(f.key));
    left.appendChild(b);
  }
  // a press focuses (and so selects) the folder before the drag threshold: remember what was
  // selected at pointerdown and put it back when the press becomes a drag
  let pressed: string | undefined;
  left.addEventListener("pointerdown", () => { pressed = selectedFolder; }, true);
  enableReorder(left, "order.documentFolders", {
    handle: ".doc-om-fold",
    onStart: () => { if (pressed !== undefined && pressed !== selectedFolder) selectFolder(pressed); },
  });
  const right = document.createElement("div");
  right.className = "doc-om-files";
  right.setAttribute("role", "group");
  renderFiles(right, list.find((f) => f.key === selectedFolder), list, query);
  body.append(left, right);

  const foot = document.createElement("div");
  foot.className = "doc-om-foot";
  foot.setAttribute("role", "group");
  foot.setAttribute("aria-label", "Actions");
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "doc-om-act";
  newBtn.setAttribute("role", "menuitem");
  newBtn.dataset.value = NEW_VALUE;
  newBtn.textContent = "New Document";
  newBtn.addEventListener("click", () => pick(() => hooks?.onNew()));
  foot.append(newBtn);

  m.append(searchWrap, body, foot);
  if (!oldSearch) m.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const field = m.querySelector<HTMLInputElement>(".doc-om-search");
    if (!field?.value) return;
    e.preventDefault();
    e.stopPropagation();
    field.value = "";
    updateFilePane(m, "");
    field.focus();
  }, true);
  left.scrollTop = foldersTop;
  if (selectedFolder === prevFolder) right.scrollTop = filesTop;

  if (searchFocused) {
    search.focus();
    if (caret !== null && caret !== undefined && selectionEnd !== null && selectionEnd !== undefined) {
      search.setSelectionRange(caret, selectionEnd, selectionDirection ?? undefined);
    }
  } else if (hadFocus) {
    let target: HTMLElement | null = null;
    if (focusValue) target = m.querySelector<HTMLElement>(`button[data-value="${CSS.escape(focusValue)}"]`);
    if (!target && focusFolder) target = folderButton(focusFolder);
    (target ?? btn)?.focus();
  }
}

/* ---- keyboard ---- */

function folderButton(key: string | undefined): HTMLElement | null {
  if (!menu || key === undefined) return null;
  return menu.querySelector<HTMLElement>(`.doc-om-fold[data-folder="${CSS.escape(key)}"]`);
}

function paneItems(cls: string): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>(cls)) : [];
}

/** Pane keys (query clearing happens in the menu capture listener; empty Escape and Tab in dropdown.ts). */
function onMenuKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const pane = target.classList.contains("doc-om-search") ? ".doc-om-search"
    : target.classList.contains("doc-om-fold") ? ".doc-om-fold"
    : target.classList.contains("doc-om-file") ? ".doc-om-file"
    : target.classList.contains("doc-om-act") ? ".doc-om-act"
    : null;
  if (!pane) return;
  const items = paneItems(pane);
  const idx = items.indexOf(target);
  const footer = paneItems(".doc-om-act");
  let next: HTMLElement | null | undefined;
  switch (e.key) {
    case "ArrowDown":
      if (pane === ".doc-om-act") return;
      if (pane === ".doc-om-search") next = (target as HTMLInputElement).value
        ? paneItems(".doc-om-file")[0]
        : folderButton(selectedFolder) ?? footer[0];
      else next = idx === items.length - 1 ? footer[0] : items[idx + 1];
      break;
    case "ArrowUp":
      if (pane === ".doc-om-act") next = folderButton(selectedFolder);
      else if (pane === ".doc-om-file" && idx === 0 && menu?.querySelector<HTMLInputElement>(".doc-om-search")?.value) {
        next = menu.querySelector<HTMLElement>(".doc-om-search");
      }
      else if (pane === ".doc-om-search") return;
      else next = items[(idx - 1 + items.length) % items.length];
      break;
    case "ArrowRight":
      if (pane === ".doc-om-fold") {
        const files = paneItems(".doc-om-file");
        next = files.find((f) => f.getAttribute("aria-current") === "true") ?? files[0];
      } else if (pane === ".doc-om-act") next = items[Math.min(idx + 1, items.length - 1)];
      else return;
      break;
    case "ArrowLeft":
      if (pane === ".doc-om-file") next = folderButton(selectedFolder);
      else if (pane === ".doc-om-act") next = items[Math.max(idx - 1, 0)];
      else return;
      break;
    default:
      return;
  }
  e.preventDefault();
  next?.focus();
}
