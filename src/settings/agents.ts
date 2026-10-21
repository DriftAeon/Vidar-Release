// Settings › Agents: the built-in rows with an On/Off toggle and, on Rendered rows, a Model field; then
// "Your Agents", the custom rows vidar.json appends. Macros sit on the same page (macros.ts).
//
// The edit logic is agents-edit.ts (pure, tested); this file only reads and draws. Every save
// re-reads vidar.json, recomputes the hits with attributeOverlay and applies ONE operation to
// that fresh overlay (the operations throw on a stale hits array), so a hand edit made while the
// page was open is never overwritten with the page's copy. A custom row is addressed by the
// overlay index that appended it plus a snapshot of that entry; if the entry moved or changed
// on disk the save is refused instead of guessed. A refusal (patch_settings or the checks here)
// shows as "Not Saved: …" on the row and survives a modal close (general.ts pattern).

import { invoke } from "../ipc";
import { getPref } from "../prefs";
import { plainRowsControl, plainRowsOn } from "./plain-rows";
import { registerGuardsRow } from "./bare-guards-row";
import { invalidateConfig, loadConfig, onConfigReloaded, onSettingsChanged, type AgentType, type VidarConfig } from "../config";
import { attributeOverlay, migrateOverlay, overlayAgents, type OverlayHit } from "../config-agents";
import { builtinAgents, PLAIN_KEYS, setPlainRowsSource } from "../launcher/roster";
import { buildTypeMenu } from "../launcher/menu";
import { gatewayModuleRows, moduleOn, modulesOf, onModulesChange } from "../modules/registry";
import { offModuleKeys } from "../launcher/roster-shown";
import { effectivePrimary, primaryChoices, setPrimarySources } from "../agents/primary";
import { folderName, pickFolder } from "../launcher/workspaces";
import {
  addCustom, removeCustom, setEffort, setEnabled, setModel, toWire, updateCustom,
  type CustomFields, type OverlayEntry,
} from "./agents-edit";
import { codexEffortLevels, codexModelSelect, effortSelect, modelSelect, primarySelect } from "./agent-selects";
import { registerMacroRows } from "./macros";
import { saveRefusal } from "./save-refusal";
import { isShortcutsModalOpen, REVERT_EVENT } from "./modal";
import { drawLauncherOrder, initLauncherOrder } from "./launcher-order";
import { focusOnNextDraw, isRedrawing, liveList, refreshLive, type Live } from "./live-list";
import { addSettingRow, registerCategory } from "./registry";

const AGENTS_CATEGORY = "agents";

// The Type select of a custom row: tab kind by `id` (roster.ts agentKind). A row whose id is not
// one of these (gateway module ids resolve to `claude` but are not editable here) is shown read-only, so a first edit can never silently rewrite its id.
const TYPES: [string, string][] = [
  ["claude", "Claude"], ["codex", "Codex"], ["gemini", "Gemini"], ["pi", "Pi"], ["shell", "Terminal"],
];
const TYPE_IDS = new Set(TYPES.map(([id]) => id));
// Fields a representable custom row may carry; anything else set makes it read-only.
const CUSTOM_FIELDS = new Set(["id", "label", "args", "cwd", "key"]);
// Fields that do not count as "Edited In vidar.json" on a built-in hit.
const NOT_AN_EDIT = new Set(["id", "under", "key", "model", "effort", "disabled"]);

const STALE = "vidar.json Changed While This Page Was Open; Check The Row And Try Again";

// ---------------------------------------------------------------------------------------------
// Reading

interface Snapshot {
  overlay: OverlayEntry[];
  /** `overlay` as the roster reads it (retired plain-row entries moved onto their Bare successor). */
  effective: OverlayEntry[];
  hits: OverlayHit[];
  rows: AgentType[];
  error: string | null;
}

/** vidar.json as it is on disk now: the memo is dropped first, so this is never the page's copy. */
async function readFresh(): Promise<Snapshot> {
  invalidateConfig();
  const res = await loadConfig();
  const overlay = (res.config.agents ?? []) as OverlayEntry[];
  return {
    overlay,
    effective: migrateOverlay(overlay) as OverlayEntry[],
    hits: attributeOverlay(builtinAgents(), overlay),
    rows: overlayAgents(builtinAgents(), overlay),
    error: res.error,
  };
}

