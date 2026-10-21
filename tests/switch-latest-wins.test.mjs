// Bottom-bar switch (panels/toggle-switch.ts): the knob follows the click at once, the last
// flip wins when set_switch replies arrive out of order, and a failed save repaints the old state
// with an error class and a tooltip. IPC is the dom-mount stub; replies are resolved by hand.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const pending = [];
const dom = setupDom({ answers: {
  read_switch: false,
  set_switch: (args) => new Promise((resolve, reject) => pending.push({ args, resolve, reject })),
} });
const { initSwitch } = await import("../src/panels/toggle-switch.ts");

async function mount() {
  pending.length = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const seen = [];
  await initSwitch(host, { name: "close-lock", label: "Close Lock", titles: { on: "On", off: "Off" }, stateClass: "locked", onChange: (v) => seen.push(v) });
  const input = host.querySelector("input");
  const flip = (to) => { input.checked = to; input.dispatchEvent(new window.Event("change")); };
  return { host, input, flip, seen };
}

test("switch: two flips, replies out of order, the last flip is what stays painted", async () => {
  const { host, input, flip, seen } = await mount();
  flip(true);
  flip(false);
  assert.equal(pending.length, 2);
  pending[1].resolve(false);
  await dom.flush();
  pending[0].resolve(true);
  await dom.flush();
  assert.equal(input.checked, false, "the stale reply must not repaint over the later flip");
  assert.equal(host.classList.contains("locked"), false);
  assert.deepEqual(seen, [false], "onChange fires only for the latest flip");
});

test("switch: the knob moves at once, before the reply", async () => {
  const { host, flip } = await mount();
  flip(true);
  assert.equal(host.classList.contains("locked"), true);
  pending[0].resolve(true);
  await dom.flush();
  assert.equal(host.classList.contains("locked"), true);
});

test("switch: a failed save puts the switch back and shows the error", async () => {
  const { host, input, flip } = await mount();
  const log = console.error;
  console.error = () => {};
  try {
    flip(true);
    pending[0].reject(new Error("disk"));
    await dom.flush();
  } finally { console.error = log; }
  assert.equal(input.checked, false);
  assert.equal(host.classList.contains("error"), true);
  assert.equal(host.title, "Could not save; the switch is back where it was.");
  flip(true);
  assert.equal(host.classList.contains("error"), false, "the next paint clears the error");
});
