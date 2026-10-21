import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";
import { rackServerId } from "../src/panels/rack-modules.ts";

const stubs = {
  "icon-img": `export function iconImg() { return document.createElement("span"); }`,
  "launcher/agent-kind": `export const isGateway = () => false;`,
  "panels/sessions": `export const getFocusedSession = () => globalThis.__railFocused;`,
  "panels/rack": `export async function initRack() { return () => {}; }`,
  prefs: `export function getPref(key) { return globalThis.__railPrefs[key]; }`,
};

const A = "C:/Work/A";
const B = "C:/Work/B";
const focused = (cwd) => ({ agent: "claude", art: "code", cwd });
const proxy = (project) => ({
  name: "proxy", scope: "project", transport: "http", target: "http://127.0.0.1:8399/mcp",
  args: [], envKeys: [], project, disabled: false,
});
const other = (project) => ({ ...proxy(project), name: "other" });

async function begin(hidden = [], servers = (p) => [proxy(p)]) {
  const dom = setupDom({ stubs, answers: { read_mcp_servers: ({ project }) => ({ servers: servers(project), notes: [] }) } });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.__railPrefs = { "modules.hidden": hidden };
  globalThis.__railFocused = focused(A);
  const host = document.createElement("div");
  document.body.append(host);
  const { initRailStripe } = await import("../src/panels/rail-stripe.ts");
  const ac = new dom.window.AbortController();
  const before = dom.ledger.count();
  initRailStripe(host, ac.signal);
  await dom.flush();
  const shown = () => [...host.querySelectorAll(".rail-btn")].filter((b) => !b.classList.contains("hidden")).map((b) => b.title);
  const change = async (next) => {
    globalThis.__railPrefs["modules.hidden"] = next;
    document.dispatchEvent(new dom.window.Event("vidar-modules-change"));
    await dom.flush();
  };
  return { ...dom, host, ac, before, shown, change };
}

test("everything visible keeps both buttons", async (t) => {
  const r = await begin();
  t.after(() => r.ac.abort());
  assert.deepEqual(r.shown(), ["LM Studio", "Proxy MCP"]);
});

test("container hidden removes both buttons, the event brings them back", async (t) => {
  const r = await begin(["rack:container"]);
  t.after(() => r.ac.abort());
  assert.deepEqual(r.shown(), []);
  await r.change([]);
  assert.deepEqual(r.shown(), ["LM Studio", "Proxy MCP"]);
});

test("hiding the Proxy row leaves LM Studio, and the reverse", async (t) => {
  const r = await begin([rackServerId(proxy(A))]);
  t.after(() => r.ac.abort());
  assert.deepEqual(r.shown(), ["LM Studio"]);
  await r.change(["rack:lmstudio"]);
  assert.deepEqual(r.shown(), ["Proxy MCP"]);
});

test("an open drawer closes when its module is hidden", async (t) => {
  const r = await begin();
  t.after(() => r.ac.abort());
  const btn = [...r.host.querySelectorAll(".rail-btn")].find((b) => b.title === "Proxy MCP");
  btn.click();
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  await r.change([rackServerId(proxy(A))]);
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(btn.classList.contains("hidden"), true);
});

test("project switch uses that project's ids", async (t) => {
  const r = await begin([rackServerId(proxy(A))], (p) => [proxy(p), other(p)]);
  t.after(() => r.ac.abort());
  assert.deepEqual(r.shown(), ["LM Studio"]);
  globalThis.__railFocused = focused(B);
  document.dispatchEvent(new r.window.CustomEvent("vidar-focus", { detail: globalThis.__railFocused }));
  await r.flush();
  assert.deepEqual(r.shown(), ["LM Studio", "Proxy MCP"]);
});

test("a failed read keeps a known hidden Proxy row hidden", async (t) => {
  const r = await begin();
  t.after(() => r.ac.abort());
  r.ipc.answers.read_mcp_servers = () => { throw new Error("offline"); };
  await r.change([rackServerId(proxy(A))]);
  assert.deepEqual(r.shown(), ["LM Studio"]);
});