// Same rule as config-agents.ts given(): read_config's nulls and `id:""` are absent.
function given(e: OverlayEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (v === null || v === undefined) continue;
    if (k === "id" && v === "") continue;
    out[k] = v;
  }
  return out;
}

function labelOf(a: AgentType): string {
  return a.label ?? a.id;
}

interface BuiltinView {
  key: string;
  builtin: AgentType;
  merged: AgentType;
  off: boolean;
  /** Label of the root whose Off took this variant with it; null when not cascaded. */
  offWith: string | null;
  edited: boolean;
}

/** Built-in rows whose agent module is off (not shipped, dependency missing): the page lists none of
 *  them, as the + menu does not. Claude, Codex and the gateway modules are the agent modules. */
function offKeys(): Set<string> {
  const ids = new Set(["claude", "codex", ...gatewayModuleRows().map((m) => m.id)]);
  return offModuleKeys(builtinAgents(), ids, moduleOn);
}

function builtinViews(s: Snapshot): BuiltinView[] {
  const selfOff = new Set<string>();
  s.hits.forEach((h, i) => {
    if (h !== null && !h.startsWith("#") && s.effective[i].disabled === true) selfOff.add(h);
  });
  const views: BuiltinView[] = [];
  const hidden = offKeys();
  for (const b of builtinAgents()) {
    // the plain rows have no On/Off of their own: the Plain Rows switch governs them
    if (!b.key || hidden.has(b.key) || PLAIN_KEYS.has(b.key)) continue;
    const key = b.key;
    let merged: AgentType = { ...b };
    let edited = false;
    s.hits.forEach((h, i) => {
      if (h !== key) return;
      const g = given(s.effective[i]);
      delete g.disabled;
      merged = { ...merged, ...g } as AgentType;
      for (const [k, v] of Object.entries(g)) {
        if (NOT_AN_EDIT.has(k)) continue;
        if (JSON.stringify(v) !== JSON.stringify((b as unknown as Record<string, unknown>)[k])) edited = true;
      }
    });
    views.push({ key, builtin: b, merged, off: selfOff.has(key), offWith: null, edited });
  }
  // Cascade, read from the resolved rows: a variant that is not off itself but is gone from the
  // launcher went with its root (a custom root with the same id would have kept it).
  for (const v of views) {
    if (v.off || !v.builtin.under || s.rows.some((r) => r.key === v.key)) continue;
    const root = views.find((r) => !r.builtin.under && r.builtin.id === v.builtin.under && r.off);
    v.offWith = root ? labelOf(root.merged) : v.builtin.under;
  }
  return views;
}

interface CustomView {
  /** Overlay index of the entry that appended the row (its hit is `#j`). */
  j: number;
  /** That entry as read, to find it again (or refuse) at save time. */
  sig: string;
  merged: AgentType;
  off: boolean;
  offWith: string | null;
  editable: boolean;
  command: string;
}

function commandOf(args: unknown): string | null {
  if (args === undefined || (Array.isArray(args) && args.length === 0)) return "";
  if (Array.isArray(args) && args.length === 3 && args[0] === "-NoExit" && args[1] === "-Command"
    && typeof args[2] === "string") return args[2];
  return null;
}

