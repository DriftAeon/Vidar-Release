// The Voice Slots page, the view half (voice slots V6): paints the `voice_slots_status` rows.
// Pure DOM over `root`; no IPC, no clipboard. Every click goes out through `actions`, so the page
// (voice-slots.ts) owns side effects and tests can drive this with stubs.
// Slots sit under two heads, Recommended (Speech To Text) and Optional (the rest), after a Set Up
// Voice row that opens into one section per install. Every row is one fixed-height line: the slot
// glyph, the name (one colour and weight for all; state shows through the icon only), the state
// icon (the state word and reason are its tooltip), one mono pick line, the size, and Copy in a
// fixed last column. The row opens for what its command installs and the command itself. Adapter,
// model, size, source and pin live in the pick line's tooltip.
import type { ColorIcon } from "../icon-img";
import type { LucideName } from "../icons";
import type { VoiceSlot, VoiceSlotSource, VoiceSlotStatus } from "../ipc-voice";
// @ts-ignore TS5097: node --test loads this module directly
import { confirmRow } from "../dom.ts";

export interface SlotViewActions {
  redetect(): void;
  /** Trust Current: arms the confirm step for that slot; nothing is re-pinned yet. */
  askTrust(slot: VoiceSlot): void;
  /** The confirm step's Trust: re-pins the slot. */
  trust(slot: VoiceSlot): void;
  cancelTrust(): void;
  copy(text: string): void;
}

/** Page state beyond the query: which slot is awaiting confirm, which one is re-pinning. */
export interface SlotViewState {
  confirming?: VoiceSlot | null;
  trusting?: VoiceSlot | null;
}

/** Draws a Lucide glyph (src/icons.ts `lucide`) and a colour icon (src/icon-img.ts `iconImg`).
 *  Passed in, not imported: tests load this view under node, which cannot resolve extensionless imports. */
export interface SlotViewIcons {
  icon: (name: LucideName) => Element;
  color: (name: ColorIcon) => Element;
}

const noIcons: SlotViewIcons = {
  icon: () => document.createElement("span"),
  color: () => document.createElement("span"),
};

/** The reason prefix a pin mismatch carries (voice_slots/mod.rs, `Verdict::Changed`). Trust
 *  Current is offered on that row only: every other broken state has nothing to re-pin. */
export const PIN_MISMATCH_PREFIX = "Changed Since Pinned";
/** The recovery hint Rust appends after the path; the confirm step names the path without it. */
export const PIN_MISMATCH_HINT = " - Trust Current In Voice Slots Accepts It";

const SLOT_LABEL: Record<VoiceSlot, string> = {
  stt: "Speech To Text",
  wake: "Wake Word",
  rewrite: "Rewrite",
  tts: "Text To Speech",
};

const SLOT_COLOR_ICON: Record<VoiceSlot, ColorIcon> = {
  stt: "mic",
  wake: "sun-low",
  rewrite: "clipboard-edit",
  tts: "speaker-on",
};

/** The two heads the four slots sit under, in the order each head lists them. */
const SLOT_GROUPS: ReadonlyArray<readonly [string, readonly VoiceSlot[]]> = [
  ["Recommended", ["stt"]],
  ["Optional", ["wake", "tts", "rewrite"]],
];

/** One install `setup-voice.ps1 -Only <id>` runs alone (sizes and sources from its confirm table). */
interface SetupInstall {
  id: "whisper" | "venv" | "kokoro" | "wakeword";
  name: string;
  size: string;
  from: string;
  needs: string;
  context: string;
}

const SETUP_INSTALLS: readonly SetupInstall[] = [
  { id: "whisper", name: "Whisper", size: "59 MB", from: "GitHub, Hugging Face", needs: "Nothing Else",
    context: "Installs the Whisper CLI and the tiny.en Model" },
  { id: "venv", name: "Voice Venv", size: "150 MB", from: "Python Package Index", needs: "Python 3.11 Installed",
    context: "Creates the Venv and Installs Its Python Packages" },
  { id: "kokoro", name: "Kokoro Voice", size: "115 MB", from: "GitHub", needs: "Voice Venv To Run It",
    context: "Installs the Kokoro Model and Voice Files" },
  { id: "wakeword", name: "Wake-Word Models", size: "7 MB", from: "github.com/dscripka/openWakeWord", needs: "Voice Venv To Run It",
    context: "Installs the openWakeWord Models" },
];
const SETUP_FULL_SIZE = "330 MB";
const SETUP_FULL_TIP = "Runs every install above; it lists each download and asks before fetching anything";

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

