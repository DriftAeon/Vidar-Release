// src\launcher\body-order.ts — the order of the launcher's body column (Raw / Rendered / Bare rows).
// Pure: locations.ts builds its rows from bodyOrder(). vidar.json `launcherLead` ("bare" | "raw")
// picks the lead; absent or any other value reads as DEFAULT_LEAD. Read once at start. Raw is the
// root's own launch, a Bare root now, so "bare" leads with Rendered and "raw" with Raw.

// @ts-ignore TS5097: node --test loads this pure module directly
import { AGENT_IDS } from "../agents/id.ts";

export type Lead = "bare" | "raw";

/** What an absent or unreadable `launcherLead` means. */
export const DEFAULT_LEAD: Lead = "bare";

/** The Bare variants that lead, best first (roster keys): Claude's Rendered, then Codex's. The Raw Bare
 *  rows are the roots themselves ("Raw" below), so they are not variants. Any other shown profiled row
 *  follows in roster order. */
const PREFERRED = AGENT_IDS.map((id) => `${id}-rendered-bare`);

export type BodyRow<T> = { kind: "raw" } | { kind: "rendered" } | { kind: "bare"; variant: T };

/** The saved value as a Lead; anything but "bare" or "raw" is absent. */
export function readLead(v: unknown): Lead {
  return v === "bare" || v === "raw" ? v : DEFAULT_LEAD;
}

let current: Lead = DEFAULT_LEAD;

/** Binds the saved `launcherLead` (main.ts, once at start). */
export function setLauncherLead(v: unknown): void {
  current = readLead(v);
}

export function launcherLead(): Lead {
  return current;
}

/** Rows in order. `raw`: Raw, Rendered (when shown), then the Bare rows in roster order. `bare`: the
 *  preferred shown Bare row, then Raw, Rendered and the other Bare rows; with no Bare row shown, Raw leads. */
export function bodyOrder<T extends { key?: string }>(rendered: boolean, bare: T[], lead: Lead): BodyRow<T>[] {
  const tail: BodyRow<T>[] = [{ kind: "raw" }];
  if (rendered) tail.push({ kind: "rendered" });
  const rows = bare.map((variant): BodyRow<T> => ({ kind: "bare", variant }));
  if (lead === "raw" || !bare.length) return [...tail, ...rows];
  const rank = (v: T) => {
    const i = PREFERRED.indexOf(v.key ?? "");
    return i < 0 ? PREFERRED.length : i;
  };
  let first = 0;
  bare.forEach((v, i) => { if (rank(v) < rank(bare[first])) first = i; });
  return [rows[first], ...tail, ...rows.filter((_, i) => i !== first)];
}

/** The Rendered variant a Resume list serves (Claude and Codex alike). With `from` (a Bare tab's
 *  profile and row key, carried by `vidar-open-resume`) it is that tab's own row, never another;
 *  without it, the variant the launcher leads with: `lead` "bare" → the preferred Bare Rendered
 *  one, otherwise the plain one, each falling back to whichever exists. */
export function resumeVariant<T extends { key?: string; body?: string; profile?: string }>(
  variants: readonly T[], lead: Lead, from?: { profile?: string; rowKey?: string },
): T | undefined {
  const rendered = variants.filter((v) => v.body === "rendered");
  if (from?.profile) {
    return rendered.find((v) => v.profile === from.profile && (!from.rowKey || v.key === from.rowKey));
  }
  const plain = rendered.find((v) => !v.profile);
  const bare = rendered.filter((v) => v.profile);
  const first = bare.length ? bodyOrder(false, bare, "bare")[0] : undefined;
  const bareFirst = first && first.kind === "bare" ? first.variant : undefined;
  return lead === "bare" ? bareFirst ?? plain : plain ?? bareFirst;
}
