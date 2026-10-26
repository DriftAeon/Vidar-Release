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
  "panels/sessions": `export const getFocusedSession = () => globalThis.__rackFocused;`,
  "panels/backend-status": `export const summarizeBackend = () => ({ live: true, parts: [], title: "" });`,
  prefs: `export function getPref(key) { return globalThis.__rackPrefs[key]; } export function setPref(key, value) { globalThis.__rackPrefs[key] = value; }`,
};

const A = "C:/Work/A";
const B = "C:/Work/B";
const focused = (cwd) => ({ agent: "claude", art: "code", cwd });
const server = (name, project, disabled = false, transport = "http") => ({
  name, scope: "project", transport,
  target: transport === "stdio" ? "same-command" : "https://remote.invalid/mcp",
  args: [], envKeys: [], project, disabled,
});
const response = (...servers) => ({ servers, notes: [] });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function begin(answers, project = A) {
  const dom = setupDom({ stubs, answers });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.__rackPrefs = { "modules.hidden": ["rack:lmstudio"], "order.rack": [] };
  globalThis.__rackFocused = focused(project);
  const root = document.createElement("div");
  document.body.append(root);
  const focus = (cwd) => {
    globalThis.__rackFocused = focused(cwd);
    document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", { detail: globalThis.__rackFocused }));
  };
  const modulesChanged = () => document.dispatchEvent(new dom.window.Event("vidar-modules-change"));
  const rows = (host = root) => [...host.querySelectorAll(".rack-row[data-server]")];
  return { ...dom, root, focus, modulesChanged, rows };
}

test("focus rebuilds project rows, including same-name identity and disabled state", async (t) => {
  const a = server("shared", A, true);
  const b = server("shared", B, false);
  const extra = { ...server("only-b", B), target: "https://other.invalid/mcp" }; // one URL is one server
  const dom = begin({ read_mcp_servers: ({ project }) => response(...(project === A ? [a] : [b, extra])) });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  t.after(() => dispose?.());
  assert.equal(typeof dispose, "function", "rack mount returns its disposer");
  assert.deepEqual(dom.rows().map((row) => row.dataset.server), ["shared"]);
  assert.equal(dom.rows()[0].dataset.key, rackServerId(a));
  assert.equal(dom.rows()[0].style.opacity, "0.5");

  dom.focus(B);
  await dom.flush();
  assert.deepEqual(dom.rows().map((row) => row.dataset.server), ["shared", "only-b"]);
  assert.equal(dom.rows()[0].dataset.key, rackServerId(b));
  assert.equal(dom.rows()[0].style.opacity, "");
  assert.notEqual(rackServerId(a), rackServerId(b), "project belongs in row identity");
});

test("Codex focus reads that tab and profile, then rereads on tab and agent changes", async (t) => {
  const claudeReads = [];
  const codexReads = [];
  const toolReads = [];
  const codexServer = (name) => ({
    name, scope: "codex", transport: "stdio", target: "node", args: ["server.mjs"],
    envKeys: [], project: null, disabled: false,
  });
  const dom = begin({
    read_mcp_servers: (args) => { claudeReads.push(args); return response(server("claude", A)); },
    read_codex_mcp_servers: (args) => { codexReads.push(args); return response(codexServer(args.tab)); },
    list_mcp_tools_stdio: (args) => { toolReads.push(args); return []; },
  });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  t.after(() => dispose?.());
  assert.equal(claudeReads.length, 1);
  assert.equal(codexReads.length, 0);

  const focus = (session) => {
    globalThis.__rackFocused = session;
    document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", { detail: session }));
  };
  focus({ id: "codex-one", agent: "codex", profile: "bare-one", rowKey: "codex-rendered-bare", art: "codex", cwd: A });
  await dom.flush();
  assert.deepEqual(codexReads, [{ tab: "codex-one", profile: "bare-one", row: "codex-rendered-bare" }]);
  assert.deepEqual(dom.rows().map((row) => row.dataset.server), ["codex-one"]);
  assert.equal(toolReads.length, 0, "a Codex stdio server is not listed until asked");
  await listRow(dom, dom.rows()[0]);
  assert.deepEqual(toolReads.at(-1), { name: "codex-one", scope: "codex", project: null, profile: "bare-one", tab: "codex-one" });

  focus({ id: "codex-two", agent: "codex", profile: "bare-one", rowKey: "codex-rendered-bare", art: "codex", cwd: A });
  await dom.flush();
  assert.deepEqual(codexReads.at(-1), { tab: "codex-two", profile: "bare-one", row: "codex-rendered-bare" });
  assert.equal(codexReads.length, 2);
  assert.deepEqual(dom.rows().map((row) => row.dataset.server), ["codex-two"]);

  focus({ id: "claude-one", agent: "claude", profile: "bare-one", art: "code", cwd: A });
  await dom.flush();
  assert.equal(claudeReads.length, 2);
  assert.deepEqual(claudeReads.at(-1), { project: A, profile: "bare-one", tab: "claude-one", row: null });
  assert.deepEqual(dom.rows().map((row) => row.dataset.server), ["claude"]);
});

