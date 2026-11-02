// Runes tab refresh: one query per switch, and a classic tab draws state only (no load trace).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

const LOOKUP = `
export const getFocusedSession = () => globalThis.__focus ?? null;
export const renderedSessionId = () => null;
export const renderedBody = () => null;
export const sessionLaunchInfo = () => null;
export const pendingVaultTab = () => null;`;

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
});

test("a classic tab draws no load trace: the list stays empty, the state line follows the focus", async () => {
  const list = () => parent.querySelector(".runes-list");
  assert.equal(list().children.length, 0, "no trace drew");
  assert.equal(parent.querySelector(".runes-state").textContent, "No Loads Recorded");
  assert.ok(parent.querySelector(".runes-strip").hidden);
  dom.ipc.answers.runes_loaded = { source: "transcript", truncated: false, files: [{ path: `${BASE.replaceAll("\\", "/")}/CLAUDE.md`, memoryType: "Project", when: "start" }] };
  replyDone();
  await settle();
  assert.equal(list().children.length, 0, "loads draw no groups or cards");
  assert.ok(!parent.querySelector(".runes-strip").hidden, "the strip names the tab");
  const focus = globalThis.__focus;
  globalThis.__focus = null;
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(list().children.length, 0);
  assert.equal(parent.querySelector(".runes-state").textContent, "");
  assert.ok(parent.querySelector(".runes-strip").hidden);
  globalThis.__focus = focus;
  onRunesHidden();
  disposeRunesView();
});
