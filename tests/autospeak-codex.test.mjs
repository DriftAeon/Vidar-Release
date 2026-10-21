// Auto-speak listener: a completed reply on the focused tab is spoken whatever the agent
// (Claude or Codex); a background tab's reply is not. toggle-switch, sessions and voice-map are
// stubbed through a resolve hook; autospeak.ts is real.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, CustomEvent: window.CustomEvent });

const stub = { on: true, active: "t1" };
globalThis.__asStub = stub;

const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  "panels/toggle-switch": `export async function initSwitch() { return { isOn: () => globalThis.__asStub.on }; }`,
  "panels/sessions": `export function getActiveSessionId() { return globalThis.__asStub.active; }`,
  "panels/voice-map": `export function openVoiceMap() {}`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const url = new URL(specifier, context.parentURL);
      const key = url.href.slice(SRC.length).replace(/\.ts$/, "");
      if (url.href.startsWith(SRC) && Object.hasOwn(STUBS, key)) {
        return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
      }
      if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(`${url.href}.ts`))) {
        return next(`${url.href}.ts`, context);
      }
    }
    return next(specifier, context);
  },
});

const { initAutoSpeak } = await import("../src/panels/autospeak.ts");

const spoken = [];
const ac = new window.AbortController();
await initAutoSpeak(document.createElement("div"), () => ({ autoSpeak: (cwd) => spoken.push(cwd) }), ac.signal);

const fire = (detail) => document.dispatchEvent(new CustomEvent("vidar-reply-done", { detail }));

test("a Codex reply on the active tab is spoken", () => {
  spoken.length = 0;
  fire({ id: "t1", agent: "codex", cwd: "C:\\w" });
  // F3: the agent and tab id ride along, so a Claude transcript in the same folder is not read.
  assert.deepEqual(spoken, [{ cwd: "C:\\w", agent: "codex", tab: "t1", profile: null }]);
});

test("a Claude reply on the active tab is spoken", () => {
  spoken.length = 0;
  fire({ id: "t1", agent: "claude", cwd: "C:\\w" });
  assert.deepEqual(spoken, [{ cwd: "C:\\w", agent: "claude", tab: "t1", profile: null }]);
});

test("a Bare Claude reply carries its launch profile", () => {
  spoken.length = 0;
  fire({ id: "t1", agent: "claude", cwd: "C:\\w", profile: "bare" });
  assert.deepEqual(spoken, [{ cwd: "C:\\w", agent: "claude", tab: "t1", profile: "bare" }]);
});

test("a reply on a background tab is not spoken", () => {
  spoken.length = 0;
  fire({ id: "t2", agent: "codex", cwd: "C:\\w" });
  assert.deepEqual(spoken, []);
});

test("switch off speaks nothing", () => {
  spoken.length = 0;
  stub.on = false;
  fire({ id: "t1", agent: "codex", cwd: "C:\\w" });
  stub.on = true;
  assert.deepEqual(spoken, []);
  ac.abort();
});
