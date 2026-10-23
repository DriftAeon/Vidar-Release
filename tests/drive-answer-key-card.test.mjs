// driveAnswer never operates the OpenAI API key card (P5b review should-fix 1): the card reuses the
// Permission card's classes, so without the exclusion a driver's allow would press Log In on a
// half-typed key and a deny would write into the password field.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/sessions": `export function createSession() {} export function hasArmedAstra() { return false; }
      export function driveSnapshot() { return { tabs: [{ id: "t1", body: "rendered" }] }; } export const renderedDrive = {};
      export function sessionContainer(id) { return id === "t1" ? globalThis.__driveContainer : null; } export function writeToSession() {}`,
    "settings/registry": "export function getRegistry() { return {}; }",
    "config": "export async function resolveDefaultCwd() { return null; }",
    "drive/paste": "export async function drivePaste() {}",
  },
});
const { initDrive } = await import("../src/drive/drive.ts");
const { apiKeyCard } = await import("../src/panels/rendered/api-key-card.ts");
const { DRIVE_CLASS } = await import("../src/panels/rendered-drive.ts");

function permissionCard(requestId, onAllow) {
  const card = document.createElement("div");
  card.className = `blk ${DRIVE_CLASS.card}`;
  card.dataset.requestId = requestId;
  card.dataset.tool = "Bash";
  const allow = document.createElement("button");
  allow.className = DRIVE_CLASS.allow;
  allow.addEventListener("click", onAllow);
  card.append(allow);
  return card;
}

test("driveAnswer with an open key card and a later permission card answers the permission card", async () => {
  initDrive({ spawnFrom: async () => "", roster: () => [] });
  const container = document.createElement("div");
  document.body.append(container);
  globalThis.__driveContainer = container;
  const submitted = [];
  let closed = 0;
  const key = apiKeyCard((k) => submitted.push(k), () => closed++);
  container.append(key.card);
  key.field.value = "sk-half-typed";
  key.field.dispatchEvent(new window.Event("input"));
  let allowed = 0;
  container.append(permissionCard("r1", () => allowed++));

  const res = await window.__vidarDrive.answer("t1", { decision: "allow" });
  assert.deepEqual(res, { id: "r1", tool: "Bash", decision: "allow" });
  assert.equal(allowed, 1);
  assert.deepEqual(submitted, [], "Log In on the key card was never pressed");
  assert.equal(closed, 0);
  assert.equal(key.field.value, "sk-half-typed");
  assert.ok(key.card.isConnected);

  // with only the key card open there is nothing for a driver to answer
  container.lastElementChild.remove();
  await assert.rejects(window.__vidarDrive.answer("t1", { decision: "deny", message: "x" }), /no pending approval card/);
  assert.equal(key.field.value, "sk-half-typed");
  assert.ok(key.card.isConnected);
  container.remove();
});
