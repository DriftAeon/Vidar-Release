// Contracts: restore by thread/turn, reject corrupt storage, bounded retention,
// and ordered persistence while notifications continue arriving.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

let releaseRead, notifyRead;
const stateRead = new Promise((resolve) => { releaseRead = resolve; });
const readStarted = new Promise((resolve) => { notifyRead = resolve; });
setupDom({ answers: { read_state: () => { notifyRead(); return stateRead; }, patch_state: null }, stubs: {
  "panels/document": `export { renderMarkdownOrText } from ${JSON.stringify(new URL("../src/panels/markdown-build.ts", import.meta.url).href)};`,
} });
const { CodexPlanStore, CODEX_PLANS_KEY, PLAN_LIMITS } = await import("../src/agents/codex-plan-store.ts");
const { codexPlan, replayCodexPlan } = await import("../src/agents/codex-progress.ts");
const { createTextStream } = await import("../src/panels/rendered/text-stream.ts");

const plan = (turnId, status = "pending", step = "Inspect Source") => ({
  turnId, explanation: "Check the cause first.", plan: [{ step, status }],
});
function disk(initial = {}) {
  let state = structuredClone(initial);
  const writes = [];
  return { writes, state: () => structuredClone(state),
    read: async () => structuredClone(state),
    patch: async (entries) => { writes.push(structuredClone(entries)); Object.assign(state, structuredClone(entries)); },
  };
}

test("latest plan survives a new store and replays only in its original thread/turn", async () => {
  const backend = disk({ theme: "dark" }), live = new CodexPlanStore(backend);
  await live.remember("a", plan("one"));
  await live.remember("a", plan("one", "completed"));
  await live.remember("a", plan("two", "inProgress"));
  await live.remember("b", plan("one", "pending", "Other Thread"));
  const restored = new CodexPlanStore(backend);
  await restored.init();
  assert.deepEqual(replayCodexPlan("a", "one", restored), codexPlan(plan("one", "completed")));
  assert.match(replayCodexPlan("b", "one", restored)[0].markdown, /Other Thread/);
  assert.deepEqual(replayCodexPlan("a", "missing", restored), []);
  assert.equal(backend.state().theme, "dark");
  const detached = restored.get("a", "one");
  detached.plan[0].step = "Changed";
  assert.equal(restored.get("a", "one").plan[0].step, "Inspect Source");
});

test("replayed checklist paints between its turn's user and following turn", async () => {
  const backend = disk(), store = new CodexPlanStore(backend);
  await store.remember("a", plan("one", "completed"));
  await store.remember("a", plan("two", "inProgress"));
  const restored = new CodexPlanStore(backend);
  await restored.init();
  const host = document.createElement("div");
  const stream = createTextStream({ interimCandidates: [], replaying: true, hydrating: false }, {
    transcript: host, follow: { toBottom() {} }, append: (node, parent) => (parent ?? host).append(node),
    sealGroup() {}, toolHost: () => host,
  });
  for (const turn of ["one", "two"]) {
    const user = document.createElement("div");
    user.textContent = `User ${turn}`;
    host.append(user);
    for (const ev of replayCodexPlan("a", turn, restored)) stream.textDone(ev.blockId, ev.markdown, ev.parentToolUseId, ev.plan);
  }
  assert.equal(host.children.length, 4);
  assert.equal(host.children[0].textContent, "User one");
  assert.ok(host.children[1].classList.contains("blk-plan"));
  assert.equal(host.children[1].querySelector(".plan-step.done .plan-step-text").textContent, "Inspect Source");
  assert.equal(host.children[2].textContent, "User two");
  assert.equal(host.children[3].querySelector(".plan-step.run .plan-step-text").textContent, "Inspect Source");
});

