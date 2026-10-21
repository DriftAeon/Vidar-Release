// tools/bare/sweep.mjs judge: the verdict rules the canary sweep reports, on synthetic cells (importing the
// module spawns nothing; main runs only as a script).
import baseTest from "node:test";
import assert from "node:assert/strict";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

// tools/bare/sweep.mjs is not in the claude-codex source set: skip with the path named.
const skip = missingInputs(import.meta.url, "../tools/bare/sweep.mjs");
const { judge, manifestDropHits } = skip ? {} : await import("../tools/bare/sweep.mjs");
const test = guard(baseTest, skip);

const MARKER = "VIDAR-PAYLOAD-000000000000";
const sb = {
  marker: MARKER,
  sites: [
    { id: "REPOMD", cells: ["repo"], token: "CANARY-REPOMD-0000000A" },
    { id: "USERMD", cells: ["repo"], token: "CANARY-USERMD-0000000B" },
    { id: "LATER", cells: ["repo"], token: "CANARY-LATER-0000000C", positiveOwed: "P9: no reader known yet" },
    { id: "NOBODY", cells: ["repo"], token: "CANARY-NOBODY-0000000D", noReader: "settled: nothing reads it" },
  ],
};
const ALL = { cells: ["repo", "agents-only", "lazy"], control: true };
const shell = { names: 1, dropHits: [] };
const cell = (mode, seen = {}, extra = {}) => ({
  name: `${mode}-repo`, mode, cell: "repo", request: { ok: true, subtype: "success" }, seen,
  marker: mode === "bare" ? "reply" : null, canaryHits: [], env: { passed: shell, shell }, ...extra,
});
const positives = { REPOMD: ["reply"], USERMD: ["reply"] };
const controls = [cell("control-user", { REPOMD: ["reply"], USERMD: ["reply"] }), cell("control-open", { REPOMD: ["reply"] })];

test("judge: a site without a default positive fails as NO POSITIVE", () => {
  const r = judge(sb, [cell("bare"), cell("default", { REPOMD: ["reply"] }), ...controls], {}, ALL);
  assert.equal(r.rows.find((x) => x.site === "USERMD").default, "NO POSITIVE");
  assert.ok(r.fails.includes("USERMD has no default positive"));
  assert.equal(r.verdict, "FAIL");
});

test("judge: positiveOwed is reported, noReader is labelled, neither fails", () => {
  const r = judge(sb, [cell("bare"), cell("default", positives), ...controls], {}, ALL);
  assert.equal(r.rows.find((x) => x.site === "LATER").default, "none yet (owed to P9)");
  assert.equal(r.rows.find((x) => x.site === "NOBODY").default, "no reader");
  assert.deepEqual(r.fails, []);
  assert.equal(r.verdict, "PASS");
});

test("judge: a control-open that shows no site fails the sweep", () => {
  const r = judge(sb, [cell("bare"), cell("default", positives), controls[0], cell("control-open")], {}, ALL);
  assert.ok(r.fails.some((f) => f.startsWith("control-open") && f.includes("cannot trip")));
  assert.equal(r.verdict, "FAIL");
});

test("judge: control-user must show USERMD and REPOMD", () => {
  const r = judge(sb, [cell("bare"), cell("default", positives), cell("control-user", { REPOMD: ["reply"] }), controls[1]], {}, ALL);
  assert.ok(r.fails.some((f) => f.startsWith("control-user") && f.includes("USERMD") && !f.includes("REPOMD")));
});

test("judge: a stale canary token in a bare cell fails though the map does not name it", () => {
  const stale = cell("bare", {}, { canaryHits: ["CANARY-OLDSITE-DEADBEEF"] });
  const r = judge(sb, [stale, cell("default", positives), ...controls], {}, ALL);
  assert.ok(r.fails.some((f) => f.includes("CANARY-OLDSITE-DEADBEEF")));
});

test("judge: a run that leaves cells out is PARTIAL, not PASS", () => {
  const r = judge(sb, [cell("bare"), cell("default", positives)], {}, { cells: ["repo"], control: false });
  assert.deepEqual(r.fails, []);
  assert.equal(r.verdict, "PARTIAL");
});

test("manifest drop hits: each manifest is judged against its own agent's overlay", () => {
  const sbm = {
    contract: { drop: ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY"] },
    profile: { overlay: { CLAUDE_CONFIG_DIR: "x" } },
    codexProfile: { overlay: { CODEX_HOME: "y" } },
  };
  const names = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY"];
  assert.deepEqual(manifestDropHits(sbm, { agent: "codex", envNames: names }), ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(manifestDropHits(sbm, { agent: "claude", envNames: names }), ["CODEX_HOME", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(manifestDropHits(sbm, { env_names: ["CODEX_HOME"] }), ["CODEX_HOME"]);
});
