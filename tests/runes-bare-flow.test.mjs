// Bare Runes flow core (src/runes/bare/flow.ts): generate order, the one-row map, hook planning,
// actives toggles, Update from Source, read-only rows and the per-row single-flight.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyGenError, codexTicks, createBareFlow, defaultTicks, generating, planGuards, rowGenerating, syncPayload } from "../src/runes/bare/flow.ts";

const ROW = "claude-bare";
const brick = (id, o = {}) => ({ id, section: [id], body: id, line: 1, studs: 1, status: "known", kept: true, rows: [], ...o });
const file = (path, kind, o = {}) => ({ path, shown: path, kind, scope: "global", ticked: true, pickable: true, ...o });
const g = (event, run) => ({ event, run: [run] });

function fakeIo(o = {}) {
  const calls = [];
  const scans = o.scans ?? {};
  const io = {
    calls,
    localSources: async () => { throw new Error("unused"); },
    actives: async (rowKey) => { calls.push(["actives", rowKey]); return typeof o.actives === "function" ? o.actives() : o.actives; },
    scan: async (path, cwd) => {
      calls.push(["scan", path, cwd]);
      if (o.failScan === path) throw new Error("boom");
      return scans[path];
    },
    apply: async (a) => { calls.push(["apply", a]); if (o.onApply) await o.onApply(a); return { library: "x", written: 0, rows: [] }; },
    layerSet: async (a) => { calls.push(["layerSet", a]); return { written: Object.keys(a) }; },
  };
  return io;
}

test("generate: scan then apply per source in order, layer write last, only the active row", async () => {
  const scans = {
    "/a/CLAUDE.md": { library: "a", bricks: [brick("a1"), brick("a2", { kept: false })] },
    "/b/AGENTS.md": { library: "b", bricks: [brick("b1")] },
    "/mem": { library: "memory-x", bricks: [brick("m1", { section: ["one", "h"] }), brick("m2", { section: ["two"] })] },
  };
  const io = fakeIo({ scans, actives: { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false } });
  const sources = {
    memoryDir: "/mem", guardsKey: false,
    files: [
      file("/a/CLAUDE.md", "rules"), file("/b/AGENTS.md", "rules"), file("/c/off.md", "rules", { ticked: false }),
      file("/mem/one.md", "memory", { section: "one" }), file("/mem/two.md", "memory", { section: "two" }),
      file("/s/x", "skill"),
    ],
  };
  const ticked = new Set(["/a/CLAUDE.md", "/b/AGENTS.md", "/mem/one.md", "/s/x"]);
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/proj" });
  const lines = await flow.generate({ sources, ticked });
  const seq = io.calls.map((c) => c[0] + (c[1] && typeof c[1] === "string" ? ":" + c[1] : ""));
  assert.deepEqual(seq, ["scan:/a/CLAUDE.md", "apply", "scan:/b/AGENTS.md", "apply", "scan:/mem", "apply", "layerSet", "actives:" + ROW]);
  const applies = io.calls.filter((c) => c[0] === "apply").map((c) => c[1]);
  assert.deepEqual(applies[0], { path: "/a/CLAUDE.md", kept: ["a1"], rows: { [ROW]: ["a1"] }, cwd: "/proj" });
  assert.deepEqual(applies[2].kept, ["m1"]); // two.md unticked: its section drops
  assert.deepEqual(Object.keys(applies[2].rows), [ROW]);
  assert.deepEqual(io.calls.find((c) => c[0] === "layerSet")[1], { skills: ["/s/x"], agents: [] });
  assert.deepEqual(lines.map((l) => l.state), ["done", "done", "done", "done"]);
});

test("generate: a failed source marks its line and the rest still run", async () => {
  const scans = { "/b": { library: "b", bricks: [brick("b1")] } };
  const io = fakeIo({ scans, failScan: "/a", actives: { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false } });
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  const seen = [];
  const lines = await flow.generate({
    sources: { memoryDir: null, guardsKey: false, files: [file("/a", "rules"), file("/b", "rules")] },
    ticked: new Set(["/a", "/b"]),
    onLine: (l) => seen.push(l.map((x) => x.state).join()),
  });
  assert.deepEqual(lines.map((l) => l.state), ["failed", "done", "done"]);
  assert.equal(lines[0].error, "boom");
  assert.ok(io.calls.some((c) => c[0] === "apply" && c[1].path === "/b"));
  assert.ok(seen.length > 3);
});

