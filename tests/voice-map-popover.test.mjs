// panels/voice-map.ts on popover.ts: the right-click that opens the map does not close it, presses
// inside it keep it open, an outside press (a left click on the mic button too) and Escape close it,
// and closing stops the 2 s status poll.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const { flush } = setupDom({
  stubs: {
    "capabilities/registry": "export function use() { return null; }",
    "icon-img": "export function iconImg() { return document.createElement('img'); }",
  },
});
const { openVoiceMap } = await import("../src/panels/voice-map.ts");

const down = (el, button = 0) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button }));
const press = (el) => { down(el); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const mic = document.createElement("button");
const outside = document.createElement("div");
document.body.append(mic, outside);
mic.addEventListener("contextmenu", (e) => { e.preventDefault(); openVoiceMap(mic); });
const rightClick = (el) => { down(el, 2); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); };
const map = () => document.getElementById("voice-map");
const shown = () => !!map() && !map().classList.contains("hidden");

test("voice map: the opening right-click keeps it open; presses inside keep it; outside closes", async () => {
  rightClick(mic);
  assert.ok(shown(), "the opening right-click does not close it");
  press(map().querySelector(".vm-row"));
  assert.ok(shown(), "a press inside keeps it open");
  rightClick(mic);
  assert.ok(shown(), "a second right-click re-anchors, still open");
  press(outside);
  assert.equal(shown(), false, "an outside press closes it");
  assert.ok(map().isConnected, "persistent: hidden, not removed");
  rightClick(mic);
  press(mic);
  assert.equal(shown(), false, "a left click on the mic button closes it (no anchor exemption)");
  await flush();
});

test("voice map: Escape closes it; Listen Off closes it", async () => {
  rightClick(mic);
  key(document.body, "Escape");
  assert.equal(shown(), false, "Escape closes it");
  rightClick(mic);
  const off = [...map().querySelectorAll("button.vm-off")].find((b) => b.textContent === "Listen Off");
  off.disabled = false;
  press(off);
  assert.equal(shown(), false, "an action button closes it");
  await flush();
});
