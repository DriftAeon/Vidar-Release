// renameWithRetry: renameSync that waits out a short scanner hold (Defender, indexer) on rename.
// Retries only EPERM, EBUSY and EACCES, up to 5 tries about 250 ms apart (about 1 s total).
// Usage: import { renameWithRetry } from "../lib/rename-retry.mjs"; renameWithRetry(from, to);
// Refuses: rethrows any error whose code is not a scanner-hold code, and rethrows the last failed try.
// Synchronous: backs off with Atomics.wait, so callers stay synchronous.
import { renameSync } from "node:fs";

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_TRIES = 5;
const RENAME_RETRY_MS = 250;

/**
 * renameSync with a short synchronous backoff on the codes a scanner (Defender, indexer) holds for a moment.
 * Up to 5 tries over about 1 s; any other error, or the last failed try, rethrows.
 */
export function renameWithRetry(from, to) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (attempt >= RENAME_RETRY_TRIES || !RENAME_RETRY_CODES.has(err?.code)) throw err;
      Atomics.wait(sleeper, 0, 0, RENAME_RETRY_MS);
    }
  }
}
