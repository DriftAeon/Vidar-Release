// pickWorkspace: a folder that is already a saved workspace is returned as it is, never saved twice.
// workspaces.ts imports the Tauri bridge, so the function body is checked as source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/launcher/workspaces.ts", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("export async function pickWorkspace"));

test("pickWorkspace looks the picked cwd up before saving and returns the existing entry", () => {
  const find = fn.indexOf("workspaces.find((w) => w.cwd === cwd)");
  const reuse = fn.indexOf("if (known) return known;");
  const save = fn.indexOf("saveWorkspaces(");
  assert.ok(find > 0 && reuse > find && save > reuse);
});

test("a cancelled picker still returns null before the lookup", () => {
  assert.ok(fn.indexOf("if (!cwd) return null;") < fn.indexOf("workspaces.find"));
});