test("generate on a Codex row: each source is scanned and applied in turn, like a Claude row", async () => {
  const scans = { "/a": { library: "a", bricks: [brick("a1")] }, "/b": { library: "b", bricks: [brick("b1")] } };
  const mk = () => fakeIo({ scans, actives: { rowKey: "codex-bare", libraries: [], skills: [], agents: [], guards: [], guardsKey: false } });
  const sources = { memoryDir: null, guardsKey: false, files: [file("/a", "rules"), file("/b", "rules")] };
  const ticked = new Set(["/a", "/b"]);

  const io = mk();
  await createBareFlow(io, { rowKey: "codex-bare", cwd: "/p", codex: true }).generate({ sources, ticked });
  const seq = io.calls.map((c) => c[0] + (typeof c[1] === "string" ? ":" + c[1] : ""));
  assert.deepEqual(seq.slice(0, 4), ["scan:/a", "apply", "scan:/b", "apply"]);
  assert.ok(io.calls.filter((c) => c[0] === "apply").every((c) => !("ahead" in c[1])), "no ahead list");
});

test("planGuards: block targets are ordinary hooks, unchanged picks write nothing, unoffered entries round-trip", () => {
  const block = file("/h/block.mjs", "hook", { guard: g("PreToolUse", "/h/guard-install.mjs") });
  const opt = file("/h/opt.mjs", "hook", { guard: g("PostToolUse", "/h/opt.mjs") });
  const dim = file("/h/d.sh", "hook", { pickable: false, ticked: false, reason: "notMjs", guard: g("Stop", "/h/d.sh") });
  const files = [block, opt, dim];
  const foreign = g("Stop", "/x/foreign.mjs");
  // unchanged
  assert.equal(planGuards(files, new Set(["/h/block.mjs", "/h/opt.mjs"]), [block.guard, opt.guard]), undefined);
  // user unticks opt: foreign round-trips
  assert.deepEqual(planGuards(files, new Set(["/h/block.mjs"]), [foreign, block.guard, opt.guard]), [foreign, block.guard]);
  // a block target not picked is not re-added
  assert.deepEqual(planGuards(files, new Set(["/h/opt.mjs"]), [block.guard, opt.guard]), [opt.guard]);
  assert.deepEqual(planGuards(files, new Set(), [opt.guard]), []);
  // unticking the block target too leaves [] (the old lock kept it on)
  assert.deepEqual(planGuards([block], new Set(), [block.guard]), []);
  // nothing pickable and nothing selected: never []
  assert.equal(planGuards([dim], new Set(), [dim.guard]), undefined);
  assert.deepEqual([...defaultTicks(files)].sort(), ["/h/block.mjs", "/h/opt.mjs"]);
});

test("generate: guards ride layerSet only when the picks changed", async () => {
  const opt = file("/h/opt.mjs", "hook", { guard: g("PostToolUse", "/h/opt.mjs") });
  const act = { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [opt.guard], guardsKey: true };
  const mk = async (ticked) => {
    const io = fakeIo({ actives: act });
    const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
    await flow.generate({ sources: { memoryDir: null, guardsKey: true, files: [opt] }, ticked: new Set(ticked), current: { guards: act.guards, skills: [], agents: [] } });
    return io.calls.filter((c) => c[0] === "layerSet");
  };
  assert.deepEqual(await mk(["/h/opt.mjs"]), []);
  assert.deepEqual((await mk([]))[0][1], { guards: [] });
});

test("toggle: re-scan then apply with the new On list; a dropped brick turned On is also kept", async () => {
  const lib = { library: "L", source: "/src.md", scope: "global", sourceGone: false, bricks: [
    { id: "a", section: ["a"], studs: 1, on: true }, { id: "b", section: ["b"], studs: 1, on: false } ] };
  const scans = { "/src.md": { library: "L", bricks: [brick("a"), brick("b", { kept: false }), brick("n", { status: "new" }), brick("z", { status: "gone" })] } };
  const io = fakeIo({ scans, actives: { rowKey: ROW, libraries: [lib], skills: [], agents: [], guards: [], guardsKey: false } });
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  await flow.load();
  const r = await flow.toggleBrick("L", "b", true);
  assert.deepEqual(r, { ok: true });
  const ap = io.calls.find((c) => c[0] === "apply")[1];
  assert.deepEqual(ap.rows[ROW].sort(), ["a", "b", "n"]); // pending new brick rides along, gone leaves
  assert.deepEqual(ap.kept.sort(), ["a", "b", "n"]);
  const off = syncPayload(lib, scans["/src.md"], { id: "a", on: false });
  assert.deepEqual(off.on.sort(), ["n"]);
});

