// Flow grid opacity round trip at DOM level: a saved flowGridOpacity is read back into the
// Settings > Flow input, lands as --flow-grid-opacity on the Flow root (the ancestor of the grid
// element), and a change through the input follows the settings-changed event to the root.
// The IPC stub plays Rust: read_config returns the stored file, patch_settings writes it and emits.
//
// Real modules: config.ts (memo + settings-changed fan-out), flow/grid-opacity, settings/flow,
// settings/registry. Stubbed: ipc, settings/modal.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  Event: window.Event,
});

const fake = { file: { flowGridOpacity: 30 }, handlers: [] };
globalThis.__gridFake = fake;

const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  ipc: `const f = globalThis.__gridFake;
  export function invoke(cmd, args) {
    if (cmd === "read_config") return Promise.resolve({ config: { ...f.file }, error: null, notice: null });
    if (cmd === "patch_settings") {
      f.file[args.key] = args.value;
      queueMicrotask(() => f.handlers.forEach((h) => h({ payload: { keys: [args.key], tier: "config" } })));
      return Promise.resolve();
    }
    return Promise.reject(new Error("unstubbed invoke: " + cmd));
  }
  export function listen(ev, h) { if (ev === "settings-changed") f.handlers.push(h); return Promise.resolve(() => {}); }`,
  "settings/modal": 'export const REVERT_EVENT = "settings-revert";',
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const url = new URL(specifier, context.parentURL);
      const key = url.href.slice(SRC.length).replace(/\.ts$/, "");
      if (url.href.startsWith(SRC) && Object.hasOwn(STUBS, key)) {
        return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
      }
      if (!/\.[a-z]+$/i.test(url.pathname)) {
        if (existsSync(fileURLToPath(`${url.href}.ts`))) return next(`${url.href}.ts`, context);
        if (existsSync(fileURLToPath(`${url.href}/index.ts`))) return next(`${url.href}/index.ts`, context);
      }
    }
    return next(specifier, context);
  },
});

const { S } = await import("../src/flow/state.ts");
const { initGridOpacity } = await import("../src/flow/grid-opacity.ts");
const { registerFlowRows } = await import("../src/settings/flow.ts");
const { getSettingRows } = await import("../src/settings/registry.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

test("saved 30 reads into the page and onto the Flow root, and a change follows the event", async () => {
  const root = document.createElement("div");
  const world = document.createElement("div");
  world.className = "flow-world flow-snap-grid";
  root.appendChild(world);
  S.rootEl = root;
  initGridOpacity();

  registerFlowRows();
  const row = getSettingRows().find((r) => r.category === "flow");
  assert.ok(row, "Flow settings row registered");
  const input = row.control(() => {});
  await tick();

  assert.equal(input.value, "30", "the page shows the saved value, not the default");
  assert.equal(root.style.getPropertyValue("--flow-grid-opacity"), "30%");
  assert.ok(root.contains(world), "the grid element sits under the root that carries the variable");

  input.value = "80";
  input.dispatchEvent(new window.Event("change"));
  await tick();
  await tick();

  assert.equal(fake.file.flowGridOpacity, 80, "the change reached the stored file");
  assert.equal(root.style.getPropertyValue("--flow-grid-opacity"), "80%");
});