test("plan card: title, explanation, ring tooltip and one status row per step", async () => {
  const [ev] = codexPlan({ turnId: "t", explanation: "Refresh, then rerun.", plan: [
    { step: "Read", status: "completed" }, { step: "Regenerate", status: "inProgress" }, { step: "Run", status: "pending" },
  ] });
  assert.match(ev.markdown, /In Progress: Regenerate/, "the text form stays for every other reader");
  const { planCard } = await import("../src/panels/rendered/plan-card.ts");
  const card = planCard(ev.plan);
  assert.equal(card.querySelector(".plan-title").textContent, "Plan");
  assert.equal(card.querySelector(".plan-exp").textContent, "Refresh, then rerun.");
  assert.equal(card.querySelector(".plan-progress title").textContent, "1 of 3");
  assert.deepEqual([...card.querySelectorAll(".plan-step")].map((r) => r.className), ["plan-step done", "plan-step run", "plan-step todo"]);
  assert.deepEqual([...card.querySelectorAll(".plan-status title")].map((t) => t.textContent), ["Completed", "In Progress", "Pending"]);
});

test("bad or duplicate rows are dropped while good rows survive", async () => {
  const valid = { ...plan("one"), threadId: "a", updatedAt: Date.now() };
  const good = { ...plan("two"), threadId: "a", updatedAt: Date.now() };
  const backend = disk({ [CODEX_PLANS_KEY]: { version: 1, entries: [valid, valid, good,
    { ...valid, turnId: "bad", plan: [{ step: "x", status: "bad" }] }] } });
  const store = new CodexPlanStore(backend, Date.now, () => {});
  await store.init();
  assert.ok(store.get("a", "one"));
  assert.ok(store.get("a", "two"));
  assert.equal(store.get("a", "bad"), null);
  assert.equal(backend.state()[CODEX_PLANS_KEY].entries.length, 2);
});

test("unreadable or structurally corrupt stores refuse writes and preserve saved data", async () => {
  for (const initial of [null, { [CODEX_PLANS_KEY]: {} }]) {
    const backend = disk(initial), errors = [];
    const store = new CodexPlanStore(backend, Date.now, (e) => errors.push(e));
    await store.remember("a", plan("one", "completed"));
    assert.equal(errors.length, 1);
    assert.equal(backend.writes.length, 0);
    assert.deepEqual(backend.state(), initial);
  }
  const errors = [], backend = disk();
  backend.read = async () => { throw new Error("Read failed"); };
  await new CodexPlanStore(backend, Date.now, (e) => errors.push(e)).remember("a", plan("one"));
  assert.equal(errors.length, 1);
  assert.equal(backend.writes.length, 0);
});

test("invalid live snapshots cannot replace a good checklist", async () => {
  const backend = disk(), store = new CodexPlanStore(backend);
  await store.remember("a", plan("one"));
  const writes = backend.writes.length;
  for (const invalid of [plan(""), { turnId: "one", plan: "bad" },
    plan("one", "unknown"), plan("one", "completed", "x".repeat(PLAN_LIMITS.planBytes))]) {
    await store.remember("a", invalid);
  }
  await store.remember("", plan("one"));
  assert.equal(backend.writes.length, writes);
  assert.equal(store.get("a", "one").plan[0].status, "pending");
});

test("turn rollback and thread archive prune only the named lifecycle", async () => {
  const backend = disk(), store = new CodexPlanStore(backend);
  await store.remember("a", plan("one"));
  await store.remember("a", plan("two"));
  await store.remember("b", plan("one"));
  await store.reconcile("a", new Set(["one"]));
  assert.equal(store.get("a", "two"), null);
  assert.ok(store.get("a", "one"));
  await store.forget("a");
  assert.equal(store.get("a", "one"), null);
  assert.ok(store.get("b", "one"));
  const reload = new CodexPlanStore(backend);
  await reload.init();
  assert.equal(reload.get("a", "one"), null);
});

test("retention caps turns, threads, total UTF-8 bytes and expires old plans", async () => {
  const backend = disk();
  let now = 1000;
  const store = new CodexPlanStore(backend, () => now++);
  for (let i = 0; i <= PLAN_LIMITS.turns; i++) await store.remember("a", plan(String(i)));
  assert.equal(store.get("a", "0"), null);
  assert.ok(store.get("a", String(PLAN_LIMITS.turns)));
  for (let i = 0; i < PLAN_LIMITS.threads; i++) await store.remember(`thread-${i}`, plan("one"));
  assert.equal(store.get("a", String(PLAN_LIMITS.turns)), null);
  for (let i = 0; i < 20; i++) await store.remember("large", plan(String(i), "pending", "\u{1f680}".repeat(3000)));
  const saved = backend.state()[CODEX_PLANS_KEY];
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= PLAN_LIMITS.bytes);
  assert.ok(store.get("large", "19"));
  now += PLAN_LIMITS.ageMs + 1;
  const reload = new CodexPlanStore(backend, () => now);
  await reload.init();
  assert.equal(reload.get("large", "19"), null);
  assert.deepEqual(backend.state()[CODEX_PLANS_KEY].entries, []);
});