test("update: new bricks join On and kept, gone leave, known keep their state", async () => {
  const mkLib = (name, source) => ({ library: name, source, scope: "global", sourceGone: false, bricks: [
    { id: "k-on", section: [], studs: 1, on: true }, { id: "k-off", section: [], studs: 1, on: false }, { id: "gone", section: [], studs: 1, on: true } ] });
  const scans = {
    "/one": { library: "one", bricks: [brick("k-on"), brick("k-off", { kept: false }), brick("gone", { status: "gone" }), brick("fresh", { status: "new" })] },
    "/two": { library: "two", bricks: [brick("k-on")] },
  };
  const io = fakeIo({ scans, actives: { rowKey: ROW, libraries: [mkLib("one", "/one"), mkLib("two", "/two"), mkLib("ro", null)], skills: [], agents: [], guards: [], guardsKey: false } });
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  await flow.load();
  assert.deepEqual(await flow.check(), [{ library: "one", added: 1, gone: 1 }, { library: "two", added: 0, gone: 0 }]);
  assert.deepEqual(await flow.update(), { ok: true });
  const applies = io.calls.filter((c) => c[0] === "apply").map((c) => c[1]);
  assert.deepEqual(applies.map((a) => a.path), ["/one", "/two"]); // the null-source library is skipped
  assert.deepEqual(applies[0].rows[ROW].sort(), ["fresh", "k-on"]);
  assert.deepEqual(applies[0].kept.sort(), ["fresh", "k-on"]);
});

test("read-only: a source-less library and a row with no rowKey never reach apply or actives", async () => {
  const ro = { library: "vidar-recall", source: null, scope: "global", sourceGone: false, bricks: [{ id: "a", section: [], studs: 1, on: true }] };
  const io = fakeIo({ actives: { rowKey: ROW, libraries: [ro], skills: [], agents: [], guards: [], guardsKey: false } });
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  await flow.load();
  assert.deepEqual(await flow.toggleBrick("vidar-recall", "a", false), { ok: false, reason: "readOnly" });
  assert.equal(io.calls.some((c) => c[0] === "apply" || c[0] === "scan"), false);

  for (const rowKey of [undefined, null, ""]) {
    const io2 = fakeIo({ actives: {} });
    const f2 = createBareFlow(io2, { rowKey, cwd: "/p" });
    assert.equal(f2.editable, false);
    assert.equal((await f2.load()).ok, false);
    assert.equal((await f2.toggleBrick("L", "a", true)).ok, false);
    assert.equal((await f2.update()).ok, false);
    assert.deepEqual(await f2.check(), []);
    await f2.generate({ sources: { memoryDir: null, guardsKey: false, files: [file("/a", "rules")] }, ticked: new Set(["/a"]) });
    assert.deepEqual(io2.calls, []);
  }
});

test("single-flight: two toggles fired together apply in order, the second sees the first", async () => {
  let on = { a: false, b: false };
  const events = [];
  const lib = () => ({ library: "L", source: "/s", scope: "global", sourceGone: false,
    bricks: Object.entries(on).map(([id, v]) => ({ id, section: [], studs: 1, on: v })) });
  const io = fakeIo({
    actives: () => ({ rowKey: ROW, libraries: [lib()], skills: [], agents: [], guards: [], guardsKey: false }),
    scans: { "/s": { library: "L", bricks: [brick("a", { kept: false }), brick("b", { kept: false })] } },
    onApply: async (a) => {
      events.push("start:" + a.rows[ROW].join(","));
      await new Promise((r) => setTimeout(r, 10));
      on = { a: a.rows[ROW].includes("a"), b: a.rows[ROW].includes("b") };
      events.push("end");
    },
  });
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  await flow.load();
  const [r1, r2] = await Promise.all([flow.toggleBrick("L", "a", true), flow.toggleBrick("L", "b", true)]);
  assert.deepEqual([r1.ok, r2.ok], [true, true]);
  assert.deepEqual(events, ["start:a", "end", "start:a,b", "end"]);
});

