// Relay strip (src/relay/strip.ts): a file-action message (Path Copied) clears when the strip's host
// leaves view (Relay tab left, Open Large hidden), so it never survives a return to Relay.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ stubs: { "clipboard": "export async function copyText() { return true; }" } });
const observers = [];
globalThis.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
};
const { createRelayStrip } = await import("../src/relay/strip.ts");

test("strip: Path Copied clears when the host leaves view, and observer drops on dispose", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const item = { id: "i1", kind: "display", source: "display", title: "t", view: { type: "display", path: "D:\\display\\a.svg" }, sinceMs: 0, resolve() {} };
  const strip = createRelayStrip(host, {
    selected: () => item, current: () => null, view: () => ({ painting: false, error: "" }),
  });
  const state = host.querySelector(".relay-state");
  strip.note("Path Copied");
  assert.equal(state.textContent, "Path Copied");
  const io = observers.at(-1);
  io.cb([{ isIntersecting: true }]);
  assert.equal(state.textContent, "Path Copied", "still in view keeps the message");
  io.cb([{ isIntersecting: false }]);
  assert.equal(state.textContent, "", "leaving view clears the message");
  strip.dispose();
  assert.equal(io.disconnected, true);
});
