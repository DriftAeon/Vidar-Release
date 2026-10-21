// A Claude tab's art is validated against the module registry: an unknown gateway id is never
// treated as plain Claude (no /clear respawn). Before the registry loads nothing is a gateway.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url).href;
globalThis.__modStub = { list: null };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const url = new URL(specifier, context.parentURL);
      if (url.href === `${SRC}ipc.ts` || url.href === `${SRC}ipc`) {
        const code = `export function invoke() { return Promise.resolve(globalThis.__modStub.list); }
        export function listen() { return Promise.resolve(() => {}); }`;
        return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
      }
      if (/\.(png|svg|css)$/i.test(url.pathname)) return { url: "data:text/javascript,export default ''", shortCircuit: true };
      if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(`${url.href}.ts`))) {
        return next(`${url.href}.ts`, context);
      }
    }
    return next(specifier, context);
  },
});

// launcher/gateways.ts repaints its art stylesheet on every module change.
globalThis.CSSStyleSheet = class { replaceSync() {} };
globalThis.document = { adoptedStyleSheets: [] };

const art = await import("../src/panels/sessions/gateway-art.ts");
const reg = await import("../src/modules/registry.ts");
const launcher = await import("../src/launcher/gateways.ts");

const gw = { runner: "claude", baseUrl: "https://example.test", keyVar: "ACME_API_KEY", model: "acme-1", env: {} };
const pack = (id, agent) => ({ id, label: id, level: "optional", kind: "agent", source: "pack", folder: id, ...(agent ? { agent } : {}) });

test("before the registry loads, no art is a gateway", () => {
  assert.equal(art.claudeArt("acme").kind, "unknown");
  assert.equal(art.mayActAsPlainClaude("acme"), false);
});

test("a gateway with an unmet when is a gateway to both the launcher and the tab art", async () => {
  globalThis.__modStub.list = { modules: [{ ...pack("acme", { gateway: gw }), when: { config: ["acme.unset"] } }], broken: [] };
  await reg.loadModules();
  assert.equal(reg.moduleOn("acme"), false, "the when is unmet");
  assert.deepEqual(launcher.gatewayModules().map((m) => m.id), ["acme"]);
  assert.deepEqual(art.claudeArt("acme"), { kind: "gateway", id: "acme" });
});

test("an unknown gateway id is not plain Claude; a loaded gateway is typed by the registry", async () => {
  globalThis.__modStub.list = { modules: [pack("acme", { gateway: gw }), pack("plain-agent", {})], broken: [] };
  await reg.loadModules();
  assert.deepEqual(art.claudeArt("acme"), { kind: "gateway", id: "acme" });
  assert.equal(art.mayActAsPlainClaude("acme"), false);
  // a removed module, and an agent module with no gateway, both fail closed
  assert.equal(art.claudeArt("removed-vendor").kind, "unknown");
  assert.equal(art.mayActAsPlainClaude("removed-vendor"), false);
  assert.equal(art.claudeArt("plain-agent").kind, "unknown");
  // only the plain art acts as plain Claude
  for (const plain of [undefined, "", "claude"]) assert.equal(art.mayActAsPlainClaude(plain), true);
});
