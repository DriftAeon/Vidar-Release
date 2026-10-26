// Explorer runs live in runtime/explorer/<stamp>/ with run-log.jsonl, findings.jsonl,
// shots/*.png|jpg, and state/ (baselines and hashes, removed by the run's down step).
// Render one run: node render.mjs --run <dir> [--out <dir>].
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FINDING_KINDS, validateFindingLine } from "../drive/explorer-contracts.mjs";
import { resolve as pathId } from "../lib/paths.mjs";

const ORDER = ["fail", "wanted", "blocked", "detour", "stale", "not-driven", "pass"];
const LABEL = { fail: "Fail", wanted: "Wanted", blocked: "Blocked", detour: "Detour",
  stale: "Stale", "not-driven": "Not Driven", pass: "Pass" };

function escapeMd(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("[", "\\[")
    .replaceAll("]", "\\]").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\n", "<br>");
}

function goalLabel(id) {
  return String(id).split(/[-_\s]+/).filter(Boolean).map((word) =>
    word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export async function renderRun(runDir, outDir) {
  const raw = await readFile(join(runDir, "findings.jsonl"), "utf8");
  const findings = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let finding;
    try { finding = JSON.parse(line); }
    catch (e) { throw new Error(`findings.jsonl:${i + 1}: ${e.message}`); }
    const errors = validateFindingLine(finding);
    if (errors.length) throw new Error(`findings.jsonl:${i + 1}: ${errors.join("; ")}`);
    findings.push(finding);
  }
  const counts = Object.fromEntries(FINDING_KINDS.map((kind) => [kind, 0]));
  for (const finding of findings) counts[finding.kind]++;
  const share = findings.length ? (100 * counts["not-driven"] / findings.length).toFixed(1) : "0.0";
  const lines = ["# Explorer Report", "", `Findings: ${findings.length} · Not Driven: ${share}%`, "",
    ...ORDER.map((kind) => `${LABEL[kind]}: ${counts[kind]}`), ""];
  await mkdir(outDir, { recursive: true });
  let shotNumber = 0;
  for (const kind of ORDER) {
    lines.push(`## ${LABEL[kind]}`, "");
    const group = findings.filter((finding) => finding.kind === kind).sort((a, b) =>
      a.goal.localeCompare(b.goal) || Date.parse(a.t) - Date.parse(b.t));
    let goal;
    for (const finding of group) {
      if (finding.goal !== goal) {
        goal = finding.goal;
        lines.push(`### ${escapeMd(goalLabel(goal))}`, "", `Goal: \`${escapeMd(goal)}\``, "");
      }
      lines.push(`#### Step ${escapeMd(finding.step)}`, "", `- Intent: ${escapeMd(finding.intent)}`,
        `- Did: ${escapeMd(finding.did)}`, `- Observed: ${escapeMd(finding.observed)}`,
        `- Expected: ${escapeMd(finding.expected)}`);
      if (finding.shot) {
        const name = basename(finding.shot);
        const suffix = extname(name).toLowerCase();
        if (!/\.(png|jpg)$/.test(suffix)) throw new Error(`invalid shot: ${finding.shot}`);
        const source = resolve(runDir, "shots", name);
        const target = `shot-${++shotNumber}${suffix}`;
        await copyFile(source, join(outDir, target));
        lines.push(`- Shot: [${escapeMd(name)}](./${target})`);
      }
      if (finding.dup) lines.push(`- Maybe duplicate of ${escapeMd(finding.dup === true ? "unspecified" : finding.dup)}`);
      lines.push("");
    }
  }
  const report = join(outDir, "report.md");
  await writeFile(report, `${lines.join("\n")}\n`, "utf8");
  return report;
}

async function main(args) {
  if (args.length < 2 || args[0] !== "--run" || !args[1] ||
      (args.length !== 2 && (args.length !== 4 || args[2] !== "--out" || !args[3]))) {
    console.error("usage: node tools/explorer/render.mjs --run <dir> [--out <dir>]");
    return 2;
  }
  const run = resolve(args[1]);
  const out = resolve(args[3] ?? join(pathId("displayReviews"), `explorer-${basename(run)}`));
  try { console.log(await renderRun(run, out)); return 0; }
  catch (e) { console.error(e.message); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