test("rapid notifications coalesce behind a blocked write and persist the newest result", async () => {
  const backend = disk(), errors = [];
  let release, calls = 0, active = 0, maxActive = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const patch = backend.patch;
  backend.patch = async (entries) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (++calls === 1) await blocked;
    await patch(entries);
    active--;
  };
  const store = new CodexPlanStore(backend, Date.now, (e) => errors.push(e));
  await store.init();
  const first = store.remember("a", plan("one"));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = [];
  for (let i = 0; i < 100; i++) pending.push(store.remember("a", plan("one", "inProgress", String(i))));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, ...pending]);
  assert.equal(maxActive, 1);
  assert.equal(calls, 2);
  assert.equal(backend.state()[CODEX_PLANS_KEY].entries[0].plan[0].step, "99");
  backend.patch = async () => { throw new Error("Write failed"); };
  await store.remember("a", plan("one", "completed"));
  assert.equal(errors.length, 1);
  backend.patch = patch;
  await store.remember("a", plan("one", "completed"));
  assert.equal(backend.state()[CODEX_PLANS_KEY].entries[0].plan[0].status, "completed");
});

test("closing a Codex body during snapshot hydration prevents spawning a retired adapter", async () => {
  const { createLifecycle } = await import("../src/panels/rendered/lifecycle.ts");
  const state = { disposed: false, spawning: null };
  let adapters = 0, spawns = 0;
  const life = createLifecycle(state, {
    opts: { agent: "codex" }, newAdapter: () => { adapters++; },
    transport: { spawn: () => { spawns++; } },
  });
  const opening = life.spawn();
  await readStarted;
  assert.equal(adapters, 0);
  state.disposed = true;
  releaseRead({});
  await opening;
  assert.equal(adapters, 0);
  assert.equal(spawns, 0);
  assert.equal(state.spawning, null);
});

test("adapter records turn/plan/updated and a resumed turn gets its plan back", async () => {
  const { CodexAdapter } = await import("../src/agents/codex.ts");
  const { codexPlans } = await import("../src/agents/codex-plan-store.ts");
  const make = (resume) => {
    const adapter = new CodexAdapter(), wire = [];
    adapter.attach((line) => wire.push(JSON.parse(line)));
    adapter.start({ cwd: "C:/work", permissionMode: "default", resume });
    const request = (m) => wire.findLast((x) => x.method === m);
    const reply = (m, result) => adapter.feed(JSON.stringify({ id: request(m).id, result }));
    reply("initialize", {});
    reply(resume ? "thread/resume" : "thread/start", { thread: { id: "adapter-thread" } });
    return { adapter, reply };
  };
  // The shared store's read is held open for the hydration test above; release it here too, or
  // this await never settles when that test fails or is skipped and the runner waits forever.
  releaseRead({});
  await codexPlans.init();
  const live = make();
  live.adapter.feed(JSON.stringify({ method: "turn/plan/updated", params: { threadId: "adapter-thread", ...plan("t-1", "completed", "Adapter Step") } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(codexPlans.get("adapter-thread", "t-1"));
  const resumed = make("adapter-thread");
  const events = resumed.reply("thread/turns/list", { data: [
    { id: "t-1", items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "Go" }] }] },
    { id: "t-2", items: [] },
  ], nextCursor: null });
  const at = events.findIndex((e) => JSON.stringify(e).includes("Adapter Step"));
  assert.ok(at > events.findIndex((e) => e.kind === "user_echo"), "plan follows its turn's user message");
  assert.equal(events.filter((e) => JSON.stringify(e).includes("Adapter Step")).length, 1);
});
