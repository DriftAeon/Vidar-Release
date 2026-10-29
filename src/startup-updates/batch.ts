// Update All: the pending CLIs, one after another. No imports, so tests load it under node.
import type { CliUpdate } from "./core.ts";

/** The offers an Update All would start: every row not held back by an open tab of its CLI. */
export function pendingUpdates(updates: readonly CliUpdate[], blocked: (u: CliUpdate) => string | null): CliUpdate[] {
  return updates.filter((u) => !blocked(u));
}

/** Runs `run` on each pending offer in order and stops at the first one that reports failure (its
 *  error is already shown). Resolves with how many succeeded. */
export async function updateAll(
  updates: readonly CliUpdate[], blocked: (u: CliUpdate) => string | null, run: (u: CliUpdate) => Promise<boolean>,
): Promise<number> {
  let done = 0;
  for (const u of pendingUpdates(updates, blocked)) {
    if (!(await run(u))) break;
    done += 1;
  }
  return done;
}
