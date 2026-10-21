/* Edit operations on the vidar.json `agents` overlay. Pure, types-only
   imports (the node test harness loads this file directly). Every operation takes the overlay as
   read_config returned it, the per-entry hits from attributeOverlay (config-agents.ts) and the
   built-ins, and returns a new overlay; the caller re-reads the config, recomputes hits, applies
   one operation and writes the result through toWire.

   Minimal diff: an operation touches only the fields it names, on the entries attributed to its
   target, plus `key` migration (a modified entry without a key gets the target's key, so a later
   built-in relabel cannot orphan it). An entry is deleted only when it carried a key before the
   operation and is left as exactly `{key}` (nulls and `id:""` ignored, the way read_config emits
   them); a legacy key-less entry is never deleted. Unknown fields ride along untouched. */
import type { AgentType } from "../config";
import type { OverlayHit } from "../config-agents";

/** An overlay entry as read_config emits it: known fields may be null, unknown fields survive. */
export type OverlayEntry = AgentType | (AgentType & Record<string, unknown>);

// The AgentCfg fields (src-tauri/src/settings/schema.rs); only these lose a `null` in toWire.
const KNOWN = ["id", "label", "shell", "args", "model", "effort", "role", "cwd", "under", "body", "permissionMode", "key", "disabled"];

function isSet(v: unknown): boolean {
  return v !== null && v !== undefined;
}

function hasKey(e: OverlayEntry): boolean {
  return typeof e.key === "string" && e.key !== "";
}

// Mirror of agentKey (config-agents.ts), with read_config's nulls read as absent. A copy because
// this module may import only types (no allowImportingTsExtensions for the test harness).
function legacyIdentity(e: OverlayEntry): string {
  const id = e.id ?? "";
  return `${id}\u0000${e.under ?? ""}\u0000${e.label ?? id}`;
}

function isKeyOnly(e: OverlayEntry): boolean {
  for (const [k, v] of Object.entries(e)) {
    if (k === "key") continue;
    if (!isSet(v) && KNOWN.includes(k)) continue;
    if (k === "id" && v === "") continue;
    return false;
  }
  return hasKey(e);
}

function withKey(e: OverlayEntry, key: string): OverlayEntry {
  return hasKey(e) ? e : { ...e, key };
}

// Every export that takes both indexes hits[i] against overlay[i]; a stale hits array is a caller bug.
function checkHits(overlay: readonly OverlayEntry[], hits: readonly OverlayHit[]): void {
  if (hits.length !== overlay.length) {
    throw new Error(`agents-edit: ${hits.length} hits for ${overlay.length} overlay entries; recompute with attributeOverlay`);
  }
}

function lastIndexOf(hits: readonly OverlayHit[], target: string): number {
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i] === target) return i;
  return -1;
}

/** Turn a built-in row on or off.
 *  Off: `disabled:true` on the LAST entry hitting K, so no later entry can fall through and be
 *  appended once the row is gone; nothing hits K → `{key:K, disabled:true}` appended.
 *  On: `disabled` cleared on every entry hitting K, and on unmatched (null) disabled entries that
 *  name K by key or legacy identity (they would re-match K once it is back). */
export function setEnabled(
  overlay: readonly OverlayEntry[],
  hits: readonly OverlayHit[],
  builtins: readonly AgentType[],
  key: string,
  on: boolean,
): OverlayEntry[] {
  checkHits(overlay, hits);
  const out = overlay.map((e) => e);
  if (!on) {
    const i = lastIndexOf(hits, key);
    if (i < 0) return [...out, { key, disabled: true } as OverlayEntry];
    if (out[i].disabled === true && hasKey(out[i])) return out;
    out[i] = { ...withKey(out[i], key), disabled: true };
    return out;
  }
  const builtin = builtins.find((b) => b.key === key);
  const legacy = builtin ? legacyIdentity(builtin) : undefined;
  const result: OverlayEntry[] = [];
  out.forEach((e, i) => {
    const named = hits[i] === key
      || (hits[i] === null && (e.key === key || (!hasKey(e) && legacyIdentity(e) === legacy)));
    if (!named || e.disabled !== true) {
      result.push(e);
      return;
    }
    const keyed = hasKey(e);
    const { disabled: _drop, ...rest } = withKey(e, key);
    if (keyed && isKeyOnly(rest as OverlayEntry)) return;
    result.push(rest as OverlayEntry);
  });
  return result;
}

/** Set or clear a row's model. Non-blank → written to the last entry hitting K (last writer wins),
 *  or `{key:K, model}` appended. Blank → `model` deleted from every hit, so it cannot snap back
 *  and the resolved model falls through to the built-in's (none: the host default). */
export function setModel(
  overlay: readonly OverlayEntry[],
  hits: readonly OverlayHit[],
  _builtins: readonly AgentType[],
  key: string,
  model: string,
): OverlayEntry[] {
  checkHits(overlay, hits);
  const out = overlay.map((e) => e);
  const v = model.trim();
  if (v !== "") {
    const i = lastIndexOf(hits, key);
    if (i < 0) return [...out, { key, model: v } as OverlayEntry];
    out[i] = { ...withKey(out[i], key), model: v };
    return out;
  }
  const result: OverlayEntry[] = [];
  out.forEach((e, i) => {
    if (hits[i] !== key || !isSet(e.model)) {
      result.push(e);
      return;
    }
    const keyed = hasKey(e);
    const { model: _drop, ...rest } = withKey(e, key);
    if (keyed && isKeyOnly(rest as OverlayEntry)) return;
    result.push(rest as OverlayEntry);
  });
  return result;
}

