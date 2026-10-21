// Verify (Codex version pin): dumps the installed Codex's protocol surface and compares it with the committed
// tools/codex-schema/manifest.json, so a new Codex release is accepted without a human when nothing changed.
// Prints exactly one JSON line: {"version","pinned","same","diff"} (diff = manifest.mjs diffMethods output).
//
// Usage: node tools/codex-schema/verify.mjs [--codex <exe|js>] [--out <file>] [--write]
//   --codex  the Codex executable or its npm codex.js; default the entrypoint Vidar spawns, then Path.
//   --out    merge {"<version>": {"pinned", "same", "atMs"}} into this JSON file (created if missing, other keys
//            kept, written tmp then rename). Vidar passes the codexAccepted path (contracts/paths.json) so a
//            same-surface version launches without the "differs from the verified" warning.
//   --write  dev only. When the surface is the same, sets the version in tools/codex-schema/manifest.json
//            `codexVersion`, profiles/bare/codex.json `verifiedVersion`, contracts/codex-server-requests.json
//            `codexVersion` and the "pinned from the X schema" line of src/agents/codex-methods.ts (the drift
//            test compares it), one line each, and prints the commit subject. When it differs, writes
//            docs/inbox/codex-drift-<version>.md for an agent and exits 1; none of the four files is touched.
//
// Refuses: a Codex that cannot be found, run or parsed (exit 1, message on stderr, nothing written).
// Exit codes: 0 verified (same or not, without --write); 1 failure, or --write on a changed surface.
// Never launches Vidar; the only process it spawns is the Codex dump.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffMethods, sameSurface } from "./manifest.mjs";
import { dumpManifest } from "./dump.mjs";
import { resolve as pathId, root as repoRoot } from "../lib/paths.mjs";

const REPO = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Merges one version's verdict into the accepted file; other keys stay. Atomic: tmp, then rename. */
export function mergeAccepted(file, version, entry) {
  let current = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    } catch { /* unreadable: start over, the file only caches verdicts */ }
  }
  current[version] = entry;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return current;
}

/** Replaces the first `"<key>": "<old>"` line value in `file`; false when the key is missing. */
function setVersionLine(file, pattern, version) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(pattern, `$1${version}$2`);
  if (next === text && !pattern.test(text)) return false;
  if (next !== text) writeFileSync(file, next, "utf8");
  return true;
}

function parseArgs(argv) {
  const o = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if ((a === "--codex" || a === "--out") && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown or incomplete argument ${a}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const committed = JSON.parse(readFileSync(join(REPO, "tools/codex-schema/manifest.json"), "utf8"));
  const { version, manifest } = dumpManifest(o.codex ?? null);
  const same = sameSurface(committed, manifest);
  const diff = diffMethods(committed, manifest);
  console.log(JSON.stringify({ version, pinned: committed.codexVersion, same, diff }));
  if (o.out) mergeAccepted(pathResolve(o.out), version, { pinned: committed.codexVersion, same, atMs: Date.now() });
  if (!o.write) return;
  if (!same) {
    const inbox = pathId("inbox", { root: repoRoot(REPO) });
    mkdirSync(inbox, { recursive: true });
    const note = join(inbox, `codex-drift-${version}.md`);
    writeFileSync(note, [
      `# Codex ${version} Changed Its Protocol`,
      "",
      `Pinned ${committed.codexVersion}; installed ${version}. Per group (added, removed, changed, possibleRenames):`,
      "",
      "```json",
      JSON.stringify(diff, null, 2),
      "```",
      "",
      "Run node tools/codex-schema/refresh.mjs, then node --test tests/codex-schema-drift.test.mjs and fix the adapter tables it names.",
      "",
    ].join("\n"), "utf8");
    console.error(`Wrote ${note}`);
    process.exit(1);
  }
  const edits = [
    ["tools/codex-schema/manifest.json", /^(\s*"codexVersion"\s*:\s*")[^"\r\n]*(")/m],
    ["profiles/bare/codex.json", /^(\s*"verifiedVersion"\s*:\s*")[^"\r\n]*(")/m],
    ["contracts/codex-server-requests.json", /^(\s*"codexVersion"\s*:\s*")[^"\r\n]*(")/m],
    ["src/agents/codex-methods.ts", /^(\/\/ Codex app-server method tables \(pinned from the )[\d.]+( schema\))/m],
  ];
  for (const [rel, pattern] of edits) {
    if (!setVersionLine(join(REPO, rel), pattern, version)) throw new Error(`No version line found in ${rel}`);
  }
  console.log(`[Chore] Bare - Verify Codex ${version}`);
}

if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
