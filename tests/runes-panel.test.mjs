// Runes tab refresh (run 2026-10-17-sharpness, lane C1): one query per switch, and open sets and cards
// survive a redraw. Catalog fixture from runes-trace.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

const LOOKUP = `
export const getFocusedSession = () => globalThis.__focus ?? null;
export const renderedSessionId = () => null;
export const renderedBody = () => null;
export const sessionLaunchInfo = () => null;`;

const dom = setupDom({ stubs: { "panels/sessions/lookup": LOOKUP } });
const { mountRunesView, onRunesShown, onRunesHidden, disposeRunesView } = await import("../src/panels/runes.ts");

const FX = new URL("./fixtures/runes-catalog/", import.meta.url);
const BASE = "D:\\fx\\repo";
const J = (p) => JSON.stringify(p).slice(1, -1);
const sub = (s) => s.replaceAll("<base>", J(BASE)).replaceAll("<repo>", J(BASE)).replaceAll("<REPO>", J(BASE.toUpperCase())).replaceAll("<home>", J("D:\\fx\\home"));
const CATALOG = JSON.parse(sub(readFileSync(new URL("golden.json", FX), "utf8")));
const NONE = { source: "none", reason: "No Loads Recorded", files: [] };

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const count = (cmd) => dom.ipc.invoked.filter((c) => c === cmd).length;

globalThis.__focus = { id: "t2", title: "R", agent: "claude", art: "claude", cwd: "C:/proj" };
dom.ipc.answers.runes_catalog = CATALOG;
dom.ipc.answers.runes_loaded = NONE;

const parent = document.createElement("div");
document.body.appendChild(parent);
mountRunesView(parent, () => {}, () => {});
const replyDone = () => document.dispatchEvent(new window.CustomEvent("vidar-reply-done", { detail: { id: "t2", agent: "claude", cwd: null } }));

test("showing the tab and a focus event in one task query the transcript once", async () => {
  onRunesShown(); // warm the catalog cache: a cold first refresh drops the overlap before the query
  await settle();
  onRunesHidden();
  const before = count("runes_loaded");
  onRunesShown();
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(count("runes_loaded") - before, 1);
  assert.ok(parent.querySelector("details.runes-set"), "the sets drew");
});

test("with no focused session the list is empty and the strip hidden", async () => {
  const focus = globalThis.__focus;
  globalThis.__focus = null;
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(parent.querySelector(".runes-list").children.length, 0, "no sets drew");
  assert.equal(parent.querySelector(".runes-state").textContent, "");
  assert.ok(parent.querySelector(".runes-strip").hidden);
  globalThis.__focus = focus;
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.ok(parent.querySelector("details.runes-set"), "the sets draw again with a session");
});

test("an open set and card survive a redraw; a changed answer redraws them open", async () => {
  const set = () => parent.querySelector("details.runes-set");
  const card = () => set().querySelector("details.runes-rn");
  set().open = true;
  card().open = true;
  card().dispatchEvent(new window.Event("toggle"));
  await settle();
  assert.ok(card().querySelector(".runes-rb"), "body built on open");
  const oldSet = set();
  replyDone();
  await settle();
  assert.equal(set(), oldSet, "same answers: no DOM write");
  assert.ok(set().open && card().open);
  dom.ipc.answers.runes_loaded = { source: "transcript", truncated: false, files: [{ path: `${BASE.replaceAll("\\", "/")}/CLAUDE.md`, memoryType: "Project", when: "start" }] };
  replyDone();
  await settle();
  assert.notEqual(set(), oldSet, "a changed answer redraws");
  assert.ok(set().open, "set open in the new DOM");
  assert.ok(card().open, "card open in the new DOM");
  assert.equal(card().querySelectorAll(".runes-rb").length, 1, "exactly one body");
  onRunesHidden();
  disposeRunesView();
});
