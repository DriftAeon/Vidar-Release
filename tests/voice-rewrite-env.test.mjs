// The rewrite adapters start an agent CLI on text they did not write, so the child must not
// inherit a hosted tab's control identity (VIDAR_CTL_SECRET, FALCON_SESSION) that reaches
// speak.ps1's env, nor the parent agent's own session vars. Runs each adapter's child_env()
// under the local-voice venv against a seeded environment.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const PY = resolve(ROOT, "content/local-voice/.venv/Scripts/python.exe");
// Full gate only (like paths-contract.test.mjs): the venv is absent on most machines.
const skip = !process.env.VIDAR_FULL_GATE ? "full gate only (VIDAR_FULL_GATE)"
  : existsSync(PY) ? false : "needs the local-voice venv (content/local-voice/.venv)";

const SEED = {
  VIDAR_CTL_SECRET: "s3cret", VIDAR_TAB: "t1", FALCON_SESSION: "f1",
  CLAUDE_CONFIG_DIR: "c", CLAUDECODE: "1", CODEX_THREAD_ID: "x", CODEX_HOME: "h",
  KEEP_ME: "yes",
};

function childEnv(adapter) {
  const dir = resolve(ROOT, "content/packs", adapter, "voice");
  const mod = adapter === "claude" ? "rewrite_claude" : "rewrite_codex";
  const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(dir)}); import ${mod} as m; print(json.dumps(sorted(m.child_env())))`;
  const r = spawnSync(PY, ["-I", "-B", "-c", code], { env: { ...process.env, ...SEED }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return new Set(JSON.parse(r.stdout));
}

test("claude rewrite child drops control, Falcon and Claude session vars", { skip }, () => {
  const env = childEnv("claude");
  for (const k of ["VIDAR_CTL_SECRET", "VIDAR_TAB", "FALCON_SESSION", "CLAUDE_CONFIG_DIR", "CLAUDECODE"]) assert.ok(!env.has(k), k);
  assert.ok(env.has("KEEP_ME"));
});

test("codex rewrite child drops control, Falcon and Codex session vars but keeps CODEX_HOME", { skip }, () => {
  const env = childEnv("codex");
  for (const k of ["VIDAR_CTL_SECRET", "VIDAR_TAB", "FALCON_SESSION", "CODEX_THREAD_ID"]) assert.ok(!env.has(k), k);
  assert.ok(env.has("CODEX_HOME"));
  assert.ok(env.has("KEEP_ME"));
});
