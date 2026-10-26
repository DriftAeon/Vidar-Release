// Explorer runs live in runtime/explorer/<stamp>/ with run-log.jsonl, findings.jsonl,
// shots/*.png|jpg, and state/ (baselines and hashes, removed by the run's down step).
// This command checks goal definitions before a run: node check-goals.mjs [--dir <dir>].
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGoalFile } from "../drive/explorer-contracts.mjs";
import { CORE_GOAL_IDS } from "./core-goals.mjs";

export async function checkGoals(dir) {
  const problems = [];
  let names;
  try { names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort(); }
  catch (e) { return [`${dir}: ${e.message}`]; }
  const seen = new Map();
  for (const name of names) {
    let goal;
    try { goal = JSON.parse(await readFile(resolve(dir, name), "utf8")); }
    catch (e) { problems.push(`${name}: ${e.message}`); continue; }
    for (const error of validateGoalFile(goal)) problems.push(`${name}: ${error}`);
    if (typeof goal?.id === "string") {
      if (seen.has(goal.id)) problems.push(`${name}: duplicate id ${goal.id} (also ${seen.get(goal.id)})`);
      else seen.set(goal.id, name);
    }
  }
  for (const id of CORE_GOAL_IDS) if (!seen.has(id)) problems.push(`missing core goal id ${id}`);
  return problems;
}

async function main(args) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--dir" || !args[1])) {
    console.error("usage: node tools/explorer/check-goals.mjs [--dir <dir>]");
    return 2;
  }
  const problems = await checkGoals(resolve(args[1] ?? "tests/explorer/goals"));
  for (const problem of problems) console.error(problem);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
