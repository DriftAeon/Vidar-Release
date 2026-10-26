// pickWorkspace: a folder that is already a saved workspace is returned as it is, never saved twice;
// a cancelled picker returns null before any lookup or save. Runs the real function over the stubbed IPC.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

let picked = null;
const dom = setupDom({
  stubs: {
    config: `export function invalidateConfig() {}
      export async function loadConfig() { return {}; }
      export async function resolveDefaultCwd() { return "C:\\\\home"; }`,
    "settings/save-refusal": "export function saveRefusal(e) { return new Error(String(e)); }",
  },
  answers: { pick_folder: () => picked, save_locations: () => undefined },
});

const { pickWorkspace, workspaces, setWorkspaces } = await import("../src/launcher/workspaces.ts");
const saves = () => dom.ipc.invoked.filter((c) => c === "save_locations").length;

test("a picked cwd already saved is returned as it is and never saved again", async () => {
  const existing = { label: "Work", cwd: "C:\\work" };
  setWorkspaces([existing]);
  picked = "C:\\work";
  assert.equal(await pickWorkspace(), existing);
  assert.equal(saves(), 0);
  assert.equal(workspaces.length, 1);
});

test("a new folder is saved once, named after the folder", async () => {
  setWorkspaces([]);
  picked = "C:\\proj\\Alpha";
  assert.deepEqual(await pickWorkspace(), { label: "Alpha", cwd: "C:\\proj\\Alpha" });
  assert.equal(saves(), 1);
  assert.equal(await pickWorkspace(), workspaces[0]);
  assert.equal(saves(), 1);
});

test("a cancelled picker returns null and saves nothing", async () => {
  const before = saves();
  picked = null;
  assert.equal(await pickWorkspace(), null);
  assert.equal(saves(), before);
});
