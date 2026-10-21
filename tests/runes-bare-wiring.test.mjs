// Bare wiring (run 2026-10-17-bare-runes-flow, T2b): the Runes tab mounts the Bare view for a focused Bare
// tab and not for a Raw one, disposes it on a focus change, io passes cwd and rowKey, and a failed actives
// read shows "Load Failed".
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const LOOKUP = `
export const getFocusedSession = () => globalThis.__focus ?? null;
export const renderedSessionId = () => null;
export const sessionLaunchInfo = (id) => (globalThis.__launch ?? {})[id] ?? null;`;

const dom = setupDom({ stubs: { "panels/sessions/lookup": LOOKUP } });
const { createBareIo } = await import("../src/runes/bare/io.ts");
const { mountRunesView, onRunesShown, onRunesHidden, disposeRunesView } = await import("../src/panels/runes.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const EMPTY_ACTIVES = { rowKey: "claude-bare", libraries: [], skills: [], agents: [], guards: [], guardsKey: false };
const SOURCES = { files: [], memoryDir: null, guardsKey: false };
const focus = (o) => { globalThis.__focus = o; };
const bare = { id: "t1", title: "T", agent: "claude", art: "claude", cwd: "C:/proj", profile: "bare" };
const raw = { id: "t2", title: "R", agent: "claude", art: "claude", cwd: "C:/proj" };

dom.ipc.answers.runes_catalog = { libraries: [] };
dom.ipc.answers.runes_loaded = { source: "none", reason: "No Loads Recorded", files: [] };
dom.ipc.answers.bare_local_sources = SOURCES;
dom.ipc.answers.bare_actives = EMPTY_ACTIVES;
globalThis.__launch = { t1: { rowKey: "claude-bare", cwd: "C:/proj" } };

const parent = document.createElement("div");
document.body.appendChild(parent);
mountRunesView(parent, () => {}, () => {});
const bareView = () => parent.querySelector(".runes-bare");
const keyEl = () => parent.querySelector(".runes-key");
const keyScopes = () => [...parent.querySelectorAll(".runes-key")].flatMap((k) =>
  [...k.querySelectorAll(".runes-key-group")[1].querySelectorAll(".runes-key-item")].map((i) => i.getAttribute("aria-label")));

test("a Bare focused tab mounts the Bare view and shows the key with the Bare scopes", async () => {
  focus(bare);
  onRunesShown();
  await settle();
  assert.ok(bareView(), "bare view");
  assert.ok(parent.querySelector(".runes-bare-trace"), "trace slot");
  assert.equal(parent.querySelector(".runes-bare-trace summary"), null, "no Active Runes section");
  assert.equal(keyEl().style.display, "");
  assert.ok(keyEl().querySelector(".runes-mode"), "the View / Modify button sits on the Key's line");
  assert.deepEqual(keyScopes(), ["Global", "Project"], "one key, Scope: Global, Project");
  assert.ok(dom.ipc.invoked.includes("bare_actives"));
});

test("a focus change to a Raw tab disposes it and restores the ordinary icon key", async () => {
  focus(raw);
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(bareView(), null);
  assert.deepEqual(keyScopes(), ["Global", "Vidar"]);
});

test("a Raw tab never mounts the Bare view", async () => {
  const launches = dom.ipc.invoked.filter((c) => c === "bare_launch").length;
  onRunesHidden();
  onRunesShown();
  await settle();
  assert.equal(bareView(), null);
  assert.equal(dom.ipc.invoked.filter((c) => c === "bare_launch").length, launches, "the ordinary view never asks for a launch");
});

test("hide, show and a Raw round trip re-attach the same Bare view", async () => {
  focus(bare);
  onRunesHidden();
  onRunesShown();
  await settle();
  const root = bareView();
  assert.ok(root);
  onRunesHidden();
  assert.equal(bareView(), root, "hiding keeps it");
  onRunesShown();
  await settle();
  assert.equal(bareView(), root, "show re-attaches the same root");
  focus(raw);
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(bareView(), null);
  focus(bare);
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(bareView(), root, "back on the Bare tab: the same root");
});

test("a failed actives read shows Load Failed with the raw error in the title", async () => {
  dom.ipc.answers.bare_actives = () => { throw new Error("boom: home gone"); };
  focus(bare);
  onRunesShown();
  await settle();
  const e = parent.querySelector(".rp-error");
  assert.ok(e, "error line");
  assert.equal(e.textContent, "Load Failed");
  assert.match(e.title, /boom: home gone/);
  dom.ipc.answers.bare_actives = EMPTY_ACTIVES;
});

const LAUNCH = {
  createdUtc: "2026-10-17T09:00:00Z", agent: "claude",
  sets: ["claude-user", "proj-claude-md"], skills: [], guards: ["guard-cwd.mjs"],
  warnings: ["Claude 9 differs from the verified 0.0.1; launching anyway", "No bareGuards in vidar.json"],
};
const traceBody = () => parent.querySelector(".runes-bare-trace");
const stateText = () => parent.querySelector(".runes-state").textContent;

test("a Bare trace shows the launch warnings once as compact lines; the set and hook name lists are gone", async () => {
  dom.ipc.answers.bare_launch = (a) => (a.tab === "t1" ? LAUNCH : null);
  focus(bare);
  onRunesHidden();
  onRunesShown();
  await settle();
  assert.equal(traceBody().querySelectorAll(".runes-div, .runes-outside").length, 0, "no set, skill or hook lists");
  const lines = [...traceBody().querySelectorAll(":scope > .runes-warn-line")];
  assert.deepEqual(lines.map((e) => e.title), LAUNCH.warnings, "the full text sits in each tooltip");
  assert.deepEqual(lines.map((e) => e.textContent), LAUNCH.warnings);
  assert.equal(stateText(), "", "no No Loads Recorded while a launch exists");
});

test("a Bare trace shows transcript loads as today's rows", async () => {
  dom.ipc.answers.bare_launch = { ...LAUNCH, skills: ["tidy"], guards: [], warnings: [] };
  dom.ipc.answers.runes_loaded = { source: "transcript", files: [{ path: "C:/proj/CLAUDE.md", memoryType: "Project", when: "start" }], truncated: false };
  onRunesHidden();
  onRunesShown();
  await settle();
  assert.equal(traceBody().querySelectorAll(".runes-group button.runes-outside-row").length, 1, "the transcript's file row");
  assert.equal(traceBody().querySelectorAll(".runes-div, .runes-outside-row:not(button)").length, 0, "no launch lists");
  dom.ipc.answers.runes_loaded = { source: "none", reason: "No Loads Recorded", files: [] };
});

test("no launch and no loads hide the trace", async () => {
  dom.ipc.answers.bare_launch = null;
  onRunesHidden();
  onRunesShown();
  await settle();
  assert.equal(traceBody().textContent, "");
  assert.equal(traceBody().hidden, true);
});

test("a Codex Bare tab shows no launch lists, never Codex Doesn't Report Loads", async () => {
  dom.ipc.answers.bare_launch = { ...LAUNCH, agent: "codex", guards: [], skills: ["tidy"], warnings: [] };
  dom.ipc.answers.runes_loaded = { source: "none", reason: "Codex Doesn't Report Loads", files: [] };
  focus({ ...bare, agent: "codex", art: "codex" });
  onRunesHidden();
  onRunesShown();
  await settle();
  assert.equal(traceBody().textContent, "");
  assert.equal(stateText(), "");
  dom.ipc.answers.runes_loaded = { source: "none", reason: "No Loads Recorded", files: [] };
  focus(bare);
});

test("the focused tab's finished turn re-queries once; another tab's does not", async () => {
  dom.ipc.answers.bare_launch = LAUNCH;
  onRunesHidden();
  onRunesShown();
  await settle();
  const count = () => dom.ipc.invoked.filter((c) => c === "bare_launch").length;
  const before = count();
  document.dispatchEvent(new window.CustomEvent("vidar-reply-done", { detail: { id: "other", agent: "claude", cwd: null } }));
  await settle();
  assert.equal(count(), before);
  document.dispatchEvent(new window.CustomEvent("vidar-reply-done", { detail: { id: "t1", agent: "claude", cwd: null } }));
  await settle();
  assert.equal(count(), before + 1);
  onRunesHidden();
  document.dispatchEvent(new window.CustomEvent("vidar-reply-done", { detail: { id: "t1", agent: "claude", cwd: null } }));
  await settle();
  assert.equal(count(), before + 1, "hidden: no query");
});

test("io passes cwd and rowKey, and layer errors reach the caller untouched", async () => {
  const calls = [];
  const io = createBareIo(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "bare_layer_set") throw "Hooks not saved";
    return {};
  });
  await io.localSources("C:/p");
  await io.actives("claude-bare");
  await io.scan("C:/p/CLAUDE.md", "C:/p");
  await io.apply({ path: "C:/p/CLAUDE.md", kept: ["a"], rows: { "claude-bare": ["a"] }, cwd: "C:/p" });
  await assert.rejects(io.layerSet({ skills: ["s"] }), /not saved$/);
  assert.deepEqual(calls, [
    ["bare_local_sources", { cwd: "C:/p" }],
    ["bare_actives", { rowKey: "claude-bare" }],
    ["rules_import_scan", { path: "C:/p/CLAUDE.md", cwd: "C:/p" }],
    ["rules_import_apply", { path: "C:/p/CLAUDE.md", kept: ["a"], rows: { "claude-bare": ["a"] }, cwd: "C:/p" }],
    ["bare_layer_set", { skills: ["s"] }],
  ]);
  disposeRunesView();
});
