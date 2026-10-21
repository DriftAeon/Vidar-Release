// B2 (review-fix 2026-10-17): the host reports every Codex thread free, so a hosted Codex resume
// of a thread another tab holds (Rendered, or a live Raw resume) is refused at spawn.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const h = setupDom().ipc;
const { holdsCodexThread, launchLineThread, pickRawThreads, rolloutKey } = await import("../src/panels/sessions/codex-thread.ts");
const lookup = await import("../src/panels/sessions/lookup.ts");
const { falconAgentTransport, tauriAgentTransport } = await import("../src/panels/rendered/transport.ts");

const X = "019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
const raw = (cmd, over = {}) => ({ agent: "codex", body: "terminal", alive: true, launchArgs: ["-NoExit", "-Command", cmd], ...over });
const rendered = (id, over = {}) => ({ agent: "codex", body: "rendered", alive: true, rendered: { sessionId: () => id }, ...over });

test("a Raw tab with `codex resume X` holds X; other shapes do not", () => {
  assert.equal(holdsCodexThread(raw(`codex resume ${X}`), X), true);
  assert.equal(holdsCodexThread(raw(`codex -c 'developer_instructions="a b"' resume ${X}`), X), true);
  assert.equal(holdsCodexThread(raw(`codex resume ${X}`), "019a2b3c"), false, "a prefix is not the thread");
  assert.equal(holdsCodexThread(raw(`codex resume ${X}`, { alive: false }), X), false, "a dead Raw tab holds nothing");
  assert.equal(holdsCodexThread(raw(`claude --resume ${X}`, { agent: "claude" }), X), false);
  assert.equal(holdsCodexThread(raw("codex"), X), false);
  assert.equal(holdsCodexThread(rendered(X), X), true);
  assert.equal(holdsCodexThread(rendered(null), X), false);
});

test("lookup: the holder is found, the spawning tab itself is skipped", () => {
  const sessions = new Map([["t1", raw(`codex resume ${X}`)], ["t2", rendered("other")]]);
  lookup.bindLookup({ sessions, getActiveId: () => null });
  assert.equal(lookup.codexThreadHolder(X), "t1");
  assert.equal(lookup.codexThreadHolder(X, "t1"), null);
  assert.equal(lookup.codexThreadHolder("other", "t1"), "t2");
});

test("falcon spawn: a hosted Codex resume of a held thread never reaches the host", async () => {
  lookup.bindLookup({ sessions: new Map([["t1", raw(`codex resume ${X}`)]]), getActiveId: () => null });
  h.answers.falcon_spawn = 7;
  const params = { tabId: "t2", agent: "codex", cwd: "C:\\x", permissionMode: "default", resume: X };
  h.invoked.length = 0;
  await assert.rejects(falconAgentTransport.spawn(params), /already open in another tab/);
  assert.ok(!h.invoked.includes("falcon_spawn"));
  // its own tab's respawn (Resume, /clear) and a free thread go through
  assert.equal((await falconAgentTransport.spawn({ ...params, tabId: "t1" })).gen, 7);
  assert.equal((await falconAgentTransport.spawn({ ...params, resume: "free" })).gen, 7);
  // Claude is untouched
  assert.equal((await falconAgentTransport.spawn({ ...params, agent: "claude" })).gen, 7);
});

// a3r (2026-10-19): a Raw tab's launch line names no thread or a stale one; its thread is resolved
// from the rollouts in its own home and cwd.
const A = "0a000000-0000-4000-8000-00000000000a";
const B = "0b000000-0000-4000-8000-00000000000b";
const C = "0c000000-0000-4000-8000-00000000000c";
// times in seconds since an origin; spawns at 10 s and 20 s, a pre-spawn rollout at 0.01 s
const rawTab = (id, over = {}) => ({ id, cwd: "C:\\p", profile: null, spawnedMs: 10_000, launchThread: null, ...over });
const rows = (...pairs) => pairs.map(([id, secs]) => ({ id, mtimeMs: secs * 1000 }));

test("launchLineThread reads `codex ... resume <id>` only", () => {
  assert.equal(launchLineThread(["-NoExit", "-Command", `codex resume ${X}`]), X);
  assert.equal(launchLineThread(["-Command", `codex -c 'x="a b"' resume '${X}'`]), X);
  assert.equal(launchLineThread(["-Command", "codex"]), null);
  assert.equal(launchLineThread(["-Command", `claude --resume ${X}`]), null);
  assert.equal(launchLineThread(undefined), null);
});