const CODEX_ACT = { rowKey: "codex-bare", libraries: [], skills: [], codexSkills: ["/s/x"], codexMcp: ["notion"], agents: ["/old/a.md"], guards: [g("PreToolUse", "h")], guardsKey: true };
const codexSources = {
  memoryDir: null, guardsKey: false,
  files: [file("/a/CLAUDE.md", "rules"), file("/b/Agents.MD", "rules", { ticked: false }), file("/m/one.md", "memory"),
    file("/s/x", "skill"), file("/s/y", "skill", { ticked: false }),
    file("/m/not", "mcp", { hosted: "notion" }), file("/m/atl", "mcp", { hosted: "atlassian", ticked: false }),
    file("/m/loc", "mcp", { pickable: false, ticked: false, reason: "stdio" }), file("/g/r.toml", "agent", { agent: "codex" }),
    file("/g/h.mjs", "hook", { guard: g("PreToolUse", "h") })],
};

test("codex: default ticks are AGENTS.md rules (any case) default-ticked skills, agents and servers only", () => {
  assert.deepEqual([...codexTicks(codexSources.files)].sort(), ["/b/Agents.MD", "/g/r.toml", "/m/not", "/s/x"]);
});

test("codex: no skill change never calls layerSet", async () => {
  const io = fakeIo({ scans: { "/b/Agents.MD": { library: "b", bricks: [brick("b1")] } }, actives: CODEX_ACT });
  const flow = createBareFlow(io, { rowKey: "codex-bare", cwd: "/p", codex: true });
  await flow.generate({
    sources: codexSources, ticked: new Set(["/b/Agents.MD", "/s/x", "/m/not", "/g/r.toml", "/g/h.mjs"]),
    current: { guards: CODEX_ACT.guards, skills: [], agents: CODEX_ACT.agents, codexSkills: ["/s/x"], codexAgents: ["/g/r.toml"], codexMcp: ["notion"] },
  });
  assert.equal(io.calls.some((c) => c[0] === "layerSet"), false);
});

test("codex: a change sends bareCodexSkills, bareCodexAgents and bareCodexMcp only, never skills, agents or guards", async () => {
  const io = fakeIo({ actives: CODEX_ACT });
  const flow = createBareFlow(io, { rowKey: "codex-bare", cwd: "/p", codex: true });
  const cur = { guards: CODEX_ACT.guards, skills: [], agents: CODEX_ACT.agents, codexSkills: ["/s/x"], codexMcp: ["notion", "extra"] };
  await flow.generate({ sources: codexSources, ticked: new Set(["/s/x", "/s/y", "/g/r.toml", "/m/atl"]), current: cur });
  const sets = io.calls.filter((c) => c[0] === "layerSet").map((c) => c[1]);
  // notion unticked and atlassian ticked; "extra" is not offered, so it round-trips; codexAgents absent from `cur` = none
  assert.deepEqual(sets, [{ codexSkills: ["/s/x", "/s/y"], codexAgents: ["/g/r.toml"], codexMcp: ["extra", "atlassian"] }]);
  assert.ok(!("agents" in sets[0]));
});

test("codex: unticking the last agent writes an empty codexAgents", async () => {
  const io = fakeIo({ actives: CODEX_ACT });
  const flow = createBareFlow(io, { rowKey: "codex-bare", cwd: "/p", codex: true });
  const cur = { guards: [], skills: [], agents: CODEX_ACT.agents, codexSkills: ["/s/x"], codexAgents: ["/g/r.toml"], codexMcp: ["notion"] };
  await flow.generate({ sources: codexSources, ticked: new Set(["/s/x", "/m/not"]), current: cur });
  assert.deepEqual(io.calls.filter((c) => c[0] === "layerSet").map((c) => c[1]), [{ codexAgents: [] }]);
});

test("codex: with no current read an empty pick writes nothing, a picked agent does", async () => {
  const io = fakeIo({ actives: CODEX_ACT });
  const flow = createBareFlow(io, { rowKey: "codex-bare", cwd: "/p", codex: true });
  await flow.generate({ sources: codexSources, ticked: new Set(["/g/h.mjs"]) });
  assert.equal(io.calls.some((c) => c[0] === "layerSet"), false);
  await flow.generate({ sources: codexSources, ticked: new Set(["/g/r.toml"]) });
  assert.deepEqual(io.calls.filter((c) => c[0] === "layerSet").map((c) => c[1]), [{ codexAgents: ["/g/r.toml"] }]);
});