test("Claude to Claude tab switches with the same cwd do not reread unless each runs on its own home", async (t) => {
  const claudeReads = [];
  const dom = begin({
    read_mcp_servers: (args) => { claudeReads.push(args); return response(server("claude", A)); },
  });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  t.after(() => dispose?.());
  const focus = (session) => {
    globalThis.__rackFocused = session;
    document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", { detail: session }));
  };
  const reads = () => dom.ipc.invoked.filter((cmd) => cmd === "read_mcp_servers").length;
  focus({ id: "claude-one", agent: "claude", art: "code", cwd: A });
  await dom.flush();
  const before = reads();
  focus({ id: "claude-two", agent: "claude", art: "code", cwd: A });
  await dom.flush();
  assert.equal(reads(), before, "unprofiled tabs share the user's own config");
  // a Bare profile's tabs may sit on different combination homes, so each reads its own
  focus({ id: "claude-three", agent: "claude", profile: "p", rowKey: "r", art: "code", cwd: A });
  await dom.flush();
  focus({ id: "claude-four", agent: "claude", profile: "p", rowKey: "r", art: "code", cwd: A });
  await dom.flush();
  assert.equal(reads(), before + 2);
  assert.deepEqual(claudeReads.at(-1), { project: A, profile: "p", tab: "claude-four", row: "r" });
});

const userStdio = (name) => ({ ...server(name, null, false, "stdio"), scope: "user" });
// A stdio server is listed only on a List Tools click: expand the row, press the button.
const listRow = async (dom, row) => {
  if (!row.classList.contains("open")) row.querySelector(".rack-name").click();
  [...row.querySelectorAll("button.item-btn")].find((b) => b.textContent === "List Tools")?.click();
  await dom.flush();
};
const toolsInvoked = (dom) => dom.ipc.invoked.filter((cmd) => cmd === "list_mcp_tools_stdio").length;

test("a drawer keeps its expanded row and tool list across a focus change", async (t) => {
  const shared = userStdio("shared");
  const dom = begin({
    read_mcp_servers: ({ project }) => response(shared, ...(project === B ? [server("extra", B)] : [])),
    list_mcp_tools_stdio: () => [{ name: "Shared Tool", description: "" }],
  });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root, { only: (s) => s.name === "shared", expand: true });
  t.after(() => dispose?.());
  await dom.flush();
  const row = dom.rows()[0];
  assert.equal(toolsInvoked(dom), 0);
  await listRow(dom, row);
  assert.match(dom.root.textContent, /Shared Tool/);
  dom.focus(B);
  await dom.flush();
  assert.equal(dom.rows()[0], row, "same row node: no rebuild");
  assert.match(dom.root.textContent, /Shared Tool/);
  assert.equal(toolsInvoked(dom), 1);
});

