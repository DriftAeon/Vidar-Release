// Launcher with no saved workspace: Home (backend default folder) sits above Select Workspace…,
// opens Raw or Rendered there without saving a workspace; the folder picker path stays.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/launcher/locations.ts", import.meta.url), "utf8");
const empty = src.slice(src.indexOf("if (!locations.length) {"), src.indexOf("// Variants (Astra"));

test("empty-workspace column lists Home before Select Workspace…", () => {
  const home = empty.indexOf('menuRow(sub, "Home")');
  const pick = empty.indexOf('menuRow(sub, "Select Workspace…")');
  assert.ok(home >= 0 && pick > home);
});

test("Home resolves the backend default cwd and never saves a workspace", () => {
  const fn = src.slice(src.indexOf("async function homeLocation"), src.indexOf("function withLocation"));
  assert.match(fn, /resolveDefaultCwd\(\)/);
  assert.doesNotMatch(fn, /pickWorkspace|save_locations/);
  assert.match(empty, /openBodies\(t, rendered, bare, null, h, homeLocation, bareRefused\)/);
});

test("a Codex-refused Home keeps its look and opens the folder picker, never going inert", () => {
  const check = empty.slice(empty.indexOf("codexRefusesHome().then"), empty.indexOf('menuRow(sub, "Select Workspace…")'));
  assert.doesNotMatch(check, /inert|remove\("has-sub"\)/);
  assert.match(empty, /refused \? pick\(e\) : launch\(e\)/);
  assert.match(empty, /const pick = withPicked\(\(loc\) => go\(t, loc\)\)/);
  assert.match(empty, /if \(refused\) openBodies\(t, rendered, bare, null, h\);/);
});

test("Select Workspace… still goes through the folder picker", () => {
  assert.match(src, /withLocation\(pickWorkspace, launch\)/);
  assert.match(empty, /withPicked\(\(loc\) => go\(t, loc\)\)/);
  assert.match(src, /resolve: \(\) => Promise<Location \| null> = pickWorkspace/);
});
