// finding '<json>' | @<path.json>: appends one FindingLine to $VIDAR_EXPLORER_RUN/findings.jsonl.
// Fills `t` (now) and `episode` ($VIDAR_EXPLORER_EPISODE) when missing, validates, exits 2 on a bad line or
// an unset run. No CDP and no drive budget: vidar-drive.mjs runs findingMain before either.
import fs from "node:fs";
import path from "node:path";
import { validateFindingLine } from "../explorer-contracts.mjs";

/** @returns {{line:object}|{errors:string[]}} */
export function buildFinding(arg, env, now = new Date()) {
  if (!env.VIDAR_EXPLORER_RUN) return { errors: ["VIDAR_EXPLORER_RUN is unset: no run folder to write to"] };
  if (!arg) return { errors: ["usage: finding '<json FindingLine>' | @<path.json>"] };
  let raw = arg;
  if (arg.startsWith("@")) {
    try { raw = fs.readFileSync(arg.slice(1), "utf8"); } catch (e) { return { errors: [`cannot read ${arg.slice(1)}: ${e.message}`] }; }
  }
  let line;
  try { line = JSON.parse(raw); } catch (e) { return { errors: [`not JSON: ${e.message}`] }; }
  if (line && typeof line === "object" && !Array.isArray(line)) {
    if (line.t === undefined) line.t = now.toISOString();
    if (line.episode === undefined && env.VIDAR_EXPLORER_EPISODE !== undefined) line.episode = String(env.VIDAR_EXPLORER_EPISODE);
  }
  const errors = validateFindingLine(line);
  return errors.length ? { errors } : { line };
}

/** Appends a valid line. @returns {{line:object}|{errors:string[]}} */
export function appendFinding(arg, env, now) {
  const r = buildFinding(arg, env, now);
  if (r.line) {
    fs.mkdirSync(env.VIDAR_EXPLORER_RUN, { recursive: true });
    fs.appendFileSync(path.join(env.VIDAR_EXPLORER_RUN, "findings.jsonl"), JSON.stringify(r.line) + "\n");
  }
  return r;
}

/** CLI entry: @returns {number} exit code (0 written, 2 refused). */
export function findingMain(argv, env) {
  const r = appendFinding(argv[0], env);
  if (r.errors) { console.error(`finding refused:\n${r.errors.join("\n")}`); return 2; }
  console.log(JSON.stringify({ ok: true, kind: r.line.kind, goal: r.line.goal }));
  return 0;
}

/** Registry handler (reached only if the early path in vidar-drive.mjs is bypassed). */
export async function finding(ctx) {
  const r = appendFinding(ctx.a1, ctx.env ?? process.env);
  if (r.errors) throw Object.assign(new Error(`finding refused:\n${r.errors.join("\n")}`), { exitCode: 2 });
  return { ok: true, kind: r.line.kind, goal: r.line.goal };
}