test("stale id: the newest unclaimed rollout for the cwd in the tab's home wins", () => {
  const key = rolloutKey(null, "C:\\p");
  // the launch line names A, the TUI moved on (/new) and writes B
  const got = pickRawThreads([rawTab("t1", { launchThread: A })], new Map([[key, rows([B, 5000], [A, 3000], [C, 0.01])]]), []);
  assert.equal(got.get("t1"), B);
  // no id at all: same answer; a rollout older than the spawn is never the tab's
  assert.equal(pickRawThreads([rawTab("t1")], new Map([[key, rows([C, 0.01])]]), []).get("t1"), null);
  // nothing written since the spawn: the launch line still stands
  assert.equal(pickRawThreads([rawTab("t1", { launchThread: A })], new Map([[key, rows([C, 0.01])]]), []).get("t1"), A);
  // a thread a Rendered tab holds is skipped
  assert.equal(pickRawThreads([rawTab("t1")], new Map([[key, rows([B, 5000], [A, 3000])]]), [B]).get("t1"), A);
});

test("two tabs, one cwd: two different rollouts, or one fresh, never a share", () => {
  const key = rolloutKey(null, "C:\\p");
  const two = pickRawThreads([rawTab("t1"), rawTab("t2", { spawnedMs: 20_000 })], new Map([[key, rows([B, 5000], [A, 3000])]]), []);
  assert.notEqual(two.get("t1"), two.get("t2"));
  assert.deepEqual(new Set([two.get("t1"), two.get("t2")]), new Set([A, B]));
  const one = pickRawThreads([rawTab("t1"), rawTab("t2", { spawnedMs: 20_000 })], new Map([[key, rows([B, 5000])]]), []);
  assert.deepEqual([one.get("t1"), one.get("t2")], [B, null], "the second tab starts fresh");
  // both launched on A: one holds it, the other holds nothing
  const same = pickRawThreads([rawTab("t1", { launchThread: A }), rawTab("t2", { launchThread: A })], new Map([[key, []]]), []);
  assert.deepEqual([same.get("t1"), same.get("t2")], [A, null]);
});

test("a Bare tab reads only its own home's rollouts", () => {
  const bare = rawTab("t1", { profile: "bare" });
  const got = pickRawThreads([bare], new Map([[rolloutKey(null, "C:\\p"), rows([A, 9000])]]), []);
  assert.equal(got.get("t1"), null, "default-home rows never reach a Bare tab");
  const own = pickRawThreads([bare], new Map([[rolloutKey(null, "C:\\p"), rows([A, 9000])], [rolloutKey("bare", "C:\\p"), rows([B, 4000])]]), []);
  assert.equal(own.get("t1"), B);
});

test("refresh: a Bare tab's rollouts are fetched with its profile; a held thread is never resumed twice", async () => {
  const sessions = new Map([
    ["raw-plain", { ...raw("codex"), cwd: "C:\\p" }],
    ["raw-bare", { agent: "codex", body: "terminal", alive: true, cwd: "C:\\p", profile: "bare" }],
    ["rend", { ...rendered(C), cwd: "C:\\p" }],
  ]);
  lookup.bindLookup({ sessions, getActiveId: () => null });
  lookup.noteRawCodexSpawn("raw-plain", 1000);
  lookup.noteRawCodexSpawn("raw-bare", 1000);
  const calls = [];
  const homes = { "": rows([C, 6000], [A, 5000]), bare: rows([B, 4000]) };
  await lookup.refreshRawCodexThreads(async (cwd, profile) => { calls.push([cwd, profile]); return homes[profile ?? ""]; });
  assert.deepEqual(new Set(calls.map((c) => JSON.stringify(c))), new Set([JSON.stringify(["C:\\p", "bare"]), JSON.stringify(["C:\\p", null])]));
  assert.equal(lookup.codexThreadHolder(A), "raw-plain", "C is the Rendered tab's, so the Raw tab writes A");
  assert.equal(lookup.codexThreadHolder(B), "raw-bare");
  assert.equal(lookup.codexThreadHolder(C), "rend");

  // a Rendered resume of the Raw tab's live thread never spawns, on either transport
  h.answers.codex_rollout_threads = ({ profile }) => homes[profile ?? ""];
  h.answers.falcon_spawn = 7;
  h.answers.spawn_codex_appserver = { gen: 8, developerInstructions: null };
  h.invoked.length = 0;
  const params = { tabId: "new", agent: "codex", cwd: "C:\\p", permissionMode: "default", resume: A };
  await assert.rejects(falconAgentTransport.spawn(params), /already open in another tab/);
  await assert.rejects(tauriAgentTransport.spawn(params), /already open in another tab/);
  await assert.rejects(tauriAgentTransport.spawn({ ...params, resume: B }), /already open in another tab/);
  assert.ok(!h.invoked.includes("falcon_spawn") && !h.invoked.includes("spawn_codex_appserver"));
  // a free thread goes through
  assert.deepEqual(await tauriAgentTransport.spawn({ ...params, resume: "free" }), { gen: 8, developerInstructions: null });

  // a failed read leaves the tab on its launch line (no thread here): nothing is refused for it
  h.answers.codex_rollout_threads = () => { throw new Error("unreadable"); };
  assert.equal((await falconAgentTransport.spawn(params)).gen, 7);
});
