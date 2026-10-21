/* Agent roster overlay:
   the built-in agent list with vidar.json `agents` laid over it, instead of vidar.json replacing
   it wholesale. Pure; no IPC, so the npm test harness imports it directly.

   Identity: an entry WITH `key` matches the row carrying the same `key` (every built-in has a
   unique one, src/launcher/roster.ts BUILTIN_AGENTS), so it can relabel or move that row. An entry WITHOUT
   `key` matches by `id` + `under` + label (label falls back to id), the pre-key rule, kept so a
   vidar.json written before keys produces the same menu. `id` alone is the SessionAgent kind
   and is shared by several rows (Claude and Rendered are both "claude"), so it
   cannot be the identity by itself. Per vidar.json entry, in order:
   - it names a retired plain row (claude, claude-rendered, codex, codex-rendered, or the key-less
     Claude/Codex/Rendered shape of one) -> it first becomes an entry for the Bare successor, below;
   - it matches a current row   -> the given fields override that row in place;
   - `disabled: true`           -> the matching row is removed; no match -> a warning;
   - otherwise                  -> appended after the built-ins, in vidar.json order.
   A removed root (no `under`) takes its variants (`under` = its id) with it, unless another
   root with that id is still present to host them; otherwise they would spill to top level. */
import type { AgentType } from "./config";

/** The legacy (key-less) identity: id + under + label. */
export function agentKey(a: AgentType): string {
  return `${a.id}\u0000${a.under ?? ""}\u0000${a.label ?? a.id}`;
}

// read_config serializes every absent Option as `null` (schema.rs AgentCfg), and a missing `id`
// as "" (a plain String with serde default), so a field is "given" only when it is neither null
// nor undefined, and `id` only when non-empty; otherwise a partial override would blank the
// built-in's fields.
function given(entry: AgentType): Partial<AgentType> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (v === null || v === undefined) continue;
    if (k === "id" && v === "") continue;
    out[k] = v;
  }
  return out as Partial<AgentType>;
}

/** The retired plain rows' Bare successors (launcher/roster.ts: the Bare rows lead Claude and Codex). */
const SUCCESSOR: Record<string, string> = {
  "claude": "claude-bare",
  "claude-rendered": "claude-rendered-bare",
  "codex": "codex-bare",
  "codex-rendered": "codex-rendered-bare",
};
/** What a retired entry hands to its successor; everything else it carried is dropped. */
const CARRIED = new Set(["model", "effort", "cwd"]);
/** Fields that only name the entry (a legacy identity or the key): never reported as dropped. */
const IDENTITY = new Set(["key", "id", "under", "label"]);

/** The successor key of a key-less legacy entry, by its id + under + label: the root-shaped "Claude" or
 *  "Codex" is the Bare root; "Rendered" or "Rendered Bare" under it is the Rendered Bare row; "Bare" is
 *  the Bare root (it was a variant before). Undefined for any other entry. */
function legacySuccessor(entry: Partial<AgentType>): string | undefined {
  const kind = entry.id;
  if (kind !== "claude" && kind !== "codex") return undefined;
  const label = entry.label ?? kind;
  if (!entry.under) return label.toLowerCase() === kind ? SUCCESSOR[kind] : undefined;
  if (entry.under !== kind) return undefined;
  if (label === "Rendered" || label === "Rendered Bare") return SUCCESSOR[`${kind}-rendered`];
  if (label === "Bare") return SUCCESSOR[kind];
  return undefined;
}

/** vidar.json shadows of a retired plain row move, in memory, onto its Bare successor: model, effort
 *  and cwd carry (the Fable guard rides on claude-rendered's model); shell, args, rules, body, profile
 *  and anything else are dropped with one warning per entry. Disabled is dropped too: turning a
 *  retired row off must not take the Bare row with it. The file is not rewritten. */
function migrateRetired(entry: Partial<AgentType>, warnings?: string[]): Partial<AgentType> {
  const to = entry.key !== undefined ? SUCCESSOR[entry.key] : legacySuccessor(entry);
  if (to === undefined) return entry;
  const out: Record<string, unknown> = { key: to };
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (CARRIED.has(k)) out[k] = v;
    else if (!IDENTITY.has(k)) dropped.push(k);
  }
  if (dropped.length) {
    const from = entry.key ?? `${entry.id}${entry.under ? ` under ${entry.under}` : ""}${entry.label ? ` "${entry.label}"` : ""}`;
    warnings?.push(`vidar.json agents: ${from} was retired and now applies to ${to}; dropped ${dropped.join(", ")}`);
  }
  return out as Partial<AgentType>;
}

