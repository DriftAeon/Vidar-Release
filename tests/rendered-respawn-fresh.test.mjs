// A pre-lock vault edit respawns the tab through the /clear route. The
// respawn spawns with no resume, a send made meanwhile waits for the new generation, and a send that still
// cannot go returns false (the composer keeps its text).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ answers: { read_state: {} } });
const { createLifecycle } = await import("../src/panels/rendered/lifecycle.ts");

function body({ failRespawn = false, onRefresh = () => {}, onRedraw = () => {}, killGate = null, onSpawned = () => {} } = {}) {
  const root = document.createElement("div");
  const sent = [];
  const spawns = [];
  let gate = null;
  let gen = 0;
  const S = { disposed: false, spawning: null, holding: false, hydrating: false, replaying: false, mode: "default", sessionId: "s1",
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
        onSpawned(S, spawns.length);
        return { gen: ++gen };
      },
      kill: async () => { if (killGate) await killGate(); },
      send: async (_tab, g, line) => { sent.push([g, line]); },
    },
    root, sl, queued: [], tools: new Map(), newAdapter: adapter, handle() {}, hostPayload() {},
    cancelApprovals() {}, resetCache() {}, stopCacheTimer() {}, drawCache() {}, redrawStatus: () => onRedraw(S), resetTranscript() { resets++; },
    setInTurn() {}, refreshState: () => onRefresh(S), append: (n) => root.appendChild(n), noticeBlock() {},
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

test("the chip repaints once a respawn's spawn clears, so a stale Ready never outlives write()'s refusal", async () => {
  // E1 run 3 case 2: the chip reads Starting… while S.spawning is set (state-chip.ts); without a repaint when it
  // clears, the chip would hold Starting… (or an earlier Ready) after the spawn resolved
  const seen = [];
  const b = body({ onRefresh: (S) => seen.push([S.spawning === null, S.holding]) });
  await b.life.spawn();
  const open = b.hold();
  const respawn = b.life.respawnFresh();
  await dom.flush();
  assert.ok(b.S.spawning, "the respawn's spawn is in flight");
  seen.length = 0;
  open();
  await respawn;
  assert.equal(b.S.spawning, null);
  assert.ok(seen.length >= 1 && seen.every(([cleared]) => cleared), "repaints come after spawning cleared");
  assert.deepEqual(seen.at(-1), [true, false], "the last repaint sees the hold released too");
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

// E1 runs 3-4 case 2 (e1-fix4): after a vault edit the harness read Ready and its scripted send came back false.
const { chipState, promptReady } = await import("../src/panels/rendered/state-chip.ts");
const chipText = (S) => chipState(S, false, 0).title.split("\n")[0];

test("a spawn's own status paint already sees S.spawning, so a pinned model never paints Ready mid-spawn", async () => {
  // spawnInner paints the status line (redrawStatus -> refreshState) before its first await; S.spawning was set
  // only after spawnInner returned, so with a model pinned (no "Starting…" text) that paint read Ready
  const painted = [];
  const b = body({ onRedraw: (S) => painted.push(!!S.spawning) });
  await b.life.spawn();
  assert.deepEqual(painted, [true], "the in-spawn paint sees the spawn in flight");
});

test("a respawn reads not ready from its first step: write() refuses and the chip reads Starting… while it stops the old process", async () => {
  let openKill;
  const killed = new Promise((r) => { openKill = r; });
  let gated = false;
  const b = body({ killGate: () => (gated ? killed : Promise.resolve()) });
  await b.life.spawn();
  Object.assign(b.S, { pendingApproval: null, loggedOut: false, costTotal: 0, disconnected: false });
  assert.equal(promptReady(b.S), true);
  assert.equal(chipText(b.S), "Ready");
  gated = true;
  const respawn = b.life.respawnFresh();
  await dom.flush();
  assert.equal(b.S.isAlive, true, "the old process is still up while its kill is in flight");
  assert.equal(promptReady(b.S), false, "a bus write during the respawn is refused, not held into a refusal later");
  assert.equal(chipText(b.S), "Starting…");
  openKill();
  await respawn;
  assert.equal(b.S.holding, false);
  assert.equal(promptReady(b.S), true);
});

test("a send held over a respawn waits out the new session's hydration instead of failing on it", async () => {
  // a hosted spawn emits hydration start before it resolves and hydration end later, from the reader thread
  // (src-tauri/src/falcon/events.rs start_event_reader): the hold released into S.hydrating and sendNow said false
  const b = body({ onSpawned: (S, n) => { if (n > 1) { S.hydrating = true; setTimeout(() => { S.hydrating = false; }, 60); } } });
  await b.life.spawn();
  const open = b.hold();
  const respawn = b.life.respawnFresh();
  await dom.flush();
  const sending = b.life.send("after restore");
  open();
  await respawn;
  assert.equal(b.S.hydrating, true, "the hold released while the new session still hydrates");
  assert.equal(await sending, true);
  assert.deepEqual(b.sent, [[2, "after restore"]]);
});
