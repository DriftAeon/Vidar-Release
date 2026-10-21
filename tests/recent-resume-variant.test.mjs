// "/resume" from a rendered body (launcher/recent.ts vidar-open-resume): a plain tab lists the
// launcher's lead variant (profile null by default roster order is checked per lead); a Bare tab
// lists its own home and opens the pick on the same profile and row key.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const rowsMade = [];
const dom = setupDom({ stubs: {
  "panels/sessions": `export function openRenderedSessionIds() { return []; }
    export async function createSession() { return "s1"; }
    export function hasArmedAstra() { return false; }`,
  "launcher/menu": `export const newBtn = document.createElement("button");
    export function openLauncher() {}`,
  "launcher/columns": `export function openColumn() { return document.createElement("div"); }
    export function placeColumn() {}
    export function hoverOpen() {}`,
  "launcher/codex-recent": `export async function openCodexRecent(t, rendered) { globalThis.__codexList = rendered; }`,
  "launcher/menu-rows": "export function twoLineRow() { return document.createElement('button'); }",
  "tab-names": "export function mintTabName() { return 'Tab'; }",
  "capabilities/registry": "export function use() { return null; }",
} });

const { BUILTIN_AGENTS, setRoster } = await import("../src/launcher/roster.ts");
const { initRecent } = await import("../src/launcher/recent.ts");
const { setLauncherLead, resumeVariant } = await import("../src/launcher/body-order.ts");

const fire = async (detail) => {
  document.dispatchEvent(new document.defaultView.CustomEvent("vidar-open-resume", { detail }));
  await new Promise((r) => setTimeout(r, 20));
};
let inited = false;
const start = (keys) => {
  setRoster(keys ? BUILTIN_AGENTS.filter((a) => keys.includes(a.key)) : BUILTIN_AGENTS);
  if (!inited) { initRecent(); inited = true; }
  globalThis.__codexList = undefined;
};

test("a plain Claude tab lands on the plain row whatever the launcher lead", async () => {
  start();
  const listed = [];
  dom.ipc.answers.list_recent_sessions = (args) => { listed.push(args); return []; };
  setLauncherLead("raw");
  await fire({ agent: "claude", cwd: "C:\\work" });
  assert.equal(listed.at(-1).profile, null, "raw lead: the default home");
  setLauncherLead("bare");
  await fire({ agent: "claude", cwd: "C:\\work2" });
  assert.equal(listed.at(-1).profile, null, "bare lead: still the default home");
});

test("a Bare Claude tab lists its own home", async () => {
  start();
  const listed = [];
  dom.ipc.answers.list_recent_sessions = (args) => { listed.push(args); return []; };
  setLauncherLead("raw");
  await fire({ agent: "claude", cwd: "C:\\work3", profile: "bare", rowKey: "claude-rendered-bare" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].profile, "bare", "list_recent_sessions gets the Bare profile");
});

test("only a Bare Rendered variant shown (plain rows off): a Bare tab resumes on it, a plain tab falls back to it", async () => {
  start(["claude-bare", "claude-rendered-bare"]);
  const listed = [];
  dom.ipc.answers.list_recent_sessions = (args) => { listed.push(args); return []; };
  setLauncherLead("raw");
  await fire({ agent: "claude", cwd: "C:\\work4", profile: "bare", rowKey: "claude-rendered-bare" });
  assert.equal(listed.at(-1)?.profile, "bare");
  const n = listed.length;
  await fire({ agent: "claude", cwd: "C:\\work4b" });
  assert.equal(listed.length, n + 1, "a plain tab falls back to the Bare row when the plain one is off");
  assert.equal(listed.at(-1)?.profile, "bare");
});

test("a Bare Codex tab resumes on the Bare row; a plain Codex tab on the plain row", async () => {
  start();
  setLauncherLead("raw");
  await fire({ agent: "codex", cwd: "C:\\work", profile: "bare", rowKey: "codex-rendered-bare" });
  assert.equal(globalThis.__codexList?.key, "codex-rendered-bare");
  assert.equal(globalThis.__codexList?.profile, "bare");
  await fire({ agent: "codex", cwd: "C:\\work" });
  assert.equal(globalThis.__codexList?.key, "codex-rendered");
});

test("a Bare tab whose row is hidden gets no list", async () => {
  start(["claude", "claude-rendered"]);
  const listed = [];
  dom.ipc.answers.list_recent_sessions = (args) => { listed.push(args); return []; };
  await fire({ agent: "claude", cwd: "C:\\work5", profile: "bare", rowKey: "claude-rendered-bare" });
  assert.deepEqual(listed, [], "never falls back to the plain row");
});

test("resumeVariant picks by lead and falls back to whichever exists", () => {
  const plain = { key: "p", body: "rendered" };
  const bare = { key: "claude-rendered-bare", body: "rendered", profile: "bare" };
  const raw = { key: "claude-bare", body: "raw", profile: "bare" };
  assert.equal(resumeVariant([plain, bare, raw], "bare"), bare);
  assert.equal(resumeVariant([plain, bare, raw], "raw"), plain);
  assert.equal(resumeVariant([bare, raw], "raw"), bare);
  assert.equal(resumeVariant([plain, raw], "bare"), plain);
  assert.equal(resumeVariant([raw], "bare"), undefined);
});
