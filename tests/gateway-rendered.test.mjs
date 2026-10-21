import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

const h = setupDom();
const { agentKind, canRenderAgent, setGatewayIds } = await import("../src/launcher/agent-kind.ts");
setGatewayIds(["acme"]);
const { resolveBodyKind } = await import("../src/panels/sessions/body-kind.ts");
const { createGatewayTransport, createFalconAdoptTransport, falconAgentTransport } = await import("../src/panels/rendered/transport.ts");
const params = { tabId: "tab", agent: "claude", cwd: "work", permissionMode: "auto" };

test("gateway Rendered lifts its route guard and preserves Raw choices", () => {
  for (const art of ["acme"]) {
    const kind = agentKind(art);
    assert.equal(canRenderAgent(kind, art), true);
    assert.equal(resolveBodyKind({ agent: kind, art, body: "rendered" }).body, "rendered");
    assert.equal(resolveBodyKind({ agent: kind, art }).body, "terminal");
  }
});

test("gateway identity crosses IPC without changing plain Claude spawn", async () => {
  let payload;
  h.ipc.answers.falcon_spawn = (args) => { payload = args; return 7; };
  await falconAgentTransport.spawn(params);
  assert.equal(Object.hasOwn(payload, "gateway"), false);
  const plain = { ...payload };
  for (const gateway of ["acme", "acme-2"]) {
    await createGatewayTransport(gateway).spawn(params);
    assert.deepEqual(payload, { ...plain, gateway });
    assert.equal(Object.keys(payload).some((k) => /token|secret|key/i.test(k)), false);
  }
});

test("adoption takes the gateway from the caller's summary and retains it on clear", async () => {
  let spawned;
  let listed = false;
  h.ipc.answers.falcon_list = () => { listed = true; return { sessions: [] }; };
  h.ipc.answers.falcon_adopt = () => 8;
  h.ipc.answers.falcon_spawn = (args) => { spawned = args; return 9; };
  const transport = createFalconAdoptTransport("s1", "acme");
  assert.equal((await transport.spawn(params)).gen, 8);
  assert.equal((await transport.spawn(params)).gen, 9);
  assert.equal(spawned.gateway, "acme");
  assert.equal(listed, false, "adopt must not list the host first");
  const hosted = readFileSync(new URL("../src/launcher/hosted.ts", import.meta.url), "utf8");
  assert.match(hosted, /art: s\.gateway \?\? "claude"/);
});

test("the ordinary Active adoption guard remains", () => {
  const locations = readFileSync(new URL("../src/launcher/locations.ts", import.meta.url), "utf8");
  assert.match(locations, /isGateway/);
});

