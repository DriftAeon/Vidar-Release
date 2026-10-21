// Card Rows progress view (src/runes/bare/agent-view.ts, progress.ts): start times from an injected clock, the
// glyph and state per card, Merge below its separator, and no interval left once the run ends or the view is disposed.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createAgentView } = await import("../src/runes/bare/agent-view.ts");
const { elapsedLabel, emptyProgress, progressCards, reduceProgress } = await import("../src/runes/bare/progress.ts");

const plan = { runId: "r", stage: "plan", chunks: [
  { files: [{ path: "a.md", part: null }] }, { files: [{ path: "b.md", part: null }] }, { files: [{ path: "c.md", part: null }] },
] };
const chunk = (index, state, runes = null) => ({ runId: "r", stage: "chunk", index, state, runes });

function fakeClock() {
  const c = { t: 1000, ticks: new Set(), now: () => c.t, every: (fn) => { const h = { fn }; c.ticks.add(h); return () => c.ticks.delete(h); } };
  c.advance = (ms) => { c.t += ms; for (const h of [...c.ticks]) h.fn(); };
  return c;
}

test("the reducer records a row's start the first time it goes running, and keeps it through a retry", () => {
  let s = reduceProgress(emptyProgress(), plan, 0);
  s = reduceProgress(s, chunk(0, "running"), 5000);
  s = reduceProgress(s, chunk(0, "retrying"), 9000);
  s = reduceProgress(s, { runId: "r", stage: "merge", state: "running" }, 20000);
  assert.equal(s.chunks[0].startedAt, 5000);
  assert.equal(s.chunks[1].startedAt, null);
  assert.equal(s.mergeStartedAt, 20000);
  const cards = progressCards(s);
  assert.deepEqual(cards.map((c) => [c.state, c.retrying, c.startedAt]), [["running", true, 5000], ["pending", false, null], ["pending", false, null], ["running", false, 20000]]);
  s = reduceProgress(s, chunk(0, "done", 3), 30000);
  assert.equal(progressCards(s)[0].startedAt, null, "a done card shows no timer");
});

test("elapsedLabel reads m:ss", () => {
  assert.equal(elapsedLabel(0), "0:00");
  assert.equal(elapsedLabel(65_900), "1:05");
  assert.equal(elapsedLabel(-5), "0:00");
});

function mountRun() {
  const clock = fakeClock();
  let push;
  let finish;
  const flow = {
    generateAgent: (a) => { push = a.onProgress; a.onRun("r"); return new Promise((r) => { finish = r; }); },
    cancelGenerate: async () => {},
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  let view;
  const paint = () => { host.replaceChildren(...view.generatingView()); };
  view = createAgentView({
    codex: false, flow, clock, paint, enter: () => {}, done: () => {},
    gen: () => ({ models: [{ value: "claude-sonnet-5", label: "Sonnet" }] }),
  });
  const go = view.generateButton({ files: [], memoryDir: null, guardsKey: false }, new Set(["x"]), true);
  return { clock, host, view, go, push: (e) => push(e), finish: (r) => finish(r) };
}

test("cards carry a glyph and state per row, Merge sits after the separator, timers tick in place", async () => {
  const m = mountRun();
  m.go.click();
  m.push(plan);
  m.push(chunk(0, "done", 1));
  m.push(chunk(1, "running"));
  m.push(chunk(2, "retrying"));
  const cards = [...m.host.querySelectorAll(".runes-gen-card")];
  assert.deepEqual(cards.map((c) => c.dataset.state), ["done", "running", "retrying", "pending"]);
  assert.deepEqual(cards.map((c) => c.querySelector("svg").getAttribute("class")), ["rg-glyph rg-done", "rg-glyph rg-running", "rg-glyph rg-retrying", "rg-glyph rg-pending"]);
  const kids = [...m.host.querySelector(".runes-gen-cards").children];
  assert.equal(kids.at(-2).className, "runes-gen-sep");
  assert.ok(kids.at(-1).classList.contains("runes-gen-merge"));
  assert.equal(cards[1].querySelector(".runes-gen-time").textContent, "0:00");
  assert.equal(cards[0].querySelector(".runes-gen-time"), null);
  const before = cards[1];
  m.clock.advance(65_000);
  assert.equal(before.querySelector(".runes-gen-time").textContent, "1:05");
  assert.equal(m.host.querySelectorAll(".runes-gen-card")[1], before, "a tick does not rebuild the cards");
  assert.equal(cards[2].querySelector(".runes-gen-state").textContent, "Retrying");
  m.view.dispose();
  assert.equal(m.clock.ticks.size, 0);
});

test("one interval runs while a row is running and none is left when the rows or the run end", async () => {
  const m = mountRun();
  m.go.click();
  m.push(plan);
  assert.equal(m.clock.ticks.size, 0, "nothing running yet");
  m.push(chunk(0, "running"));
  m.push(chunk(1, "running"));
  assert.equal(m.clock.ticks.size, 1);
  m.push(chunk(0, "done", 1));
  m.push(chunk(1, "done", 1));
  assert.equal(m.clock.ticks.size, 0, "no row running");
  m.push(chunk(2, "running"));
  assert.equal(m.clock.ticks.size, 1);
  m.finish({ state: "cancelled", error: "cancelled" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m.clock.ticks.size, 0, "the run ended");
  assert.deepEqual([...m.host.querySelectorAll(".runes-gen-card")].map((c) => c.dataset.state), ["done", "done", "stopped", "stopped"]);
  m.view.dispose();
});
