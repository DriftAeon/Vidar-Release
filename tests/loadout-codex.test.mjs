import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

const { window, ipc } = setupDom({
  stubs: {
    "panels/reorder": "export function applyOrder() {} export function enableReorder() {}",
    "modules/registry": "export const moduleOn = () => true; export const onModulesChange = () => () => {};",
  },
});
const { codexRows } = await import("../src/panels/loadout-codex.ts");
const { initLoadout } = await import("../src/panels/loadout.ts");

const base = {
  home: null,
  instructions: [],
  developerInstructionsChars: null,
  skills: [],
  agents: [],
  model: null,
  effort: null,
  sandbox: null,
  approval: null,
  reviewer: null,
  network: null,
  notify: [],
  rulesFiles: 0,
  notes: [],
};

function render(overrides = {}) {
  const list = document.createElement("div");
  list.append(...codexRows({ ...base, ...overrides }, "."));
  for (const row of list.querySelectorAll(".rack-row")) row.querySelector(".rack-name").click();
  return list;
}

function detail(list, key) {
  return list.querySelector('[data-key="' + key + '"] .rack-detail');
}

test("Codex rows keep their order, labels, grouped notify scripts and notes", () => {
  const list = render({
    developerInstructionsChars: 42,
    skills: [{ name: "one-skill", description: "Skill description" }],
    agents: [{ name: "reviewer", model: "gpt-5" }, { name: "planner", model: null }],
    model: "gpt-test",
    sandbox: "workspace-write",
    network: true,
    notify: ["first.ps1", "second.mjs"],
    rulesFiles: 3,
    notes: ["Config unreadable"],
  });
  assert.deepEqual(
    [...list.querySelectorAll(".rack-row")].map((row) => row.dataset.key),
    ["Instructions", "Skills", "Agents", "Config", "Hooks", "Permissions"],
  );
  assert.deepEqual(
    [...list.querySelectorAll(".rack-label")].map((label) => label.textContent),
    ["Instructions", "Skills", "Agents", "Config", "Hooks", "Permissions"],
  );
  assert.match(detail(list, "Instructions").textContent, /Developer Instructions 42 chars/);
  assert.deepEqual(
    [...detail(list, "Config").querySelectorAll(".loadout-info-line")].map((line) => line.textContent),
    ["Model gpt-test", "Sandbox workspace-write"],
  );
  assert.equal(detail(list, "Permissions").textContent, "Sandbox workspace-writeNetwork OnRules Files 3");
  assert.equal(detail(list, "Hooks").querySelector(".loadout-group-head").textContent, "Notify");
  assert.deepEqual(
    [...detail(list, "Hooks").querySelectorAll(".loadout-item-line")].map((line) => line.textContent),
    ["first.ps1", "second.mjs"],
  );
  assert.equal(detail(list, "Skills").querySelector(".item-btn-name").textContent, "One Skill");
  assert.equal(list.querySelector(".tool-err").textContent, "Config unreadable");
  const agentRows = [...detail(list, "Agents").children].map((row) => row.textContent);
  assert.equal(agentRows.length, 2);
  assert.match(agentRows[0], /^reviewer/);
  assert.match(agentRows[1], /^planner—$/);
  assert.equal(list.querySelector('[data-key="Agents"] .rack-name').hasAttribute("aria-disabled"), false);
});

test("a role read-only by prompt gets the lock icon after its model; others do not", () => {
  const list = render({
    agents: [{ name: "orion", model: null, readOnlyByPrompt: true }, { name: "striker", model: null, readOnlyByPrompt: false }],
  });
  const [orion, striker] = [...detail(list, "Agents").children];
  assert.equal(orion.textContent, "orion—");
  assert.equal(orion.querySelector("img.icn").title, "Read-only by prompt: Codex does not sandbox this role");
  assert.match(orion.querySelector("img.icn").src, /lock\.svg$/);
  assert.equal(striker.textContent, "striker—");
  assert.equal(striker.querySelector("img.icn"), null);
});

