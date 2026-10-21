// D2b: the bare home is %LOCALAPPDATA%\Vidar\homes\<install-root-key>. The JS resolver and the Rust one
// (src-tauri/src/bare/home.rs `resolve_for`, test `home_paths_match_the_js_table`) hold the same table.
import assert from "node:assert/strict";
import test from "node:test";
import { installRootKey, resolveHome } from "../tools/lib/agent-env.mjs";

const LAD = "C:\\Users\\Test User\\AppData\\Local";
const TABLE = [
  ["D:\\Tools\\Vidar", "1c49ff625c89a9b8"],
  ["C:\\Program Files\\My Vidar\\App", "096f91e36c966a48"],
  ["E:\\Mixed\\Case\\ViDaR", "161d7d325fd5bbcf"],
];

test("agent home: key and path match the Rust table", () => {
  for (const [root, key] of TABLE) {
    assert.equal(installRootKey(root), key, root);
    assert.equal(resolveHome(root, LAD), `${LAD}\\Vidar\\homes\\${key}`);
  }
});

test("agent home: spelling of a root does not change its key, a different root does", () => {
  assert.equal(installRootKey("d:/tools/vidar/"), installRootKey("D:\\Tools\\Vidar"));
  assert.notEqual(installRootKey("D:\\Tools\\Vidar2"), installRootKey("D:\\Tools\\Vidar"));
});

test("agent home: an unset or relative LOCALAPPDATA is refused, not guessed", () => {
  assert.throws(() => resolveHome("D:\\Tools\\Vidar", ""), /LOCALAPPDATA/);
  assert.throws(() => resolveHome("D:\\Tools\\Vidar", "AppData\\Local"), /LOCALAPPDATA/);
});
