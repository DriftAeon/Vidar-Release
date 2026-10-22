// Adapter contract parity: what the panel waits on from an adapter (a setter's ack, a method the
// in-process Codex view has) must also come from the hosted one. A new adapter, a new AgentAdapter
// method or a new Codex request that this file does not know about fails here, so the gap is a
// choice written down with a reason, not a surprise on a live tab (2aacee17: a hosted tab with no
// skills catalog, found by a user).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { ClaudeAdapter } = await import("../src/agents/claude.ts");
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { HostedCodexAdapter } = await import("../src/agents/codex-hosted.ts");
const { deliver } = await import("../src/panels/rendered/host-router.ts");

const agentsDir = new URL("../src/agents/", import.meta.url);
const read = (name) => readFileSync(new URL(name, agentsDir), "utf8");

// ---- 1. setter acks ----
const SETTERS = [
  { encode: "encodeSetModel", value: "m-1", expect: (ev) => ev.kind === "model_set" && ev.model === "m-1" },
  { encode: "encodeSetPermissionMode", value: "plan", expect: (ev) => ev.kind === "mode" && ev.mode === "plan" && ev.ack === true },
  { encode: "encodeSetEffort", value: "high", expect: (ev) => ev.kind === "effort" && ev.level === "high" },
];
const wireAck = {
  Claude: { encodeSetModel: [{ type: "sidecar", subtype: "model", model: "m-1" }],
    encodeSetPermissionMode: [{ type: "sidecar", subtype: "mode", mode: "plan" }],
    encodeSetEffort: [{ type: "effort", level: "high" }] },
};
const accepted = (command, kind, payload) => ({ record: "command-accepted", command, client: "vidar", kind, payload });
const settled = (command, outcome) => ({ record: "command-settled", command, outcome, message: null });
const hostAck = {
  encodeSetModel: [accepted(1, "set_model", { type: "set_model", model: "m-1" }), settled(1, "applied")],
  encodeSetPermissionMode: [accepted(2, "set_permission_mode", { type: "set_permission_mode", mode: "plan" }), settled(2, "applied")],
  encodeSetEffort: [accepted(3, "set_effort", { type: "set_effort", level: "high" }), settled(3, "applied")],
};
/** class name -> [constructor, how its acks arrive]: null from a setter means applied locally */
const ADAPTERS = {
  ClaudeAdapter: { make: () => new ClaudeAdapter(), acks: (encode) => wireAck.Claude[encode].map((m) => ({ line: JSON.stringify(m) })) },
  CodexAdapter: { make: () => new CodexAdapter(), acks: () => [] },
  HostedCodexAdapter: { make: () => new HostedCodexAdapter(), acks: (encode) => hostAck[encode].map((body) => ({ hostRecord: { body }, gen: 1 })) },
};

test("every adapter class is in the setter-ack table", () => {
  const found = readdirSync(agentsDir).filter((f) => f.endsWith(".ts"))
    .flatMap((f) => [...read(f).matchAll(/export class (\w+) implements AgentAdapter/g)].map((m) => m[1]));
  assert.deepEqual(found.sort(), Object.keys(ADAPTERS).sort(), "a new adapter needs a row (and ack fixtures) here");
});

for (const [name, { make, acks }] of Object.entries(ADAPTERS)) for (const s of SETTERS) {
  test(`${name}.${s.encode}: a sent line is answered with the event the panel awaits`, () => {
    const adapter = make();
    adapter.attach(() => {});
    adapter.start({ cwd: "C:/work", permissionMode: "default" });
    const line = adapter[s.encode](s.value);
    if (line === null) return; // applied locally; the panel settles at once
    const handled = [];
    const route = { gen: 1, floor: 0, handle: (ev) => handled.push(ev), dropped() {}, exit() {}, adapter, host() {} };
    for (const payload of acks(s.encode)) deliver(route, payload);
    assert.ok(handled.some(s.expect), `${name} sent ${line} and nothing settled it: got ${JSON.stringify(handled)}`);
  });
}

// ---- 2. method parity ----
const ALLOWED_HOSTED_GAPS = {
  encodeLogin: "login stays in-process; a hosted tab offers none (codex-hosted.ts header)",
  loginReady: "goes with encodeLogin",
  exited: "the host owns the process; nothing queued locally is lost on exit",
};
test("every AgentAdapter method CodexAdapter has, the hosted one has, unless a reason is written here", () => {
  const protocol = readFileSync(new URL("protocol.ts", agentsDir), "utf8");
  const block = protocol.slice(protocol.indexOf("export interface AgentAdapter {"));
  const body = block.slice(0, block.search(/^}/m));
  const methods = [...body.matchAll(/^ {2}(\w+)\??\(/gm)].map((m) => m[1]);
  assert.ok(methods.length >= 10, `parsed ${methods.length} interface methods`);
  const own = (cls) => new Set(Object.getOwnPropertyNames(cls.prototype));
  const codex = own(CodexAdapter);
  const hosted = own(HostedCodexAdapter);
  const missing = methods.filter((m) => codex.has(m) && !hosted.has(m) && !(m in ALLOWED_HOSTED_GAPS));
  assert.deepEqual(missing, [], "the hosted adapter drops a method the in-process one has: add it, or list it with a reason");
  for (const m of Object.keys(ALLOWED_HOSTED_GAPS)) {
    assert.ok(methods.includes(m), `${m} is no longer an AgentAdapter method: drop it from the allowlist`);
    assert.ok(!hosted.has(m), `${m} now exists hosted: drop it from the allowlist`);
  }
});

// ---- 3. request coverage ----
/** every JSON-RPC method the in-process view sends -> where a hosted tab gets that answer */
const REQUEST_SOURCES = {
  "initialize": { host: "the host initializes the app-server" },
  "account/read": { host: "login stays in-process; the host reads the account itself" },
  "account/login/start": { host: "login stays in-process" },
  "account/login/cancel": { host: "login stays in-process" },
  "thread/start": { feed: "falcon/thread" },
  "thread/resume": { feed: "falcon/thread" },
  "thread/turns/list": { feed: "falcon/history" },
  "model/list": { feed: "falcon/models" },
  "turn/start": { host: "the host starts turns (encodeUser sends the user line)" },
  "turn/interrupt": { host: "encodeInterrupt sends the interrupt line" },
  "skills/list": { feed: "falcon/skills" },
};
test("every request the in-process view sends has a hosted source, or a reason it has none", () => {
  const sent = new Set([...read("codex.ts").matchAll(/this\.request\("([^"]+)"/g)].map((m) => m[1]));
  assert.ok(sent.size >= 8, `parsed ${sent.size} request methods`);
  assert.deepEqual([...sent].filter((m) => !(m in REQUEST_SOURCES)).sort(), [],
    "a new Codex request needs a row: how a hosted tab gets that answer");
  assert.deepEqual(Object.keys(REQUEST_SOURCES).filter((m) => !sent.has(m)).sort(), [], "a row names a request codex.ts no longer sends");
  const hostedSrc = read("codex-hosted.ts");
  for (const [method, src] of Object.entries(REQUEST_SOURCES)) {
    if (src.feed) assert.ok(hostedSrc.includes(`"${src.feed}"`), `${method}: codex-hosted.ts no longer handles ${src.feed}`);
    else assert.ok(src.host || src.gap, `${method}: a reason is required`);
  }
});
