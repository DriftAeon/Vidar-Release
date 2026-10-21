import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const reply = (memoryEntries) => ({
  instructions: [], memoryPath: "C:\A\MEMORY.md", memoryEntries, handoffPath: null, handoffNewest: null,
  skills: [], agents: [], notes: [], hooks: [], permissions: [],
});

let pending = [];
setupDom({
  stubs: {
    "panels/reorder": "export function applyOrder() {} export function enableReorder() {}",
    "modules/registry": "export const moduleOn = () => true; export const onModulesChange = () => () => {};",
  },
  answers: { read_loadout: (args) => new Promise((resolve) => pending.push({ cwd: args.cwd, resolve })) },
});
const { initLoadout } = await import("../src/panels/loadout.ts");
const { boundedCache } = await import("../src/panels/loadout-cache.ts");

const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const focus = (id, cwd) => document.dispatchEvent(new window.CustomEvent("vidar-focus", {
  detail: { id, agent: "claude", cwd, launchArgs: [] },
}));

test("boundedCache drops the oldest entry past its bound", () => {
  const c = boundedCache(2);
  c.set("a", 1); c.set("b", 2); c.set("a", 3); c.set("c", 4);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 3);
  assert.equal(c.size, 2);
});

test("Tab switch keeps the rows on screen and keeps open rows open", async () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const controller = new window.AbortController();
  initLoadout(root, controller.signal);
  const list = root.querySelector(".rack-list");
  const counts = [];
  new window.MutationObserver(() => counts.push(list.children.length)).observe(list, { childList: true });
  const flush = async () => { await tick(); await tick(); };

  focus("a", "C:\\A");
  assert.match(list.textContent, /Querying/); // never drawn: the one allowed Querying line
  pending.shift().resolve(reply(1));
  await flush();
  const full = list.children.length;
  assert.ok(full > 3);
  counts.length = 0;
  list.querySelector('[data-key="Memory"] .rack-name').click();

  focus("b", "C:\\B"); // no cache entry: previous rows stay
  await flush();
  assert.equal(list.children.length, full);
  assert.doesNotMatch(list.textContent, /Querying/);
  assert.equal(list.querySelector('[data-key="Memory"] .rack-name').getAttribute("aria-expanded"), "true");
  pending.shift().resolve(reply(1));
  await flush();

  focus("a", "C:\\A"); // cached: drawn at once, refetch behind it
  await flush();
  assert.equal(list.children.length, full);
  assert.equal(pending.length, 1);
  pending.shift().resolve(reply(7)); // differs: redraws with the open row kept
  await flush();
  assert.equal(list.children.length, full);
  assert.equal(list.querySelector('[data-key="Memory"] .rack-name').getAttribute("aria-expanded"), "true");
  assert.ok(!counts.includes(1), `child count dipped to 1: ${counts}`);

  controller.abort();
});
