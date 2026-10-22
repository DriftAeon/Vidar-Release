// Settings › Agents, reading half: vidar.json as it is on disk now (Snapshot) and the built-in and
// custom row views derived from it. Pure reads, no drawing and no saving; agents.ts draws and saves.

import { invalidateConfig, loadConfig, type AgentType } from "../config";
import { attributeOverlay, migrateOverlay, overlayAgents, type OverlayHit } from "../config-agents";
import { builtinAgents, PLAIN_KEYS } from "../launcher/roster";
import { gatewayModuleRows, moduleOn } from "../modules/registry";
import { offModuleKeys } from "../launcher/roster-shown";
import type { OverlayEntry } from "./agents-edit";

// The Type select of a custom row: tab kind by `id` (roster.ts agentKind). A row whose id is not
// one of these (gateway module ids resolve to `claude` but are not editable here) is shown read-only, so a first edit can never silently rewrite its id.
export const TYPES: [string, string][] = [
  ["claude", "Claude"], ["codex", "Codex"], ["gemini", "Gemini"], ["pi", "Pi"], ["shell", "Terminal"],
];
export const TYPE_IDS = new Set(TYPES.map(([id]) => id));
// Fields a representable custom row may carry; anything else set makes it read-only.
const CUSTOM_FIELDS = new Set(["id", "label", "args", "cwd", "key"]);
// Fields that do not count as "Edited In vidar.json" on a built-in hit.
const NOT_AN_EDIT = new Set(["id", "under", "key", "model", "effort", "disabled"]);

export interface Snapshot {
  overlay: OverlayEntry[];
  /** `overlay` as the roster reads it (retired plain-row entries moved onto their Bare successor). */
  effective: OverlayEntry[];
  hits: OverlayHit[];
  rows: AgentType[];
  error: string | null;
}

/** vidar.json as it is on disk now: the memo is dropped first, so this is never the page's copy. */
export async function readFresh(): Promise<Snapshot> {
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

export function labelOf(a: AgentType): string {
  return a.label ?? a.id;
}

export interface BuiltinView {
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
export function offKeys(): Set<string> {
  const ids = new Set(["claude", "codex", ...gatewayModuleRows().map((m) => m.id)]);
  return offModuleKeys(builtinAgents(), ids, moduleOn);
}

export function builtinViews(s: Snapshot): BuiltinView[] {
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

export interface CustomView {
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

export function customViews(s: Snapshot, builtins: BuiltinView[]): CustomView[] {
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
export function locate(s: Snapshot, j: number, sig: string): number | null {
  const at = (k: number) => s.hits[k] === `#${k}` && JSON.stringify(s.overlay[k]) === sig;
  if (j < s.overlay.length && at(j)) return j;
  for (let k = 0; k < s.overlay.length; k++) if (at(k)) return k;
  return null;
}
