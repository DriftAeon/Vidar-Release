// The gate mod (plugins/gate/hooks/register.js) in a bare tab: with VIDAR_AGENT_HOME set it reads
// its config and writes its .mod in that folder (the tab's own
// Claude config dir), never under <USERPROFILE>\.claude; without it nothing moves.
// Plugin I/O is an in-memory fake,.
//
//   node --test tests\gate-agent-home.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../plugins/gate/hooks/register.js";

const SID = "0123abcd-0000-4000-8000-000000000001";
const PROFILE = "C:\\sandbox\\user-home";
const AGENT = "C:\\homes\\k\\claude-config";
const CONFIG = JSON.stringify({ budget: 230000, headroom: 20000 });

function harness(env, files) {
  const handlers = new Map();
  register((name, ...args) => {
    handlers.set(name, args.at(-1));
    return { catch() {} };
  });
  const store = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const reads = [];
  const writes = [];
  const $ = {
    env: { get: async (key) => env[key] },
    fs: {
      read: async (p) => {
        reads.push(p);
        const v = store.get(p.toLowerCase());
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
      write: async (p, text) => { writes.push(p); store.set(p.toLowerCase(), text); },
      list: async () => [],
    },
    session: { id: async () => SID, cwd: async () => "C:\\work\\repo", usage: async () => ({ context: { tokens: 215000, window: 1000000 } }) },
    plugin: { root: "C:/vidar/plugins/gate" },
    ui: { invalidate() {} },
  };
  return { handlers, $, reads, writes };
}

test("register.js keeps config and .mod under VIDAR_AGENT_HOME", async () => {
  const h = harness({ USERPROFILE: PROFILE, VIDAR_AGENT_HOME: AGENT, FALCON_SESSION: "s1" }, { [`${AGENT}\\context-gate.json`]: CONFIG });
  assert.equal(h.handlers.has("classic.SessionStart"), false, "the gate no longer registers SessionStart");
  await h.handlers.get("prompt.submit")(h.$, { text: "hi" }, async (e) => e);
  assert.ok(h.writes.includes(`${AGENT}\\context-gate\\${SID}.mod`), h.writes.join("\n"));

  await h.handlers.get("session.measure")(h.$, { context: { tokens: 215000, window: 1000000 } }, async () => {});
  assert.ok(h.reads.includes(`${AGENT}\\context-gate.json`), "the agent home's config was not read");
  assert.equal(h.handlers.has("prompt.submit"), true, "the gate's SessionStart fallback rides prompt.submit");
  assert.equal(h.handlers.has("classic.Stop"), false, "the gate no longer blocks Stop");

  const underProfile = (p) => p.toLowerCase().startsWith(`${PROFILE}\\.claude\\`.toLowerCase());
  const leaked = [...h.writes, ...h.reads].filter((p) => underProfile(p) && !p.includes("session-index"));
  assert.deepEqual(leaked, [], "the gate touched the profile's .claude");
});

test("without VIDAR_AGENT_HOME the gate stays under <USERPROFILE>\\.claude", async () => {
  const h = harness({ USERPROFILE: PROFILE }, { [`${PROFILE}\\.claude\\context-gate.json`]: CONFIG });
  await h.handlers.get("prompt.submit")(h.$, { text: "hi" }, async (e) => e);
  assert.ok(h.writes.includes(`${PROFILE}\\.claude\\context-gate\\${SID}.mod`), h.writes.join("\n"));
});
