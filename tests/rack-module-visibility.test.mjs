// Rack views must only query rows they actually render, and each project owns its tools promise.
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
  "panels/reorder": `export function applyOrder() {} export function enableReorder() { globalThis.__domMount.reorderCalls++; }`,
  "panels/sessions": `export const getFocusedSession = () => null;`,
  "panels/backend-status": `export const summarizeBackend = () => ({ live: true, parts: [], title: "" });`,
  prefs: `export function getPref(key) { return globalThis.__rackPrefs[key]; } export function setPref(key, value) { globalThis.__rackPrefWrites.push([key, value]); }`,
};

const server = (name, project, overrides = {}) => ({
  name, scope: "project", transport: "stdio", target: "shared-command", args: ["--stdio"],
  envKeys: [], project, ...overrides,
});

async function mountRack(answers, options = {}, hidden = []) {
  const dom = setupDom({ stubs, answers });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.__rackPrefs = { "modules.hidden": hidden, "order.rack": [] };
  globalThis.__rackPrefWrites = [];
  dom.ipc.reorderCalls = 0;
  const { initRack } = await import("../src/panels/rack.ts");
  const root = document.createElement("div");
  document.body.append(root);
  await initRack(root, options);
  return { ...dom, root };
}

// A stdio server is listed only on a List Tools click: expand every row, press every button.
async function listAll(rack) {
  for (const row of rack.root.querySelectorAll(".rack-row[data-server]")) {
    if (!row.classList.contains("open")) row.querySelector(".rack-name").click();
    for (const b of row.querySelectorAll("button.item-btn")) if (b.textContent === "List Tools") b.click();
  }
  await rack.flush();
}
const stdioCalls = (rack) => rack.ipc.invoked.filter((name) => name === "list_mcp_tools_stdio").length;

test("same stdio command in two projects starts and retains separate cached requests", async () => {
  const calls = [];
  const rack = await mountRack({
    read_mcp_servers: { servers: [server("one", "C:/Work/One"), server("two", "C:/Work/Two")], notes: [] },
    list_mcp_tools_stdio: (args) => { calls.push(args); return []; },
  });

  assert.equal(stdioCalls(rack), 0, "mounting lists no stdio server");
  assert.deepEqual(rack.root.querySelectorAll(".rack-row[data-server]").length, 2);
  await listAll(rack);
  assert.equal(stdioCalls(rack), 2);
  assert.deepEqual(calls.map((args) => args.project).sort(), ["C:/Work/One", "C:/Work/Two"]);
});

