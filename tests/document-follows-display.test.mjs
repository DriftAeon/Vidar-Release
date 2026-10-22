// Document panel contract: its open-menu catalog is refetched when a display-update arrives,
// so a review written while the tab is open is listed without a relaunch.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": "export const getActiveSessionId = () => null; export const writeToSession = () => {}; export const openWorkbench = () => {}; export const isWorkbenchOpen = () => true;",
    "panels/comments": "export const mountComments = () => {}; export const setCommentsDocument = () => {}; export const wrapForComments = (x) => x;",
    "clipboard": "export async function copyText() { return true; }",
    "panels/document-open-menu": `export const mountOpenMenu = () => {}; export const closeOpenMenu = () => {};
      export const setOpenDocLabel = () => {}; export const clearOpenDocLabel = () => {};
      export function setCatalog(entries) { (globalThis.__catalogs ??= []).push(entries); }`,
  },
});
Object.assign(dom.ipc.answers, {
  list_documents: () => [{ path: "C:\\d\\reviews\\" + (dom.ipc.invoked.filter((c) => c === "list_documents").length) + ".md", group: "Reviews" }],
  publish_document: null,
});
const { mountDocumentView } = await import("../src/panels/document.ts");

test("a display-update refetches the document catalog", async () => {
  mountDocumentView(document.body, () => {});
  await dom.flush();
  assert.equal(globalThis.__catalogs.length, 1);
  assert.equal(typeof dom.ipc.listeners["display-update"], "function");
  dom.ipc.listeners["display-update"]({ payload: { files: [], docs: [], newest: null } });
  await dom.flush();
  assert.equal(globalThis.__catalogs.length, 2);
  assert.notDeepEqual(globalThis.__catalogs[1], globalThis.__catalogs[0]);
});

test("replies crossing out of order: the newest request's catalog stays applied", async () => {
  const waiting = [];
  dom.ipc.answers.list_documents = () => new Promise((resolve) => waiting.push(resolve));
  const before = globalThis.__catalogs.length;
  dom.ipc.listeners["display-update"]({ payload: {} });
  dom.ipc.listeners["display-update"]({ payload: {} });
  assert.equal(waiting.length, 2);
  waiting[1]([{ path: "C:\\d\\reviews\\new.md", group: "Reviews" }]);
  await dom.flush();
  waiting[0]([{ path: "C:\\d\\reviews\\old.md", group: "Reviews" }]);
  await dom.flush();
  const applied = globalThis.__catalogs.slice(before);
  assert.deepEqual(applied.map((e) => e[0].path), ["C:\\d\\reviews\\new.md"], "the older reply is dropped");
});
