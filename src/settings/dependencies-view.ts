// The Dependencies page, the view half: paints the catalog against the last detect
// report. Pure DOM over `root`; no IPC, no clipboard, no state module. Every click goes out through
// `actions`, so the page (dependencies.ts) owns side effects and tests can drive this with stubs.
// Grouped by state (user pick, 2026-10-21): each problem is a card with its fix inside, everything
// working folds into a two-column Ready list.
import type { DepCatalog, DepEntry, DepReport, DepStatus } from "../deps/types";
import type { ColorIcon } from "../icon-img";
import type { LucideName } from "../icons";
import type { CliUpdate, CliUpdateBusy } from "../startup-updates/core";

/** Draws a shared Lucide glyph (src/icons.ts `lucide`). Passed in, not imported: tests load this
 *  view under node without a resolve hook, and icons.ts is reached through an extensionless import. */
export type DepIcon = (name: LucideName) => Element;

/** Draws a colour icon (src/icon-img.ts `iconImg`); passed in for the same reason as DepIcon. */
export type DepColorIcon = (name: ColorIcon) => Element;

/** No glyph: an empty box keeps the row's icon column when no factory is passed. */
const noIcon: DepIcon = () => document.createElement("span");
const noColorIcon: DepColorIcon = () => document.createElement("span");

/** deps.rs STALE_PATH_DETAIL / STALE_ENV_DETAIL: on disk but not in this process, so a restart
 *  fixes it. Missing by the report, a warning by its mark. */
const STALE_DETAILS: ReadonlySet<string> = new Set(["Installed After Launch: Restart Vidar", "Set After Launch: Restart Vidar"]);

/** The page's worst state, for the summary and its bar: a required miss beats a warning beats done. */
export type DepsState = "is-checking" | "is-done" | "is-warning" | "is-missing";

/** Pure: the summary state from the report, the required-missing count and whether any row warns. */
export function depsState(report: DepReport | null, missing: number, warned: boolean): DepsState {
  if (!report) return "is-checking";
  if (missing > 0) return "is-missing";
  return warned ? "is-warning" : "is-done";
}

/** A found row with a warning, or a missing row a restart would fix: the warning mark. */
function warns(st: DepStatus | undefined): boolean {
  if (!st) return false;
  return st.found ? !!st.warning : !!st.detail && STALE_DETAILS.has(st.detail);
}

/** A module row the page lists as an error: a rejected pack folder or an inactive module. */
export interface ModuleProblem {
  name: string;
  reason: string;
  /** The pack folder, on a rejected pack row only: the Trust Current target. */
  folder?: string;
}

/** The broken reason of a gateway pack edited since its pin (modules/scan.rs `CHANGED`). Trust
 *  Current is offered on that row only: every other broken pack has to be fixed in the pack. */
export const PACK_CHANGED_REASON = "Changed Since Pinned";

/** Pure: a dep's `usedBy` labels, dropping each entry whose module `listed` says the running set
 *  lacks (the page passes modules/registry.ts `moduleListed`; the default keeps every entry). */
export function usedByLabels(d: DepEntry, listed: (module: string) => boolean = () => true): string[] {
  return d.usedBy.flatMap((u) => typeof u === "string" ? [u] : listed(u.module) ? [u.label] : []);
}

export interface DepViewActions {
  recheck(): void;
  setup(): void;
  copy(text: string): void;
  openUrl(url: string): void;
  /** Opens the Voice Slots page, which owns the speech models (STT, wake, rewrite, TTS). */
  openVoiceSlots(): void;
  /** Re-runs the CLI update check on demand (the page owns the running state and the result note). */
  checkUpdates?(): void;
  /** Update or Skip on a CLI card that has a newer release (the startup update card does the work). */
  updateCli?(u: CliUpdate, skip: boolean): void;
  /** Trust Current on a pack row: arms the confirm step for that folder; nothing is re-pinned yet. */
  askTrust?(folder: string): void;
  /** The confirm step's Trust: re-pins the pack (`module_trust_current`). */
  trust?(folder: string): void;
  cancelTrust?(): void;
}

