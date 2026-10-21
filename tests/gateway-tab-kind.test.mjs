import test from "node:test";
import assert from "node:assert/strict";
import { agentKind, canRenderAgent, setGatewayIds } from "../src/launcher/agent-kind.ts";
import { rawPackRows } from "../src/launcher/pack-rows.ts";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
setGatewayIds(["acme"]);
const { resolveBodyKind } = await import("../src/panels/sessions/body-kind.ts");

test("gateway identity selects the Claude CLI and may open Rendered through Falcon", () => {
  for (const art of ["acme"]) {
    const kind = agentKind(art);
    assert.equal(kind, "claude");
    // Falcon carries the gateway identity and runs the shared vendor preparation, so Rendered is allowed.
    assert.deepEqual(resolveBodyKind({ agent: kind, art, body: "rendered" }), { kind, body: "rendered" });
    assert.equal(canRenderAgent(kind, art), true);
    // Raw stays the default when no body is requested.
    assert.deepEqual(resolveBodyKind({ agent: kind, art }), { kind, body: "terminal" });
  }
});

test("supported CLIs keep their body choices; Raw-only CLIs and unknown rows stay terminal", () => {
  for (const agent of ["claude", "codex", "gemini", "pi", "shell"]) {
    assert.equal(agentKind(agent), agent);
    assert.deepEqual(resolveBodyKind({ agent }), { kind: agent, body: "terminal" });
    assert.equal(resolveBodyKind({ agent, body: "rendered" }).body,
      ["claude", "codex"].includes(agent) ? "rendered" : "terminal");
  }
  assert.equal(agentKind("local"), "shell");
  assert.deepEqual(resolveBodyKind(), { kind: "shell", body: "terminal" });
  assert.deepEqual(resolveBodyKind({ falconSession: "existing", agent: "shell" }), { kind: "claude", body: "rendered" });
});

test("pack Raw rows keep their existing tab kinds without gaining Rendered bodies", () => {
  const modules = ["gemini", "pi", "local"].map((id) => ({
    id, label: id, kind: "agent", source: "pack", when: { deps: [id] },
    agent: { rows: ["raw"], launch: { executable: id, args: [] } },
  }));
  for (const row of rawPackRows(modules)) {
    const kind = agentKind(row.id);
    assert.equal(kind, row.id === "local" ? "shell" : row.id);
    assert.deepEqual(resolveBodyKind({ agent: kind, art: row.id, body: "rendered" }), { kind, body: "terminal" });
  }
});

test("Loadout and MCP Rack stay empty for gateway tabs (wrapper fence is invisible to read_loadout)", async () => {
  const { readFileSync } = await import("node:fs");
  const loadout = readFileSync(new URL("../src/panels/loadout.ts", import.meta.url), "utf8");
  const rack = readFileSync(new URL("../src/panels/rack.ts", import.meta.url), "utf8");
  assert.match(loadout, /focused\.agent !== "claude" \|\| isGateway\(focused\.art\)/);
  assert.match(rack, /s\?\.agent === "claude" && !isGateway\(s\.art\)/);
});

