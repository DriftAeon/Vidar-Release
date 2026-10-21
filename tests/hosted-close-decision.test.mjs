import test from "node:test";
import assert from "node:assert/strict";

const { hostedCloseDecision } = await import("../src/panels/sessions/hosted-close.ts");

// Regression (2026-10-03): after a Falcon host restart the tab X and the menu's Close Session
// both failed on "falcon control disconnected" and reopened the tab menu; the tab never closed.
test("a lost host connection removes the tab; a live refusal keeps it", () => {
  assert.equal(hostedCloseDecision({ disconnected: true }), "remove");
  for (const error of [
    "falcon control disconnected; detach and reattach the session",
    "falcon control changed; detach and reattach the session",
    "read from falcon: failed to fill whole buffer",
    "write to falcon: The pipe is being closed. (os error 232)",
  ]) assert.equal(hostedCloseDecision({ disconnected: false, error }), "remove", error);
  assert.equal(hostedCloseDecision({ disconnected: false, error: "falcon did not answer close within 40s" }), "keep");
  assert.equal(hostedCloseDecision({ disconnected: false, error: "session is controlled by another client" }), "keep");
});
