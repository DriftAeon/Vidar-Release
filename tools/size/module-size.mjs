#!/usr/bin/env node
// Module-size gate CLI. Data: contracts/module-size.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, CONTRACT, DOC, BOM, loadContract, measure, renderLedger, spliceLedger, applyWrite, applyAccept,
} from "./module-size-lib.mjs";

const HELP = `usage: node tools/size/module-size.mjs [--write | --accept <path> --reason "<text>"]

  (no flag)   print every scanned file over its line: path, code lines, Rust inline test lines
              (— for other languages), the line, the recorded ceiling and the status.
  --write     lower ceilings to the actual count, drop entries under the line or gone, regenerate
              the ledger block in ${DOC}. Never raises a count, never adds an entry.
  --accept    raise one file's ceiling to its actual count, or add the entry (owed) for an
              over-line file that has none; the reason is appended to its note.
              Main thread only: an executor reports the needed raise instead of running this.`;

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name);

// Both files or neither: the doc splice is computed first, so missing markers fail before any write.
function save(contract) {
  const docAbs = join(ROOT, DOC);
  const raw = readFileSync(docAbs, "utf8");
  const bom = raw.startsWith(BOM) ? BOM : "";
  const doc = bom + spliceLedger(raw.slice(bom.length), renderLedger(contract));
  writeFileSync(join(ROOT, CONTRACT), JSON.stringify(contract, null, 2) + "\n", "utf8");
  writeFileSync(docAbs, doc, "utf8");
}

function print(contract) {
  const { over, unknownExt } = measure(contract);
  const byPath = new Map(contract.entries.map((e) => [e.path, e]));
  const rows = [["file", "code", "tests", "line", "ceiling", "status"]];
  for (const f of over) {
    const e = byPath.get(f.path);
    rows.push([f.path, String(f.code), f.testLines === null ? "—" : String(f.testLines), String(f.line),
      e ? String(e.code) : "—", e ? e.status : "unlisted"]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  "));
  for (const rel of unknownExt) console.log(`no line for extension: ${rel}`);
}

try {
  if (flag("--help") >= 0 || flag("-h") >= 0) {
    console.log(HELP);
  } else if (flag("--accept") >= 0) {
    const path = args[flag("--accept") + 1];
    const r = flag("--reason");
    const reason = r >= 0 ? args[r + 1] : "";
    if (!path || path.startsWith("--")) throw new Error("--accept needs a path");
    const { contract, from, to } = applyAccept(loadContract(), path.replaceAll("\\", "/"), reason);
    save(contract);
    console.log(from === null ? `accept ${path} new entry at ${to} (owed)` : `accept ${path} ${from} -> ${to}`);
  } else if (flag("--write") >= 0) {
    const { contract, log } = applyWrite(loadContract());
    save(contract);
    for (const l of log) console.log(l);
    console.log(`wrote ${CONTRACT} (${contract.entries.length} entries) and the ledger block in ${DOC}`);
  } else if (args.length) {
    throw new Error(`unknown arguments: ${args.join(" ")}\n\n${HELP}`);
  } else {
    print(loadContract());
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
