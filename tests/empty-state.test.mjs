// Shared empty state (src/panels/empty-state.ts): Not Connected and Not a Git Repository draw through one renderer.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({});
const { brandIcon, buildEmptyState, clearEmptyState, connectActions, fillEmptyState, goButton, lineIcon } = await import("../src/panels/empty-state.ts");

test("Not Connected stacks icon, title, note and the Connect/Hide pair", () => {
  const calls = [];
  const root = buildEmptyState({
    icon: brandIcon("slack"),
    title: "Slack Not Connected",
    note: "A note.",
    actions: connectActions(() => calls.push("connect"), () => calls.push("hide")),
  }, "nt-notice");
  assert.ok(root.classList.contains("empty-state") && root.classList.contains("nt-notice"));
  assert.deepEqual([...root.children].map((c) => c.className.baseVal ?? c.className), ["icn es-icon", "es-title", "es-note", "es-acts"]);
  const [connect, hide] = root.querySelectorAll(".es-acts > button");
  assert.equal(connect.textContent, "Connect");
  assert.ok(connect.classList.contains("ws-add"), "green approve look");
  assert.equal(hide.title, "Hide");
  assert.equal(hide.getAttribute("aria-label"), "Hide");
  assert.equal(hide.textContent, "", "icon only");
  assert.ok(hide.querySelector("svg"));
  connect.click();
  hide.click();
  assert.deepEqual(calls, ["connect", "hide"]);
});

test("No Repo carries the path, the green button and the alert line", () => {
  const host = document.createElement("div");
  host.className = "cx-empty";
  let ran = 0;
  fillEmptyState(host, {
    icon: lineIcon("folder-x"),
    title: "Not a Git Repository",
    path: "C:\\Work\\demo",
    actions: [goButton("Generate Git Prompt", () => { ran++; })],
    alert: "No tab to type into.",
  });
  assert.ok(host.classList.contains("cx-empty") && host.classList.contains("empty-state"));
  assert.equal(host.querySelector(".es-path").textContent, "C:\\Work\\demo");
  assert.equal(host.querySelector(".es-alert-msg").textContent, "No tab to type into.");
  host.querySelector("button.ws-add").click();
  assert.equal(ran, 1);
  fillEmptyState(host, { icon: lineIcon("folder-x"), title: "Not a Git Repository", alert: null });
  assert.equal(host.querySelector(".es-alert"), null);
  assert.equal(host.querySelector(".es-acts"), null);
  clearEmptyState(host);
  assert.ok(!host.classList.contains("empty-state"));
});
