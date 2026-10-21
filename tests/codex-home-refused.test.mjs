// The refused-tab pane matches the spawn error against a TS copy of codex_cwd.rs HOME_CWD_REFUSED;
// the two must stay equal or the Select Workspace… button silently stops appearing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("lifecycle HOME_CWD_REFUSED equals the string in codex_cwd.rs", async () => {
  const rs = readFileSync(new URL("../src-tauri/src/codex_cwd.rs", import.meta.url), "utf8");
  const m = rs.match(/pub const HOME_CWD_REFUSED: &str = "([^"]*)";/);
  assert.ok(m, "constant not found in codex_cwd.rs");
  const ts = readFileSync(new URL("../src/panels/rendered/lifecycle.ts", import.meta.url), "utf8");
  const t = ts.match(/export const HOME_CWD_REFUSED = "([^"]*)";/);
  assert.ok(t, "constant not found in lifecycle.ts");
  assert.equal(t[1], m[1]);
});
