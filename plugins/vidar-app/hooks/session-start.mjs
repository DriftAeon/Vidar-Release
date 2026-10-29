// plugins\vidar-app\hooks\session-start.mjs — SessionStart hook: injects the Vidar app-layer context.
// FALCON_SESSION set -> context\rendered.md; else VIDAR_TAB set -> context\raw.md; else nothing.
// Usage: run by Claude Code via hooks.json. Never throws, always exits 0 (a missing file is silence).

import { readFileSync, realpathSync } from "node:fs";
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

// Same check as tools\mcp\vidar-drive\server.mjs: `\\?\` prefix stripped, realpath, case-folded on Windows.
export const normPath = (p, platform = process.platform) => {
  try {
    const strip = (s) => s.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    let s = strip(String(p));
    try { s = strip(realpathSync(s)); } catch { /* keep the stripped path */ }
    s = resolve(s);
    return platform === "win32" ? s.toLowerCase() : s;
  } catch { return null; }
};
export const isMain = (argv1, metaUrl, platform = process.platform) => {
  const a = argv1 ? normPath(argv1, platform) : null;
  return a !== null && a === normPath(fileURLToPath(metaUrl), platform);
};
if (isMain(process.argv[1], import.meta.url)) {
  try {
    const out = buildOutput(process.env, ROOT, (p) => readFileSync(p, "utf8"));
    if (out) process.stdout.write(out);
  } catch { /* never surface */ }
  process.exit(0);
}
