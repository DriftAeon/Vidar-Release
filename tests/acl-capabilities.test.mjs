// Per-window command ACL: Vidar ships an app manifest (src-tauri/build.rs) so Tauri checks app
// commands per capability. The ocr-overlay window may call only ocr_cancel and ocr_capture; the
// main window gets the generated "main-all" set (one allow-* per generate_handler! entry).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function handlerCommands() {
  const src = read("src-tauri/src/main.rs");
  const start = src.indexOf("generate_handler![");
  assert.ok(start >= 0, "generate_handler! block missing");
  const body = src.slice(start + "generate_handler![".length, src.indexOf("]", start));
  return body
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => e.split("::").pop().trim());
}

test("ocr-overlay capability grants exactly core:default plus two ocr commands", () => {
  const cap = JSON.parse(read("src-tauri/capabilities/ocr-overlay.json"));
  assert.deepEqual([...cap.permissions].sort(), ["allow-ocr-cancel", "allow-ocr-capture", "core:default"]);
  assert.deepEqual(cap.windows, ["ocr-overlay"]);
});

test("overlay.ts invokes only the commands its capability grants", () => {
  const src = read("src/overlay.ts");
  const used = new Set([...src.matchAll(/invoke\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["ocr_cancel", "ocr_capture"]);
});

test("main capability grants main-all", () => {
  const cap = JSON.parse(read("src-tauri/capabilities/default.json"));
  assert.ok(cap.permissions.includes("main-all"));
  assert.ok(cap.permissions.includes("core:default"));
});

test("handler list parses and the overlay commands are in it", () => {
  const names = handlerCommands();
  assert.ok(names.length > 0);
  assert.equal(new Set(names).size, names.length, "duplicate handler entries");
  assert.ok(names.includes("ocr_cancel") && names.includes("ocr_capture"));
});

test("generated main-all set, when present, matches the handler count", () => {
  let toml;
  try {
    toml = read("src-tauri/permissions/sets/main-all.toml");
  } catch {
    return; // ignored build output: absent on a clean checkout, build.rs writes it
  }
  const ids = [...toml.matchAll(/^\s*"(allow-[a-z0-9-]+)",?\s*$/gm)].map((m) => m[1]);
  const want = handlerCommands().map((n) => `allow-${n.replaceAll("_", "-")}`);
  assert.deepEqual(ids, want);
});
