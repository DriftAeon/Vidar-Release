// Explorer run log: one RunLogLine per input verb, appended to $VIDAR_EXPLORER_RUN/run-log.jsonl.
// Unset VIDAR_EXPLORER_RUN logs nothing. Lines are validated against explorer-contracts.mjs
// before they are written. Also holds the per-port state files (turn count, console cursor) that
// sit beside the log in $VIDAR_EXPLORER_RUN/state/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRunLogLine } from "./explorer-contracts.mjs";

export const INPUT_VERBS = ["press", "key", "act", "paste", "send"];

export function stateFile(env, name) {
  const dir = env.VIDAR_EXPLORER_RUN ? path.join(env.VIDAR_EXPLORER_RUN, "state") : os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

export function readState(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeState(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Appends one validated line; throws on an invalid one. @returns {object|null} the line, or null when logging is off */
export function appendRunLog(env, { port, verb, args = [], target, hit, exit = 0, now = new Date() }) {
  if (!env.VIDAR_EXPLORER_RUN) return null;
  const line = { t: now.toISOString(), port, episode: env.VIDAR_EXPLORER_EPISODE ?? "0", verb,
    args: args.map((a) => String(a).slice(0, 200)), exit };
  if (target) line.target = target;
  if (hit) line.hit = hit;
  const errs = validateRunLogLine(line);
  if (errs.length) throw new Error(`run-log line invalid: ${errs.join("; ")}`);
  fs.mkdirSync(env.VIDAR_EXPLORER_RUN, { recursive: true });
  fs.appendFileSync(path.join(env.VIDAR_EXPLORER_RUN, "run-log.jsonl"), JSON.stringify(line) + "\n");
  return line;
}

/** Called by vidar-drive.mjs after an input verb; never throws (a log problem must not fail the verb). */
export function logVerb(env, cmd, port, args, out, exit) {
  if (!INPUT_VERBS.includes(cmd) || !env.VIDAR_EXPLORER_RUN) return;
  try {
    const hit = out?.hit && typeof out.hit.ok === "boolean" ? { ok: out.hit.ok, ...(out.hit.got?.role ? { tag: out.hit.got.role } : {}) } : undefined;
    appendRunLog(env, { port, verb: cmd, args: args.filter((a) => a !== undefined), target: out?.target, hit, exit });
  } catch (e) { console.error(`run log skipped: ${e.message ?? e}`); }
}
