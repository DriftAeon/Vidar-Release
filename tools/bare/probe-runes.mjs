// Probe-runes: one headless Bare turn that proves the rune pointer read and the inline markers (run 2026-10-25-runes-batch).
//
// Usage: node tools/bare/probe-runes.mjs --agent claude|codex
//
// claude -> runs the ignored cargo test `probe_runes_runs_one_real_bare_turn_with_a_recall_set`
//           (src-tauri/src/bare/probe_runes_tests.rs): the real `bare::prepare` on a temp vidar.json whose
//           `claude-bare` row names a temp library's set `probe-runes`, slotting real runes copied from the
//           checkout: two `always` rules (inline, so `<!-- rune: id -->` markers) and RULE, a recall fact (a
//           pointer into the `vidar-runes` skill). The checkout has no launchable set holding both. Then one
//           `claude -p` turn.
//           It writes a manifest and a transcript into this checkout's Bare home and the skill copy under its
//           runeSkills folder. The home index entries its prepare records (`vault:<scratch vault>`) are
//           removed when the test ends, pass or fail (`ProbeEntries`); the folders stay for the transcript
//           read below. The runner then judges the turn itself, never the model's self-report:
//             read     the transcript holds a Read of vidar-runes/<RULE>.md (and `runeReads` names it)
//             answer   the reply carries facts only RULE's body holds, and the payload carries only its pointer
//             markers  a NOTE, never a FAIL (rune markers stay, user pick 2026-10-25): marker text is quoted
//                      only when the model is asked to quote its instructions; reports whether the payload
//                      has markers, the reply quotes any, and the payload's first-list items survive
//           Prints PASS/FAIL/NOTE per check. Exit 0 no FAIL, 1 a FAIL.
// codex  -> the same set and prompt through `probe_runes_runs_one_real_codex_exec_turn_with_a_recall_set`:
//           the `codex-bare` row admitted from the temp vidar.json, the real Codex prepare on its
//           one-shot surface (profile `execArgs`: `codex --no-daemon exec --skip-git-repo-check
//           --color never --profile vidar-<hash12> -o <file> <prompt>`), the reply from `-o`. The
//           transcript is the turn's rollout under its CODEX_HOME\sessions; `read` is a completed
//           `CommandExecution` item (event_msg item_completed) whose parsed `read` path or command
//           names vidar-runes\<RULE>.md. A model-side `custom_tool_call` naming it is an attempt, not a read.
// Refuses (exit 2): an unknown or missing --agent, the cargo test failing, or no result file written.
// Never launches Vidar.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "../lib/paths.mjs";

/** The recall rune the prompt needs, and the body facts only it carries. */
export const RULE = "paths-scan-tracked-only";
export const FACTS = ["git ls-files", "paths-scan.mjs"];
export const PROMPT = [
  "Two tasks, answered in this order.",
  "1. Which exact git command does Vidar's paths-contract test use to list the files it scans, and which script file holds that scan? Answer from the on-demand rule your instructions point to for this.",
  "2. Quote the first list in your instructions verbatim, every item.",
].join("\n");
/** The ignored cargo test each agent runs. */
export const TESTS = {
  claude: "probe_runes_runs_one_real_bare_turn_with_a_recall_set",
  codex: "probe_runes_runs_one_real_codex_exec_turn_with_a_recall_set",
};

const flat = (s) => s.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const MARKER = /<!--\s*rune:\s*[a-z0-9-]+\s*-->/i;
const MARKER_TEXT = /rune:\s*[a-z0-9-]+/i;

/** The payload's first markdown list: its items, marker lines skipped (a marker never ends a list). */
export function firstList(payload) {
  const items = [];
  for (const raw of payload.replace(/\r/g, "").split("\n")) {
    if (MARKER.test(raw.trim()) && raw.trim().startsWith("<!--")) continue;
    const m = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(raw);
    if (m) items.push(m[1]);
    else if (items.length && raw.startsWith("  ") && raw.trim()) items[items.length - 1] += ` ${raw.trim()}`;
    else if (items.length) break;
  }
  return items;
}

/** The transcript lines holding a Read tool_use of vidar-runes/<id>.md. */
export function readLines(transcriptText, id) {
  const want = `vidar-runes/${id}.md`.toLowerCase();
  return transcriptText.split("\n").filter((l) => {
    if (!l.includes('"tool_use"')) return false;
    try {
      const v = JSON.parse(l);
      return (v.message?.content ?? []).some((c) => c.type === "tool_use" && c.name === "Read" && String(c.input?.file_path ?? "").replace(/\\/g, "/").toLowerCase().endsWith(want));
    } catch {
      return false;
    }
  });
}

const namesRune = (s, id) => String(s ?? "").replace(/[\\/]+/g, "/").toLowerCase().includes(`vidar-runes/${id}.md`.toLowerCase());

