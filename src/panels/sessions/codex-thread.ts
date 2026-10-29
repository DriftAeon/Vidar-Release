// Does a tab hold a Codex thread? A Rendered Codex tab holds its live sessionId(); a live Raw
// Codex tab holds the thread resolved from its own home's rollouts (`pickRawThreads`), else the id
// its `codex resume <id>` command line names (a launcher resume; rules may sit between `codex` and
// `resume`, rules/inject.ts). A hosted or in-process Codex resume of a held thread would put a
// second writer on one rollout (review-fix B2), so both transports refuse it through lookup.ts
// codexThreadHolder. Pure, so it is testable under plain node.
//
// Why the launch line alone is not enough: the launcher never
// writes `codex resume <id>` on a Raw Codex line (its Resume opens a Rendered variant, a Raw Bare
// row carries no args at all), and a /new or /resume typed inside the TUI moves the tab to another
// thread while the line keeps the old id. So the id is absent or stale for nearly every Raw tab.

export interface CodexThreadTab {
  agent: string;
  body: string;
  alive: boolean;
  rendered?: { sessionId(): string | null } | null;
  launchArgs?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CODEX_WORD = /(?:^|\s)codex(?=\s|$)/;
const RESUME_ID = /(?:^|\s)resume\s+['"]?([0-9A-Za-z][0-9A-Za-z-]*)['"]?(?=\s|$)/;

/** The thread a Raw Codex launch line resumes (`codex ... resume <id>`), or null. */
export function launchLineThread(args: readonly string[] | undefined): string | null {
  for (const a of args ?? []) {
    if (!CODEX_WORD.test(a)) continue;
    const m = RESUME_ID.exec(a);
    if (m) return m[1];
  }
  return null;
}

/** True when `tab` is a Codex tab whose Rendered session or Raw thread is `thread`. `resolved` is
 *  the Raw tab's thread from its rollouts (`pickRawThreads`): a string or null (resolved, none
 *  held) replaces the launch line; undefined (never resolved) falls back to it. */
export function holdsCodexThread(tab: CodexThreadTab, thread: string, resolved?: string | null): boolean {
  if (!thread || tab.agent !== "codex") return false;
  if (tab.rendered && tab.rendered.sessionId() === thread) return true;
  if (tab.body !== "terminal" || !tab.alive) return false;
  if (resolved !== undefined) return resolved === thread;
  if (!tab.launchArgs) return false;
  const resume = new RegExp(`(?:^|\\s)resume\\s+['"]?${escapeRe(thread)}['"]?(?=\\s|$)`);
  return tab.launchArgs.some((a) => CODEX_WORD.test(a) && resume.test(a));
}

/** One live Raw Codex tab to resolve: `profile` names its Bare home (null: the default home). */
export interface RawThreadTab {
  id: string;
  cwd: string;
  profile: string | null;
  row?: string | null;
  /** epoch ms of its PTY spawn */
  spawnedMs: number;
  launchThread: string | null;
}

export interface RolloutThread {
  id: string;
  mtimeMs: number;
}

/** The rollout list a tab reads: one per (home, cwd), so a Bare tab never sees default-home rows. */
export const rolloutKey = (profile: string | null, cwd: string, row?: string | null): string => JSON.stringify([profile ?? "", cwd, row ?? ""]);

/** A rollout written this long before a spawn still counts as the tab's (mtime granularity). */
const SPAWN_SLACK_MS = 1000;

/** Each Raw tab's thread: the newest rollout in its own home and cwd written since it spawned that
 *  no other tab holds. `held` are the threads Rendered tabs hold; every pick joins it, so two tabs
 *  never claim one thread. Oldest tab first. With no such rollout, its launch-line id if still
 *  free (the TUI has not written yet), else null: a fresh session holding nothing, never a share. */
export function pickRawThreads(
  tabs: readonly RawThreadTab[],
  rollouts: ReadonlyMap<string, readonly RolloutThread[]>,
  held: Iterable<string>,
): Map<string, string | null> {
  const claimed = new Set(held);
  const out = new Map<string, string | null>();
  for (const t of [...tabs].sort((a, b) => a.spawnedMs - b.spawnedMs)) {
    const rows = rollouts.get(rolloutKey(t.profile, t.cwd, t.row)) ?? [];
    const pick = rows.find((r) => r.mtimeMs >= t.spawnedMs - SPAWN_SLACK_MS && !claimed.has(r.id))?.id
      ?? (t.launchThread && !claimed.has(t.launchThread) ? t.launchThread : null);
    if (pick) claimed.add(pick);
    out.set(t.id, pick);
  }
  return out;
}
