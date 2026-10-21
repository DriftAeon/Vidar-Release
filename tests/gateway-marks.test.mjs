import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { gatewayMark, markFor, onGatewayMarksChange, setGatewayMarks } = await import("../src/launcher/menu-rows.ts");

test("a gateway mark matches the text the type and flyout rows pass, by module id", () => {
  const zai = gatewayMark("zai", "blob:zai", "#e0246e");
  const deepseek = gatewayMark("deepseek", "blob:deepseek", "#6ee7a0");
  setGatewayMarks([deepseek, zai]);
  // menu.ts and locations.ts build the hay as `${id} ${label}`
  assert.equal(markFor("zai Zai"), zai);
  assert.equal(markFor("zai Rendered"), zai);
  assert.equal(markFor("deepseek DeepSeek"), deepseek);
  assert.equal(markFor("zai-rendered x"), undefined);
  assert.equal(markFor("claude Claude")?.icon.includes("claude"), true);
  setGatewayMarks([]);
  assert.equal(markFor("zai Zai"), undefined);
});

test("setting the gateway marks tells listeners, so rows built before the art arrived redraw", () => {
  let calls = 0;
  const off = onGatewayMarksChange(() => { calls++; });
  setGatewayMarks([gatewayMark("acme", "blob:acme")]);
  assert.equal(calls, 1);
  off();
  setGatewayMarks([]);
  assert.equal(calls, 1);
});
