// Regression across the status bar -> adapter -> app-server turn/start contract.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { createStatusBar } = await import("../src/panels/rendered/status-bar.ts");

test("Codex spawn and local model/effort picks reach the next turn without a setter RPC", () => {
  const adapter = new CodexAdapter();
  const wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  const request = (method) => wire.findLast((m) => m.method === method);
  const reply = (method, result) => adapter.feed(JSON.stringify({ id: request(method).id, result }));
  adapter.start({ cwd: "C:/work", model: "gpt-primary", effort: "high", permissionMode: "default" });
  adapter.encodeUser("Queued before initialization");
  reply("initialize", {});
  reply("account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: true }); // turns wait for it
  assert.equal(request("thread/start").params.model, "gpt-primary");
  const model = (name, efforts, hidden = false) => ({ model: name, displayName: name, hidden,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })) });
  const page = reply("model/list", { data: [model("gpt-primary", ["low", "medium", "high", "xhigh"]),
    model("gpt-hidden", ["high"], true)], nextCursor: "page-2" });
  assert.equal(request("model/list").params.cursor, "page-2");
  const catalog = reply("model/list", { data: [model("gpt-secondary", ["low", "medium", "high"])], nextCursor: null });
  assert.equal(page[0].models.length, 1);
  assert.deepEqual(catalog[0].models.map((m) => m.value), ["gpt-primary", "gpt-secondary"]);
  const init = reply("thread/start", { thread: { id: "thread-1" }, model: "gpt-primary", reasoningEffort: "medium" });
  assert.ok(init.some((ev) => ev.kind === "effort" && ev.level === "high"));
  assert.equal(request("turn/start").params.model, "gpt-primary");
  assert.equal(request("turn/start").params.effort, "high");

  const state = { adapter, isAlive: true, inTurn: false, mode: "default", models: catalog[0].models,
    modelPending: null, characterModel: "gpt-primary", characterModelLive: true };
  const opts = { agent: "codex", cwd: "C:/work", effort: "high" };
  let menu;
  const bar = createStatusBar(state, { opts, send: async () => assert.fail("Local Codex picks must not send a setter"),
    noticeBlock: () => assert.fail("No warnings expected"), refreshState() {}, emitCharacterStatus() {},
    openStMenu: (_anchor, items) => { menu = items; } });
  bar.sl.model = "Primary";
  bar.sl.effort = "high";
  bar.redrawStatus();
  const count = wire.length;
  bar.setEffort("max");
  assert.equal(opts.effort, "xhigh", "explicit Max clamps to Extra High");
  bar.setModel("gpt-secondary");
  assert.equal(state.characterModel, "gpt-secondary");
  assert.equal(state.modelPending, null, "no setter acknowledgment is awaited");
  assert.equal(opts.effort, "high", "changing model clamps to its advertised maximum");
  bar.setEffort("low");
  assert.equal(wire.length, count);
  bar.pickEffortMenu();
  assert.deepEqual(menu.map((m) => m.value), ["low", "medium", "high"]);
  assert.deepEqual([...bar.slParts.querySelectorAll(".eff-seg")].map((b) => b.dataset.level), ["low", "medium", "high"]);
  state.inTurn = true;
  bar.setModel("gpt-primary");
  bar.setEffort("medium");
  assert.equal(opts.effort, "low", "picks during an active Codex turn are blocked");
  state.inTurn = false;
  adapter.encodeUser("After the picks");
  assert.equal(request("turn/start").params.threadId, "thread-1");
  assert.equal(request("turn/start").params.model, "gpt-secondary");
  assert.equal(request("turn/start").params.effort, "low");

  const resumed = new CodexAdapter();
  resumed.attach((line) => wire.push(JSON.parse(line)));
  resumed.start({ cwd: opts.cwd, model: state.characterModel, effort: opts.effort, permissionMode: "default", resume: "thread-1" });
  resumed.feed(JSON.stringify({ id: request("initialize").id, result: {} }));
  resumed.feed(JSON.stringify({ id: request("account/read").id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }));
  assert.equal(request("thread/resume").params.model, "gpt-secondary");
  assert.equal(request("thread/resume").params.excludeTurns, true, "history pages in through thread/turns/list");
  resumed.feed(JSON.stringify({ id: request("thread/resume").id, result: { thread: { id: "thread-1" }, model: "gpt-secondary" } }));
  resumed.feed(JSON.stringify({ id: request("thread/turns/list").id, result: { data: [], nextCursor: null } }));
  resumed.encodeUser("After resume");
  assert.equal(request("turn/start").params.model, "gpt-secondary");
  assert.equal(request("turn/start").params.effort, "low");
});

