// `node tools/gate/index-check.mjs [file]` - INDEX.md shape (retired rune docs-index-size-limit).
// Default files: docs/INDEX.md and docs/explore/INDEX.md.
// Hard fail: an entry that wraps onto a second line (an indented continuation line).
// Warning (exit 0): word count against the cap stated in the file ("under N words"); docs/INDEX.md only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "../lib/paths.mjs";

const rels = process.argv[2] ? [process.argv[2]] : ["docs/INDEX.md", "docs/explore/INDEX.md"];
const wraps = [];

for (const rel of rels) {
  const file = join(root(), rel);
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s+\S/.test(l)) wraps.push(`${rel}:${i + 1}: entry wraps onto a second line: ${l.trim().slice(0, 60)}`);
  });
  if (rel === "docs/INDEX.md") {
    const words = text.split(/\s+/).filter(Boolean).length;
    const cap = Number(/under (\d+) words/.exec(text)?.[1]);
    if (cap && words > cap) console.log(`warning INDEX.md: ${words} words against the cap of ${cap}`);
  }
}

if (wraps.length) {
  console.error(wraps.join("\n"));
  process.exit(1);
}