/** The overlay as the roster reads it: one entry per input entry, a retired plain row's entry already
 *  moved onto its Bare successor (no warnings). Settings › Agents reads `disabled` and the edited
 *  fields from this, so a stale `disabled` on a retired key never shows the Bare row Off. */
export function migrateOverlay(overlay: readonly AgentType[]): AgentType[] {
  return overlay.map((raw) => {
    const g = given(raw);
    const m = migrateRetired(g);
    return m === g ? raw : (m as AgentType);
  });
}

/** Which row each overlay entry landed on (Settings › Agents): the built-in's `key` it hit
 *  (its legacy identity if that built-in has no key), `#j` for the custom row appended by entry j,
 *  or `null` for a disabled entry that matched nothing. Read from an origin array spliced
 *  alongside the rows, never from the row's `key`: a custom row can carry a key of its own. */
export type OverlayHit = string | null;

function applyOverlay(
  builtins: readonly AgentType[],
  overlay: readonly AgentType[] | undefined,
  warnings?: string[],
): { rows: AgentType[]; hits: OverlayHit[] } {
  const out: AgentType[] = builtins.map((a) => ({ ...a }));
  const origin: string[] = builtins.map((a) => a.key ?? agentKey(a));
  const hits: OverlayHit[] = [];
  const removedRoots = new Set<string>();
  (overlay ?? []).forEach((raw, j) => {
    const entry = migrateRetired(given(raw), warnings);
    const { disabled, ...fields } = entry;
    // No key and no id: nothing to match and nothing to launch, and patch_settings refuses the
    // whole agents list while it is there (commands.rs "needs a non-blank id or key"). Skipped,
    // with a warning that names the entry and the fix.
    const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";
    if (blank(entry.key) && blank(raw.id)) {
      hits.push(null);
      // Named by id when it has one; `j` is a position in the already-filtered list (Rust drops
      // unparsable entries first), so it is never reported as a file index.
      const who = typeof raw.id === "string" && raw.id.trim() !== "" ? `agents id ${raw.id}` : "agents entry";
      warnings?.push(`vidar.json ${who}: has no id and no key, skipped; Settings › Agents cannot save until it is given one or removed: ${JSON.stringify(entry)}`);
      return;
    }
    const i = entry.key !== undefined
      ? out.findIndex((a) => a.key === entry.key)
      : out.findIndex((a) => agentKey(a) === agentKey({ id: raw.id ?? "", ...entry }));
    if (disabled === true) {
      if (i >= 0) {
        hits.push(origin[i]);
        const [gone] = out.splice(i, 1);
        origin.splice(i, 1);
        if (!gone.under) removedRoots.add(gone.id);
      } else {
        hits.push(null);
        warnings?.push(`vidar.json agents: disabled entry matches no row, ignored: ${JSON.stringify(entry)}`);
      }
      return;
    }
    if (i >= 0) {
      hits.push(origin[i]);
      out[i] = { ...out[i], ...fields };
    } else {
      hits.push(`#${j}`);
      out.push({ id: raw.id ?? "", ...fields });
      origin.push(`#${j}`);
    }
  });
  // Cascade after the loop, so the result does not depend on where in vidar.json the disable sits.
  for (const id of removedRoots) {
    if (out.some((a) => !a.under && a.id === id)) continue;
    for (let j = out.length - 1; j >= 0; j--) if (out[j].under === id) out.splice(j, 1);
  }
  return { rows: out, hits };
}

/** `warnings` (optional) collects one line per entry that could not be applied, entry included,
 *  for the caller to log and surface; the function itself stays side-effect free. */
export function overlayAgents(
  builtins: readonly AgentType[],
  overlay: readonly AgentType[] | undefined,
  warnings?: string[],
): AgentType[] {
  return applyOverlay(builtins, overlay, warnings).rows;
}

/** One OverlayHit per overlay entry, in overlay order; the same pass as overlayAgents. */
export function attributeOverlay(
  builtins: readonly AgentType[],
  overlay: readonly AgentType[] | undefined,
): OverlayHit[] {
  return applyOverlay(builtins, overlay).hits;
}