test("a rebuilt rack reuses a settled tool list across A to B to A", async (t) => {
  const shared = userStdio("shared");
  const dom = begin({
    read_mcp_servers: ({ project }) => response(shared, server("only-" + (project === A ? "a" : "b"), project)),
    list_mcp_tools_stdio: () => [{ name: "Shared Tool", description: "" }],
  });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  t.after(() => dispose?.());
  await dom.flush();
  await listRow(dom, dom.rows()[0]);
  dom.focus(B);
  await dom.flush();
  dom.focus(A);
  await dom.flush();
  assert.deepEqual(dom.rows().map((row) => row.dataset.server), ["shared", "only-a"], "A drawn again");
  assert.equal(toolsInvoked(dom), 1, "the shared server's tools were listed once");
  await listRow(dom, dom.rows()[0]);
  assert.equal(toolsInvoked(dom), 1, "the settled promise is reused");
  assert.match(dom.root.textContent, /Shared Tool/);
});

test("the first focus event for the mounted Claude tab does not reread", async (t) => {
  const dom = begin({ read_mcp_servers: () => response(server("claude", A)) });
  globalThis.__rackFocused = { id: "c1", agent: "claude", profile: null, art: "code", cwd: A };
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  t.after(() => dispose?.());
  const reads = () => dom.ipc.invoked.filter((cmd) => cmd === "read_mcp_servers").length;
  assert.equal(reads(), 1);
  document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", { detail: globalThis.__rackFocused }));
  await dom.flush();
  assert.equal(reads(), 1);
});

test("a late A read cannot replace the newer B reply", async (t) => {
  const pendingA = deferred();
  const pendingB = deferred();
  const a = server("shared", A, true, "stdio");
  const b = server("shared", B, false, "stdio");
  const dom = begin({
    read_mcp_servers: ({ project }) => project === null ? response() : project === A ? pendingA.promise : pendingB.promise,
    list_mcp_tools_stdio: () => [{ name: "B Tool", description: "" }],
  }, null);
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  t.after(() => dispose?.());

  dom.focus(A);
  dom.focus(B);
  pendingB.resolve(response(b));
  await dom.flush();
  assert.deepEqual(dom.rows().map((row) => row.dataset.key), [rackServerId(b)]);
  await listRow(dom, dom.rows()[0]);
  assert.match(dom.root.textContent, /B Tool/);

  pendingA.resolve(response(a));
  await dom.flush();
  assert.deepEqual(dom.rows().map((row) => row.dataset.key), [rackServerId(b)]);
  assert.doesNotMatch(dom.root.textContent, /A Tool/);
});

test("an expanded A row cannot append tools after B takes focus", async (t) => {
  const pendingToolsA = deferred();
  const dom = begin({
    read_mcp_servers: ({ project }) => response(server("shared", project, false, "stdio")),
    list_mcp_tools_stdio: ({ project }) => project === A ? pendingToolsA.promise : [{ name: "B Tool", description: "" }],
  });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  t.after(() => dispose?.());
  await listRow(dom, dom.rows()[0]);
  dom.focus(B);
  await dom.flush();
  await listRow(dom, dom.rows()[0]);
  assert.match(dom.root.textContent, /B Tool/);
  pendingToolsA.resolve([{ name: "A Tool", description: "" }]);
  await dom.flush();
  assert.deepEqual(dom.rows().map((row) => row.dataset.key), [rackServerId(server("shared", B, false, "stdio"))]);
  assert.doesNotMatch(dom.root.textContent, /A Tool/);
});

