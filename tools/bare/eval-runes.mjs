// Eval-runes: grades whether a recall rune is read, and applied, when its text is not always-on (run 2026-10-25-runes-batch).
//
// What it does: reads a suite `<lib>/evals/<rune-id>/<case>/{prompt.md,case.json}` and runs one headless Bare turn per
//   planned session through the probe (`probe_runes_runs_one_real_bare_turn_with_a_recall_set`, driven by
//   VIDAR_PROBE_CASE / VIDAR_PROBE_OUT).
//   case.json: the contract's fields minus `prompt` (taken from prompt.md): the slotted rune ids (default: just the target), `scaffold`,
//   `model`, `timeoutSec`, `unsetTab`; plus graders `kind` (unprompted|prompted|unrelated), `fact` (regex on stdout),
//   `behaviour` ({ "pattern": re } on stdout, or { "path": p, "pattern": re } on a cwdFiles entry), `forbiddenReads`
//   (rune ids that must not be read), and `arms` (prompted/unrelated only; default ["recall"]).
//   Plan: unprompted cases run three recall sessions per model per case, then off and always once each.
//   Prompted/unrelated run one session per arm they name. All planned checks run after recall misses.
//   Off/always order alternates per case as tools/lab/plan.mjs does.
//   Judged from the transcript (a Read of vidar-runes/<id>.md, either slash) and stdout, never the model's claims.
//   `timedOut` is a fail. A probe that exits non-zero with no out file, an `error` result, or an agent exit
//   status != 0 is a Harness Error: not a miss, never stops a rune or counts toward a verdict; 2 in a row abort
//   the run (stderr tail printed, exit 1). Sessions run strictly one at a time.
//   Output: <runs>/<date>-rune-eval/{sessions.jsonl,result.json,report.md}. The cwd of every session is a
//   synthetic scaffold, not the real checkout; the report says so.
//
// Usage:
//   node tools/bare/eval-runes.mjs --lib <dir> [--rune <id>[,<id>]] [--model <m>] [--confirm-model <m>] --dry
//   node tools/bare/eval-runes.mjs [same flags] --confirm <planned-count>
//   --lib is required (e.g. the checkout's runes folder). The planned count is exact unless a harness error aborts.
// Refuses (exit 2): no --lib; a real run without --confirm, or one that differs from the planned count; an unknown flag; a
//   missing suite, a bad case.json (kind, regex, no grader, target not in runes), or no case selected.
// Never launches Vidar. Do not run it from an agent session without the user's go: each session is a paid model turn.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, root } from "../lib/paths.mjs";
import { TESTS, readLines } from "./probe-runes.mjs";

const KINDS = ["unprompted", "prompted", "unrelated"];
const ARMS = ["off", "always", "recall"];
export const UNPROMPTED_SESSIONS = 3;
export const VERDICTS = { safe: "Recall-Safe", keep: "Keep Always-On", offPass: "Off Arm Passes: Check the Case", harness: "No Verdict: Harness Error" };

const stripBom = (s) => s.replace(/^﻿/, "");
const re = (s) => new RegExp(s, "i");
const fail = (msg) => Object.assign(new Error(msg), { refusal: true });

