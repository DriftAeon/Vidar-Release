import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_IDS } from "../src/agents/id.ts";
import { AGENTS } from "../src/agents/descriptor.ts";
import { agentFiles, createBareFlow } from "../src/runes/bare/flow.ts";

const file = (path, agent) => ({ path, shown: path, kind: "rules", scope: "global",
  ticked: true, pickable: true, ...(agent ? { agent } : {}) });

test("Runes source and Generate routing follow every agent descriptor", async () => {
  const files = [file("shared"), ...AGENT_IDS.map((id) => file(id, id))];
  for (const agent of AGENT_IDS) {
    const selected = agentFiles(files, agent);
    assert.deepEqual(selected.map((f) => f.path), AGENTS[agent].flowSdk ? ["shared", agent] : [agent]);
    let sent;
    const flow = createBareFlow({
      generate: async (args) => { sent = args; return { library: "test" }; },
      generateCancel: async () => {},
    }, { cwd: "C:/test", agent });
    const result = await flow.generateAgent({ sources: { files: selected, memoryDir: null, guardsKey: false },
      ticked: new Set(selected.map((f) => f.path)), model: "model", effort: "medium", effortLevels: ["medium"] });
    assert.equal(result.state, "done");
    assert.equal(sent.agent, agent);
    assert.deepEqual(sent.paths, selected.map((f) => f.path));
  }
});