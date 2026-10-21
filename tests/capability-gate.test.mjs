// Per-capability gates.
//
// registry.ts has bundler-style extensionless imports, a Vite-only
// import.meta.glob and panel side effects, so a resolve hook maps extensionless src imports to
// their .ts file and swaps facts.ts, deps/state, the panels and module registry for stubs; a load
// hook replaces each glob with globalThis.__capGlob(pattern). Real: registry.ts, core.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const { window } = new JSDOM(
  '<!doctype html><html><body><div id="host-a" style="display: none"></div><div id="host-b" style="display: none"></div></body></html>',
);
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const gates = { fa: deferred(), fb: deferred() };
const mounted = [];
globalThis.__capGateStub = { gates };
const MOUNTS = {
  "./mounts/capa.ts": async () => ({ mount() { mounted.push("capa"); return () => {}; } }),
  "./mounts/capb.ts": async () => ({ mount() { mounted.push("capb"); return () => {}; } }),
};
globalThis.__capGlob = (pattern) => (pattern === "./mounts/*.ts" ? MOUNTS : {});

const DECLS = [
  { id: "capa", label: "A", kind: "capability", when: { facts: ["fa"] }, capability: { host: "host-a" } },
  { id: "capb", label: "B", kind: "capability", when: { facts: ["fb"] }, capability: { host: "host-b" } },
];

const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  "capabilities/facts": `export const FACT_IDS = new Set(["fa", "fb"]);
  export function settle() {
    const g = globalThis.__capGateStub.gates;
    return { deps: Promise.resolve(), facts: new Map([["fa", g.fa.promise], ["fb", g.fb.promise]]) };
  }
  export async function snapshot() {
    return { cfg: {}, facts: { deps: null, packs: new Set(), config: {}, facts: new Set(["fa", "fb"]), off: new Set() } };
  }
  export function onFactsChange() { return () => {}; }`,
  "deps/state": "export const CATALOG = { deps: [] };",
  "modules/registry": `export function moduleViews() {
    return ${JSON.stringify(DECLS)}.map((row) => ({ row, active: false }));
  }`,
  "panels/toggle-switch": "export async function initSwitch() { return { isOn: () => true }; }",
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
  load(url, context, next) {
    const out = next(url, context);
    if (!url.endsWith("/src/capabilities/registry.ts")) return out;
    const source = String(out.source).replace(/import\.meta\.glob.*?\(\s*("[^"]*")\s*\)/g, "globalThis.__capGlob($1)");
    assert.notEqual(source, String(out.source), "registry.ts no longer uses import.meta.glob as expected");
    return { ...out, source };
  },
});

const { mountCapabilities } = await import("../src/capabilities/registry.ts");

const settleTicks = () => new Promise((done) => setTimeout(done, 20));

test("a capability whose gate has not settled stays unmounted while another's mounts", async () => {
  const dispose = mountCapabilities({});
  gates.fa.resolve();
  await settleTicks();
  assert.deepEqual(mounted, ["capa"], "only the settled gate's capability mounts");
  assert.equal(document.getElementById("host-a").style.display, "");
  assert.equal(document.getElementById("host-b").style.display, "none");
  gates.fb.resolve();
  await settleTicks();
  assert.deepEqual(mounted, ["capa", "capb"], "the held one mounts once its own gate settles");
  dispose();
});