test("closed rail stays unmounted; first open and hide/show use the latest project", async (t) => {
  const a = server("proxy", A);
  const b = server("proxy", B);
  const dom = begin({ read_mcp_servers: ({ project }) => response(project === A ? a : b) });
  const { initRack } = await import("../src/panels/rack.ts");
  const { initRailStripe } = await import("../src/panels/rail-stripe.ts");
  const dispose = await initRack(dom.root);
  const rail = document.createElement("div");
  document.body.append(rail);
  const controller = new dom.window.AbortController();
  initRailStripe(rail, controller.signal);
  t.after(() => { controller.abort(); dispose?.(); });

  const proxy = rail.querySelector('[aria-label="Proxy MCP"]');
  assert.ok(proxy);
  assert.equal(document.querySelector('[role="dialog"][aria-label="Proxy MCP"] .rack-row'), null);
  const readsBeforeFocus = dom.ipc.invoked.filter((cmd) => cmd === "read_mcp_servers").length;
  dom.focus(B);
  await dom.flush();
  assert.equal(dom.ipc.invoked.filter((cmd) => cmd === "read_mcp_servers").length, readsBeforeFocus + 2,
    "a closed drawer does not mount a rack; the main rack and the rail button visibility read once each");
  proxy.click();
  await dom.flush();
  const drawer = document.querySelector('[role="dialog"][aria-label="Proxy MCP"]');
  assert.deepEqual(dom.rows(drawer).map((row) => row.dataset.key), [rackServerId(b)]);
  assert.deepEqual(dom.rows().map((row) => row.dataset.key), [rackServerId(b)]);

  globalThis.__rackPrefs["modules.hidden"] = ["rack:lmstudio", rackServerId(b)];
  dom.modulesChanged();
  await dom.flush();
  assert.equal(dom.rows().length, 0, "main rack hides the row");
  assert.ok(proxy.classList.contains("hidden"), "rail button hides with its only row");
  assert.ok(drawer.classList.contains("hidden"), "open drawer closes when its module hides");
  globalThis.__rackPrefs["modules.hidden"] = ["rack:lmstudio"];
  dom.modulesChanged();
  await dom.flush();
  assert.deepEqual(dom.rows().map((row) => row.dataset.key), [rackServerId(b)]);
  assert.ok(!proxy.classList.contains("hidden"), "rail button returns on show");
  proxy.click();
  await dom.flush();
  assert.deepEqual(dom.rows(drawer).map((row) => row.dataset.key), [rackServerId(b)]);

  proxy.click();
  assert.equal(dom.ledger.types().filter((type) => type === "vidar-focus").length, 2,
    "closing the drawer disposes its rack listener; main rack and rail visibility keep theirs");
  dom.focus(A);
  await dom.flush();
  proxy.click();
  await dom.flush();
  assert.deepEqual(dom.rows(drawer).map((row) => row.dataset.key), [rackServerId(a)],
    "reopened drawer mounts from current focus");
});

test("the left-bar rack lists no server rows: each server is a rail button", async (t) => {
  const dom = begin({ read_mcp_servers: ({ project }) => response(server("a", project)) });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root, { exclude: (s) => s.name === "proxy" });
  t.after(() => dispose?.());
  assert.equal(dom.rows().length, 0);
  assert.equal(dom.root.querySelector(".rack-list")?.children.length, 0, "empty list: modules.css hides the box");
});

test("dispose removes focus listeners and prevents late updates", async () => {
  const pendingB = deferred();
  const dom = begin({ read_mcp_servers: ({ project }) => project === B ? pendingB.promise : response(server("a", A)) });
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(dom.root);
  assert.equal(dom.ledger.types().filter((type) => type === "vidar-focus").length, 1);
  dom.focus(B);
  dispose();
  assert.equal(dom.ledger.types().filter((type) => type === "vidar-focus").length, 0);
  const afterDispose = dom.root.innerHTML;
  pendingB.resolve(response(server("b", B)));
  await dom.flush();
  assert.equal(dom.root.innerHTML, afterDispose, "disposed rack ignores the pending reply");
  const readCount = dom.ipc.invoked.filter((cmd) => cmd === "read_mcp_servers").length;
  dom.focus(A);
  assert.equal(dom.ipc.invoked.filter((cmd) => cmd === "read_mcp_servers").length, readCount);
});