test("an empty Agents row has no toggle: aria-disabled, never opens, no placeholder", () => {
  const list = render();
  const row = list.querySelector('[data-key="Agents"]');
  const name = row.querySelector(".rack-name");
  assert.equal(name.getAttribute("aria-disabled"), "true");
  assert.equal(name.hasAttribute("aria-expanded"), false);
  assert.equal(name.disabled, false, "aria-disabled, not the dimming disabled attribute");
  name.click();
  assert.ok(!row.classList.contains("open"));
  assert.equal(detail(list, "Agents").textContent, "");
});

test("a section with nothing in it is hidden; one with entries is shown", () => {
  const list = render({ skills: [{ name: "one-skill", description: "" }], network: false });
  const hidden = (key) => list.querySelector('[data-key="' + key + '"]').hidden;
  assert.equal(hidden("Skills"), false);
  assert.equal(hidden("Permissions"), false);
  for (const key of ["Instructions", "Agents", "Config", "Hooks"]) assert.equal(hidden(key), true, key);
});


test("null config values and network are omitted; empty rows stay shut", () => {
  const list = render({ network: false });
  const config = list.querySelector('[data-key="Config"] .rack-name');
  assert.equal(config.getAttribute("aria-disabled"), "true");
  assert.equal(detail(list, "Config").textContent, "");
  assert.equal(detail(list, "Permissions").textContent, "Sandbox —Network OffRules Files 0");
  assert.equal(list.querySelector('[data-key="Hooks"] .rack-name').getAttribute("aria-disabled"), "true");
  assert.equal(detail(list, "Hooks").textContent, "");

  const withoutNetwork = render();
  assert.equal(detail(withoutNetwork, "Permissions").textContent, "Sandbox —Rules Files 0");
});

test("loadout source retains both readers and the Codex command payload", () => {
  const source = readFileSync(new URL("../src/panels/loadout.ts", import.meta.url), "utf8");
  assert.match(source, /invoke\("read_loadout",\s*\{/);
  assert.match(source, /focused\?\.agent === "codex" && moduleOn\("codex"\)/);
  assert.match(source, /invoke\("read_codex_loadout",\s*\{\s*tab: target\.id,\s*profile: target\.profile \?\? null,\s*cwd: target\.cwd,/);
});

test("focused Codex tab queries its own reader and renders the returned rows", async () => {
  const calls = [];
  ipc.answers.read_codex_loadout = (args) => {
    calls.push(args);
    return { ...base, model: "gpt-test", network: true };
  };
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const controller = new window.AbortController();
  initLoadout(root, controller.signal);
  document.dispatchEvent(new window.CustomEvent("vidar-focus", {
    detail: { id: "codex-tab", agent: "codex", profile: "bare", cwd: ".", launchArgs: [] },
  }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [{ tab: "codex-tab", profile: "bare", cwd: "." }]);
  assert.deepEqual(
    [...root.querySelectorAll(".rack-row")].map((row) => row.dataset.key),
    ["Instructions", "Skills", "Agents", "Config", "Hooks", "Permissions"],
  );
  assert.ok(ipc.invoked.includes("read_codex_loadout"));
  assert.ok(!ipc.invoked.includes("read_loadout"));
  controller.abort();
});

test("a same-tab cwd or profile change reloads; a same-inputs focus does not", async () => {
  const calls = [];
  ipc.answers.read_codex_loadout = (args) => {
    calls.push(args);
    return { ...base };
  };
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const controller = new window.AbortController();
  initLoadout(root, controller.signal);
  const focus = (detail) => document.dispatchEvent(new window.CustomEvent("vidar-focus", { detail }));
  const tab = { id: "codex-tab", agent: "codex", profile: "bare", cwd: "C:\\one", launchArgs: [] };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  focus(tab);
  await settle();
  focus({ ...tab, title: "Renamed" });
  await settle();
  focus({ ...tab, cwd: "C:\\two" });
  await settle();
  focus({ ...tab, cwd: "C:\\two", profile: "work" });
  await settle();
  controller.abort();
  assert.deepEqual(calls.map((c) => [c.cwd, c.profile]), [["C:\\one", "bare"], ["C:\\two", "bare"], ["C:\\two", "work"]]);
});