test("hidden, excluded, and filtered rows do not prefetch; LM Studio visibility is independent", async () => {
  const hiddenServer = server("container", "C:/Work/One", { target: "hidden-container-command", args: ["--isolated"] });
  const servers = [server("proxy", "C:/Work/One"), hiddenServer, server("other", "C:/Work/One")];
  const containerId = rackServerId(hiddenServer);
  const hiddenContainer = await mountRack({ read_mcp_servers: { servers, notes: [] } }, {}, ["rack:container"]);
  assert.equal(hiddenContainer.root.childElementCount, 0);
  assert.deepEqual(hiddenContainer.ipc.invoked, [], "a hidden rack container returns before reading config");

  const fullCalls = [];
  const full = await mountRack({
    read_mcp_servers: { servers, notes: [] },
    list_mcp_tools_stdio: (args) => { fullCalls.push(args); return []; },
  }, {}, [containerId]);

  assert.deepEqual([...full.root.querySelectorAll("[data-server]")].map((row) => row.dataset.server), ["proxy", "other"]);
  assert.equal(full.root.querySelector(`[data-key="${containerId}"]`), null);
  assert.equal(stdioCalls(full), 0);
  await listAll(full);
  assert.equal(stdioCalls(full), 1,
    "visible rows sharing a project and command reuse one tools request");
  assert.equal(fullCalls.some((args) => args.command === hiddenServer.target), false,
    "the hidden server's unique command is never prefetched");

  const filteredCalls = [];
  const filtered = await mountRack({
    read_mcp_servers: { servers, notes: [] },
    list_mcp_tools_stdio: (args) => { filteredCalls.push(args); return []; },
  }, { only: (s) => s.name !== "container" }, [containerId]);
  assert.deepEqual([...filtered.root.querySelectorAll("[data-server]")].map((row) => row.dataset.server), ["proxy", "other"]);
  assert.equal(filtered.root.querySelector(`[data-key="${containerId}"]`), null);
  await listAll(filtered);
  assert.equal(stdioCalls(filtered), 1);
  assert.equal(filteredCalls.some((args) => args.command === hiddenServer.target), false,
    "the hidden server stays unqueried in a filtered view too");
  assert.equal(filtered.root.querySelector('[data-key="lmstudio"]'), null);

  const hiddenLm = await mountRack({
    read_mcp_servers: { servers, notes: [] },
    list_mcp_tools_stdio: () => [],
  }, {}, ["rack:lmstudio"]);
  assert.equal(hiddenLm.root.querySelector('[data-key="lmstudio"]'), null);
  assert.equal(hiddenLm.root.querySelectorAll("[data-server]").length, servers.length);
  await listAll(hiddenLm);
  assert.equal(stdioCalls(hiddenLm), 2, "hiding LM Studio leaves MCP server listing intact");

  const lm = await mountRack({
    read_mcp_servers: { servers, notes: [] },
    list_mcp_tools_stdio: () => [],
  }, { lmStudioOnly: true, expand: true });
  assert.equal(lm.root.querySelectorAll("[data-server]").length, 0);
  assert.equal(lm.ipc.invoked.includes("list_mcp_tools_stdio"), false);
  assert.equal(lm.root.querySelector('[data-key="lmstudio"]')?.querySelector(".rack-detail")?.textContent, "LM detail");
});

test("empty and failed reads preserve their visible state without config mutations", async () => {
  const empty = await mountRack({ read_mcp_servers: { servers: [], notes: [] } }, {}, ["rack:lmstudio"]);
  assert.equal(empty.root.querySelectorAll(".rack-row").length, 0);
  assert.equal(empty.root.querySelector(".rack-list")?.childElementCount ?? 0, 0);

  const failed = await mountRack({ read_mcp_servers: () => { throw new Error("config read failed"); } }, {}, ["rack:lmstudio"]);
  assert.equal(failed.root.querySelectorAll(".rack-row").length, 0);
  assert.match(failed.root.textContent, /config read failed/);
  assert.deepEqual(failed.ipc.invoked, ["read_mcp_servers"], "rack reads and renders without invoking config writes");
});

