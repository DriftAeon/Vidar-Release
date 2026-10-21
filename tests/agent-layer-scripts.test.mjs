// Vidar-layer scripts for bare tabs (tools/agent-layer/): stdin fixture in, the file written where
// the --root/--home arguments say; missing or relative arguments exit 0 with one stderr line and
// write nothing (hook-side scripts never fail Claude: tools-ps1.md).
// USERPROFILE/HOME point at a trap folder that must stay empty (the scripts never read them).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "../tools/lib/paths.mjs";
import { absoluteArgs, isAbsoluteWin } from "../tools/lib/agent-env.mjs";

const BRIDGE = fileURLToPath(new URL("../tools/agent-layer/statusline-bridge.mjs", import.meta.url));
const ILOG = fileURLToPath(new URL("../tools/agent-layer/instructions-log.mjs", import.meta.url));

const STATUS = {
  session_id: "0a33187a-0000-4000-8000-000000000001",
  transcript_path: "C:\\x\\0a33187a-0000-4000-8000-000000000001.jsonl",
  workspace: { current_dir: "C:\\work\\trial-repo" },
  model: { id: "claude-opus-5-5", display_name: "Opus" },
  context_window: { used_percentage: 12.5 },
};

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "agent-layer-"));
  const root = join(dir, "root");
  const home = join(dir, "homes");
  const trap = join(dir, "trap");
  mkdirSync(root);
  mkdirSync(trap);
  return { dir, root, home, trap, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(script, argv, input, sb, tab = "s3-abc123") {
  return spawnSync(process.execPath, [script, ...argv], {
    input,
    encoding: "utf8",
    env: { ...process.env, VIDAR_TAB: tab, USERPROFILE: sb.trap, HOME: sb.trap },
  });
}

test("statusline-bridge: stdin payload lands verbatim in the tab's sessions file, line on stdout", () => {
  const sb = sandbox();
  try {
    const sessions = resolvePath("sessions", { root: sb.root });
    mkdirSync(sessions, { recursive: true });
    const raw = JSON.stringify(STATUS);
    const r = run(BRIDGE, ["--root", sb.root, "--home", sb.home], raw, sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(sessions, "s3-abc123.json"), "utf8"), raw);
    assert.deepEqual(readdirSync(sessions), ["s3-abc123.json"], "no temp file left");
    assert.match(r.stdout, /\[trial-repo\].*\[Opus\].*Context 12%/);
    assert.deepEqual(readdirSync(sb.trap), []);
  } finally {
    sb.done();
  }
});

test("statusline-bridge: no sessions dir means no mkdir and no write", () => {
  const sb = sandbox();
  try {
    const r = run(BRIDGE, ["--root", sb.root, "--home", sb.home], JSON.stringify(STATUS), sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(resolvePath("sessions", { root: sb.root })), false);
  } finally {
    sb.done();
  }
});

for (const [name, script] of [["statusline-bridge", BRIDGE], ["instructions-log", ILOG]]) {
  test(`${name}: missing or relative arguments exit 0 with one stderr line, write nothing`, () => {
    const sb = sandbox();
    try {
      const sessions = resolvePath("sessions", { root: sb.root });
      mkdirSync(sessions, { recursive: true });
      const cases = [
        [],
        ["--root", sb.root],
        ["--home", sb.home],
        ["--root", "relative\\root", "--home", sb.home],
        ["--root", sb.root, "--home", "C:homes"],
      ];
      for (const argv of cases) {
        const r = run(script, argv, JSON.stringify({ ...STATUS, file_path: "C:\\x\\CLAUDE.md" }), sb);
        assert.equal(r.status, 0, `${argv.join(" ")}: exit ${r.status}`);
        assert.equal(r.stdout, "");
        assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
      }
      assert.deepEqual(readdirSync(sessions), []);
      assert.equal(existsSync(sb.home), false);
      assert.deepEqual(readdirSync(sb.trap), []);
    } finally {
      sb.done();
    }
  });
}

test("instructions-log: one JSON line per event in <home>\\logs\\instructions.jsonl, stdout silent", () => {
  const sb = sandbox();
  try {
    const ev = (p, why) => JSON.stringify({ hook_event_name: "InstructionsLoaded", session_id: "x", file_path: p, memory_type: "Project", load_reason: why });
    for (const [p, why] of [["C:\\repo\\CLAUDE.md", "session_start"], ["C:\\repo\\sub\\CLAUDE.md", "nested_traversal"]]) {
      const r = run(ILOG, ["--root", sb.root, "--home", sb.home], ev(p, why), sb, "s7-zz9");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
    const lines = readFileSync(join(sb.home, "logs", "instructions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["file_path", "load_reason", "memory_type", "tab", "time"]);
    assert.equal(lines[1].file_path, "C:\\repo\\sub\\CLAUDE.md");
    assert.equal(lines[1].load_reason, "nested_traversal");
    assert.equal(lines[0].memory_type, "Project");
    assert.equal(lines[0].tab, "s7-zz9");
    assert.ok(!Number.isNaN(Date.parse(lines[0].time)));
    assert.deepEqual(readdirSync(sb.trap), []);
  } finally {
    sb.done();
  }
});

test("agent-env: only drive or UNC paths count as absolute", () => {
  assert.ok(isAbsoluteWin("C:\\a") && isAbsoluteWin("c:/a") && isAbsoluteWin("\\\\srv\\share\\a"));
  for (const p of ["a\\b", "\\a", "C:a", "", undefined]) assert.equal(isAbsoluteWin(p), false, String(p));
  assert.deepEqual(absoluteArgs(["--root", "C:\\r", "--home", "D:\\h"], ["root", "home"]).values, { root: "C:\\r", home: "D:\\h" });
  assert.match(absoluteArgs(["--root", "C:\\r"], ["root", "home"]).error, /--home/);
});
