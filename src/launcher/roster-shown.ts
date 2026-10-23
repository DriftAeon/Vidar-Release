// src\launcher\roster-shown.ts — the pure half of launcher dependency gating: which roots
// and variants the launcher shows for a given `available` predicate. No runtime imports, so
// `node --test` loads it directly (roster.ts pulls the sessions panel). roster.ts binds these to
// launcherTypes, variantsOf and state.ts's isAvailable.
// The `requires` rule (every listed dependency available) lives here, in `keep`; the root order
// (saved, else defaultRootOrder, primary agent first) in `orderRoots`; the Falcon row's parent in
// `falconRowParent`.

import type { AgentId } from "../agents/id";

export interface ShownRow {
  key?: string;
  id: string;
  label?: string;
  under?: string;
  requires?: string[];
}

// `requires` arrives from vidar.json unchecked (an unknown field to schema.rs), so a hand edit can
// write a bare string: read it as a one-item list; anything else that is not an array as none.
function requiresOf(r: ShownRow): string[] {
  const req: unknown = r.requires;
  if (Array.isArray(req)) return req.filter((id): id is string => typeof id === "string");
  return typeof req === "string" && req !== "" ? [req] : [];
}

const keep = <T extends ShownRow>(available: (id: string) => boolean) => (r: T): boolean =>
  requiresOf(r).every((id) => available(id));

// Root order (Settings › Agents › Launcher Order). The default, top-down, by a
// row's key, else its id (the user's key-less Local row matches "local").
// Gateway module roots (launcher/gateways.ts, by agent.order) sit between Pi and Gemini.
let gatewayRoots: readonly string[] = [];
export function setGatewayRootOrder(ids: readonly string[]): void {
  gatewayRoots = [...ids];
}
// The primary agent (src/agents/primary.ts effectivePrimary), read at shaping time: its root leads
// the Claude/Codex pair. Unbound or null keeps Claude first. A saved Launcher Order still wins.
let primaryRoot: () => string | null = () => null;
export function setPrimaryRootSource(fn: () => string | null): void {
  primaryRoot = fn;
}
const defaultRootOrder = (): string[] => {
  const pair = primaryRoot() === "codex" ? ["codex", "claude"] : ["claude", "codex"];
  return [...pair, "pi", ...gatewayRoots, "gemini", "local", "terminal"];
};

/** The root id the Falcon row mounts under: the primary agent's root when the launcher shows it,
 *  else the other agent's, else none. Null too when Falcon is unavailable (its dependency lives in
 *  the Claude pack). An unknown primary (null) keeps Claude first, as before the setting. */
export function falconRowParent(primary: string | null, shownRootIds: readonly string[], falconAvailable: boolean): AgentId | null {
  if (!falconAvailable) return null;
  const order: AgentId[] = primary === "codex" ? ["codex", "claude"] : ["claude", "codex"];
  return order.find((id) => shownRootIds.includes(id)) ?? null;
}

// The saved order, read at shaping time. Settings binds it to the "order.launcher" pref
// (settings/launcher-order.ts); unbound it is absent, so the default applies.
let savedOrder: () => readonly string[] | undefined = () => undefined;
export function setRootOrderSource(fn: () => readonly string[] | undefined): void {
  savedOrder = fn;
}

/** A saved order written when "claude" and "codex" were the plain roots: those slots now belong to the
 *  Bare roots ("claude-bare", "codex-bare"), when the roster has them. A list that already names the
 *  Bare root is current, and its "claude" is the plain row. */
function savedAsBare(saved: readonly string[], roots: readonly ShownRow[]): readonly string[] {
  const swap = (plain: string, bare: string) => (list: readonly string[]) =>
    list.includes(bare) || !roots.some((r) => r.key === bare) ? list : list.map((s) => (s === plain ? bare : s));
  return swap("codex", "codex-bare")(swap("claude", "claude-bare")(saved));
}

/** Roots in the saved order (entries are rowIds). A root the saved list does not name goes after
 *  the named ones, in default order, then in roster order; a saved id with no root is ignored. */
export function orderRoots<T extends ShownRow>(roots: readonly T[], saved: readonly string[] | undefined): T[] {
  const order = savedAsBare(saved ?? [], roots);
  const rank = (r: T) => {
    const i = order.indexOf(rowId(r));
    return i < 0 ? order.length : i;
  };
  const defaults = defaultRootOrder();
  // Claude and Codex rank by their kind, so the Bare root and the plain one share a slot; the rest by key, else id.
  const byDefault = (r: T) => {
    const i = defaults.indexOf(r.id === "claude" || r.id === "codex" ? r.id : r.key ?? r.id);
    return i < 0 ? defaults.length : i;
  };
  return roots
    .map((r, i) => ({ r, i }))
    // within one default slot a keyed row (the built-in) leads a key-less one sharing its id
    .sort((a, b) => rank(a.r) - rank(b.r) || byDefault(a.r) - byDefault(b.r)
      || Number(!a.r.key) - Number(!b.r.key) || a.i - b.i)
    .map((x) => x.r);
}

export function shownRootsOf<T extends ShownRow>(roots: T[], available: (id: string) => boolean): T[] {
  return orderRoots(roots.filter(keep<T>(available)), savedOrder());
}

/** Keys of the keyed rows whose agent module is off (`moduleIds` names the ids that are modules;
 *  `on` is the registry's moduleOn). Settings › Agents hides these rows and their Launcher Order slot,
 *  so a build without Claude lists no Claude row. Key-less (custom) rows are never listed. */
export function offModuleKeys(
  rows: readonly ShownRow[],
  moduleIds: ReadonlySet<string>,
  on: (id: string) => boolean,
): Set<string> {
  const off = new Set<string>();
  for (const r of rows) if (r.key && moduleIds.has(r.id) && !on(r.id)) off.add(r.key);
  return off;
}

// A variant is shown only under a shown root: a hidden root never promotes its children.
export function shownVariantsOf<T extends ShownRow>(
  root: T,
  roots: T[],
  variantsOf: Map<T, T[]>,
  available: (id: string) => boolean,
): T[] {
  if (!roots.includes(root) || !keep<T>(available)(root)) return [];
  return (variantsOf.get(root) ?? []).filter(keep<T>(available));
}

// Identity of one row for change detection: the unique `key`, else the id/under/label triple
// config-agents.ts matches key-less entries by. Also the saved launcher order's entry.
export function rowId(r: ShownRow): string {
  return r.key ?? `${r.id}|${r.under ?? ""}|${r.label ?? ""}`;
}

// Everything the launcher currently shows, as one comparable string (roots in order, each with its
// shown variants). The menu redraws only when this changes between two dependency reports.
export function shownIdsKey<T extends ShownRow>(
  roots: T[],
  variantsOf: Map<T, T[]>,
  available: (id: string) => boolean,
): string {
  return shownRootsOf(roots, available)
    .map((r) => `${rowId(r)}[${shownVariantsOf(r, roots, variantsOf, available).map(rowId).join(",")}]`)
    .join(";");
}
