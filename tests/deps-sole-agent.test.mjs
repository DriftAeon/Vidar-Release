// The dep of a set's only agent is required; with two agents listed, deps stay as the packs declare.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requireSoleAgentDep } from "../src/deps/sole-agent.ts";

const pack = (id) => JSON.parse(readFileSync(new URL(`../content/packs/${id}/pack.json`, import.meta.url), "utf8")).module;
const codex = pack("codex");
const claude = pack("claude");
const depsOf = (...mods) => mods.flatMap((m) => m.deps ?? []);
const reqOf = (deps, id) => deps.find((d) => d.id === id).required;

test("codex-only set: Codex CLI is required", () => {
  const out = requireSoleAgentDep([codex], depsOf(codex));
  assert.equal(reqOf(out, "codex"), true);
  assert.equal(codex.deps[0].required, false, "the pack declaration is not mutated");
});

test("full set: Codex CLI and Claude Code stay as declared", () => {
  const deps = depsOf(claude, codex);
  const out = requireSoleAgentDep([claude, codex], deps);
  assert.deepEqual(out, deps);
});

test("claude-only set: Claude Code is required, Falcon is not", () => {
  const falcon = pack("falcon");
  const out = requireSoleAgentDep([claude, falcon], depsOf(claude, falcon));
  assert.equal(reqOf(out, "claude"), true);
  assert.equal(reqOf(out, "falcon"), false);
});

test("no agent listed, or an agent without a setup dep: unchanged", () => {
  const deps = depsOf(codex);
  assert.deepEqual(requireSoleAgentDep([{ kind: "content" }], deps), deps);
  assert.deepEqual(requireSoleAgentDep([{ kind: "agent" }], deps), deps);
});
