// Model picker grouping: which CLI model rows are "Latest" and which fold under "Legacy".
// Pure; the status bar maps the CLI's list through it before the menu draws.

/** "Default (recommended)" → "Default": the CLI's display text minus its trailing hint. */
export const menuLabel = (label: string): string => label.replace(/\s*\(recommended\)\s*$/i, "");

type Parsed = { family: string; version: number[] };

/** Same parse as `prettyModel` (src/format.ts): drop "claude-", "[1m]" and date stamps. */
function parseModel(id: string): Parsed | null {
  const parts = id.toLowerCase().replace(/\[1m\]$/, "").replace(/^claude-/, "").split(/[-\s]+/)
    .filter((p) => p && !/^\d{8}$/.test(p));
  if (!parts.length || !/^[a-z]/.test(parts[0])) return null;
  const version = parts.slice(1).filter((p) => /^\d+$/.test(p)).map(Number);
  return { family: parts[0], version };
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Index of the one row to tick, or -1. `model` is the confirmed model: after a pick it is the
 *  value sent to setModel ("opus", "default", an id), after init/resume a canonical id.
 *  0) the row whose value is `picked` (menu value of the last confirmed pick; the ack carries a
 *     resolved id, so `model` alone cannot tell Default from the explicit row);
 *  1) a row whose value is that string (the user's pick, "default" included);
 *  2) else rows whose `resolved` equals it — an explicit row beats Default, which resolves to the
 *     same id whenever the default is that model;
 *  3) else the first row whose `nameMatch` holds, for CLIs sending no `resolved`.
 *  Before the first turn (`live` false) the same steps run on the model the tab will use: the
 *  settings hint, else what Default resolves to, so a fresh tab ticks that model's row, not
 *  Default (2026-10-04: "it should show the model it's going to use"). */
export function currentModelIndex(
  rows: { value: string; resolved?: string | null; nameMatch: boolean }[],
  model: string | null,
  live: boolean,
  picked: string | null = null,
): number {
  if (live && picked) {
    const byPick = rows.findIndex((r) => r.value === picked);
    if (byPick >= 0) return byPick;
  }
  const target = live ? model : (model ?? rows.find((r) => r.value === "default")?.resolved ?? null);
  if (target) {
    const byValue = rows.findIndex((r) => r.value === target && (live || r.value !== "default"));
    if (byValue >= 0) return byValue;
    const byId = rows.map((r, i) => (r.resolved && r.resolved === target ? i : -1)).filter((i) => i >= 0);
    const explicit = byId.find((i) => rows[i].value !== "default");
    if (explicit !== undefined) return explicit;
    if (byId.length) return byId[0];
  }
  return rows.findIndex((r) => !r.resolved && r.nameMatch);
}

/** Tags each row `group: "legacy"` unless it is an alias (no digits in its value), the newest
 *  of its family, or unparseable. The CLI's order is kept. */
export function groupModels<T extends { value: string; resolved?: string | null }>(rows: T[]): (T & { group?: "legacy" })[] {
  const parsed = rows.map((r) => parseModel(r.resolved ?? r.value));
  const newest = new Map<string, number[]>();
  for (const p of parsed) {
    if (!p) continue;
    const best = newest.get(p.family);
    if (!best || cmp(p.version, best) > 0) newest.set(p.family, p.version);
  }
  return rows.map((r, i) => {
    const p = parsed[i];
    const alias = !/\d/.test(r.value.replace(/\[1m\]/gi, ""));
    if (alias || !p || cmp(p.version, newest.get(p.family) ?? []) >= 0) return r;
    return { ...r, group: "legacy" as const };
  });
}