test("an empty read hides Proxy even when its last known row was visible", async (t) => {
  const r = await begin();
  t.after(() => r.ac.abort());
  r.ipc.answers.read_mcp_servers = { servers: [], notes: [] };
  document.dispatchEvent(new r.window.Event("vidar-modules-change"));
  await r.flush();
  assert.deepEqual(r.shown(), ["LM Studio"]);
});

test("a failed initial read cannot expose an unknown Proxy row", async (t) => {
  const r = await begin([], () => { throw new Error("offline"); });
  t.after(() => r.ac.abort());
  assert.deepEqual(r.shown(), ["LM Studio"]);
});

test("Codex focus gives one button per server, the proxy folded into Proxy MCP", async (t) => {
  const codex = (name, target) => ({ name, scope: "codex", transport: "http", target, args: [], envKeys: [], project: null, disabled: false });
  const r = await begin();
  t.after(() => r.ac.abort());
  r.ipc.answers.read_codex_mcp_servers = { servers: [
    codex("openaiDeveloperDocs", "https://developers.openai.com/mcp"),
    codex("proxy", "http://127.0.0.1:8399/mcp"),
    codex("rider", "http://127.0.0.1:64482/stream"),
  ], notes: [] };
  globalThis.__railFocused = { id: "cx", agent: "codex", art: "codex", cwd: A };
  document.dispatchEvent(new r.window.CustomEvent("vidar-focus", { detail: globalThis.__railFocused }));
  await r.flush();
  assert.deepEqual(r.shown(), ["OpenAI Developer Docs", "Rider", "LM Studio", "Proxy MCP"]);
  await r.change([rackServerId(codex("rider", ""))]);
  assert.deepEqual(r.shown(), ["OpenAI Developer Docs", "LM Studio", "Proxy MCP"], "a hidden id hides its button");
});

test("a same-key focus does not reread; a project change does", async (t) => {
  const r = await begin();
  t.after(() => r.ac.abort());
  const reads = () => r.ipc.invoked.filter((c) => c === "read_mcp_servers").length;
  const first = reads();
  document.dispatchEvent(new r.window.CustomEvent("vidar-focus", { detail: globalThis.__railFocused }));
  await r.flush();
  assert.equal(reads(), first, "same focus key: no read");
  await r.change([]);
  assert.equal(reads(), first + 1, "a modules change always resyncs");
  globalThis.__railFocused = focused(B);
  document.dispatchEvent(new r.window.CustomEvent("vidar-focus", { detail: globalThis.__railFocused }));
  await r.flush();
  assert.equal(reads(), first + 2, "a new project reads");
});

test("a late reply for an earlier focus cannot replace the current buttons", async (t) => {
  const C = "C:/Work/C";
  const r = await begin();
  t.after(() => r.ac.abort());
  let release;
  const late = new Promise((res) => { release = res; });
  r.ipc.answers.read_mcp_servers = ({ project }) => (project === B ? late.then(() => ({ servers: [proxy(B)], notes: [] })) : { servers: [{ ...other(project), target: "http://127.0.0.1:64482/stream" }], notes: [] });
  globalThis.__railFocused = focused(B);
  document.dispatchEvent(new r.window.CustomEvent("vidar-focus", { detail: globalThis.__railFocused }));
  globalThis.__railFocused = focused(C);
  document.dispatchEvent(new r.window.CustomEvent("vidar-focus", { detail: globalThis.__railFocused }));
  await r.flush();
  const current = r.shown();
  assert.equal(current.includes("Proxy MCP"), false, "C's reply drew first");
  release();
  await r.flush();
  assert.deepEqual(r.shown(), current, "B's late reply is discarded");
});

test("dispose removes the listeners", async () => {
  const r = await begin();
  assert.ok(r.ledger.count() > r.before);
  r.ac.abort();
  assert.equal(r.ledger.count(), r.before);
  assert.equal(r.host.children.length, 0);
});
