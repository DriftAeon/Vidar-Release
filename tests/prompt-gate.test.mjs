// ctl.prompt refusals: a raw or closed target can never accept (no retry wording, refused before the
// card); only a rendered tab that is not promptReady is "err tab not ready".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { promptTargetRefusal, promptDeliveryRefusal } from "../src/control/prompt-gate.ts";

const tabs = [{ id: "r1", body: "rendered" }, { id: "p1", body: "pty" }];

test("raw tab refuses as err raw tab, closed tab as err no tab, before any card", () => {
  assert.equal(promptTargetRefusal(tabs, "p1"), "err raw tab");
  assert.equal(promptTargetRefusal(tabs, "gone"), 'err no tab "gone"');
  assert.equal(promptTargetRefusal(tabs, "r1"), null);
});

test("delivery: not-ready rendered tab is err tab not ready; ready delivers; raw never reads not ready", () => {
  assert.equal(promptDeliveryRefusal(tabs, "r1", () => false), "err tab not ready");
  assert.equal(promptDeliveryRefusal(tabs, "r1", () => true), null);
  assert.equal(promptDeliveryRefusal(tabs, "p1", () => false), "err raw tab");
  assert.equal(promptDeliveryRefusal(tabs, "gone", () => false), 'err no tab "gone"');
});

test("listen.ts runs the target refusal before the approval card is minted", () => {
  const src = readFileSync(new URL("../src/control/listen.ts", import.meta.url), "utf8");
  const refuse = src.indexOf("promptTargetRefusal(driveSnapshot().tabs, tab)");
  const card = src.indexOf('"ctl-prompt")');
  assert.ok(refuse > 0 && card > 0 && refuse < card, "refusal must precede askGate");
  assert.ok(src.includes("promptDeliveryRefusal(driveSnapshot().tabs, tab, tabPromptReady)"), "delivery check not wired");
});
