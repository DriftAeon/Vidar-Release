// tools/falcon/build.mjs stageBundle: the bundle a source checkout stages for Vidar's pick_bundle.
// The pick itself is checked in Rust against a real staged checkout (src-tauri/src/falcon/host_launch.rs
// staged_source_bundle, ignored by default); this covers layout, reuse and the live-host refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPrune, settleStage, stageBundle } from "../tools/falcon/build.mjs";
import { resolve as contractPath } from "../tools/lib/paths.mjs";

function fakeCheckout() {
  const root = mkdtempSync(join(tmpdir(), "vidar-source-bundle-"));
  const put = (rel, text) => { const p = join(root, ...rel.split("/")); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  put("tools/claude-sidecar.mjs", "// sidecar");
  put("tools/claude-sidecar-shrink.mjs", "// shrink");
  put("tools/claude-sidecar-mcp-wait.mjs", "// mcp wait");
  put("tools/claude-sidecar-shrink.test.mjs", "// not staged");
  put("node_modules/@anthropic-ai/claude-agent-sdk/package.json", '{"name":"@anthropic-ai/claude-agent-sdk"}');
  put("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", "// sdk");
  put("src-falcon/tauri.conf.json", '{"identifier":"com.example.falcon"}');
  const exe = put("out/falcon.exe", "stub exe");
  return { root, exe, put };
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("stages a schema-4 bundle with the sidecar, SDK and a pointer naming it", () => {
  const { root, exe } = fakeCheckout();
  try {
    const r = stageBundle({ root, exe, imageOf: () => null });
    assert.match(r.bundleId, /^src-[0-9a-f]{16}$/);
    assert.equal(r.repointed, true);
    const m = readJson(join(r.bundleDir, "runtime-manifest.json"));
    assert.equal(m.bundle_id, r.bundleId);
    assert.deepEqual(m.runtimes, ["claude", "codex"]);
    assert.ok(m.created_utc && !m.codex, "no codex block: Falcon uses the installed Codex");
    assert.equal(m.claude.store_exe, "claude.exe");
    assert.ok(m.claude.installed.names.length > 0 && m.claude.installed.candidates.length > 0);
    for (const f of m.files) assert.ok(existsSync(join(r.bundleDir, ...f.path.split("/"))), f.path);
    assert.deepEqual(m.files.map((f) => f.path), [
      "falcon.exe",
      "sidecar/claude-sidecar-mcp-wait.mjs",
      "sidecar/claude-sidecar-shrink.mjs",
      "sidecar/claude-sidecar.mjs",
      "sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      "sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
      "tauri.conf.json",
    ]);
    assert.ok(existsSync(join(r.bundleDir, m.claude.sidecar)) && existsSync(join(r.bundleDir, m.claude.sdk)));
    assert.equal(readJson(contractPath("falconPointer", { root })).bundle_id, r.bundleId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unchanged rerun reuses the bundle; a changed exe stages a new one", () => {
  const { root, exe, put } = fakeCheckout();
  try {
    const first = stageBundle({ root, exe, imageOf: () => null });
    const again = stageBundle({ root, exe, imageOf: () => null });
    assert.equal(again.bundleId, first.bundleId);
    assert.equal(again.reused, true);
    assert.equal(again.repointed, false);
    put("out/falcon.exe", "rebuilt exe");
    const next = stageBundle({ root, exe, imageOf: () => null });
    assert.notEqual(next.bundleId, first.bundleId);
    assert.equal(readJson(contractPath("falconPointer", { root })).previous_bundle_id, first.bundleId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live falcon.exe in this checkout's registry blocks the repoint, not the staging", () => {
  const { root, exe, put } = fakeCheckout();
  try {
    const first = stageBundle({ root, exe, imageOf: () => null });
    const registry = contractPath("falconRegistry", { root });
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, JSON.stringify({ pid: 4242 }));
    put("out/falcon.exe", "rebuilt exe");
    const blocked = stageBundle({ root, exe, imageOf: () => "falcon.exe" });
    assert.equal(blocked.repointed, false);
    assert.match(blocked.refusal, /pid 4242/);
    assert.ok(existsSync(blocked.bundleDir));
    assert.equal(readJson(contractPath("falconPointer", { root })).bundle_id, first.bundleId);
    const unknown = stageBundle({ root, exe, imageOf: () => undefined });
    assert.equal(unknown.repointed, false, "an unreadable process table counts as running");
    const stale = stageBundle({ root, exe, imageOf: () => "notepad.exe" });
    assert.equal(stale.repointed, true, "a reused pid that is not falcon.exe is no host");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bundle whose files drifted from its manifest is refused, not overwritten", () => {
  const { root, exe } = fakeCheckout();
  try {
    const r = stageBundle({ root, exe, imageOf: () => null });
    writeFileSync(join(r.bundleDir, "sidecar", "claude-sidecar.mjs"), "// edited in place");
    assert.throws(() => stageBundle({ root, exe, imageOf: () => null }), /no longer matches its manifest/);
    assert.equal(readFileSync(join(r.bundleDir, "sidecar", "claude-sidecar.mjs"), "utf8"), "// edited in place");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses without the Agent SDK in node_modules", () => {
  const { root, exe } = fakeCheckout();
  try {
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    assert.throws(() => stageBundle({ root, exe, imageOf: () => null }), /npm ci/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// settleStage: what build.mjs does after staging. The prune is injected; no real repo is touched.
function settle({ prune, ...args } = {}) {
  const calls = [], warnings = [];
  const code = settleStage({
    root: "R", result: { refusal: null }, warn: (m) => warnings.push(m), ...args,
    prune: (root) => { calls.push(root); return prune ? prune(root) : { ok: true, detail: "" }; },
  });
  return { code, calls, warnings };
}

test("prunes the staging root after a repoint", () => {
  const r = settle();
  assert.deepEqual(r.calls, ["R"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.warnings, []);
});

test("--no-prune skips the prune", () => {
  const r = settle({ noPrune: true });
  assert.deepEqual(r.calls, []);
  assert.equal(r.code, 0);
});

test("a live-host refusal prunes nothing and keeps exit 2", () => {
  const r = settle({ result: { refusal: "a host is running" } });
  assert.deepEqual(r.calls, []);
  assert.equal(r.code, 2);
});

test("a prune failure or throw only warns; the exit code stays 0", () => {
  const failed = settle({ prune: () => ({ ok: false, detail: "falcon-prune.ps1 exited 1" }) });
  assert.equal(failed.code, 0);
  assert.match(failed.warnings[0], /not pruned.*exited 1/);
  const threw = settle({ prune: () => { throw new Error("boom"); } });
  assert.equal(threw.code, 0);
  assert.match(threw.warnings[0], /boom/);
});

test("runPrune skips quietly when the prune script is absent, and settleStage does not warn", () => {
  const root = mkdtempSync(join(tmpdir(), "vidar-prune-root-"));
  try {
    const out = runPrune(root, join(root, "no-such-prune.ps1"));
    assert.equal(out.ok, true);
    assert.equal(out.skipped, true);
    const warnings = [];
    const code = settleStage({ root, result: { refusal: null }, prune: () => out, warn: (m) => warnings.push(m) });
    assert.equal(code, 0);
    assert.deepEqual(warnings, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runPrune on a temp root without current.json fails closed and reports it", () => {
  const root = mkdtempSync(join(tmpdir(), "vidar-prune-root-"));
  try {
    const out = runPrune(root);
    assert.equal(out.ok, false);
    assert.ok(out.detail);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
