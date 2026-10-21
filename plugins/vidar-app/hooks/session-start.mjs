// plugins\vidar-app\hooks\session-start.mjs — SessionStart hook: injects the Vidar app-layer context.
// FALCON_SESSION set -> context\rendered.md; else VIDAR_TAB set -> context\raw.md; else nothing.
// Usage: run by Claude Code via hooks.json. Never throws, always exits 0 (a missing file is silence).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CONTEXT = resolve(HERE, "../context");

/** Pure: the hook's stdout string ("" for no output). `readFile(path)` returns text or throws. */
export function buildOutput(env, root, readFile, contextDir = CONTEXT) {
  try {
    const name = env.FALCON_SESSION ? "rendered.md" : env.VIDAR_TAB ? "raw.md" : null;
    if (!name) return "";
    const body = readFile(resolve(contextDir, name));
    if (typeof body !== "string" || !body.trim()) return "";
    const additionalContext =
      `Vidar install root: ${root}. Relative tool and runtime paths below resolve against it.\n\n${body}`;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
  } catch {
    return "";
  }
}

const real = (p) => { try { return resolve(p).toLowerCase(); } catch { return null; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    const out = buildOutput(process.env, ROOT, (p) => readFileSync(p, "utf8"));
    if (out) process.stdout.write(out);
  } catch { /* never surface */ }
  process.exit(0);
}