function customViews(s: Snapshot, builtins: BuiltinView[]): CustomView[] {
  const views: CustomView[] = [];
  s.hits.forEach((h, j) => {
    if (h !== `#${j}`) return;
    let merged: AgentType = { id: s.overlay[j].id ?? "" };
    let off = false;
    let plain = true;
    s.hits.forEach((h2, i) => {
      if (h2 !== h) return;
      const g = given(s.overlay[i]);
      if (g.disabled === true) off = true;
      delete g.disabled;
      for (const k of Object.keys(g)) if (!CUSTOM_FIELDS.has(k)) plain = false;
      merged = { ...merged, ...g } as AgentType;
    });
    const command = commandOf(merged.args);
    views.push({
      j, sig: JSON.stringify(s.overlay[j]), merged, off, offWith: null,
      editable: plain && !off && command !== null && TYPE_IDS.has(merged.id),
      command: command ?? "",
    });
  });
  // Roots that went Off this pass: built-in roots switched off, custom roots disabled.
  const removed = new Map<string, string>();
  for (const b of builtins) if (b.off && !b.builtin.under) removed.set(b.builtin.id, labelOf(b.merged));
  for (const c of views) if (c.off && !c.merged.under) removed.set(c.merged.id, labelOf(c.merged));
  for (const c of views) {
    const under = c.merged.under;
    if (c.off || !under || !removed.has(under)) continue;
    if (s.rows.some((r) => !r.under && r.id === under)) continue;
    c.offWith = removed.get(under) ?? under;
  }
  return views;
}

/** The overlay index of a custom row's appending entry in a fresh read, or null when it moved or
 *  changed on disk (the save is then refused). */