test("Claude module availability controls rack mounts and the Settings offer", async () => {
  const mounted = [];
  const subscribers = new Set();
  let claude = false;
  let codex = false;
  globalThis.__rackCodexAvailable = () => codex;
  const registry = `export const moduleListed = () => true;
    export const moduleOn = (id) => (id === "claude" && globalThis.__rackClaudeAvailable()) || (id === "codex" && globalThis.__rackCodexAvailable());
    export const onModulesChange = (fn) => { globalThis.__rackModuleSubscribers.add(fn); return () => globalThis.__rackModuleSubscribers.delete(fn); };`;
  globalThis.__rackClaudeAvailable = () => claude;
  globalThis.__rackModuleSubscribers = subscribers;
  globalThis.__rackMounts = mounted;
  const noop = "export const initStatus = () => {}; export const initInspect = () => {}; export const initCloseLock = () => {}; export const initSwap = () => {}; export const initRightbarResize = () => {}; export const initLoadout = () => {};";
  const dom = setupDom({
    stubs: {
      ...stubs,
      prefs: `export function getPref(key) { return globalThis.__rackPrefs[key]; }
        export function setPref(key, value) { globalThis.__rackPrefs[key] = value; return true; }
        export async function savePrefConfirmed() { return { status: "saved" }; }`,
      "modules/registry": registry,
      "panels/status": noop, "panels/inspect": noop, "panels/closelock": noop,
      "panels/swap": noop, "panels/resize": noop, "panels/loadout": noop,
      "panels/rack": `export function initRack(host, _opts, signal) {
        globalThis.__rackMounts.push("rack"); host.textContent = "Rack";
        signal.addEventListener("abort", () => host.replaceChildren(), { once: true });
      }`,
      "panels/rail-stripe": `export function initRailStripe(host, signal) {
        globalThis.__rackMounts.push("stripe"); host.textContent = "Proxy MCP";
        signal.addEventListener("abort", () => host.replaceChildren(), { once: true });
      }`,
      "panels/workbench": "export function setWorkbenchTabVisibility() {}",
      "panels/toolbench": "export function setToolVisibility() {} export function syncToolOrder() {}",
      "tools/registry": "export const BUILTIN_TOOL_MODULES = [];",
    },
    answers: { read_mcp_servers: { servers: [server("alpha", "C:/Work/One")], notes: [] } },
  });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.__rackPrefs = { "modules.hidden": [], "order.rack": [] };
  document.body.innerHTML = ["status-compact", "inspect-btn", "close-lock", "swap-btn", "rightbar-grip", "bar-modules", "rail-stripe"]
    .map((id) => `<div id="${id}"></div>`).join("");
  const notifyModules = () => { for (const fn of [...subscribers]) fn(); };
  const { mountPanels } = await import("../src/panels/index.ts");
  const dispose = mountPanels();
  assert.deepEqual(mounted, [], "no Claude set mounts neither rack view");

  const { registerModuleRows } = await import("../src/settings/modules.ts");
  const { getSettingRows } = await import("../src/settings/registry.ts");
  registerModuleRows();
  const control = getSettingRows().find((row) => row.category === "modules").control(() => {});
  document.body.append(control);
  assert.equal(control.querySelector('[data-order-key="order.rack"]'), null);
  assert.equal(dom.ipc.invoked.includes("read_mcp_servers"), false);

  // a Claude-free set with Codex on still gets the rack and the Settings offer
  codex = true;
  notifyModules();
  await dom.flush();
  assert.deepEqual(mounted, ["rack", "stripe"], "Codex alone mounts the rack");
  assert.ok(control.querySelector('[data-module-id="rack:container"]'));
  codex = false;
  notifyModules();
  assert.equal(control.querySelector('[data-order-key="order.rack"]'), null);
  mounted.length = 0;

  claude = true;
  notifyModules();
  await dom.flush();
  assert.deepEqual(mounted, ["rack", "stripe"]);
  assert.ok(control.querySelector('[data-module-id="rack:container"]'));
  assert.ok(control.querySelector('[data-module-id="rack:lmstudio"]'));
  assert.ok(control.querySelector('[data-module-id^="rack:server:"]'));

  claude = false;
  notifyModules();
  assert.equal(document.querySelector("#bar-modules").textContent, "");
  assert.equal(document.querySelector("#rail-stripe").textContent, "");
  assert.equal(control.querySelector('[data-order-key="order.rack"]'), null);
  const reads = dom.ipc.invoked.filter((name) => name === "read_mcp_servers").length;
  document.dispatchEvent(new dom.window.CustomEvent("vidar-focus"));
  assert.equal(dom.ipc.invoked.filter((name) => name === "read_mcp_servers").length, reads);
  dispose();
});

