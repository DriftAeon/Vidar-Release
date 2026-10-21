// Startup update policy: version ordering, remembered skips and a bounded check.
export interface CliUpdate {
  id: string;
  label: string;
  installed: string;
  latest: string;
}
export interface CliUpdateBusy { id: string; label: "Updating…" | "Saving…" }

type Version = { core: number[]; pre: string[] };
function version(text: string): Version | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(text);
  if (!m) return null;
  const core = m.slice(1, 4).map(Number);
  const pre = m[4]?.split(".") ?? [];
  return core.every(Number.isSafeInteger) && !pre.some((x) => /^\d+$/.test(x) && x.length > 1 && x.startsWith("0"))
    ? { core, pre } : null;
}

/** null means unreadable: an unknown version must never become an update offer. */
export function compareVersions(a: string, b: string): number | null {
  const x = version(a), y = version(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i]);
  if (!x.pre.length || !y.pre.length) return Math.sign(Number(!x.pre.length) - Number(!y.pre.length));
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return l.length === r.length ? (l < r ? -1 : 1) : Math.sign(l.length - r.length);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function skippedVersions(state: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const id of ["gemini", "codex", "claude", "pi"]) {
    const value = state[`startupUpdates.skip.${id}`];
    if (typeof value === "string" && version(value)) result[id] = value;
  }
  return result;
}

export function offeredUpdates(updates: CliUpdate[], skipped: Record<string, string>): CliUpdate[] {
  return updates.filter((u) => compareVersions(u.latest, u.installed) === 1 &&
    (!skipped[u.id] || compareVersions(u.latest, skipped[u.id]) === 1));
}

/** An explicit check: strictly newer offers only, skipped versions included (asking means wanting to
 *  see them). Rejects with the fetch's error, or "Check Timed Out"; a late result is discarded. */
export async function explicitCheck(fetch: () => Promise<CliUpdate[]>, timeoutMs = 15_000): Promise<CliUpdate[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const updates = await Promise.race([
      Promise.resolve().then(fetch),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Check Timed Out")), timeoutMs); }),
    ]);
    return offeredUpdates(updates, {});
  } finally { clearTimeout(timer); }
}

/** A late result is discarded; both rejection and offline timeout are quiet. */
export async function quietCheck<T>(check: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