/** Loads <lib>/evals/<rune>/<case>; throws a refusal on a bad case. `only` filters rune ids. */
export function loadSuite(lib, only = []) {
  const dir = join(lib, "evals");
  if (!existsSync(dir)) throw fail(`No suite: ${dir} does not exist`);
  const cases = [];
  for (const rune of readdirSync(dir).sort()) {
    if (only.length && !only.includes(rune)) continue;
    const rdir = join(dir, rune);
    for (const name of readdirSync(rdir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      const cdir = join(rdir, name);
      const where = `${rune}/${name}`;
      let c;
      try {
        c = JSON.parse(stripBom(readFileSync(join(cdir, "case.json"), "utf8")));
        c.prompt = readFileSync(join(cdir, "prompt.md"), "utf8").trim();
      } catch (e) {
        throw fail(`Bad case ${where}: ${e.message}`);
      }
      if (!KINDS.includes(c.kind)) throw fail(`Bad case ${where}: kind must be ${KINDS.join("|")}`);
      c.runes = c.runes ?? [rune];
      if (!c.runes.includes(rune)) throw fail(`Bad case ${where}: runes does not hold the target ${rune}`);
      if (!c.fact && !c.behaviour) throw fail(`Bad case ${where}: needs a fact or behaviour grader`);
      try {
        if (c.fact) re(c.fact);
        if (c.behaviour) re(c.behaviour.pattern);
      } catch (e) {
        throw fail(`Bad case ${where}: ${e.message}`);
      }
      c.arms = c.kind === "unprompted" ? ["recall", "off", "always"] : (c.arms ?? ["recall"]);
      if (!c.arms.every((a) => ARMS.includes(a))) throw fail(`Bad case ${where}: arms must be from ${ARMS.join(", ")}`);
      cases.push({ ...c, target: rune, name, id: where });
    }
  }
  if (!cases.length) throw fail("No cases selected");
  return cases;
}

/** Planned sessions: three independent recall turns per model and case, then case checks. */
export function planSessions(cases, { model, confirmModel } = {}) {
  const plan = [];
  const unprompted = cases.filter((c) => c.kind === "unprompted");
  for (const c of unprompted) for (let i = 0; i < UNPROMPTED_SESSIONS; i++) plan.push({ phase: "recall", c, arm: "recall", model });
  if (confirmModel) for (const c of unprompted) for (let i = 0; i < UNPROMPTED_SESSIONS; i++) plan.push({ phase: "confirm", c, arm: "recall", model: confirmModel });
  cases.forEach((c, i) => {
    const arms = c.kind === "unprompted" ? ["off", "always"] : c.arms;
    for (const arm of i % 2 === 0 ? arms : [...arms].reverse()) plan.push({ phase: "check", c, arm, model });
  });
  return plan;
}

/** One session's grade from the probe result (null = no out file) and the transcript text. */
export function grade(c, arm, result, transcriptText) {
  if (!result) return { pass: false, why: "no out file" };
  if (result.timedOut) return { pass: false, why: "timed out" };
  if (result.error) return { pass: false, why: `probe error: ${result.error}` };
  const stdout = String(result.stdout ?? "");
  const reads = (id) => readLines(transcriptText, id).length > 0;
  const read = reads(c.target);
  const forbidden = [...new Set([...(c.forbiddenReads ?? []), ...(c.kind === "unrelated" ? [c.target] : [])])].filter(reads);
  const fact = c.fact ? re(c.fact).test(stdout) : null;
  let behaviour = null;
  if (c.behaviour) {
    const b = c.behaviour;
    const text = b.path
      ? (result.cwdFiles ?? []).filter((f) => f.path.replace(/\\/g, "/") === b.path.replace(/\\/g, "/")).map((f) => f.text ?? "").join("\n")
      : stdout;
    behaviour = re(b.pattern).test(text);
  }
  // TODO: Decide whether a prompted recall pass requires a rune read or only the right answer.
  const pass = fact !== false && behaviour !== false && !forbidden.length && (arm !== "recall" || c.kind === "unrelated" || read);
  return { pass, read, fact, behaviour, forbidden };
}

const runnerCode = (status) => (status && typeof status === "object" ? status.status : status);

/** A harness error, not a miss: the probe broke before a model graded anything (timedOut stays a fail). */
export function isHarnessError(status, result) {
  if (result?.timedOut) return false;
  if (!result) return typeof runnerCode(status) !== "number" || runnerCode(status) !== 0;
  if (result.error) return true;
  return typeof result.status === "number" && result.status !== 0;
}

function harnessWhy(status, result) {
  if (!result) return `probe exited ${runnerCode(status)} with no out file`;
  if (result.error) return String(result.error);
  return `agent exited ${result.status}: ${String(result.stdout ?? result.reply ?? "").trim().slice(0, 200)}`;
}

/** The default runner: the probe's cargo test, with the case file and out file in the env. */
export function spawnRunner(repo, agent = "claude") {
  return (caseFile, outFile, c) => {
    const p = spawnSync(
      "cargo",
      ["test", "--manifest-path", join(repo, "src-tauri", "Cargo.toml"), TESTS[agent], "--", "--ignored", "--nocapture", "--test-threads=1"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, VIDAR_PROBE_CASE: caseFile, VIDAR_PROBE_OUT: outFile }, timeout: ((c.timeoutSec ?? 180) + 600) * 1000 },
    );
    return { status: p.status, tail: `${p.stdout ?? ""}${p.stderr ?? ""}`.split("\n").slice(-30).join("\n") };
  };
}

