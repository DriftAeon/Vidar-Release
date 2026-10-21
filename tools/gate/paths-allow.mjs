// `node tools/gate/paths-allow.mjs [--write]`
// Report: current literal counts per id against tests/paths-contract.allow.json.
// --write: lower allowlist counts to the current ones (never raises, never adds an id; a rise exits 1).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "../lib/paths.mjs";
import { scanRepo } from "../lib/paths-scan.mjs";

const base = root();
const file = join(base, "tests", "paths-contract.allow.json");
const allow = JSON.parse(readFileSync(file, "utf8"));
const counts = scanRepo(base);
const write = process.argv.includes("--write");

const rises = [];
const rows = [];
for (const id of new Set([...counts.keys(), ...Object.keys(allow)])) {
  const now = counts.get(id) ?? 0;
  const was = allow[id]?.count;
  rows.push(`${id.padEnd(18)} now ${String(now).padStart(4)}  allow ${was ?? "-"}`);
  if (was === undefined ? now > 0 : now > was) rises.push(`${id}: ${now} > ${was ?? "unlisted"}`);
}
console.log(rows.sort().join("\n"));
if (rises.length) {
  console.error(`\nrise (fix the call site; never raise the allowlist):\n  ${rises.join("\n  ")}`);
  process.exit(1);
}
if (write) {
  for (const id of Object.keys(allow)) allow[id].count = Math.min(allow[id].count, counts.get(id) ?? 0);
  writeFileSync(file, JSON.stringify(allow, null, 2) + "\n");
  console.log("\nallowlist lowered where counts fell");
}