// ---- agent Generate (run 2026-10-17-rune-generator, ipc.md) ----
const GEN_RESULT = { library: "gen-claude-bare-0a1b2c3d", runes: 3, on: 3, encodedChars: null, costUsd: null,
  inputTokens: 1000, outputTokens: 500, durationMs: 130000, warnings: [] };
const GEN_ACT = { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false };
const genSources = { memoryDir: "/mem", guardsKey: false, files: [
  file("/a/CLAUDE.md", "rules"), file("/c/off.md", "rules"), file("/mem/one.md", "memory", { section: "one" }), file("/s/x", "skill"),
] };
const genTicks = new Set(["/a/CLAUDE.md", "/mem/one.md", "/s/x"]);

function genIo(over = {}) {
  const io = fakeIo({ actives: GEN_ACT });
  io.generate = async (a) => { io.calls.push(["generate", a]); return GEN_RESULT; };
  io.generateCancel = async (id) => { io.calls.push(["cancel", id]); return null; };
  io.generateToggle = async (a) => { io.calls.push(["gtoggle", a]); return { library: a.library, written: 1, rows: [a.rowKey] }; };
  return Object.assign(io, over);
}

test("generateAgent: Claude row sends the ticked rules and memory dir, budget null, an 8-hex run id", async () => {
  const io = genIo();
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/proj" });
  const out = await flow.generateAgent({ sources: genSources, ticked: genTicks, model: "claude-sonnet-5", effort: "medium" });
  assert.equal(out.state, "done");
  assert.deepEqual(out.result, GEN_RESULT);
  const a = io.calls.find((c) => c[0] === "generate")[1];
  assert.match(a.runId, /^[0-9a-f]{8}$/);
  assert.deepEqual({ ...a, runId: "" }, { runId: "", rowKey: ROW, agent: "claude", model: "claude-sonnet-5", effort: "medium",
    mergeEffort: "low", paths: ["/a/CLAUDE.md", "/mem"], cwd: "/proj", budget: null });
  assert.ok(io.calls.some((c) => c[0] === "actives"), "actives re-read after Done");
  assert.equal(generating(), false);
});

test("generateAgent: a Codex row sends agent codex and budget 9000", async () => {
  const io = genIo();
  const flow = createBareFlow(io, { rowKey: "codex-bare", cwd: "/proj", codex: true });
  await flow.generateAgent({ sources: genSources, ticked: genTicks, model: "gpt-5", effort: "high" });
  const a = io.calls.find((c) => c[0] === "generate")[1];
  assert.equal(a.agent, "codex");
  assert.equal(a.budget, 9000);
  assert.equal(a.rowKey, "codex-bare");
});

test("generateAgent: the merge effort is low unless a Codex model's levels lack it", async () => {
  const sent = async (codex, levels, effort = "high") => {
    const io = genIo();
    const flow = createBareFlow(io, { rowKey: ROW, cwd: "/proj", codex });
    await flow.generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort, effortLevels: levels });
    return io.calls.find((c) => c[0] === "generate")[1].mergeEffort;
  };
  assert.equal(await sent(true, ["low", "medium", "high"]), "low");
  assert.equal(await sent(true, ["medium", "high"]), "high");
  assert.equal(await sent(true, undefined), "low");
  assert.equal(await sent(false, ["medium", "high"]), "low", "Claude always has low");
});

test("generateAgent: each error prefix maps to its end state", async () => {
  const cases = [
    ["cancelled", "cancelled", ""], ["timeout", "timeout", ""], ["timeout: c01 after 360 s; stderr tail: x", "timeout", "c01 after 360 s; stderr tail: x"], ["stale: row moved", "stale", "row moved"],
    ["login: expired", "login", "expired"], ["spawn: no exe", "failed", "no exe"], ["output: bad json", "failed", "bad json"],
    ["invalid: l1\nl2\nl3\nl4\nl5\nl6\nl7", "rejected", "l1\nl2\nl3\nl4\nl5"], ["busy: other", "busy", "other"],
    ["something odd", "failed", "something odd"],
  ];
  for (const [msg, state, error] of cases) {
    const io = genIo({ generate: async () => { throw msg; } });
    const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
    const out = await flow.generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort: "e" });
    assert.deepEqual([out.state, out.error], [state, error], msg);
    assert.equal(generating(), false, "single flight cleared after " + msg);
  }
  assert.deepEqual(classifyGenError("invalid: x"), { state: "rejected", error: "x" });
});