function summarise(sessions, planned) {
  const runes = {};
  const empty = () => ({ unprompted: { ran: 0, read: 0, pass: 0 }, confirm: { ran: 0, pass: 0 }, arms: {}, cases: {}, harness: 0 });
  for (const s of sessions) {
    const r = (runes[s.rune] ??= empty());
    if (s.harness) {
      r.harness++;
      continue;
    }
    const byCase = (r.cases[s.case] ??= { recall: { ran: 0, pass: 0 }, confirm: { ran: 0, pass: 0 } });
    const a = (r.arms[s.arm] ??= { ran: 0, pass: 0, fact: 0, behaviour: 0 });
    a.ran++;
    if (s.pass) a.pass++;
    if (s.fact) a.fact++;
    if (s.behaviour) a.behaviour++;
    if (s.phase === "recall") {
      r.unprompted.ran++;
      if (s.read) r.unprompted.read++;
      if (s.pass) r.unprompted.pass++;
      byCase.recall.ran++;
      if (s.pass) byCase.recall.pass++;
    }
    if (s.phase === "confirm") {
      r.confirm.ran++;
      if (s.pass) r.confirm.pass++;
      byCase.confirm.ran++;
      if (s.pass) byCase.confirm.pass++;
    }
  }
  for (const r of Object.values(runes)) {
    const off = r.arms.off, always = r.arms.always;
    r.readRate = r.unprompted.ran ? r.unprompted.read / r.unprompted.ran : null;
    const majority = (a) => a.ran === UNPROMPTED_SESSIONS && a.pass > a.ran / 2;
    const recallPassed = Object.values(r.cases).every((c) => !c.recall.ran || majority(c.recall));
    const confirmPassed = Object.values(r.cases).every((c) => !c.confirm.ran || majority(c.confirm));
    r.verdict = r.harness || !Object.keys(r.arms).length ? VERDICTS.harness
      : off?.pass ? VERDICTS.offPass
      : !r.unprompted.ran || !recallPassed || !confirmPassed || !always?.ran || always.pass < always.ran ? VERDICTS.keep
      : VERDICTS.safe;
  }
  return { planned, ran: sessions.length, runes };
}

export function report(date, result, opts) {
  const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  const lines = [
    `# Rune Recall Eval ${date}`,
    "",
    `Sessions ran in a synthetic scaffold cwd (a small scratch repo per case), not the real checkout. Model ${opts.model ?? "per case"}${opts.confirmModel ? `, unprompted recall re-checked on ${opts.confirmModel}` : ""}. ${result.ran} of up to ${result.planned} planned sessions ran. The off arm only validates the case.`,
    "",
  ];
  for (const [id, r] of Object.entries(result.runes)) {
    lines.push(`## ${id}`, "", `- Read rate unprompted: ${pct(r.readRate)} (${r.unprompted.read}/${r.unprompted.ran})`);
    for (const [name, c] of Object.entries(r.cases)) {
      if (c.recall.ran) lines.push(`- ${name} recall majority: ${c.recall.pass}/${c.recall.ran}`);
      if (c.confirm.ran) lines.push(`- ${name} confirm majority: ${c.confirm.pass}/${c.confirm.ran}`);
    }
    for (const [arm, a] of Object.entries(r.arms)) lines.push(`- ${arm}: pass ${a.pass}/${a.ran}, fact ${a.fact}/${a.ran}, behaviour ${a.behaviour}/${a.ran}`);
    if (r.harness) lines.push(`- Harness Error: ${r.harness} session(s), not counted`);
    lines.push(`- Verdict: ${r.verdict}`, "");
  }
  if (result.aborted) lines.push("## Aborted", "", "Run stopped after 2 consecutive Harness Error sessions. Stderr tail:", "", "```", result.tail ?? "", "```", "");
  return lines.join("\n");
}

