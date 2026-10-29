#!/usr/bin/env node
// lint-case.mjs — refuses a hand-rolled capitalizer in src/**/*.ts. Visible text is cased in one place,
// src/format.ts (label for a word or config value, titleWords for an id or name); a second copy drifts
// (the Runes tab once kept its own acronym table). Flagged shapes: `.charAt(0).toUpperCase()`,
// `[0].toUpperCase()` and `.toUpperCase()` followed by `.slice(1)` on the same line. `case-ok: <reason>` on
// the line suppresses it (ids, keys, wire values, generated code that is not display text).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOME = "src/format.ts";
const SHAPES = [/\.charAt\(0\)\.toUpperCase\(\)/, /\[0\]\.toUpperCase\(\)/, /\.toUpperCase\(\)[^\n]*\.slice\(1\)/];

/** Findings for one file's text: `{ line, text }` per offending line without a `case-ok:` mark. */
export function lintCaseText(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes("case-ok:")) return;
    if (SHAPES.some((re) => re.test(line))) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function main() {
  let bad = 0;
  for (const path of walk(join(ROOT, "src"))) {
    const rel = relative(ROOT, path).replace(/\\/g, "/");
    if (rel === HOME) continue;
    for (const f of lintCaseText(readFileSync(path, "utf8"))) {
      console.error(`lint:case: ${rel}:${f.line}: hand-rolled capitalizer; use label or titleWords from src/format.ts (or add "case-ok: <reason>"): ${f.text}`);
      bad++;
    }
  }
  if (bad) return 1;
  console.log("lint:case: ok");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
