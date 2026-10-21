import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";
import { rackServerId } from "../src/panels/rack-modules.ts";

const stubs = {
  "icon-img": `export const BACKEND_ICON_MAP = new Map(); export function iconImg() { return document.createElement("span"); }`,
  format: `export const DASH = "—"; export const firstLine = (s) => s.split(/\\r?\\n/)[0]; export const label = (s) => s; export const titleWords = (s) => s;`,
  "panels/lmstudio": `export async function renderLmStudioDetail(host) { host.textContent = "LM detail"; }`,
  "panels/skill-label": `export const skillLabel = (s) => s;`,
  "launcher/agent-kind": `export const isGateway = () => false;`,
  "panels/reorder": `export function applyOrder() {} export function enableReorder() {}`,
  "panels/sessions": `export const getFocusedSession = () => globalThis.__rackContextFocus;`,
  "panels/backend-status": `export const summarizeBackend = () => ({ live: true, parts: [], title: "" });`,
  prefs: `export function getPref(key) { return globalThis.__rackContextPrefs[key]; }
    export function setPref(key, value) {
      globalThis.__rackContextPrefs[key] = value;
      globalThis.__rackContextWrites.push([key, value]);
      return true;
    }`,
};

const A = "C:/Work/A";
const B = "C:/Work/B";
const server = (name, project) => ({
  name, scope: "project", transport: "http", target: "https://remote.invalid/mcp",
  args: [], envKeys: [], project,
});
const response = (...servers) => ({ servers, notes: [] });
const hidden = () => globalThis.__rackContextPrefs["modules.hidden"];
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')];

async function mount(answers, savedHidden = [], project = A) {
  const dom = setupDom({ stubs, answers });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.__rackContextPrefs = { "modules.hidden": savedHidden, "order.rack": [] };
  globalThis.__rackContextWrites = [];
  globalThis.__rackContextFocus = { agent: "claude", art: "code", cwd: project };
  const leftbar = document.createElement("div");
  leftbar.id = "leftbar";
  const dock = document.createElement("div");
  dock.id = "bar-dock";
  const modules = document.createElement("div");
  modules.id = "bar-modules";
  const root = document.createElement("div");
  modules.append(root);
  dock.append(modules);
  leftbar.append(dock);
  document.body.append(leftbar);
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(root);
  const context = (target) => {
    target.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 12, clientY: 15,
    }));
    return menuItems();
  };
  const select = (label) => {
    const item = menuItems().find((entry) => entry.textContent === label);
    assert.ok(item, `${label} is offered`);
    item.click();
  };
  const focus = (cwd) => {
    globalThis.__rackContextFocus = { agent: "claude", art: "code", cwd };
    document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", { detail: globalThis.__rackContextFocus }));
  };
  return { ...dom, leftbar, dock, modules, root, dispose, context, select, focus };
}

test("server and LM Studio rows hide, then blank rack space restores both", async (t) => {
  const alpha = server("Alpha", A);
  const dom = await mount({ read_mcp_servers: () => response(alpha) });
  t.after(() => dom.dispose?.());
  const id = rackServerId(alpha);
  const row = dom.root.querySelector(`[data-key="${id}"]`);
  assert.ok(row);
  assert.ok(dom.context(row).some((item) => item.textContent === "Hide Alpha"));
  dom.select("Hide Alpha");
  await dom.flush();
  assert.ok(hidden().includes(id));
  assert.equal(dom.root.querySelector(`[data-key="${id}"]`), null);

  const lm = dom.root.querySelector('[data-key="lmstudio"]');
  assert.ok(lm);
  assert.ok(dom.context(lm).some((item) => item.textContent === "Hide LM Studio"));
  dom.select("Hide LM Studio");
  await dom.flush();
  assert.ok(hidden().includes("rack:lmstudio"));
  assert.equal(dom.root.querySelector('[data-key="lmstudio"]'), null);

  dom.context(dom.root.querySelector(".rack-list"));
  dom.select("Show Alpha");
  await dom.flush();
  assert.equal(hidden().includes(id), false);
  assert.ok(dom.root.querySelector(`[data-key="${id}"]`));
  dom.context(dom.leftbar);
  dom.select("Show LM Studio");
  await dom.flush();
  assert.equal(hidden().includes("rack:lmstudio"), false);
  assert.ok(dom.root.querySelector('[data-key="lmstudio"]'));
  assert.equal(globalThis.__rackContextWrites.some(([key]) => key !== "modules.hidden" && key !== "order.rack"), false);
  assert.equal(dom.ipc.invoked.some((cmd) => /write|save|disable|config/i.test(cmd)), false,
    "visibility controls never write Claude MCP configuration");
});