test("Loadout gates Claude and Codex readers across focus, module changes and late replies while keeping Launch", async () => {
  const subscribers = new Set();
  const pending = [];
  const pendingCodex = [];
  let claude = false;
  let codex = false;
  globalThis.__loadoutModuleOn = (id) => (id === "codex" ? codex : claude);
  globalThis.__loadoutModuleSubscribers = subscribers;
  const dom = setupDom({
    stubs: {
      ...stubs,
      format: `${stubs.format} export const prettyModel = (s) => s;`,
      "modules/registry": `export const moduleOn = (id) => globalThis.__loadoutModuleOn(id);
        export const onModulesChange = (fn) => { globalThis.__loadoutModuleSubscribers.add(fn); return () => globalThis.__loadoutModuleSubscribers.delete(fn); };`,
    },
    answers: {
      read_loadout: () => new Promise((resolve) => pending.push(resolve)),
      read_codex_loadout: () => new Promise((resolve) => pendingCodex.push(resolve)),
    },
  });
  const { initLoadout } = await import("../src/panels/loadout.ts?module-visibility");
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const controller = new dom.window.AbortController();
  initLoadout(root, controller.signal);
  const focus = (id, agent) => document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", {
    detail: { id, agent, cwd: "C:\\Work", launchArgs: ["ANTHROPIC_BASE_URL=https://api.example"] },
  }));
  const notify = () => { for (const fn of [...subscribers]) fn(); };
  const rows = () => [...root.querySelectorAll(".rack-row")].map((row) => row.dataset.key);
  const reply = { instructions: [], memoryPath: "", memoryEntries: 0, handoffPath: "", handoffNewest: null,
    skills: [], agents: [], hooks: [], permissions: [], notes: [] };

  focus("claude-tab", "claude");
  assert.deepEqual(dom.ipc.invoked, []);
  assert.deepEqual(rows(), ["Launch"]);

  focus("codex-tab", "codex");
  assert.deepEqual(rows(), ["Launch"]);
  root.querySelector('[data-key="Launch"] .rack-name').click();
  assert.match(root.querySelector('[data-key="Launch"] .rack-detail').textContent, /https:\/\/api\.example/);
  assert.deepEqual(dom.ipc.invoked, []);

  claude = true;
  notify();
  assert.deepEqual(dom.ipc.invoked, [], "enabling Claude does not read a Codex tab");
  focus("claude-tab", "claude");
  assert.equal(pending.length, 1);
  assert.deepEqual(rows(), ["Launch"]);

  claude = false;
  notify();
  pending.shift()(reply);
  await dom.flush();
  assert.deepEqual(rows(), ["Launch"], "a late Claude reply cannot restore Claude rows");
  assert.equal(root.textContent.includes("Querying"), false);

  claude = true;
  notify();
  assert.equal(pending.length, 1, "reenabling Claude starts a fresh read for the focused tab");
  pending.shift()(reply);
  await dom.flush();
  assert.ok(rows().includes("Instructions"));
  assert.ok(rows().includes("Launch"));
  assert.equal(dom.ipc.invoked.filter((name) => name === "read_loadout").length, 2);

  // Codex rows follow the Codex module only; other agents stay Launch-only.
  const codexReply = { home: null, instructions: [], developerInstructionsChars: null, skills: [], agents: [], model: null,
    effort: null, sandbox: null, approval: null, reviewer: null, network: null, notify: [], rulesFiles: 0, notes: [] };
  focus("codex-tab", "codex");
  assert.deepEqual(rows(), ["Launch"], "Codex module off: Launch only");
  assert.equal(pendingCodex.length, 0);
  codex = true;
  notify();
  assert.equal(pendingCodex.length, 1, "enabling Codex reads the focused Codex tab");
  pendingCodex.shift()(codexReply);
  await dom.flush();
  assert.ok(rows().includes("Instructions"));
  assert.ok(rows().includes("Launch"));
  assert.equal(dom.ipc.invoked.filter((name) => name === "read_codex_loadout").length, 1);
  focus("gemini-tab", "gemini");
  assert.deepEqual(rows(), ["Launch"], "other agents show Launch only");
  codex = false;
  notify();
  focus("codex-tab", "codex");
  assert.deepEqual(rows(), ["Launch"], "Codex module off again: Launch only");

  controller.abort();
  assert.equal(subscribers.size, 0);
});