/** Page state beyond the report: which pack is awaiting confirm, which one is re-pinning. */
export interface ModuleTrustState {
  confirming?: string | null;
  trusting?: string | null;
}

/** The Check for Updates button's state: running, and the last result line. */
export interface UpdateCheckState {
  checking?: boolean;
  note?: string;
}

/** What the CLI update check knows (startup-updates/known.ts): the CLIs with a newer release, and
 *  the update running now. A version is shown only for these; the detect report carries none. */
export interface KnownCliUpdates {
  updates?: readonly CliUpdate[];
  busy?: CliUpdateBusy | null;
  error?: string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, cls: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(doc: Document, cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el(doc, "button", `ws-btn ${cls}`, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** Startup offers share this page's rows and buttons inside the existing card look. */
export function renderStartupUpdateRows(
  root: HTMLElement, updates: CliUpdate[], busy: CliUpdateBusy | null, error: string | null,
  actions: { update(u: CliUpdate): void; skip(u: CliUpdate): void; blocked?(u: CliUpdate): string | null },
): void {
  const doc = root.ownerDocument;
  root.textContent = "";
  root.appendChild(el(doc, "div", "swap-confirm-head", "CLI Updates"));
  const body = el(doc, "div", "swap-confirm-body");
  const rows = el(doc, "div", "deps-rows");
  for (const u of updates) {
    const r = el(doc, "div", "deps-row");
    r.dataset.cli = u.id;
    const content = el(doc, "div", "deps-body");
    const head = el(doc, "div", "deps-head");
    head.appendChild(el(doc, "span", "deps-label", u.label));
    const controls = el(doc, "div", "deps-route");
    const update = button(doc, "deps-update", busy?.id === u.id && busy.label === "Updating…" ? busy.label : "Update", () => actions.update(u));
    const skip = button(doc, "deps-skip", busy?.id === u.id && busy.label === "Saving…" ? busy.label : "Skip", () => actions.skip(u));
    update.disabled = skip.disabled = busy !== null;
    // A CLI with an open tab: updating would replace the binary under it, so Update waits.
    const blocked = actions.blocked?.(u) ?? null;
    if (blocked) update.disabled = true;
    controls.append(update, skip);
    content.append(head, el(doc, "code", "deps-where", `${u.installed} → ${u.latest}`), controls);
    if (blocked) content.appendChild(el(doc, "div", "deps-note", blocked));
    r.appendChild(content);
    rows.appendChild(r);
  }
  body.appendChild(rows);
  if (error) body.appendChild(el(doc, "div", "deps-error", error));
  root.appendChild(body);
}

/** Same element as iconImg("copy") (src/icon-img.ts); inlined because tests load this view under node, which cannot resolve extensionless imports. */
function copyIcon(doc: Document): HTMLImageElement {
  const img = doc.createElement("img");
  img.className = "icn";
  img.src = "/icons/color/copy.png";
  img.alt = "";
  img.draggable = false;
  img.setAttribute("aria-hidden", "true");
  return img;
}

/** Trust Current and its two-step confirm, from voice-slots-view.ts trustControls: the same
 *  classes, so the shared decision pair. The module's card is already the `.vs-confirm` box, so the
 *  confirm is its question row, not a second box. */
function trustControls(doc: Document, folder: string, actions: DepViewActions, ui: ModuleTrustState, color: DepColorIcon): HTMLElement {
  const locked = !!ui.trusting;
  if (ui.confirming !== folder) {
    const trust = iconButton(doc, "vs-trust deps-trust", color("shield"), "Trust current: re-pin this pack as it is now", () => actions.askTrust?.(folder));
    trust.disabled = locked;
    return trust;
  }
  const running = ui.trusting === folder;
  // Not `.ws-btn`: its hover/active colours would override the shared decision pair.
  const plain = (cls: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = el(doc, "button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };
  const yes = plain("swap-yes vs-trust-confirm", running ? "Trusting…" : "Trust", () => actions.trust?.(folder));
  const no = plain("swap-no vs-trust-cancel", "Cancel", () => actions.cancelTrust?.());
  yes.disabled = locked;
  no.disabled = running;
  const btns = el(doc, "div", "swap-confirm-actions");
  btns.append(yes, no);
  const ask = el(doc, "div", "deps-ask");
  ask.append(el(doc, "p", "vs-confirm-text", `Re-Pin Pack ${folder} As It Is Now?`), btns);
  return ask;
}

/** Icon-only page-head button: the icon alone, the tooltip as its title and accessible name. */
function iconButton(doc: Document, cls: string, glyph: Element, tip: string, onClick: () => void): HTMLButtonElement {
  const b = button(doc, cls, "", onClick);
  b.title = tip;
  b.setAttribute("aria-label", tip);
  b.appendChild(glyph);
  return b;
}

/** Icon-only Recheck: Lucide refresh-cw in currentColor, the name in title/aria-label. */
function refreshButton(doc: Document, icon: DepIcon, onClick: () => void): HTMLButtonElement {
  return iconButton(doc, "deps-recheck", icon("refresh-cw"), "Recheck", onClick);
}

/** A glyph box for a mark that is not a colour icon (Voice Slots' mic, the update arrow). */
function mark(doc: Document, icon: DepIcon, name: LucideName, label?: string): HTMLElement {
  const m = el(doc, "span", "deps-mark");
  m.appendChild(icon(name));
  if (label) {
    m.setAttribute("role", "img");
    m.setAttribute("aria-label", label);
    m.title = label;
  } else m.setAttribute("aria-hidden", "true");
  return m;
}

/** A row's state icon in its own box; the state's name is its tooltip and aria-label. Dim marks a
 *  state that needs nothing (optional miss, unknown): compact rows show that by dimming. */
function stateMark(doc: Document, color: DepColorIcon, name: ColorIcon, label: string, dim = false): HTMLElement {
  const m = el(doc, "span", dim ? "deps-mark is-dim" : "deps-mark");
  m.appendChild(color(name));
  m.setAttribute("role", "img");
  m.setAttribute("aria-label", label);
  m.title = label;
  return m;
}

/** The page's state at a glance: one icon and a short line, or nothing while only an error shows.
 *  The root folder (where this copy reads and writes) is its tooltip. */
function summary(doc: Document, icon: DepIcon, state: DepsState, error: string | null, missing: number, root: string | null): HTMLElement | null {
  if (state === "is-checking" && error) return null;
  const [name, text]: [LucideName, string] = state === "is-checking" ? ["circle", "Checking…"]
    : state === "is-missing" ? ["circle-alert", `${missing} Required Missing`]
    : state === "is-warning" ? ["circle-alert", "All Required Found"]
    : ["circle-check", "All Required Found"];
  const s = el(doc, "div", `deps-summary ${state}`);
  s.append(icon(name), el(doc, "span", "deps-summary-text", text));
  if (root) s.title = root;
  return s;
}

/** One copy button carrying its text in `data-text`. */
function copyButton(doc: Document, text: string, actions: DepViewActions): HTMLButtonElement {
  const copy = button(doc, "deps-copy icon-btn", "", () => actions.copy(text));
  copy.appendChild(copyIcon(doc));
  copy.setAttribute("aria-label", "Copy");
  copy.setAttribute("data-text", text);
  copy.title = `Copy ${text}`;
  return copy;
}

/** One install route: the text shown, then a Copy button carrying it in `data-text`. */
function copyLine(doc: Document, text: string, actions: DepViewActions): HTMLElement {
  const line = el(doc, "div", "deps-route");
  line.append(el(doc, "code", "deps-cmd", text), copyButton(doc, text, actions));
  return line;
}

/** The install commands of a dep, in the order the page offers them. */
function installCommands(d: DepEntry): string[] {
  const { winget, command } = d.install;
  return [...(winget ? [`winget install --id ${winget} -e`] : []), ...(command ? [command] : [])];
}

/** The tooltip: who uses it, and where it was found. */
function tipOf(d: DepEntry, st: DepStatus | undefined): string {
  const tip = [`Used by ${usedByLabels(d).join(", ")}`];
  if (st?.found && st.location) tip.push(st.location);
  return tip.join("\n");
}

/** A confirm-style card: the title-tile head (state mark + name), then a body holding the fix. */
function card(doc: Document, cls: string, tile: Element, title: string): { box: HTMLElement; body: HTMLElement } {
  const box = el(doc, "div", `deps-row deps-card vs-confirm ${cls}`);
  const head = el(doc, "div", "swap-confirm-head");
  const t = el(doc, "span", "title-tile"); // the gate title bar's icon tile (title-bar.css)
  t.append(tile);
  head.append(t, el(doc, "strong", "deps-card-title", title));
  const body = el(doc, "div", "swap-confirm-body");
  box.append(head, body);
  return { box, body };
}

/** Needs You: a problem card with its fix inside. Required miss, warning, restart-fixable miss or
 *  a newer release (`upd`). */
function problemCard(
  doc: Document, d: DepEntry, st: DepStatus, upd: CliUpdate | undefined, known: KnownCliUpdates,
  actions: DepViewActions, icon: DepIcon, color: DepColorIcon,
): HTMLElement {
  const missing = st.found === false;
  const warning = st.found === true && st.warning ? st.warning : null;
  const cls: string[] = [];
  if (missing) cls.push("is-missing");
  else if (warning) cls.push("is-warning");
  else cls.push("is-update");
  if (!d.required) cls.push("is-optional");

  const tile = warning ? stateMark(doc, color, "warning", "Warning")
    : missing ? (warns(st) ? stateMark(doc, color, "warning", st.detail ?? "Warning") : stateMark(doc, color, "dismiss-circle", "Missing"))
    : mark(doc, icon, "circle-arrow-up", "Update Available");
  const { box, body } = card(doc, cls.join(" "), tile, d.label);
  box.setAttribute("data-id", d.id);
  box.title = tipOf(d, st);

  // Visible only when it says more than the mark: the warning, why a row counts as missing, the versions.
  const where = warning ?? (missing ? st.detail : undefined) ?? (upd ? `${upd.installed} → ${upd.latest}` : undefined);
  if (where) {
    const w = el(doc, "div", "deps-where", where);
    w.title = where;
    body.appendChild(w);
  }

  if (missing) {
    const routes = el(doc, "div", "deps-routes");
    for (const text of installCommands(d)) routes.appendChild(copyLine(doc, text, actions));
    const { url, note } = d.install;
    const acts = el(doc, "div", "deps-acts");
    if (url) {
      const open = iconButton(doc, "deps-open deps-site", icon("square-arrow-out-up-right"), `Open site: ${url}`, () => actions.openUrl(url));
      open.setAttribute("data-url", url);
      acts.appendChild(open);
    }
    if (note) routes.appendChild(el(doc, "div", "deps-note", note));
    if (routes.childElementCount) body.appendChild(routes);
    if (acts.childElementCount) body.appendChild(acts);
  } else if (warning && d.install.login) {
    const routes = el(doc, "div", "deps-routes");
    routes.append(copyLine(doc, d.install.login, actions), el(doc, "div", "deps-note", "Run it in a terminal, then Recheck."));
    body.appendChild(routes);
  } else if (upd) {
    const busy = known.busy ?? null;
    const acts = el(doc, "div", "deps-acts");
    const update = button(doc, "deps-update", busy?.id === upd.id && busy.label === "Updating…" ? busy.label : "Update", () => actions.updateCli?.(upd, false));
    const skip = button(doc, "deps-skip", busy?.id === upd.id && busy.label === "Saving…" ? busy.label : "Skip", () => actions.updateCli?.(upd, true));
    update.disabled = skip.disabled = busy !== null || !actions.updateCli;
    acts.append(update, skip);
    body.appendChild(acts);
  }
  return box;
}

/** Ready: one compact item. A found row is a tick and a name; an optional miss that is fine stays
 *  dimmed (MCP rack rule: no badge) with its install copy buttons. A row with no report is unknown. */
function readyItem(doc: Document, d: DepEntry, st: DepStatus | undefined, actions: DepViewActions, icon: DepIcon, color: DepColorIcon): HTMLElement {
  const missing = st?.found === false;
  const cls = ["deps-row", "deps-item"];
  if (missing) cls.push("is-missing");
  if (!d.required) cls.push("is-optional");
  const r = el(doc, "div", cls.join(" "));
  r.setAttribute("data-id", d.id);
  const glyph: [ColorIcon, string, boolean] = !st ? ["question-circle", "Unknown", true]
    : st.found ? ["check-circle", "Found", false]
    : ["dismiss-circle", "Not Installed", true];
  r.append(stateMark(doc, color, ...glyph), el(doc, "span", "deps-label", d.label));
  const tip = [tipOf(d, st)];
  if (missing) {
    for (const text of installCommands(d)) r.appendChild(copyButton(doc, text, actions));
    const { url, note } = d.install;
    if (url) {
      const open = iconButton(doc, "deps-open deps-site", icon("square-arrow-out-up-right"), `Open site: ${url}`, () => actions.openUrl(url));
      open.setAttribute("data-url", url);
      r.appendChild(open);
    }
    if (note) tip.push(note);
  }
  r.title = tip.join("\n");
  return r;
}

/** A module the page lists as an error: a rejected pack folder or an inactive module. */
function moduleCard(doc: Document, m: ModuleProblem, actions: DepViewActions, trust: ModuleTrustState, color: DepColorIcon): HTMLElement {
  const { box, body } = card(doc, "is-missing", stateMark(doc, color, "dismiss-circle", "Broken"), m.name);
  box.setAttribute("data-module", m.name);
  const where = el(doc, "div", "deps-where", m.reason);
  where.title = m.reason;
  body.appendChild(where);
  if (m.folder && m.reason === PACK_CHANGED_REASON && actions.askTrust) body.appendChild(trustControls(doc, m.folder, actions, trust, color));
  return box;
}

export function renderDependencies(
  root: HTMLElement,
  catalog: DepCatalog,
  report: DepReport | null,
  error: string | null,
  setupBlocker: string | null,
  actions: DepViewActions,
  modules: readonly ModuleProblem[] = [],
  trust: ModuleTrustState = {},
  icon: DepIcon = noIcon,
  color: DepColorIcon = noColorIcon,
  updateCheck: UpdateCheckState = {},
  known: KnownCliUpdates = {},
): void {
  const doc = root.ownerDocument;
  root.textContent = "";
  const byId = new Map((report?.deps ?? []).map((s) => [s.id, s] as const));
  const updateOf = new Map((known.updates ?? []).map((u) => [u.id, u] as const));
  // Same rule as state.ts missingRequired(): required and not found (absent counts).
  const missingRequired = report ? catalog.deps.filter((d) => d.required && byId.get(d.id)?.found !== true).length : 0;
  const warned = catalog.deps.some((d) => warns(byId.get(d.id)));
  const pageState = depsState(report, missingRequired, warned);

  // Top bar: the state at a glance (the resolved root is its tooltip), then Setup, Check for Updates
  // and Recheck. The bar carries the summary's state too, so its edge takes the state colour.
  const bar = el(doc, "div", `deps-bar ${pageState}`);
  const state = summary(doc, icon, pageState, error, missingRequired, report?.root ?? null);
  if (state) bar.appendChild(state);
  bar.appendChild(el(doc, "div", "deps-bar-fill"));
  // Setup installs what is required; with nothing required missing there is no Setup and no
  // blocker line, whatever optional rows are missing (each keeps its own install line).
  const needsSetup = report === null || missingRequired > 0;
  if (needsSetup) {
    const setup = iconButton(doc, "deps-setup", color("agent"), "Setup via Agent", () => actions.setup());
    setup.disabled = setupBlocker !== null;
    if (setupBlocker !== null) setup.title = setupBlocker;
    bar.appendChild(setup);
  }
  if (actions.checkUpdates) {
    const checking = updateCheck.checking === true;
    const check = iconButton(doc, "deps-check-updates", icon("circle-arrow-up"), checking ? "Checking…" : "Check for Updates", () => actions.checkUpdates?.());
    check.disabled = checking;
    bar.appendChild(check);
  }
  bar.appendChild(refreshButton(doc, icon, () => actions.recheck()));
  root.appendChild(bar);

  // Before a report the summary already says Checking…; the blocker line would repeat it.
  if (report && needsSetup && setupBlocker !== null) root.appendChild(el(doc, "div", "deps-blocker", setupBlocker));
  if (updateCheck.note) root.appendChild(el(doc, "div", "deps-note", updateCheck.note));
  if (known.error) root.appendChild(el(doc, "div", "deps-error", known.error));
  if (error) {
    const text = report ? `Detection Failed: ${error} (Showing Last Result)` : `Detection Failed: ${error}`;
    root.appendChild(el(doc, "div", "deps-error", text));
  }

  // Split by state, catalog order kept inside each group. Needs You: required miss, warning or
  // restart-fixable miss, then a newer release. Everything else (found, optional miss, unknown) is Ready.
  const needs: { rank: number; d: DepEntry; st: DepStatus; upd?: CliUpdate }[] = [];
  const ready: DepEntry[] = [];
  for (const d of catalog.deps) {
    const st = byId.get(d.id);
    if (!st) { ready.push(d); continue; }
    if (st.found === false) {
      if (d.required || warns(st)) needs.push({ rank: warns(st) && !d.required ? 1 : 0, d, st });
      else ready.push(d);
    } else if (st.warning) needs.push({ rank: 1, d, st });
    else if (updateOf.has(d.id)) needs.push({ rank: 2, d, st, upd: updateOf.get(d.id) });
    else ready.push(d);
  }
  needs.sort((a, b) => a.rank - b.rank); // stable: catalog order inside a rank

  if (needs.length || modules.length) {
    const section = el(doc, "section", "deps-section deps-needs");
    section.appendChild(el(doc, "h3", "deps-section-title", "Needs You"));
    const list = el(doc, "div", "deps-cards");
    for (const n of needs) list.appendChild(problemCard(doc, n.d, n.st, n.upd, known, actions, icon, color));
    // Modules that failed validation or went inactive: the missing card's style, no install routes.
    for (const m of modules) list.appendChild(moduleCard(doc, m, actions, trust, color));
    section.appendChild(list);
    root.appendChild(section);
  }

  // Speech models are voice slots, not catalog entries (no probe kind fits a slot), so the page
  // links out instead of listing them. The venv stays a catalog entry: it is shared runtime.
  const section = el(doc, "section", "deps-section deps-ready");
  section.appendChild(el(doc, "h3", "deps-section-title", "Ready"));
  const list = el(doc, "div", "deps-ready-list");
  for (const d of ready) list.appendChild(readyItem(doc, d, byId.get(d.id), actions, icon, color));
  const voice = el(doc, "div", "deps-row deps-item deps-link");
  // data-link, not data-id: data-id marks catalog rows (tests and the setup flow count them).
  voice.setAttribute("data-link", "voice-slots");
  voice.title = "Used by Dictation, Wake Word, Speak Rewrite and Speak";
  voice.append(
    mark(doc, icon, "mic"),
    el(doc, "span", "deps-label", "Voice Slots"),
    iconButton(doc, "deps-open deps-open-voice-slots deps-site", icon("square-arrow-out-up-right"), "Open Voice Slots", () => actions.openVoiceSlots()),
  );
  list.appendChild(voice);
  section.appendChild(list);
  root.appendChild(section);
}