test("hiding a focused row keeps focus in the rack after its async rebuild", async (t) => {
  const alpha = server("Alpha", A);
  const dom = await mount({ read_mcp_servers: () => response(alpha) });
  t.after(() => dom.dispose?.());
  const name = dom.root.querySelector(`[data-key="${rackServerId(alpha)}"] .rack-name`);
  name.focus();
  dom.context(name);
  dom.select("Hide Alpha");
  await dom.flush();
  assert.notEqual(document.activeElement, document.body);
  assert.ok(dom.root.contains(document.activeElement));
});

test("container hides and recovers from the persistent left bar while its box is CSS-hidden", async (t) => {
  const dom = await mount({ read_mcp_servers: response(server("Alpha", A)) });
  t.after(() => dom.dispose?.());
  dom.context(dom.root.querySelector(".rack-list"));
  dom.select("Hide MCP Rack");
  await dom.flush();
  assert.ok(hidden().includes("rack:container"));
  assert.equal(dom.root.childElementCount, 0);
  dom.modules.style.display = "none"; // matches the parent CSS-hidden state after rack off
  assert.ok(dom.context(dom.leftbar).some((item) => item.textContent === "Show MCP Rack"));
  dom.select("Show MCP Rack");
  await dom.flush();
  assert.equal(hidden().includes("rack:container"), false);
  assert.ok(dom.root.querySelector('[data-key="lmstudio"]'));
});

test("same-name project rows keep separate visibility choices, including the rail view", async (t) => {
  const a = server("Shared", A);
  const b = server("Shared", B);
  const dom = await mount({ read_mcp_servers: ({ project }) => response(project === A ? a : b) });
  const rail = document.createElement("div");
  document.body.append(rail);
  const railDispose = await (await import("../src/panels/rack.ts")).initRack(rail, { only: (s) => s.name === "Shared" });
  t.after(() => { railDispose?.(); dom.dispose?.(); });
  assert.notEqual(rackServerId(a), rackServerId(b));
  assert.ok(rail.querySelector(`[data-key="${rackServerId(a)}"]`));
  dom.context(dom.root.querySelector(`[data-key="${rackServerId(a)}"]`));
  dom.select("Hide Shared");
  await dom.flush();
  assert.ok(hidden().includes(rackServerId(a)));
  assert.equal(rail.querySelector(`[data-key="${rackServerId(a)}"]`), null,
    "a saved-hidden server is absent from the filtered rail");
  dom.focus(B);
  await dom.flush();
  assert.ok(dom.root.querySelector(`[data-key="${rackServerId(b)}"]`));
  assert.ok(rail.querySelector(`[data-key="${rackServerId(b)}"]`));
  assert.equal(hidden().includes(rackServerId(b)), false);
  dom.focus(A);
  await dom.flush();
  dom.context(dom.root.querySelector(".rack-list"));
  dom.select("Show Shared");
  await dom.flush();
  assert.ok(dom.root.querySelector(`[data-key="${rackServerId(a)}"]`));
  assert.ok(rail.querySelector(`[data-key="${rackServerId(a)}"]`));
});

test("empty rack keeps its appearance and can restore a saved-hidden LM Studio row", async (t) => {
  const dom = await mount({ read_mcp_servers: response() }, ["rack:lmstudio"]);
  t.after(() => dom.dispose?.());
  assert.equal(dom.root.querySelectorAll(".rack-row").length, 0);
  assert.equal(dom.root.querySelector(".rack-list")?.childElementCount, 0);
  dom.context(dom.leftbar);
  dom.select("Show LM Studio");
  await dom.flush();
  assert.ok(dom.root.querySelector('[data-key="lmstudio"]'));
  assert.equal(dom.ipc.invoked.some((cmd) => /write|save|disable|config/i.test(cmd)), false);
});
