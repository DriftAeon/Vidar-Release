import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { agentRoots, globalRunesDir } from "./paths.mjs";
import { AGENTS } from "../../src/agents/descriptor.ts";
import { AGENT_IDS } from "../../src/agents/id.ts";

const HOME = join("C:", "home", "u");
const first = AGENTS[AGENT_IDS[0]];
const last = AGENTS[AGENT_IDS[AGENT_IDS.length - 1]];
const firstDir = join(HOME, first.userDir);

test("first agent's home present: its runes folder", () => {
  const got = globalRunesDir({ USERPROFILE: HOME, [last.homeEnv]: join("D:", "cx") }, (p) => p === firstDir);
  assert.equal(got, join(firstDir, "runes"));
});

test("first agent's home env set to a temp dir: global runes under it", () => {
  const cfg = join("E:", "cfg");
  assert.equal(globalRunesDir({ USERPROFILE: HOME, [first.homeEnv]: cfg }, (p) => p === cfg), join(cfg, "runes"));
});

test("first root absent, last agent's home env set: its runes folder", () => {
  const cx = join("D:", "cx");
  assert.equal(globalRunesDir({ USERPROFILE: HOME, [last.homeEnv]: cx }, () => false), join(cx, "runes"));
});

test("first root absent, last agent's home env empty: <home>/<userDir>/runes", () => {
  assert.equal(
    globalRunesDir({ USERPROFILE: HOME, [last.homeEnv]: "" }, () => false),
    join(HOME, last.userDir, "runes"),
  );
});

test("agent roots list every agent in table order, env over home", () => {
  const cx = join("D:", "cx");
  const got = agentRoots({ USERPROFILE: HOME, [last.homeEnv]: cx });
  assert.equal(got.length, AGENT_IDS.length);
  assert.equal(got[0], firstDir);
  assert.equal(got[got.length - 1], cx);
});
