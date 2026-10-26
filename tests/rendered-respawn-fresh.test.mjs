// D-d (run 2026-10-25-rune-vault L3b2): a pre-lock vault edit respawns the tab through the /clear route. The
// respawn spawns with no resume, a send made meanwhile waits for the new generation, and a send that still
// cannot go returns false (the composer keeps its text).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ answers: { read_state: {} } });
const { createLifecycle } = await import("../src/panels/rendered/lifecycle.ts");

function body({ failRespawn = false } = {}) {
  const root = document.createElement("div");
  const sent = [];
  const spawns = [];
  let gate = null;
  let gen = 0;
  const S = { disposed: false, spawning: null, hydrating: false, replaying: false, mode: "default", sessionId: "s1",
    switchPending: false, isAlive: false, inTurn: false, gen: 0 };
  const adapter = () => ({ attach() {}, start() {}, encodeInterrupt: () => null });
  const sl = { ctxTokens: 9, ctxPct: 40 };
  let resets = 0;
  const life = createLifecycle(S, {
    opts: { agent: "claude", tabId: "fresh-1", cwd: "C:\\work", onDead() {}, onAdopted() {} },
    transport: {
      spawn: async (p) => {
        spawns.push(p.resume);
        if (gate) await gate;
        if (failRespawn && spawns.length > 1) throw new Error("spawn refused");
        return { gen: ++gen };
      },
      kill: async () => {},
      send: async (_tab, g, line) => { sent.push([g, line]); },
    },
    root, sl, queued: [], tools: new Map(), newAdapter: adapter, handle() {}, hostPayload() {},
    cancelApprovals() {}, resetCache() {}, stopCacheTimer() {}, drawCache() {}, redrawStatus() {}, resetTranscript() { resets++; },
    setInTurn() {}, refreshState() {}, append: (n) => root.appendChild(n), noticeBlock() {},
    stats: { end() {} }, openHydratedCards() {}, checkLogin() {},
  });
  return { S, sl, life, sent, spawns, resets: () => resets, hold: () => { let open; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; } };
}

test("respawnFresh spawns with no resume and a send made meanwhile reaches the new generation", async () => {
  const b = body();
  await b.life.spawn();
  assert.equal(b.S.gen, 1);
  const open = b.hold();
  const respawn = b.life.respawnFresh();
  await dom.flush();
  const sending = b.life.send("hello");
  await dom.flush();
  assert.deepEqual(b.sent, [], "the send waits while the respawn has no generation");
  open();
  await respawn;
  assert.equal(await sending, true);
  assert.deepEqual(b.spawns, ["s1", null], "the respawn is a fresh session, not a resume");
  assert.deepEqual(b.sent, [[2, "hello"]], "the held send goes to the new process");
  assert.equal(b.S.sessionId, null);
  assert.equal(b.sl.ctxTokens, 0);
  assert.equal(b.sl.ctxPct, null);
  assert.ok(b.resets() >= 1, "the transcript clears");
});

test("a send held over a respawn that fails returns false, so the composer keeps its text", async () => {
  const b = body({ failRespawn: true });
  await b.life.spawn();
  const open = b.hold();
  const respawn = b.life.respawnFresh();
  await dom.flush();
  const sending = b.life.send("keep me");
  open();
  await respawn;
  assert.equal(await sending, false);
  assert.deepEqual(b.sent, []);
});