/** The rollout lines holding a completed CommandExecution that read vidar-runes/<id>.md (Codex). */
export function codexReadLines(rolloutText, id) {
  return rolloutText.split("\n").filter((l) => {
    if (!l.includes('"CommandExecution"')) return false;
    try {
      const v = JSON.parse(l);
      const item = v.payload?.item ?? {};
      if (v.type !== "event_msg" || v.payload?.type !== "item_completed" || item.type !== "CommandExecution" || item.status !== "completed") return false;
      return (item.parsed_cmd ?? []).some((p) => p.type === "read" && namesRune(p.path, id)) || (item.command ?? []).some((a) => namesRune(a, id));
    } catch {
      return false;
    }
  });
}

/** Model-side Codex tool calls naming vidar-runes/<id>.md: attempts, reported when no read completed. */
export function codexAttempts(rolloutText, id) {
  return rolloutText.split("\n").filter((l) => l.includes('"response_item"') && /"(custom_tool_call|function_call)"/.test(l) && namesRune(l, id)).length;
}

/** [name, verdict, why] per check, from the test's result and the transcript (or rollout) text. */
export function judge(result, transcriptText, agent = "claude") {
  const out = [];
  const codex = agent === "codex";
  const lines = transcriptText ? (codex ? codexReadLines : readLines)(transcriptText, RULE) : [];
  const named = (result.runeReads ?? []).includes(RULE);
  const kind = codex ? "completed command line(s) reading" : "Read line(s) of";
  const tried = codex && !lines.length && transcriptText ? `; ${codexAttempts(transcriptText, RULE)} tool call(s) naming it` : "";
  out.push(["read", lines.length && named ? "PASS" : "FAIL", transcriptText ? `${lines.length} ${kind} vidar-runes/${RULE}.md; runeReads ${JSON.stringify(result.runeReads ?? [])}${tried}` : codex ? "no rollout" : "no transcript"]);

  const payload = result.payload ?? "";
  const reply = flat(result.reply ?? "");
  const pointer = payload.includes(`Read ${RULE}.md in skill vidar-runes`);
  const inline = FACTS.some((f) => payload.includes(f));
  const missing = FACTS.filter((f) => !reply.includes(flat(f)));
  out.push(["answer", pointer && !inline && !missing.length ? "PASS" : "FAIL", !pointer ? "payload carries no pointer to the rule" : inline ? "payload carries the rule body inline" : missing.length ? `reply lacks ${missing.join(", ")}` : `reply holds ${FACTS.join(", ")}`]);

  const items = firstList(payload);
  const lost = items.filter((i) => !reply.includes(flat(i).split(" ").slice(0, 6).join(" ")));
  const why = !MARKER.test(payload) ? "payload carries no rune marker"
    : MARKER_TEXT.test(result.reply ?? "") ? "reply quotes rune marker text"
    : !items.length ? "payload has no list"
    : lost.length ? `reply drops ${lost.length}/${items.length} item(s): ${lost.map((i) => i.slice(0, 40)).join(" | ")}`
    : `no marker in reply; ${items.length}/${items.length} first-list items quoted`;
  out.push(["markers", "NOTE", why]);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--agent");
  const agent = i >= 0 ? argv[i + 1] : undefined;
  if (!Object.hasOwn(TESTS, agent ?? "")) {
    console.error("Usage: node tools/bare/probe-runes.mjs --agent claude|codex");
    process.exit(2);
  }
  const repo = root();
  const out = join(tmpdir(), `vidar-runes-probe-result-${process.pid}.json`);
  rmSync(out, { force: true });
  const probe = spawnSync(
    "cargo",
    ["test", "--manifest-path", join(repo, "src-tauri", "Cargo.toml"), TESTS[agent], "--", "--ignored", "--nocapture", "--test-threads=1"],
    { cwd: repo, encoding: "utf8", env: { ...process.env, VIDAR_PROBE_PROMPT: PROMPT, VIDAR_PROBE_OUT: out }, timeout: 900000 },
  );
  if (!existsSync(out)) {
    console.error(`${probe.stdout ?? ""}${probe.stderr ?? ""}`.split("\n").slice(-30).join("\n"));
    console.error("The probe test wrote no result; nothing judged.");
    process.exit(2);
  }
  const result = JSON.parse(readFileSync(out, "utf8"));
  rmSync(out, { force: true });
  const transcriptText = result.transcript && existsSync(result.transcript) ? readFileSync(result.transcript, "utf8") : "";
  console.log(`sets       ${(result.sets ?? []).join(", ")}  rule ${RULE}`);
  console.log(`exit       ${result.status}`);
  console.log(`transcript ${result.transcript ?? "none"}`);
  if (agent === "codex") {
    for (const l of codexReadLines(transcriptText, RULE)) console.log(`  Command  ${JSON.parse(l).payload.item.command.at(-1)}`);
  } else {
    for (const l of readLines(transcriptText, RULE)) {
      const c = JSON.parse(l).message.content.find((x) => x.type === "tool_use" && x.name === "Read");
      console.log(`  Read     ${c.input.file_path}`);
    }
  }
  console.log(`reply\n${String(result.reply ?? "").trim().replace(/^/gm, "  | ")}`);
  const checks = judge(result, transcriptText, agent);
  for (const [name, verdict, why] of checks) console.log(`${verdict.padEnd(4)} ${name.padEnd(8)} ${why}`);
  process.exit(checks.every(([, v]) => v !== "FAIL") && probe.status === 0 ? 0 : 1);
}

if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
