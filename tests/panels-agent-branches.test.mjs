// T3a: the panel sites that branched on an agent id now read the descriptor or a Record<AgentId, _>;
// these pin the bytes they produced before.
import test from "node:test";
import assert from "node:assert/strict";
import { isProjectScope, rackServerId, rackToolsKey } from "../src/panels/rack-modules.ts";
import { groupModels } from "../src/panels/rendered/model-groups.ts";
import { ASYNC_ASK_ORIGIN } from "../src/asks/record.ts";

const base = { name: "srv", transport: "stdio", target: "node", args: [], project: "C:\\Work\\A" };

test("only project and local scopes carry the project in an MCP server id and tools key", () => {
  for (const scope of ["user", "codex"]) {
    assert.equal(isProjectScope(scope), false);
    assert.equal(rackServerId({ ...base, scope }), `rack:server:${scope}:srv`);
    assert.equal(JSON.parse(rackToolsKey({ ...base, scope }))[1], null);
  }
  for (const scope of ["project", "local"]) {
    assert.equal(isProjectScope(scope), true);
    assert.equal(rackServerId({ ...base, scope }), `rack:server:${scope}:c%3A%2Fwork%2Fa:srv`);
    assert.equal(JSON.parse(rackToolsKey({ ...base, scope }))[1], "c:/work/a");
  }
});

test("the model prefix the picker strips comes from the descriptor, not a literal", () => {
  const rows = [
    { label: "Opus 5.5", value: "claude-opus-5-5" },
    { label: "Opus 5", value: "claude-opus-5" },
  ];
  assert.deepEqual(groupModels(rows).map((r) => r.group ?? null), [null, "legacy"]);
});

test("the async ask origin is a neutral value no persisted reader holds", () => {
  assert.equal(ASYNC_ASK_ORIGIN, "async-ask");
});
