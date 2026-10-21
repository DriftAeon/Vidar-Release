// A raw Codex tab's meters live beside the Claude statusline entries: a status-update replaces the
// Claude map whole but must not wipe the Codex entry; null forgets it.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const limits = (model) => ({
  model,
  five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 },
  seven_day: { used_percentage: 7, resets_at: Math.floor(Date.now() / 1000) + 86400 },
  observed_ms: Date.now(),
});

async function mount() {
  const dom = setupDom({ answers: { status_snapshot: () => [] } });
  globalThis.CustomEvent = dom.window.CustomEvent;
  const { initStatus, setCodexStatus } = await import("../src/panels/status.ts");
  const compact = document.createElement("div");
  const expanded = document.createElement("div");
  document.body.append(compact, expanded);
  const ac = new dom.window.AbortController();
  await initStatus(compact, expanded, ac.signal);
  document.dispatchEvent(new dom.window.CustomEvent("vidar-focus", { detail: { id: "cx" } }));
  return { dom, compact, expanded, ac, setCodexStatus };
}

test("a Codex entry survives a status-update for other tabs and null removes it", async () => {
  const { dom, compact, expanded, ac, setCodexStatus } = await mount();
  try {
    setCodexStatus("cx", limits("gpt-test"));
    compact.click();
    assert.match(expanded.innerHTML, /Codex/);
    assert.match(expanded.innerHTML, /5H window/);
    assert.match(expanded.innerHTML, /42%/);
    assert.match(expanded.innerHTML, /7D window/);
    // no context figure: no This Session head
    assert.doesNotMatch(expanded.innerHTML, /This Session/);
    dom.ipc.listeners["status-update"]({
      payload: [{ tab: "other", age_secs: 1, mtime_ms: Date.now(), payload: { session_name: "Other" } }],
    });
    assert.match(expanded.innerHTML, /42%/);
    assert.equal(compact.dataset.tier, "fresh");
    setCodexStatus("cx", null);
    assert.equal(compact.dataset.tier, "idle");
  } finally {
    ac.abort();
  }
});

test("a reading without a model adds no entry", async () => {
  const { compact, ac, setCodexStatus } = await mount();
  try {
    setCodexStatus("cx", { ...limits(null), model: null });
    assert.equal(compact.dataset.tier, "idle");
  } finally {
    ac.abort();
  }
});
