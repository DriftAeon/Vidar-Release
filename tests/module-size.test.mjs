// The module-size rule as a test: every scanned file over its
// line has an entry in contracts/module-size.json, no file grows past its recorded ceiling, and the
// ledger block in the doc is the render of that JSON. Fixes: `node tools/size/module-size.mjs --write`,
// or ask the main thread for `--accept`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, DOC, CLI, loadContract, treeProblems, renderLedger, ledgerInDoc, readText,
} from "../tools/size/module-size-lib.mjs";

test("JSON covers the tree", () => {
  const problems = treeProblems(loadContract());
  assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});

const ledgerSkip = existsSync(join(ROOT, DOC)) ? false : `${DOC} is not in this tree (docs not shipped)`;

test("ledger matches JSON", { skip: ledgerSkip }, () => {
  const found = ledgerInDoc(readText(join(ROOT, DOC)));
  assert.notEqual(found, null, `${DOC}: ledger markers missing`);
  const want = renderLedger(loadContract());
  if (found === want) return;
  const f = found.split("\n");
  const w = want.split("\n");
  let i = 0;
  while (i < Math.max(f.length, w.length) && f[i] === w[i]) i++;
  assert.fail(`${DOC}: ledger block differs from the JSON at row ${i + 1}\n  doc:  ${f[i] ?? "(none)"}\n  json: ${w[i] ?? "(none)"}\nrun \`${CLI} --write\``);
});