/** Runs the plan strictly serially; `run(caseFile, outFile, c)` is injected (a fake in tests). */
export function runSuite(cases, opts, run, { outDir, tmp = tmpdir(), now = () => new Date() } = {}) {
  const plan = planSessions(cases, opts);
  const date = now().toISOString().slice(0, 10);
  mkdirSync(outDir, { recursive: true });
  const jsonl = join(outDir, "sessions.jsonl");
  const outFile = join(tmp, `vidar-eval-runes-${process.pid}.json`);
  const caseFile = join(tmp, `vidar-eval-runes-case-${process.pid}.json`);
  const sessions = [];
  let streak = 0;
  let aborted = false;
  let lastTail = "";
  for (const item of plan) {
    const c = item.c;
    const { prompt, arms, kind, fact, behaviour, forbiddenReads, id, name, ...probe } = c;
    const body = { ...probe, runes: c.runes, target: c.target, arm: item.arm, prompt };
    if (item.model ?? c.model) body.model = item.model ?? c.model;
    writeFileSync(caseFile, JSON.stringify(body));
    rmSync(outFile, { force: true });
    const t0 = Date.now();
    let status = null;
    try {
      status = run(caseFile, outFile, c);
    } catch (e) {
      status = `runner threw: ${e.message}`;
    }
    let result = null;
    if (existsSync(outFile)) {
      try {
        result = JSON.parse(stripBom(readFileSync(outFile, "utf8")));
      } catch {
        result = null;
      }
    }
    const tp = result?.transcript;
    const transcript = tp && existsSync(tp) ? readFileSync(tp, "utf8") : "";
    const harness = isHarnessError(status, result);
    const g = harness ? { pass: false, harness: true, why: `Harness Error: ${harnessWhy(status, result)}` } : grade(c, item.arm, result, transcript);
    const s = { rune: c.target, case: name, kind, phase: item.phase, arm: item.arm, model: body.model ?? null, status: typeof status === "object" && status ? status.status : status, ms: Date.now() - t0, ...g };
    sessions.push(s);
    appendFileSync(jsonl, `${JSON.stringify(s)}\n`);
    if (harness) {
      streak++;
      lastTail = (status && status.tail) || String(result?.error ?? result?.stdout ?? "");
      if (streak >= 2) {
        aborted = true;
        break;
      }
      continue;
    }
    streak = 0;
  }
  const result = summarise(sessions, plan.length);
  if (aborted) {
    result.aborted = true;
    result.tail = lastTail;
  }
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(outDir, "report.md"), report(date, result, opts));
  rmSync(outFile, { force: true });
  rmSync(caseFile, { force: true });
  return result;
}

export function parseArgs(argv) {
  const o = { dry: false };
  const val = { "--lib": "lib", "--rune": "rune", "--model": "model", "--confirm-model": "confirmModel", "--confirm": "confirm", "--out": "out" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry") o.dry = true;
    else if (Object.hasOwn(val, argv[i]) && argv[i + 1] !== undefined) o[val[argv[i]]] = argv[++i];
    else throw fail(`Unknown or incomplete flag: ${argv[i]}`);
  }
  return o;
}

function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (!o.lib) throw fail("Refusing: --lib <dir> is required (the library whose evals/ folder holds the suite)");
    const lib = pathResolve(o.lib);
    const cases = loadSuite(lib, o.rune ? o.rune.split(",") : []);
    const opts = { model: o.model, confirmModel: o.confirmModel };
    const plan = planSessions(cases, opts);
    if (o.dry) {
      plan.forEach((p, i) => console.log(`${String(i + 1).padStart(3)}  ${p.phase.padEnd(7)} ${p.c.id.padEnd(48)} ${p.arm.padEnd(7)} ${p.model ?? p.c.model ?? "-"}`));
      console.log(`${plan.length} sessions planned (unless consecutive Harness Errors abort the run)`);
      return;
    }
    if (o.confirm === undefined || Number(o.confirm) !== plan.length) throw fail(`Refusing: --confirm must equal the planned count ${plan.length} (got ${o.confirm ?? "none"}); see --dry`);
    const outDir = o.out ? pathResolve(o.out) : join(resolve("runs"), `${new Date().toISOString().slice(0, 10)}-rune-eval`);
    const result = runSuite(cases, opts, spawnRunner(root()), { outDir });
    for (const [id, r] of Object.entries(result.runes)) console.log(`${id}: ${r.verdict}`);
    console.log(`${result.ran}/${result.planned} sessions; report ${join(outDir, "report.md")}`);
    if (result.aborted) {
      console.error(`Aborted after 2 consecutive Harness Errors. Tail:\n${result.tail}`);
      process.exit(1);
    }
  } catch (e) {
    if (!e.refusal) throw e;
    console.error(e.message);
    process.exit(2);
  }
}

if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
