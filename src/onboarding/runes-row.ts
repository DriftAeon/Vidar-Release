// src\onboarding\runes-row.ts — which launcher row the First Runeset step builds for. Pure, no runtime
// imports, so `node --test` loads it. The row is the launcher's own Rendered Bare variant of the primary
// agent (roster.ts BUILTIN_AGENTS: `<id>-rendered-bare`); its `key` is the Bare row key, read from the
// rows the launcher shows, never rebuilt from a format.

/** The slice of a launcher row the lookup reads (structural, so `AgentType` fits). */
export interface RosterRow {
  id: string;
  key?: string;
  body?: string;
  profile?: string;
}

/** Pure: the key of the primary's Rendered Bare row among `shown` (the variants the launcher shows for
 *  the primary's roots), or null when it has none (module off, dependency missing). */
export function renderedBareKey(shown: readonly RosterRow[], primary: string | null): string | null {
  if (!primary) return null;
  const row = shown.find((r) => r.id === primary && r.body === "rendered" && r.profile === "bare" && !!r.key);
  return row?.key ?? null;
}