/** Same element as iconImg("swap"); Voice settings have no trust or pin icon, so the trust confirm borrows Swap Confirm's. */
function shieldIcon(doc: Document): HTMLImageElement {
  const img = copyIcon(doc);
  img.src = "/icons/color/shield.svg";
  return img;
}

const PINNED_LABEL ={ yes: "Yes", "not-yet": "Not Yet", never: "Never" } as const;

function el<K extends keyof HTMLElementTagNameMap>( // home-ok: takes the Document as an argument; node tests pass a fake one
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

function isPinMismatch(r: VoiceSlotStatus): boolean {
  return r.state === "broken" && r.slot !== null && (r.reason ?? "").startsWith(PIN_MISMATCH_PREFIX);
}

/** The changed path Rust names after the prefix (`Changed Since Pinned: <path><hint>`). */
function changedPath(r: VoiceSlotStatus): string {
  const tail = (r.reason ?? "").slice(PIN_MISMATCH_PREFIX.length).replace(/^:\s*/, "");
  return tail.endsWith(PIN_MISMATCH_HINT) ? tail.slice(0, -PIN_MISMATCH_HINT.length) : tail;
}

function stateText(r: VoiceSlotStatus): string {
  switch (r.state) {
    case "filled": return "Filled";
    case "missing": return "Missing";
    case "empty": return "Empty (Optional)";
    default: return "Broken";
  }
}

function sourceText(s: VoiceSlotSource): string {
  if (s.kind === "stock") return "Stock";
  if (s.kind === "pack") return `Pack ${s.pack}`;
  return `Legacy ${s.key}`;
}

function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Splits Rust's `from <pack>, unverified: <line>` (a non-stock fill) into note and command. */
function fillParts(fill: string): { note: string | null; command: string } {
  const m = /^from (.+?), unverified: (.*)$/s.exec(fill);
  const command = (m ? m[2] : fill).replace(/\\/g, "/");
  return { note: m ? `From ${m[1]}, Unverified` : null, command: `! ${command}` };
}

/** One line on what a fill installs, from the script it runs; an unknown (pack) fill gets the generic line. */
function fillContext(command: string, unverified: boolean): string {
  if (unverified) return "Runs a Command From a Pack";
  if (/fetch-whisper\.ps1/.test(command)) return "Installs the Whisper CLI and the Model";
  if (/wakeword-models\.ps1/.test(command)) return "Installs the openWakeWord Models";
  if (/setup-voice\.ps1.* -Only kokoro/.test(command)) return "Installs the Kokoro Model and Voice Files";
  if (/setup-voice\.ps1.* -Only venv/.test(command)) return "Creates the Venv and Installs Its Python Packages";
  if (/setup-voice\.ps1/.test(command)) return "Installs the Voice Stack";
  return "Runs a Setup Command";
}

/** The checkout path the slot fills name (`... -File <root>/tools/voice/...`), so the Set Up Voice
 *  commands carry the real path; `<install>` when no fill names one. */
function installRoot(rows: VoiceSlotStatus[]): string {
  for (const r of rows) {
    const m = r.fill ? /-File\s+(.+?)\/tools\/voice\//.exec(r.fill.replace(/\\/g, "/")) : null;
    if (m) return m[1];
  }
  return "<install>";
}

function setupCommand(root: string, only?: SetupInstall["id"]): string {
  const script = `${root}/tools/voice/setup-voice.ps1`;
  return `! pwsh -File ${script.includes(" ") ? `"${script}"` : script}${only ? ` -Only ${only}` : ""}`;
}

/** Adapter, model, size, licence, source, recommendation, pin and file as `Key: value` lines. */
function factLines(r: VoiceSlotStatus, pack: boolean): string[] {
  const lines: string[] = [];
  const add = (k: string, v: string | null | undefined): void => {
    if (v) lines.push(`${k}: ${v}`);
  };
  add("Adapter", r.adapter ? (r.label ? `${r.label} (${r.adapter})` : r.adapter) : null);
  add("Model", r.model);
  add("Size", r.bytes !== null ? sizeText(r.bytes) : null);
  add("Licence", r.licence);
  add("Source", r.source ? sourceText(r.source) : null);
  add("Recommended", r.recommended ? (r.recommendedModel ? `${r.recommended} · ${r.recommendedModel}` : r.recommended) : null);
  add("Pinned", r.pinned ? PINNED_LABEL[r.pinned] : null);
  if (pack) add("File", r.file);
  return lines;
}

/** The one mono line: the current pick when an adapter resolves, else the recommended one; a
 *  broken pack shows its file. Null when there is nothing to name. */
function pickLine(r: VoiceSlotStatus, pack: boolean): { text: string; kind: string } | null {
  if (pack) {
    const text = r.file ?? r.adapter;
    return text ? { text, kind: "File" } : null;
  }
  if (r.adapter) return { text: r.model ? `${r.adapter} · ${r.model}` : r.adapter, kind: "Current Pick" };
  if (r.recommended) {
    return { text: r.recommendedModel ? `${r.recommended} · ${r.recommendedModel}` : r.recommended, kind: "Recommended" };
  }
  return null;
}

/** A glyph box (deps-mark, settings-modal.css); with a label it is an image whose name is the tooltip. */
function mark(doc: Document, glyph: Element, cls: string, label?: string): HTMLElement {
  const m = el(doc, "span", `deps-mark ${cls}`);
  m.appendChild(glyph);
  if (label) {
    m.setAttribute("role", "img");
    m.setAttribute("aria-label", label);
    m.title = label;
  } else m.setAttribute("aria-hidden", "true");
  return m;
}

/** The state icon: green tick filled, red cross missing or broken, a dimmed cross for an empty
 *  optional slot (it needs nothing). Its tooltip is the state word plus Rust's reason. */
function stateMark(doc: Document, r: VoiceSlotStatus, pack: boolean, icons: SlotViewIcons): HTMLElement {
  let word = stateText(r);
  if (!pack && r.slot && !r.required && r.state !== "empty") word += " (Optional)";
  const tip = r.reason && r.reason !== word ? `${word}: ${r.reason}` : word;
  const name: ColorIcon = r.state === "filled" ? "check-circle" : "dismiss-circle";
  return mark(doc, icons.color(name), r.state === "empty" ? "vs-state is-dim" : "vs-state", tip);
}

function trustControls(
  doc: Document, r: VoiceSlotStatus, slot: VoiceSlot, actions: SlotViewActions, locked: boolean, ui: SlotViewState,
): HTMLElement {
  if (ui.confirming !== slot) {
    const trust = button(doc, "vs-trust", "Trust Current", () => actions.askTrust(slot));
    trust.title = "Re-pin every file this adapter uses as it is now";
    trust.disabled = locked;
    return trust;
  }
  const box = el(doc, "div", "vs-confirm");
  const running = ui.trusting === slot;
  const head = el(doc, "div", "swap-confirm-head");
  const tile = el(doc, "span", "title-tile"); // the gate title bar's icon tile (title-bar.css)
  tile.append(shieldIcon(doc));
  head.append(tile, el(doc, "strong", "", "Trust Current"));
  const body = el(doc, "div", "swap-confirm-body");
  // Not `.ws-btn`: its hover/active colours would override the shared decision pair.
  confirmRow({
    doc,
    root: body,
    note: el(doc, "p", "vs-confirm-text", `Re-Pin ${changedPath(r)} As It Is Now?`),
    yes: { label: running ? "Trusting…" : "Trust", cls: "vs-trust-confirm", run: () => actions.trust(slot), disabled: locked },
    no: { label: "Cancel", cls: "vs-trust-cancel", run: () => actions.cancelTrust(), disabled: running },
  });
  box.append(head, body);
  return box;
}

/** The Copy icon button: it sits in the fixed last column of its line. An unverified (pack) fill's
 *  Copy says so: the copied `!` line runs when pasted, so no part of it may hide. */
function copyButton(doc: Document, command: string, note: string | null, actions: SlotViewActions, tip?: string): HTMLButtonElement {
  const copy = button(doc, "vs-copy icon-btn", "", () => actions.copy(command));
  copy.appendChild(copyIcon(doc));
  copy.setAttribute("aria-label", note ? "Copy (Unverified)" : "Copy");
  copy.setAttribute("data-text", command);
  copy.title = note ? "Copy this unverified command; read all of it first" : (tip ?? `Copy ${command}`);
  return copy;
}

/** The command as a one-line mono chip (the whole command is its tooltip). An unverified (pack)
 *  fill shows whole, wrapped with newlines kept, behind a warning mark. */
function commandLine(doc: Document, command: string, note: string | null, icons: SlotViewIcons): HTMLElement {
  const line = el(doc, "div", note ? "deps-route vs-fill is-unverified" : "deps-route vs-fill");
  if (note) line.appendChild(mark(doc, icons.color("warning"), "vs-unverified", `${note}: read all of it before you run it.`));
  const code = el(doc, "code", "vs-cmd", command);
  code.title = command;
  line.appendChild(code);
  return line;
}

/** Open or closed survives a repaint: each `details` records its toggle here, keyed per root. */
const openState = new WeakMap<HTMLElement, Map<string, boolean>>();

function track(root: HTMLElement, d: HTMLDetailsElement, key: string, fallback: boolean): void {
  let map = openState.get(root);
  if (!map) openState.set(root, (map = new Map()));
  const saved = map;
  d.open = saved.get(key) ?? fallback;
  d.addEventListener("toggle", () => saved.set(key, d.open));
}

/** The summary line every row shares: glyph, name, state slot, pick slot, size slot, Copy slot. */
function summary(doc: Document, parts: { glyph: Element; label: string; state?: Element; pick: Element; size?: string; copy?: Element }): HTMLElement {
  const sum = el(doc, "summary", "vs-sum");
  sum.append(
    parts.glyph,
    el(doc, "span", "vs-label", parts.label),
    parts.state ?? el(doc, "span", "vs-slot"),
    parts.pick,
    el(doc, "span", "vs-size", parts.size ?? ""),
    parts.copy ?? el(doc, "span", "vs-slot vs-copy-gap"),
  );
  return sum;
}

function row(
  root: HTMLElement, key: string, r: VoiceSlotStatus, actions: SlotViewActions, pack: boolean, locked: boolean, ui: SlotViewState,
  icons: SlotViewIcons,
): HTMLElement {
  const doc = root.ownerDocument;
  const item = el(doc, "details", `vs-row is-${r.state}${!pack && r.slot && !r.required ? " is-optional" : ""}`);
  item.setAttribute("data-slot", pack || !r.slot ? "pack" : r.slot);
  item.setAttribute("data-state", r.state);

  const glyph = pack || !r.slot ? icons.icon("file-cog") : icons.color(SLOT_COLOR_ICON[r.slot]);
  const label = pack || !r.slot ? (r.slot ? `Pack (${SLOT_LABEL[r.slot]})` : "Pack") : SLOT_LABEL[r.slot];
  const pick = pickLine(r, pack);
  const facts = factLines(r, pack);
  const { note, command } = r.fill ? fillParts(r.fill) : { note: null, command: "" };

  let pickEl: HTMLElement;
  if (pick) {
    pickEl = el(doc, "code", `deps-where vs-pick is-${pick.kind === "Recommended" ? "recommended" : "current"}`, pick.text);
    pickEl.title = [`${pick.kind}: ${pick.text}`, ...facts].join("\n");
  } else pickEl = el(doc, "span", "vs-pick");
  const sum = summary(doc, {
    glyph: mark(doc, glyph, "vs-glyph"),
    label,
    state: stateMark(doc, r, pack, icons),
    pick: pickEl,
    size: r.bytes !== null ? sizeText(r.bytes) : undefined,
    copy: r.fill ? copyButton(doc, command, note, actions) : undefined,
  });
  if (!pick && facts.length) sum.title = facts.join("\n");
  item.appendChild(sum);

  const slot = r.slot;
  const trust = !pack && slot && isPinMismatch(r);
  if (r.fill || trust) {
    const body = el(doc, "div", "vs-more");
    if (r.fill) {
      body.appendChild(el(doc, "p", "vs-context", fillContext(command, !!note)));
      body.appendChild(commandLine(doc, command, note, icons));
    }
    if (trust && slot) body.appendChild(trustControls(doc, r, slot, actions, locked, ui));
    item.appendChild(body);
    track(root, item, key, !!note || !!trust);
  } else item.classList.add("is-flat");
  return item;
}

/** The Set Up Voice row: Copy in its summary runs the full stack; it opens into one section per
 *  install, each with its own facts and Copy, all in the same columns as the slot rows. */
function setupRow(root: HTMLElement, installRootPath: string, open: boolean, actions: SlotViewActions, icons: SlotViewIcons): HTMLElement {
  const doc = root.ownerDocument;
  const item = el(doc, "details", "vs-row vs-setup");
  item.setAttribute("data-slot", "setup");
  const full = setupCommand(installRootPath);
  item.appendChild(summary(doc, {
    glyph: mark(doc, icons.icon("file-cog"), "vs-glyph"),
    label: "Set Up Voice",
    pick: el(doc, "span", "vs-pick vs-pick-ui", SETUP_INSTALLS.map((i) => i.name).join(", ")),
    size: SETUP_FULL_SIZE,
    copy: copyButton(doc, full, null, actions, `Copy ${full}: ${SETUP_FULL_TIP}`),
  }));
  const more = el(doc, "div", "vs-more vs-installs");
  for (const i of SETUP_INSTALLS) {
    const cmd = setupCommand(installRootPath, i.id);
    const block = el(doc, "section", "vs-install");
    block.setAttribute("data-install", i.id);
    const facts = el(doc, "div", "vs-facts");
    facts.append(el(doc, "span", "vs-fact", `From: ${i.from}`), el(doc, "span", "vs-fact", `Needs: ${i.needs}`));
    block.append(
      el(doc, "span", "vs-install-name", i.name),
      el(doc, "span", "vs-context", i.context),
      el(doc, "span", "vs-size", i.size),
      copyButton(doc, cmd, null, actions),
      facts,
      commandLine(doc, cmd, null, icons),
    );
    more.appendChild(block);
  }
  item.appendChild(more);
  track(root, item, "setup", open);
  return item;
}

/** `rows` null = the first query has not answered; `error` = the last query failed. */
export function renderVoiceSlots(
  root: HTMLElement,
  rows: VoiceSlotStatus[] | null,
  error: string | null,
  busy: boolean,
  actions: SlotViewActions,
  ui: SlotViewState = {},
  icons: SlotViewIcons = noIcons,
): void {
  const doc = root.ownerDocument;
  // A query or a trust in flight locks Re-Detect and every Trust: a query that hashed before the
  // re-pin must not paint over it, and a second click must not start a second rehash.
  const locked = busy || !!ui.trusting;
  root.textContent = "";

  // The first row per slot id is the slot's own; a broken manifest listed under a slot follows
  // the four and goes with the packs.
  const seen = new Set<VoiceSlot>();
  const slots: VoiceSlotStatus[] = [];
  const packs: VoiceSlotStatus[] = [];
  for (const r of rows ?? []) {
    if (r.slot !== null && !seen.has(r.slot)) {
      seen.add(r.slot);
      slots.push(r);
    } else packs.push(r);
  }
  const failing = slots.filter((r) => r.state === "missing" || r.state === "broken").length;
  const state = !rows ? "is-checking" : failing === 0 ? "is-done" : "is-missing";

  // One line: the summary (Dependencies' bar look, its edge taking the page's state), then Re-Detect.
  const bar = el(doc, "div", `deps-bar vs-bar ${state}`);
  const text = !rows ? (error ? "" : "Checking…")
    : failing === 0 ? "All Slots Ready"
    : failing === 1 ? "1 Slot Needs Attention" : `${failing} Slots Need Attention`;
  if (text) {
    const s = el(doc, "div", `deps-summary vs-summary ${state}`);
    s.append(icons.icon(state === "is-checking" ? "circle" : state === "is-done" ? "circle-check" : "circle-alert"), el(doc, "span", "", text));
    bar.appendChild(s);
  }
  bar.appendChild(el(doc, "span", "deps-bar-fill"));
  const redetectTip = busy ? "Checking…" : "Re-Detect";
  const redetect = button(doc, "deps-recheck vs-redetect", "", () => actions.redetect());
  redetect.appendChild(icons.icon("refresh-cw"));
  redetect.title = redetectTip;
  redetect.setAttribute("aria-label", redetectTip);
  redetect.disabled = locked;
  bar.appendChild(redetect);
  root.appendChild(bar);

  if (error) {
    const msg = rows ? `Detection Failed: ${error} (Showing Last Result)` : `Detection Failed: ${error}`;
    root.appendChild(el(doc, "div", "vs-error", msg));
  }
  if (!rows) return;

  // Set Up Voice leads (no head), then the slots under Recommended and Optional, then broken packs.
  const setup = el(doc, "section", "vs-section");
  const setupHolder = el(doc, "div", "vs-rows");
  setupHolder.appendChild(setupRow(root, installRoot(rows), failing > 0, actions, icons));
  setup.appendChild(setupHolder);
  root.appendChild(setup);

  const sections: Array<readonly [string, VoiceSlotStatus[], boolean]> = [
    ...SLOT_GROUPS.map(([title, ids]) => [title, ids.map((id) => slots.find((r) => r.slot === id)).filter((r): r is VoiceSlotStatus => !!r), false] as const),
    ["Broken Packs", packs, true] as const,
  ];
  for (const [title, list, isPacks] of sections) {
    if (!list.length) continue;
    const section = el(doc, "section", "vs-section");
    section.appendChild(el(doc, "h3", "vs-section-title", title));
    const holder = el(doc, "div", "vs-rows");
    list.forEach((r, i) => holder.appendChild(row(root, isPacks ? `pack:${i}` : `slot:${r.slot}`, r, actions, isPacks, locked, ui, icons)));
    section.appendChild(holder);
    root.appendChild(section);
  }
}
