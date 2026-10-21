import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";
import { isLoopbackHttp } from "../src/panels/rack-modules.ts";

const stubs = {
  "icon-img": `export const BACKEND_ICON_MAP = new Map(); export function iconImg() { return document.createElement("span"); }`,
  format: `export const DASH = "—"; export const firstLine = (s) => s.split(/\\r?\\n/)[0]; export const label = (s) => s; export const titleWords = (s) => s;`,
  "panels/lmstudio": `export async function renderLmStudioDetail(host) { host.textContent = "LM detail"; }`,
  "panels/skill-label": `export const skillLabel = (s) => s;`,
  "launcher/agent-kind": `export const isGateway = () => false;`,
  "panels/reorder": `export function applyOrder() {} export function enableReorder() {}`,
  "panels/sessions": `export const getFocusedSession = () => null;`,
  "panels/backend-status": `export const summarizeBackend = () => ({ live: true, parts: [], title: "" });`,
  prefs: `export function getPref(key) { return globalThis.__rackPrefs[key]; } export function setPref(key, value) { globalThis.__rackPrefs[key] = value; }`,
};

const stdio = (name, approved) => ({
  name, scope: "project", transport: "stdio", target: "node", args: [name],
  envKeys: [], project: "C:/Work/A", disabled: false, ...(approved === undefined ? {} : { approved }),
});

async function mount(servers) {
  const dom = setupDom({
    stubs,
    answers: {
      read_mcp_servers: { servers, notes: [] },
      list_mcp_tools_stdio: [{ name: "t1", description: "one" }],
    },
  });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.__rackPrefs = { "modules.hidden": ["rack:lmstudio"], "order.rack": [] };
  const root = document.createElement("div");
  document.body.append(root);
  const { initRack } = await import("../src/panels/rack.ts");
  const dispose = await initRack(root);
  const listings = () => globalThis.__domMount.invoked.filter((c) => c === "list_mcp_tools_stdio").length;
  const row = (name) => root.querySelector(`.rack-row[data-server="${name}"]`);
  return { dom, root, dispose, listings, row };
}

test("drawer init lists no stdio server; the button lists exactly once", async (t) => {
  const m = await mount([stdio("ok", true), stdio("legacy")]);
  t.after(() => m.dispose?.());
  assert.equal(m.listings(), 0, "init spawns nothing");
  m.row("ok").querySelector(".rack-name").click();
  assert.equal(m.listings(), 0, "expanding spawns nothing");
  const btn = [...m.row("ok").querySelectorAll("button.item-btn")].find((b) => b.textContent === "List Tools");
  assert.ok(btn, "expanded stdio row offers List Tools");
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m.listings(), 1);
  assert.deepEqual([...m.row("ok").querySelectorAll(".item-btn-name")].map((n) => n.textContent), ["t1"]);
  assert.equal(m.listings(), 1, "no further listing");
});

test("an unapproved server is dimmed, has no button and is never listed", async (t) => {
  const m = await mount([stdio("bad", false)]);
  t.after(() => m.dispose?.());
  const row = m.row("bad");
  assert.equal(row.style.opacity, "0.5");
  assert.equal(row.querySelector(".rack-name").title, "Not approved in Claude for this project");
  row.querySelector(".rack-name").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(row.querySelectorAll("button.item-btn").length, 0);
  assert.equal(m.listings(), 0);
});

test("loopback parse refuses userinfo and look-alike hosts", () => {
  assert.equal(isLoopbackHttp("http://localhost:80@evil.example/"), false);
  assert.equal(isLoopbackHttp("http://127.0.0.1.evil.example/"), false);
  assert.equal(isLoopbackHttp("https://127.0.0.1/mcp"), false);
  assert.equal(isLoopbackHttp("not a url"), false);
  assert.equal(isLoopbackHttp("http://127.0.0.1:8399/mcp"), true);
  assert.equal(isLoopbackHttp("http://localhost/mcp"), true);
  assert.equal(isLoopbackHttp("http://[::1]:8399/mcp"), true);
});