const { GUARDS, EFFORT_NAMES } = await import("../src/prefs-core.ts");
const { EFFORT_LEVELS } = await import("../src/agents/protocol.ts");
const { createEvents } = await import("../src/panels/rendered/events.ts");
const { getPref, initPrefs, setPref } = await import("../src/prefs.ts");
const { codexEffortLevels, codexModelSelect, effortSelect, modelSelect } = await import("../src/settings/agent-selects.ts");

test("the codexModels validator accepts the catalog shape and rejects malformed file values", () => {
  const ok = GUARDS.codexModels;
  assert.deepEqual(EFFORT_NAMES, [...EFFORT_LEVELS], "the leaf copy matches protocol.ts");
  assert.ok(ok([]));
  assert.ok(ok([{ value: "gpt-a", label: "Gpt-a", effortLevels: ["low", "xhigh"] }, { value: "gpt-b", label: "B", effortLevels: [] }]));
  for (const bad of [null, {}, "gpt-a", [null], [{ value: "gpt-a", label: "A" }], [{ value: 1, label: "A", effortLevels: [] }],
    [{ value: "gpt-a", label: "A", effortLevels: ["minimal"] }], [{ value: "gpt-a", label: "A", effortLevels: "low" }]]) {
    assert.equal(ok(bad), false, JSON.stringify(bad));
  }
});

test("a Codex tab saves its full model catalog as codexModels; Claude's path is unchanged", async () => {
  Object.assign(globalThis.__domMount.answers, { read_state: {}, patch_state: null }); // an empty state file; writes land nowhere
  await initPrefs();
  const S = { models: [] };
  const handler = (agent) => createEvents(S, { opts: { agent }, sl: { model: "Primary" }, redrawStatus() {}, tools: new Map() }).handle;
  setPref("codexModels", undefined);
  setPref("claudeModels", undefined);
  const row = (value, effortLevels) => ({ value, resolved: value, label: value, effortLevels });
  handler("codex")({ kind: "models", models: [row("gpt-a", ["low", "high"])], partial: true });
  assert.equal(getPref("codexModels"), undefined, "nothing saved before the last page");
  handler("codex")({ kind: "models", models: [row("gpt-a", ["low", "high"]), row("gpt-b", [])] });
  assert.deepEqual(getPref("codexModels"), [{ value: "gpt-a", label: "gpt-a", effortLevels: ["low", "high"] }, { value: "gpt-b", label: "gpt-b", effortLevels: [] }]);
  assert.equal(getPref("claudeModels"), undefined, "a Codex catalog never lands in claudeModels");
  handler("claude")({ kind: "models", models: [{ value: "opus", label: "Opus", resolved: "claude-opus" }] });
  assert.deepEqual(getPref("claudeModels"), [{ value: "opus", label: "Opus", resolved: "claude-opus" }]);
  assert.equal(getPref("codexModels").length, 2, "a Claude catalog never lands in codexModels");
});

test("the Codex Rendered row's selects: catalog models, advertised efforts, and pinned values kept", () => {
  const catalog = [{ value: "gpt-a", label: "Gpt-a", effortLevels: ["low", "medium"] }, { value: "gpt-b", label: "Gpt-b", effortLevels: [] }];
  const options = (sel) => [...sel.options].map((o) => [o.value, o.textContent]);
  assert.equal(codexModelSelect("", [], () => {}), null, "no catalog: the row keeps its text field");
  const picks = [];
  const model = codexModelSelect("gpt-old", catalog, (v) => picks.push(v));
  assert.deepEqual(options(model), [["", "—"], ["gpt-a", "Gpt-a"], ["gpt-b", "Gpt-b"], ["gpt-old", "gpt-old (Not Listed)"]]);
  assert.equal(model.value, "gpt-old");
  assert.doesNotMatch(model.title, /Fable/);
  assert.match(modelSelect("", [], () => {}).title, /Fable/, "Claude's tooltip is unchanged");
  model.value = "gpt-a";
  model.dispatchEvent(new model.ownerDocument.defaultView.Event("change"));
  assert.deepEqual(picks, ["gpt-a"]);
  assert.deepEqual(codexEffortLevels("gpt-a", catalog), ["low", "medium"]);
  assert.deepEqual(codexEffortLevels("gpt-b", catalog), ["low", "medium", "high", "xhigh"], "no advertised levels: Codex's four");
  assert.deepEqual(codexEffortLevels("", catalog), ["low", "medium", "high", "xhigh"]);
  const effort = effortSelect("high", () => {}, codexEffortLevels("gpt-a", catalog));
  assert.deepEqual(options(effort), [["", "—"], ["low", "Low"], ["medium", "Medium"], ["high", "High (Not Listed)"]]);
  assert.equal(effort.value, "high");
  assert.deepEqual(options(effortSelect("", () => {})).map(([v]) => v), ["", ...EFFORT_LEVELS], "Claude's effort list is unchanged");
});