test("generateAgent: subscribes to progress before invoke, filters by run id, unsubscribes after", async () => {
  const order = [];
  let push;
  const io = genIo({
    generateProgress: async (fn) => { order.push("listen"); push = fn; return () => { order.push("unlisten"); }; },
    generate: async (a) => {
      order.push("generate");
      push({ runId: "other", stage: "merge", state: "running" });
      push({ runId: a.runId, stage: "merge", state: "done" });
      return GEN_RESULT;
    },
  });
  const seen = [];
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  const out = await flow.generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort: "e", onProgress: (e) => seen.push(e) });
  assert.equal(out.state, "done");
  assert.deepEqual(order, ["listen", "generate", "unlisten"]);
  assert.deepEqual(seen, [{ runId: out.runId, stage: "merge", state: "done" }]);
});

test("generateAgent: unsubscribes when the run fails", async () => {
  let off = 0;
  const io = genIo({ generateProgress: async () => () => { off++; }, generate: async () => { throw "output: bad"; } });
  const out = await createBareFlow(io, { rowKey: ROW, cwd: "/p" }).generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort: "e" });
  assert.equal(out.state, "failed");
  assert.equal(off, 1);
});

test("generateAgent: one run at a time app-wide; Cancel names the run id", async () => {
  let release;
  const io = genIo({ generate: (a) => { io.calls.push(["generate", a]); return new Promise((r) => { release = () => r(GEN_RESULT); }); } });
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  const other = createBareFlow(genIo(), { rowKey: "codex-bare", cwd: "/p", codex: true });
  let id = null;
  const first = flow.generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort: "e", onRun: (r) => { id = r; } });
  assert.equal(generating(), true);
  assert.equal(rowGenerating(ROW), true);
  assert.equal(rowGenerating("codex-bare"), false);
  const second = await other.generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort: "e" });
  assert.equal(second.state, "busy", "no second call reaches the backend");
  const same = await flow.generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort: "e" });
  assert.equal(same.state, "busy");
  assert.equal(io.calls.filter((c) => c[0] === "generate").length, 1);
  await flow.cancelGenerate(id);
  assert.deepEqual(io.calls.find((c) => c[0] === "cancel"), ["cancel", id]);
  release();
  assert.equal((await first).state, "done");
  assert.equal(generating(), false);
});

test("generateAgent: a row without a key is read-only and calls nothing", async () => {
  const io = genIo();
  const out = await createBareFlow(io, { cwd: "/p" }).generateAgent({ sources: genSources, ticked: genTicks, model: "m", effort: "e" });
  assert.equal(out.state, "readOnly");
  assert.equal(io.calls.length, 0);
});

test("toggleBrick: a generated library goes through rules_generate_toggle, not scan and apply", async () => {
  const lib = { library: "gen-claude-bare-0a1b2c3d", source: null, scope: "global", sourceGone: false, bricks: [{ id: "r1", on: false }],
    generated: { agent: "claude", model: "m", effort: "e", date: "2026-10-17", inputs: [], warnings: [], encodedChars: null } };
  const io = genIo({ actives: async () => ({ ...GEN_ACT, libraries: [lib] }) });
  io.actives = async (k) => { io.calls.push(["actives", k]); return { ...GEN_ACT, libraries: [lib] }; };
  const flow = createBareFlow(io, { rowKey: ROW, cwd: "/p" });
  await flow.load();
  const r = await flow.toggleBrick(lib.library, "r1", true);
  assert.equal(r.ok, true);
  assert.deepEqual(io.calls.find((c) => c[0] === "gtoggle")[1], { library: lib.library, rowKey: ROW, id: "r1", on: true });
  assert.equal(io.calls.some((c) => c[0] === "scan" || c[0] === "apply"), false);
  assert.deepEqual(await flow.check(), [], "a generated library is not an update source");
});