function locate(s: Snapshot, j: number, sig: string): number | null {
  const at = (k: number) => s.hits[k] === `#${k}` && JSON.stringify(s.overlay[k]) === sig;
  if (j < s.overlay.length && at(j)) return j;
  for (let k = 0; k < s.overlay.length; k++) if (at(k)) return k;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Saving

type Area = "builtin" | "custom";
type SetError = (msg: string) => void;

// A refusal that lands after the modal closed is kept and shown when the row is next built.
const pendingErrors = new Map<Area, string>();

// Live page renderers; a save or a settings-changed for `agents` redraws both lists (a root's Off
// changes the custom rows under it). Detached ones are dropped on the next pass.
const live: Live = new Set();
const refreshAll = () => refreshLive(live);

/** Re-read, apply one operation to the fresh overlay, write. Returns the refusal, or null. */
async function saveAgents(op: (s: Snapshot) => OverlayEntry[] | string): Promise<string | null> {
  const s = await readFresh();
  // A file with errors reads without its bad keys/entries; writing that would drop them.
  if (s.error) return saveRefusal(s.error);
  let next: OverlayEntry[];
  try {
    const r = op(s);
    if (typeof r === "string") return r;
    next = r;
  } catch (e) {
    return String(e);
  }
  try {
    await invoke("patch_settings", { key: "agents", value: toWire(next) });
    return null;
  } catch (e) {
    return String(e);
  }
}

async function run(area: Area, setError: SetError, op: (s: Snapshot) => OverlayEntry[] | string): Promise<boolean> {
  const err = await saveAgents(op);
  if (err === null) {
    setError("");
  } else {
    setError(`Not Saved: ${err}`);
    if (!isShortcutsModalOpen()) {
      pendingErrors.set(area, `Not Saved: ${err}`);
      console.warn(`settings: agents not saved: ${err}`);
    }
  }
  refreshAll();
  return err === null;
}

/** Custom-row operation by the row's snapshot: refused when the entry moved or changed. */
function onCustom(
  view: CustomView,
  apply: (s: Snapshot, k: number) => OverlayEntry[],
): (s: Snapshot) => OverlayEntry[] | string {
  return (s) => {
    const k = locate(s, view.j, view.sig);
    return k === null ? STALE : apply(s, k);
  };
}

function argsFor(command: string): string[] | undefined {
  const c = command.trim();
  return c === "" ? undefined : ["-NoExit", "-Command", c];
}

// ---------------------------------------------------------------------------------------------
// Drawing

function button(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ws-btn ${cls}`.trim();
  b.textContent = label;
  return b;
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

/** A text field that commits on change (blur or Enter) and reverts on Escape / the modal's
 *  REVERT_EVENT, like General's rows. `commit` gets the trimmed value; returning false reverts. */
function field(
  cls: string,
  value: string,
  placeholder: string,
  commit: (v: string) => boolean | void,
  onInput?: (v: string) => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = `sc-input ${cls}`.trim();
  input.spellcheck = false;
  input.value = value;
  input.defaultValue = value;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  const revert = () => { input.value = value; };
  input.addEventListener("change", () => {
    if (isRedrawing()) return;
    const v = input.value.trim();
    if (v === value) return;
    if (commit(v) === false) revert();
  });
  if (onInput) input.addEventListener("input", () => onInput(input.value));
  input.addEventListener(REVERT_EVENT, revert);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") revert();
    e.stopPropagation(); // typing is not a shortcut (general.ts)
  });
  return input;
}

function typeSelect(value: string, onPick: (id: string) => void): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "sc-select";
  sel.setAttribute("aria-label", "Type");
  for (const [id, label] of TYPES) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = TYPE_IDS.has(value) ? value : "shell";
  // Never a blank Type: the select only ever holds one of TYPES.
  sel.addEventListener("change", () => { if (TYPE_IDS.has(sel.value)) onPick(sel.value); });
  return sel;
}

function folderButton(cwd: string | undefined, onPick: (cwd: string) => void, setError: SetError): HTMLButtonElement {
  const b = button(cwd ? folderName(cwd) : "Choose Folder", "ag-folder");
  b.title = cwd ? `Opens In ${cwd}` : "Opens In The Launcher's Folder";
  b.addEventListener("click", () => {
    void pickFolder(cwd).then((picked) => {
      if (picked && picked !== cwd) onPick(picked);
    }, (e) => setError(String(e)));
  });
  return b;
}

function takePending(area: Area, setError: SetError): void {
  const p = pendingErrors.get(area);
  if (p) {
    pendingErrors.delete(area);
    setError(p);
  }
}

/** A list control that redraws from a fresh read on open, after each save and on settings-changed. */
const list = (draw: (root: HTMLElement, s: Snapshot) => void): HTMLElement => liveList(live, readFresh, draw);

function builtinsControl(setError: SetError): HTMLElement {
  takePending("builtin", setError);
  return list((root, s) => {
    const views = builtinViews(s);
    for (const v of views) {
      const row = document.createElement("div");
      row.className = "ag-row";
      if (v.builtin.under) row.classList.add("ag-variant");
      if (v.off || v.offWith) row.classList.add("ag-row-off");

      const name = span("ag-name", labelOf(v.merged));
      if (v.edited) name.appendChild(span("ag-note", "Edited In vidar.json"));

      const bind = document.createElement("div");
      bind.className = "sc-bind";
      const shown = !v.off && !v.offWith;
      // Model only on a live Rendered row: on an Off row a model would land on a disabled entry.
      if (shown && v.merged.body === "rendered") {
        const model = v.merged.model ?? "";
        const claude = v.merged.id === "claude";
        const save = (next: string) => {
          void run("builtin", setError, (fresh) => setModel(fresh.overlay, fresh.hits, builtinAgents(), v.key, next));
        };
        const codex = v.merged.id === "codex";
        const codexModels = codex ? getPref("codexModels") ?? [] : [];
        const listed = codex ? codexModelSelect(model, codexModels, save) : null;
        if (claude) {
          bind.appendChild(modelSelect(model, getPref("claudeModels") ?? [], save));
          if (model === "") name.appendChild(span("ag-note", "Pin A Model To Keep Fable Off"));
        } else if (listed) {
          bind.appendChild(listed);
        } else {
          const input = field("ag-model", model, "CLI Default", save);
          input.setAttribute("aria-label", "Model");
          bind.appendChild(input);
          if (codex) name.appendChild(span("ag-note", "Open A Codex Tab To List Models"));
        }
        if (claude || codex) {
          const pick = (next: string) => {
            void run("builtin", setError, (fresh) => setEffort(fresh.overlay, fresh.hits, builtinAgents(), v.key, next));
          };
          bind.appendChild(effortSelect(v.merged.effort ?? "", pick, codex ? codexEffortLevels(model, codexModels) : undefined));
        }
      }
      if (v.offWith) {
        const b = button(`Off With ${v.offWith}`);
        b.disabled = true;
        bind.appendChild(b);
      } else {
        const on = !v.off;
        if (v.key === "astra" && !on) {
          const next = s.rows.find((r) => r.role === "astra");
          if (next) name.appendChild(span("ag-note", `Reviews Go To ${labelOf(next)}`));
        }
        const b = button(on ? "On" : "Off");
        b.setAttribute("aria-pressed", String(on));
        b.title = on ? `Hide ${labelOf(v.merged)} From The Launcher` : `Show ${labelOf(v.merged)} In The Launcher`;
        b.addEventListener("click", () => {
          b.disabled = true;
          void run("builtin", setError, (fresh) => setEnabled(fresh.overlay, fresh.hits, builtinAgents(), v.key, !on));
        });
        bind.appendChild(b);
      }
      row.append(name, bind);
      root.appendChild(row);
    }
  });
}

// The Add Agent draft lives outside the render so a redraw (another save, settings-changed) keeps
// it; it is written only once Label and Command are both non-blank.
interface Draft { label: string; id: string; command: string; cwd: string }
let draft: Draft | null = null;

function readOnlyText(v: CustomView, s: Snapshot): string {
  const m = v.merged;
  const parts: string[] = [];
  if (m.under) {
    const root = s.rows.find((r) => !r.under && r.id === m.under)
      ?? builtinAgents().find((r) => !r.under && r.id === m.under);
    parts.push(`${root ? labelOf(root) : m.under} Variant`);
  }
  if (m.body === "rendered") parts.push("Rendered");
  if (m.role) parts.push(`Role ${m.role.charAt(0).toUpperCase()}${m.role.slice(1)}`);
  if (v.off) parts.push("Off In vidar.json");
  if (v.offWith) parts.push(`Off With ${v.offWith}`);
  parts.push("Edit In vidar.json");
  return parts.join(" · ");
}

function customsControl(setError: SetError): HTMLElement {
  takePending("custom", setError);
  return list((root, s) => {
    for (const v of customViews(s, builtinViews(s))) {
      const row = document.createElement("div");
      row.className = "ws-row";
      const remove = button("Remove", "ws-remove");
      remove.addEventListener("click", () => {
        remove.disabled = true;
        void run("custom", setError, onCustom(v, (f, k) => removeCustom(f.overlay, f.hits, builtinAgents(), k)));
      });
      if (!v.editable) {
        const text = document.createElement("span");
        text.className = "ag-readonly";
        const b = document.createElement("b");
        b.textContent = labelOf(v.merged);
        text.append(b, ` · ${readOnlyText(v, s)}`);
        row.append(text, remove);
        root.appendChild(row);
        continue;
      }
      const edit = (fields: CustomFields) =>
        void run("custom", setError, onCustom(v, (f, k) => updateCustom(f.overlay, f.hits, builtinAgents(), k, fields)));
      const label = field("ag-label", labelOf(v.merged), "Label", (next) => {
        if (next === "") return false;
        edit({ label: next });
      });
      const type = typeSelect(v.merged.id, (id) => edit({ id }));
      const command = field("ag-cmd", v.command, "Command", (next) => edit({ args: argsFor(next) }));
      const folder = folderButton(v.merged.cwd, (cwd) => edit({ cwd }), setError);
      row.append(label, type, command, folder, remove);
      root.appendChild(row);
    }

    if (draft) {
      const d = draft;
      const row = document.createElement("div");
      row.className = "ws-row ag-draft";
      const tryAdd = () => {
        if (d.label.trim() === "" || d.command.trim() === "") return;
        const fields: CustomFields = { label: d.label.trim(), id: d.id, args: argsFor(d.command), cwd: d.cwd || undefined };
        void run("custom", setError, (f) => addCustom(f.overlay, builtinAgents(), fields)).then((ok) => {
          if (ok && draft === d) {
            draft = null;
            refreshAll();
          }
        });
      };
      const label = field("ag-label", d.label, "Label", (next) => { d.label = next; tryAdd(); }, (raw) => { d.label = raw; });
      const type = typeSelect(d.id, (id) => { d.id = id; });
      const command = field("ag-cmd", d.command, "Command", (next) => { d.command = next; tryAdd(); }, (raw) => { d.command = raw; });
      const folder = folderButton(d.cwd || undefined, (cwd) => { d.cwd = cwd; refreshAll(); }, setError);
      const discard = button("Discard", "ws-remove");
      discard.addEventListener("click", () => { draft = null; setError(""); refreshAll(); });
      row.append(label, type, command, folder, discard);
      root.appendChild(row);
    }

    const add = button("Add Agent", "ws-add");
    add.disabled = draft !== null;
    add.addEventListener("click", () => {
      draft = { label: "", id: "shell", command: "", cwd: "" };
      focusOnNextDraw(root, ".ag-draft .ag-label"); // the new draft's Label, once the redraw lands
      refreshAll();
    });
    root.appendChild(add);
  });
}

// ---------------------------------------------------------------------------------------------
// Primary agent (vidar.json `primaryAgent`; resolved in agents/primary.ts)

// The saved pick, cached for agents/primary.ts's sync reads; refreshed on every write and hand reload.
let savedPrimary: unknown;
const primaryOf = (c: VidarConfig): unknown => c.primaryAgent;

// A new pick re-reads it, then rebuilds the launcher, which draws its rows once per build
// (launcher-order.ts pattern).
const readPrimary = (rebuild: boolean): Promise<void> => loadConfig().then(({ config: c }) => {
  savedPrimary = primaryOf(c);
  if (rebuild) buildTypeMenu(overlayAgents(builtinAgents(), c.agents), c.locations ?? []);
});

const primaryControl = (setError: SetError): HTMLElement => primarySelect(effectivePrimary(), primaryChoices(), (value) => {
  setError("");
  invoke("patch_settings", { key: "primaryAgent", value }).catch((e) => setError(`Not Saved: ${e}`));
});

let registered = false;

/** Adds the Agents page once, above Keybinds: Primary Agent, built-in rows, Launcher Order, Your
 *  Agents, Macros. Also binds the primary agent's sources, once, at boot. */
export function registerAgentRows(): void {
  if (registered) return;
  registered = true;
  setPrimarySources(() => savedPrimary, () => modulesOf("agent"));
  void readPrimary(false);
  onModulesChange(refreshAll); // a module turning on or off adds or drops its rows
  onSettingsChanged((e) => { if (e.keys.includes("primaryAgent")) void readPrimary(true); });
  onConfigReloaded((res) => { savedPrimary = primaryOf(res.config); });
  registerCategory(AGENTS_CATEGORY, "Agents", "keybinds");
  initLauncherOrder();
  setPlainRowsSource(plainRowsOn);
  addSettingRow({
    name: "Primary Agent",
    tip: "Leads the launcher and Setup Via Agent.",
    category: AGENTS_CATEGORY,
    keywords: () => "primary default main agent codex claude",
    control: primaryControl,
  });
  addSettingRow({
    name: "Plain Rows",
    tip: "Shows the plain Claude and Codex rows beside the Bare ones. Off by default.",
    category: AGENTS_CATEGORY,
    keywords: () => "plain claude codex bare escape hatch rows launcher",
    control: () => plainRowsControl(refreshAll),
  });
  registerGuardsRow(AGENTS_CATEGORY);
  addSettingRow({
    name: "Built-In Agents",
    description: "Model applies to Rendered tabs only.", // note-ok: user, 2026-10-01 (scope limit the name doesn't state)
    tip: "Off hides a row from the launcher.",
    category: AGENTS_CATEGORY,
    wide: true,
    keywords: () => builtinAgents().map(labelOf).join(" "),
    control: builtinsControl,
  });
  addSettingRow({
    name: "Launcher Order",
    tip: "Drag to reorder the + menu.",
    category: AGENTS_CATEGORY,
    wide: true,
    keywords: () => "order reorder launcher new tab menu",
    control: () => list((root, s) => drawLauncherOrder(root, s.rows.filter((r) => !r.key || !offKeys().has(r.key)))),
  });
  addSettingRow({
    name: "Your Agents",
    description: "A new agent saves once Label and Command are filled.", // note-ok: user, 2026-10-01 (consequence: unsaved until filled)
    tip: "Agents added here or in vidar.json.",
    category: AGENTS_CATEGORY,
    wide: true,
    keywords: () => "custom add agent command folder",
    control: customsControl,
  });
  registerMacroRows(AGENTS_CATEGORY);
  onSettingsChanged((e) => { if (e.keys.includes("agents")) refreshAll(); });
}
