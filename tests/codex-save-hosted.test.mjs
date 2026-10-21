// codex-save (rendered.codexTabs): an in-process Codex Rendered tab is saved for the boot restore as
// before; a Falcon-hosted one (adopted, or spawned through Falcon) is skipped, since readopt brings
// it back and a restore would open the same thread twice.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

globalThis.__codexSaveWrites = [];
setupDom({ stubs: {
  prefs: `export function setPref(k, v) { globalThis.__codexSaveWrites.push([k, v]); return true; }
    export function getPref() { return undefined; }`,
} });
const { bindCodexSave, saveCodexTabs } = await import("../src/panels/sessions/codex-save.ts");

const button = (title) => Object.assign(document.createElement("button"), { title });
const tab = (id, extra) => ({
  id, agent: "codex", body: "rendered", cwd: "C:\\w", model: "gpt", permissionMode: "default",
  button: button(id), rendered: { sessionId: () => `thread-${id}`, permissionMode: () => "default", hosted: () => false },
  ...extra,
});

test("in-process Codex tabs are saved; hosted ones are skipped", () => {
  const sessions = new Map([
    ["a", tab("a")],
    ["b", tab("b", { falconSession: "falcon-1" })],
    ["c", tab("c", { rendered: { sessionId: () => "thread-c", permissionMode: () => "default", hosted: () => true } })],
    ["d", tab("d", { profile: "bare", rowKey: "row-d" })],
  ]);
  bindCodexSave({ sessions, orderedIds: () => ["a", "b", "c", "d"], getActiveId: () => "a" });
  saveCodexTabs();
  const [key, list] = globalThis.__codexSaveWrites.find(([name]) => name === "rendered.codexTabs");
  assert.equal(key, "rendered.codexTabs");
  assert.deepEqual(list.map((r) => r.title), ["a", "d"]);
  assert.equal(list[0].active, true);
  assert.equal("profile" in list[0], false);
  assert.deepEqual([list[1].profile, list[1].rowKey], ["bare", "row-d"]);
});
