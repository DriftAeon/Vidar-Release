// Explorer runs live in runtime/explorer/<stamp>/ with run-log.jsonl, findings.jsonl,
// shots/*.png|jpg, and state/ (baselines and hashes, removed by the run's down step).
// Audit one run: node report-audit.mjs --run <dir>.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFindingLine, validateRunLogLine } from "../drive/explorer-contracts.mjs";

const INPUTS = new Set(["press", "key", "act", "paste", "send"]);
const stamp = (item) => Date.parse(item.value.t);

async function lines(file, label, validate, problems) {
  const result = [];
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch (e) { problems.push(`${label}: -: file: ${e.message}`); return result; }
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const at = `${label}:${index + 1}`;
    let value;
    try { value = JSON.parse(line); }
    catch (e) { problems.push(`unknown: -: invalid line: ${at}: ${e.message}`); continue; }
    const errors = validate(value);
    if (typeof value?.t === "string" && !Number.isFinite(Date.parse(value.t))) errors.push("t: cannot order timestamp");
    if (errors.length) {
      for (const error of errors) problems.push(`${value?.episode ?? value?.goal ?? "unknown"}: ${value?.t ?? "-"}: invalid line: ${at}: ${error}`);
      continue;
    }
    result.push({ value, at });
  }
  return result;
}

// Findings have a goal but no episode. Prefer an exact goal/episode ID match;
// otherwise assign by the interval from an episode's first log to the next one's.
function episodeFor(finding, episodes) {
  if (finding.value.episode !== undefined) {
    const named = episodes.find((ep) => String(ep.id) === finding.value.episode);
    if (named) return named;
  }
  const exact = episodes.find((ep) => String(ep.id) === finding.value.goal);
  if (exact) return exact;
  const time = stamp(finding);
  let chosen;
  for (const ep of episodes) if (ep.start <= time) chosen = ep;
  return chosen ?? episodes[0];
}

export async function auditRun(dir) {
  const problems = [];
  const logs = await lines(join(dir, "run-log.jsonl"), "run-log.jsonl", validateRunLogLine, problems);
  const findings = await lines(join(dir, "findings.jsonl"), "findings.jsonl", validateFindingLine, problems);
  const byId = new Map();
  for (const log of logs) {
    const id = String(log.value.episode);
    if (!byId.has(id)) byId.set(id, { id, start: stamp(log), items: [] });
    byId.get(id).start = Math.min(byId.get(id).start, stamp(log));
    byId.get(id).items.push({ ...log, type: "log" });
  }
  const episodes = [...byId.values()].sort((a, b) => a.start - b.start);
  for (const finding of findings) {
    const ep = episodeFor(finding, episodes);
    if (ep) ep.items.push({ ...finding, type: "finding" });
  }
  for (const ep of episodes) {
    // The crawl is scripted, not a model: its silent presses aren't unreported work, so only line validity applies.
    if (ep.id === "crawl") continue;
    ep.items.sort((a, b) => stamp(a) - stamp(b) || (a.type === "log" ? -1 : 1));
    let inputs = [];
    let lastFinding;
    for (let i = 0; i < ep.items.length; i++) {
      const item = ep.items[i];
      if (item.type === "finding") {
        if (inputs.length > 6) problems.push(`${ep.id}: ${item.value.t}: inputs without detour: ${inputs[0].at}..${inputs.at(-1).at}, ${item.at} (${inputs.length} inputs)`);
        inputs = [];
        lastFinding = item;
        continue;
      }
      if (!INPUTS.has(item.value.verb)) continue;
      inputs.push(item);
      if (item.value.hit?.ok === false) {
        let laterInputs = 0;
        let noticed = false;
        for (const next of ep.items.slice(i + 1)) {
          if (next.type === "finding") { noticed = true; break; }
          if (INPUTS.has(next.value.verb) && ++laterInputs > 2) break;
        }
        if (!noticed) problems.push(`${ep.id}: ${item.value.t}: unnoticed miss: ${item.at} (no finding within next 2 inputs)`);
      }
    }
    if (inputs.length > 6) problems.push(`${ep.id}: ${inputs[0].value.t}: unreported tail: ${lastFinding?.at ?? "start"}, ${inputs[0].at}..${inputs.at(-1).at} (${inputs.length} inputs)`);
  }
  return problems;
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--run" || !args[1]) {
    console.error("usage: node tools/explorer/report-audit.mjs --run <dir>");
    return 2;
  }
  const problems = await auditRun(resolve(args[1]));
  for (const problem of problems) console.error(problem);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
