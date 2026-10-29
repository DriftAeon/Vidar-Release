// Launcher vault pick (src/launcher/set-pick.ts): the pure row helpers and the inline tray on a Bare
// body row: one vault ticked from the pre-pick, Custom ticks library sets and creates a vault at Launch,
// a click on the icon never reaches the row. IPC and createSession are stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": `export async function createSession() { return "s1"; }
      export function hasArmedAstra() { return false; }`,
    "tab-names": "export function mintTabName() { return 'Tab'; }",
    "capabilities/registry": "export function use() { return null; }",
  },
  answers: { bare_sets_list: [{ set: "base" }, { set: "kit" }] },
});

const { pickRows, pickedRefs, refKey, refLabel, attachSetPick, vaultRows, customSources } = await import("../src/launcher/set-pick.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

test("rows: own sets first, library extras next, workspace add-ons last and deduped", () => {
  const rows = pickRows([{ set: "base" }], [{ library: "team", set: "unreal-tools" }, { set: "base" }], [{ set: "base" }, { set: "kit" }, { library: "kit", set: "workflow" }, { library: "kit", set: "base" }]);
  assert.deepEqual(rows.map((r) => [refLabel(r.ref), r.addon]), [["base", false], ["kit", false], ["Kit/base", false], ["Kit/workflow", false], ["Team/unreal-tools", true]]);
});

test("rows: a Codex row hides a Claude generated library, keeps imports and its own agent's variants", () => {
  const lib = [
    { library: "gen-claude-bare-0000000a", set: "row-claude-bare" },
    { library: "gen-codex-bare-0000000b", set: "row-codex-bare" },
    { library: "gen-codex-rendered-bare-0000000c", set: "row-codex-rendered-bare" },
    { library: "kit", set: "workflow" },
  ];
  const rows = pickRows([{ set: "base" }], undefined, lib, "codex");
  assert.deepEqual(rows.map((r) => r.ref.set), ["base", "workflow", "row-codex-bare", "row-codex-rendered-bare"]);
});

test("rows: a chosen set of the hidden class stays listed", () => {
  const claudeGen = { library: "gen-claude-bare-0000000a", set: "row-claude-bare" };
  const own = pickRows([claudeGen], undefined, [claudeGen], "codex");
  assert.deepEqual(own.map((r) => r.ref.set), ["row-claude-bare"]);
  const ws = pickRows(undefined, [claudeGen], [claudeGen], "codex");
  assert.deepEqual(ws.map((r) => [r.ref.set, r.addon]), [["row-claude-bare", true]]);
});

test("a generated library reads by its readable name, others as the Runes view heads them", () => {
  assert.equal(refLabel({ library: "gen-claude-bare-0000000a", set: "row-claude-bare" }), "Runes-Claude-Bare-Fig/row-claude-bare");
  assert.equal(refLabel({ library: "gen-odd", set: "x" }), "Gen Odd/x");
  assert.equal(refLabel({ library: "claude-user", set: "row-claude-bare" }), "Claude User/row-claude-bare");
});

test("picked refs keep list order and only the ticked", () => {
  const rows = pickRows([{ set: "a" }, { set: "b" }], [{ set: "c" }], undefined);
  assert.deepEqual(pickedRefs(rows, new Set([refKey({ set: "c" }), refKey({ set: "a" })])), [{ set: "a" }, { set: "c" }]);
});

const LISTED = [
  { id: "team-kit", name: "Team Kit", template: false, hash: "h1", lockedUtc: null },
  { id: "stock-claude", name: "Stock Claude", template: false, hash: "h2", lockedUtc: null },
  { id: "stock-claude", name: "Stock Claude", template: true, hash: "", lockedUtc: null },
  { id: "stock-codex", name: "Stock Codex", template: true, hash: "", lockedUtc: null },
];

test("vault rows: the agent's stock vault first and once, saved vaults by name, no other agent's stock", () => {
  assert.deepEqual(vaultRows(LISTED, "claude").map((v) => v.id), ["stock-claude", "team-kit"]);
  assert.deepEqual(vaultRows(LISTED, "codex").map((v) => v.id), ["stock-codex", "team-kit"]);
});

test("vault rows: a stock vault's variant (a non-reserved id) shows for Claude and Codex alike", () => {
  const variant = { id: "claude-variant", name: "Stock Claude Variant", template: false, hash: "h3", lockedUtc: null };
  assert.deepEqual(vaultRows([...LISTED, variant], "claude").map((v) => v.id), ["stock-claude", "claude-variant", "team-kit"]);
  assert.ok(vaultRows([...LISTED, variant], "codex").some((v) => v.id === "claude-variant"));
});

test("custom sources: a rules-library set names the library by its folder; none set drops it", () => {
  assert.deepEqual(customSources([{ set: "base" }, { library: "kit", set: "workflow" }], "D:\\work\\runes\\tracked"),
    [{ library: "tracked", set: "base" }, { library: "kit", set: "workflow" }]);
  assert.deepEqual(customSources([{ set: "base" }], undefined), []);
});

test("tray: one vault ticked from the pre-pick, Custom makes a vault from the ticked sets and launches on it", async () => {
  const col = document.createElement("div");
  const row = document.createElement("button");
  col.appendChild(row);
  document.body.appendChild(col);
  const launched = [];
  let rowClicks = 0;
  const created = [];
  dom.ipc.answers.rune_vault_list = LISTED;
  dom.ipc.answers.read_config = { config: { rulesLibrary: "runes\\tracked" }, error: null, notice: null };
  dom.ipc.answers.rune_vault_read = { vault: { runesets: [{ source: { library: "stock", set: "floor" } }], runes: [{ library: "stock", id: "mode-auto" }] }, drift: [] };
  dom.ipc.answers.rune_vault_create = (args) => { created.push(args); return { id: "custom-abc123" }; };
  row.addEventListener("click", () => { rowClicks++; });
  attachSetPick(row, {
    variant: { id: "claude", key: "claude-bare", profile: "bare", sets: [{ set: "base" }] },
    launch: (vault) => { launched.push(vault); },
    place: () => {},
  });
  const icon = row.querySelector(".sp-ico");
  assert.equal(icon.title, "Pick Vault");
  icon.click();
  assert.equal(rowClicks, 0, "the icon click never launches the row");
  await tick();
  await tick();
  const tray = col.querySelector(".sp-inline");
  assert.ok(row.nextElementSibling === tray, "tray sits right under the row");
  const rows = () => [...tray.querySelectorAll(".sp-row")].map((r) => [r.textContent, r.getAttribute("aria-checked")]);
  assert.deepEqual(rows(), [["Stock Claude", "true"], ["Team Kit", "false"], ["Custom", "false"]], "the row's own sets are not offered");
  tray.querySelector(".ws-btn").click();
  assert.deepEqual(launched, ["stock-claude"]);
  [...tray.querySelectorAll(".sp-row")][1].click();
  assert.deepEqual(rows().map((r) => r[1]), ["false", "true", "false"], "one vault ticked");
  [...tray.querySelectorAll(".sp-row")][2].click(); // Custom: the library's sets, none ticked
  assert.deepEqual(rows(), [["Stock Claude", "false"], ["Team Kit", "false"], ["Custom", "true"], ["base", "false"], ["kit", "false"]]);
  [...tray.querySelectorAll(".sp-row")][4].click(); // tick kit
  tray.querySelector(".ws-btn").click();
  await tick();
  await tick();
  assert.deepEqual(created, [{ name: null, runesets: [{ library: "stock", set: "floor" }, { library: "tracked", set: "kit" }], runes: [{ library: "stock", id: "mode-auto" }], agent: "claude" }], "the stock floor first, then the picks");
  assert.deepEqual(launched, ["stock-claude", "custom-abc123"]);
  // No stock vault in the store yet: Custom refuses rather than launch without the floor.
  dom.ipc.answers.rune_vault_read = () => { throw new Error("no vault"); };
  tray.querySelector(".ws-btn").click();
  await tick();
  await tick();
  assert.equal(created.length, 1, "no floor, no Custom vault");
  assert.deepEqual(launched, ["stock-claude", "custom-abc123"]);
  icon.click();
  assert.equal(col.querySelector(".sp-inline"), null, "a second click closes the tray");
});
