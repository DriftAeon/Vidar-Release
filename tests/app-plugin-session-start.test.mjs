// tests\app-plugin-session-start.test.mjs — the vidar-app SessionStart hook picks context by surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutput } from "../plugins/vidar-app/hooks/session-start.mjs";

const ROOT = "C:\\Fake\\Vidar";
const files = { "rendered.md": "RENDERED BODY", "raw.md": "RAW BODY" };
const read = (p) => {
  const name = p.split(/[\\/]/).pop();
  if (!(name in files)) throw new Error("ENOENT");
  return files[name];
};
const ctx = (out) => JSON.parse(out).hookSpecificOutput;

test("FALCON_SESSION: rendered text with the absolute root line", () => {
  const h = ctx(buildOutput({ FALCON_SESSION: "f", VIDAR_TAB: "t" }, ROOT, read));
  assert.equal(h.hookEventName, "SessionStart");
  assert.ok(h.additionalContext.startsWith(`Vidar install root: ${ROOT}. `));
  assert.ok(h.additionalContext.endsWith("\n\nRENDERED BODY"));
});

test("VIDAR_TAB only: raw text", () => {
  const h = ctx(buildOutput({ VIDAR_TAB: "t" }, ROOT, read));
  assert.ok(h.additionalContext.endsWith("\n\nRAW BODY"));
});

test("neither variable: empty output", () => {
  assert.equal(buildOutput({}, ROOT, read), "");
});

test("missing context file: empty output", () => {
  assert.equal(buildOutput({ FALCON_SESSION: "f" }, ROOT, () => { throw new Error("ENOENT"); }), "");
});

test("isMain matches the hook path with and without the verbatim prefix", async () => {
  const { isMain } = await import("../plugins/vidar-app/hooks/session-start.mjs");
  const url = new URL("../plugins/vidar-app/hooks/session-start.mjs", import.meta.url).href;
  const plain = (await import("node:url")).fileURLToPath(url);
  assert.equal(isMain(plain, url), true);
  assert.equal(isMain("\\\\?\\" + plain, url), true);
  assert.equal(isMain(plain + ".other", url), false);
});