/** Set or clear a row's effort, the way setModel does a model: non-blank → last entry hitting K
 *  (or `{key:K, effort}` appended); blank → `effort` deleted from every hit (not pinned). */
export function setEffort(
  overlay: readonly OverlayEntry[],
  hits: readonly OverlayHit[],
  _builtins: readonly AgentType[],
  key: string,
  effort: string,
): OverlayEntry[] {
  checkHits(overlay, hits);
  const out = overlay.map((e) => e);
  const v = effort.trim();
  if (v !== "") {
    const i = lastIndexOf(hits, key);
    if (i < 0) return [...out, { key, effort: v } as OverlayEntry];
    out[i] = { ...withKey(out[i], key), effort: v } as OverlayEntry;
    return out;
  }
  const result: OverlayEntry[] = [];
  out.forEach((e, i) => {
    if (hits[i] !== key || !isSet(e.effort)) {
      result.push(e);
      return;
    }
    const keyed = hasKey(e);
    const { effort: _drop, ...rest } = withKey(e, key);
    if (keyed && isKeyOnly(rest as OverlayEntry)) return;
    result.push(rest as OverlayEntry);
  });
  return result;
}

function slug(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s === "" ? "agent" : s;
}

/** `user-<ascii-slug|agent>`, then `-2`, `-3`… until unique against every built-in and overlay key. */
function newUserKey(overlay: readonly OverlayEntry[], builtins: readonly AgentType[], label: string): string {
  const taken = new Set<string>();
  for (const e of [...builtins, ...overlay]) if (hasKey(e)) taken.add(e.key as string);
  const base = `user-${slug(label)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Fields a custom row edit may name; `undefined` or "" clears the field. */
export type CustomFields = Partial<Pick<AgentType, "id" | "label" | "shell" | "args" | "cwd">>;

function blank(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Append a custom row under a fresh `user-*` key; blank fields are left out. */
export function addCustom(
  overlay: readonly OverlayEntry[],
  builtins: readonly AgentType[],
  fields: CustomFields,
): OverlayEntry[] {
  const key = newUserKey(overlay, builtins, fields.label ?? "");
  const entry: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(fields)) if (!blank(v)) entry[k] = v;
  if (entry.id === undefined) entry.id = "shell";
  return [...overlay, entry as unknown as OverlayEntry];
}

/** Edit the custom row appended by entry j (every entry attributed `#j`). Set fields go to the last
 *  such entry; cleared fields leave all of them. On the first edit of a key-less custom row every
 *  `#j` entry gets one `user-*` key, so a relabel cannot orphan a later entry that matched by label. */
export function updateCustom(
  overlay: readonly OverlayEntry[],
  hits: readonly OverlayHit[],
  builtins: readonly AgentType[],
  j: number,
  fields: CustomFields,
): OverlayEntry[] {
  checkHits(overlay, hits);
  const target = `#${j}`;
  const idx = hits.flatMap((h, i) => (h === target ? [i] : []));
  if (idx.length === 0) return overlay.map((e) => e);
  const out = overlay.map((e) => e);
  const existing = idx.map((i) => out[i]).find(hasKey)?.key;
  const key = existing ?? newUserKey(overlay, builtins, (out[j].label ?? out[j].id ?? "") as string);
  for (const i of idx) out[i] = withKey(out[i], key);
  const last = idx[idx.length - 1];
  for (const [k, v] of Object.entries(fields)) {
    if (blank(v)) {
      for (const i of idx) {
        if (!(k in out[i])) continue;
        const copy: Record<string, unknown> = { ...out[i] };
        delete copy[k];
        out[i] = copy as unknown as OverlayEntry;
      }
    } else {
      out[last] = { ...out[last], [k]: v } as OverlayEntry;
    }
  }
  return out;
}

/** Remove the custom row appended by entry j: every entry attributed `#j`. A custom root whose id
 *  no built-in root carries also takes the custom variants under that id (otherwise they would be
 *  promoted to top level, roster.ts resolveAgents). */
export function removeCustom(
  overlay: readonly OverlayEntry[],
  hits: readonly OverlayHit[],
  builtins: readonly AgentType[],
  j: number,
): OverlayEntry[] {
  checkHits(overlay, hits);
  const target = `#${j}`;
  const gone = new Set<string>([target]);
  const root = overlay[j];
  if (root && !isSet(root.under) && hits[j] === target) {
    const id = root.id ?? "";
    // Mirrors the overlay's live-root check: another root with this id still hosts the variants.
    const otherCustomRoot = hits.some((h, i) =>
      h !== null && h !== target && h === `#${i}` && !isSet(overlay[i].under) && (overlay[i].id ?? "") === id
      && !hits.some((d, m) => d === h && overlay[m].disabled === true));
    if (!builtins.some((b) => !b.under && b.id === id) && !otherCustomRoot) {
      hits.forEach((h, i) => {
        if (h !== null && h.startsWith("#") && overlay[i].under === id) gone.add(h);
      });
    }
  }
  return overlay.filter((_, i) => !(hits[i] !== null && gone.has(hits[i] as string)));
}

/** What patch_settings gets: `null` dropped on the known AgentCfg fields (an unknown `null` a hand
 *  edit wrote survives) and `id:""` dropped when the entry has a key. Field order is kept. */
export function toWire(overlay: readonly OverlayEntry[]): Record<string, unknown>[] {
  return overlay.map((e) => {
    const out: Record<string, unknown> = {};
    const keyed = hasKey(e);
    for (const [k, v] of Object.entries(e)) {
      if (v === null && KNOWN.includes(k)) continue;
      if (v === undefined) continue;
      if (k === "id" && v === "" && keyed) continue;
      out[k] = v;
    }
    return out;
  });
}
