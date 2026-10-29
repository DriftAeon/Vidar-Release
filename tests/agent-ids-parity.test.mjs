// Pins the agent list: AGENT_IDS (src/agents/id.ts), agent_spec.rs ALL, the protocol.rs Agent variants
// and its as_str arms are one list in one order; each spec agrees with profiles/bare/<id>.json.
// Pure text reads, no cargo. Never reads a credential file (only the profile's key names).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ts = read("src/agents/id.ts");
const spec = read("src-tauri/src/agent_spec.rs");
const proto = read("src-falcon/src/protocol.rs");

const tsIds = () => {
  const m = /export const AGENT_IDS = \[([^\]]*)\] as const;/.exec(ts);
  assert.ok(m, "AGENT_IDS shape changed in id.ts; update this test with it");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

// agent_spec.rs ALL delegates to Agent::ALL, so it is the protocol.rs list.
const specAll = () => {
  assert.match(spec, /pub const ALL: \[Agent; \d+\] = Agent::ALL;/, "agent_spec.rs ALL must delegate to Agent::ALL");
  const m = /pub const ALL: \[Agent; (\d+)\] = \[([^\]]*)\];/.exec(proto);
  assert.ok(m, "Agent::ALL shape changed in protocol.rs; update this test with it");
  const list = [...m[2].matchAll(/Agent::(\w+)/g)].map((x) => x[1].toLowerCase());
  assert.equal(Number(m[1]), list.length, "ALL length annotation");
  return list;
};

const agentEnum = () => {
  const m = /pub enum Agent \{([^}]*)\}/.exec(proto);
  assert.ok(m, "Agent enum shape changed in protocol.rs; update this test with it");
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
};

test("AGENT_IDS, ALL and the Agent variants are one list in one order", () => {
  const ids = tsIds();
  assert.deepEqual(specAll(), ids, "agent_spec.rs ALL");
  assert.deepEqual(agentEnum().map((v) => v.toLowerCase()), ids, "protocol.rs variants");
});

test("AGENT_IDS equals the protocol.rs ALL variants", () => {
  const m = /pub const ALL: \[Agent; (\d+)\] = \[([^\]]*)\];/.exec(proto);
  assert.ok(m, "Agent::ALL shape changed in protocol.rs; update this test with it");
  const list = [...m[2].matchAll(/Agent::(\w+)/g)].map((x) => x[1].toLowerCase());
  assert.equal(Number(m[1]), list.length, "ALL length annotation");
  assert.deepEqual(list, tsIds());
});

test("AGENT_IDS and PTY_ONLY_IDS do not overlap", () => {
  const m = /export const PTY_ONLY_IDS = \[([^\]]*)\] as const;/.exec(ts);
  assert.ok(m, "PTY_ONLY_IDS shape changed in id.ts; update this test with it");
  const pty = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(pty.length > 0);
  assert.deepEqual(pty.filter((p) => tsIds().includes(p)), []);
});

test("the gateway runner is a full agent", () => {
  const runner = JSON.parse(read("contracts/modules.json")).gateway.runner;
  assert.ok(tsIds().includes(runner), `gateway runner ${runner}`);
});

test("Agent::as_str arms match the variants", () => {
  const m = /pub const fn as_str\(self\) -> &'static str \{\s*match self \{([^}]*)\}/.exec(proto);
  assert.ok(m, "as_str shape changed in protocol.rs; update this test with it");
  const arms = [...m[1].matchAll(/Self::(\w+) => "([^"]+)"/g)].map((x) => [x[1], x[2]]);
  assert.deepEqual(arms, agentEnum().map((v) => [v, v.toLowerCase()]));
});

test("Agent keeps rename_all lowercase", () => {
  assert.match(proto, /#\[serde\(rename_all = "lowercase"\)\]\s*pub enum Agent\b/);
});

test("each spec agrees with profiles/bare/<id>.json", () => {
  for (const id of tsIds()) {
    const block = new RegExp(`static ${id.toUpperCase()}: AgentSpec = AgentSpec \\{([\\s\\S]*?)\\n\\};`).exec(spec);
    assert.ok(block, `static ${id.toUpperCase()} shape changed in agent_spec.rs`);
    const str = (k) => new RegExp(`\\n    ${k}: "([^"]*)"`).exec(block[1])?.[1];
    const logins = [...(/\n    logins: &\[([^\]]*)\]/.exec(block[1])?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.equal(str("profile_file"), `${id}.json`);
    const profile = JSON.parse(read(`profiles/bare/${str("profile_file")}`));
    assert.equal(profile.agent, id, "profile agent");
    assert.ok(profile.homeDirs.includes(str("config_dir")), "config_dir is a homeDirs entry");
    assert.equal(str("homes_dir"), `${id}-homes`);
    assert.equal(str("homes_index"), `${id}-homes.json`);
    assert.equal(str("gen_dir"), `gen-${id}`);
    assert.ok(logins.length > 0, "logins listed");
    // A profile that lists sharedLogin must name the spec's credential (the first login) in config_dir.
    for (const s of profile.sharedLogin ?? []) {
      assert.equal(s.agent, id);
      assert.equal(s.file, `${str("config_dir")}/${logins[0]}`);
    }
  }
});
