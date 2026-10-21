// Bare Runes view (src/runes/bare/view.ts) against a fake BareFlowIo: the empty row's button, Generate
// through the flow back to Actives, a card toggle that dims, the rowless read-only state, the Codex state
// and the verbatim strings (docs/projects/bare/runes-tab-plan.md).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { mountBareView } = await import("../src/runes/bare/view.ts");

const ROW = "claude-bare";
const CTX = { agent: "claude", rowKey: ROW, cwd: "C:/proj", profile: "bare" };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const file = (path, kind, o = {}) => ({ path, shown: path, kind, scope: "global", ticked: true, pickable: true, ...o });
const active = (id, section, on, o = {}) => ({ id, section, studs: 1, on, path: `C:/r/rules/${id}.md`, kind: "rule",
  activate: "always", description: section.at(-1), body: `Body of ${id}.`, ...o });
const brick = (id, o = {}) =>({ id, section: ["Doc", id], body: id, line: 1, studs: 1, status: "known", kept: true, rows: [], ...o });

const SOURCES = {
  memoryDir: null, guardsKey: false,
  files: [
    file("C:/proj/CLAUDE.md", "rules", { library: "proj-claude-md", scope: "project" }),
    file("C:/proj/.claude/rules/ui.md", "rules", { ticked: false, reason: "pathScoped" }),
    file("C:/h/skills/ctx", "skill"),
    file("C:/h/agents/a.md", "agent", { ticked: false }),
    file("C:/h/hooks/block.mjs", "hook", { reason: "blockTarget", guard: { event: "PreToolUse", run: ["node", "C:/h/hooks/block.mjs"] } }),
    file("C:/h/hooks/x.ps1", "hook", { pickable: false, ticked: false, reason: "notMjs" }),
  ],
};

function fakeIo(state) {
  const calls = [];
  return {
    calls,
    localSources: async (cwd) => { calls.push(["localSources", cwd]); return SOURCES; },
    actives: async (rowKey) => { calls.push(["actives", rowKey]); return structuredClone(state.actives); },
    scan: async (path) => { calls.push(["scan", path]); return state.scans?.[path] ?? { library: "x", bricks: [] }; },
    apply: async (a) => {
      calls.push(["apply", a]);
      if (state.onApply) state.onApply(a);
      return { library: "x", written: 1, rows: [ROW] };
    },
    layerSet: async (a) => { calls.push(["layerSet", a]); return { written: Object.keys(a) }; },
  };
}

function mount(ctx, io) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountBareView(host, ctx, io);
  // View is the default; `modify()` presses the Modify button (it lives on the Key's line, outside `host`)
  const modify = async () => { handle.modeButton.click(); await settle(); };
  return { host, dispose: handle.dispose, handle, modify };
}

const button = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

test("a row with no runes shows the create button even when the shared skills and agents are set", async () => {
  const io = fakeIo({ actives: { rowKey: ROW, libraries: [], skills: ["C:/h/skills/ctx"], agents: ["C:/h/agents/a.md"], guards: [], guardsKey: false } });
  const { host, dispose } = mount(CTX, io);
  await settle();
  assert.ok(button(host, "Create Runes"));
  dispose();
});

test("an empty row shows only the create button, and it opens Local Files", async () => {
  const io = fakeIo({ actives: { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false } });
  const { host, dispose } = mount(CTX, io);
  await settle();
  const create = button(host, "Create Runes");
  assert.ok(create, "create button");
  assert.ok(create.classList.contains("ws-add"));
  assert.equal(host.querySelector(".runes-bare-trace summary"), null, "no Active Runes section");
  create.click();
  await settle();
  const heads = [...host.querySelectorAll(".runes-group-head")].map((h) => h.textContent);
  assert.deepEqual(heads, ["Local Files", "Rules", "Skills", "Agents", "Hooks"]);
  const row = (p) => host.querySelector(`.rp-source[data-path="${p}"]`);
  assert.equal(row("C:/proj/CLAUDE.md").getAttribute("aria-pressed"), "true");
  assert.equal(row("C:/proj/.claude/rules/ui.md").title, "This file is path-scoped; a Bare tab loads it every session.");
  assert.equal(row("C:/h/hooks/block.mjs").title, "Vidar's block guards stay on in Bare.");
  assert.equal(row("C:/h/hooks/block.mjs").getAttribute("aria-disabled"), "true");
  assert.equal(row("C:/h/hooks/x.ps1").disabled, true);
  assert.equal(row("C:/h/hooks/x.ps1").title, "Only node .mjs hooks copy into a Bare home.");
  assert.ok(button(host, "Back"));
  dispose();
  assert.equal(host.childElementCount, 0, "disposer removes the view");
});

test("Generate is disabled with nothing ticked; Generate runs the flow and redraws Actives", async () => {
  const state = { actives: { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false } };
  state.scans = { "C:/proj/CLAUDE.md": { library: "proj-claude-md", bricks: [brick("a"), brick("b")] } };
  state.onApply = (a) => {
    state.actives = {
      rowKey: ROW, skills: ["C:/h/skills/ctx"], agents: [], guards: [], guardsKey: true,
      libraries: [{ library: "proj-claude-md", source: a.path, scope: "project", sourceGone: false,
        bricks: a.kept.map((id) => active(id, ["Doc", id], true)) }],
    };
  };
  const io = fakeIo(state);
  const { host, dispose, modify } = mount(CTX, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  // untick everything pickable: Generate disables
  for (const p of ["C:/proj/CLAUDE.md", "C:/h/skills/ctx"]) host.querySelector(`.rp-source[data-path="${p}"]`).click();
  assert.equal(button(host, "Import Raw").disabled, true);
  for (const p of ["C:/proj/CLAUDE.md", "C:/h/skills/ctx"]) host.querySelector(`.rp-source[data-path="${p}"]`).click();
  assert.equal(button(host, "Import Raw").disabled, false);
  button(host, "Import Raw").click();
  await settle();
  const seq = io.calls.map((c) => c[0]);
  assert.ok(seq.indexOf("scan") < seq.indexOf("apply") && seq.indexOf("apply") < seq.indexOf("layerSet"));
  assert.deepEqual(io.calls.find((c) => c[0] === "apply")[1].rows, { [ROW]: ["a", "b"] });
  // back on Actives: the library as a rune set with cards, Inherited Runes, the note, Add Local Files
  assert.ok(!host.textContent.includes("Changes load in the next Bare tab"), "View: no reload note");
  assert.equal(button(host, "Add Local Files"), undefined, "View: no Add Local Files");
  const set = host.querySelector('.runes-set[data-library="proj-claude-md"]');
  assert.ok(set, "library set");
  assert.equal(set.querySelector(".runes-set-head").title.includes("Imported from a project folder; this row loads it in every folder."), true);
  assert.equal(set.querySelectorAll(".runes-rn[data-id]").length, 2);
  assert.ok([...host.querySelectorAll(".runes-group-head")].some((h) => h.textContent === "Inherited Runes"));
  assert.equal(button(host, "Update from Source"), undefined, "no deltas, no Update");
  await modify();
  assert.ok(host.textContent.includes("Changes load in the next Bare tab you open; this tab keeps what it started with."));
  assert.ok(button(host, "Add Local Files"));
  dispose();
});

test("a failed source line reads Import Failed with the raw error only in its tooltip", async () => {
  const state = { actives: { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false } };
  const io = fakeIo(state);
  io.scan = async () => { throw new Error("boom"); };
  const { host, dispose } = mount(CTX, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  button(host, "Import Raw").click();
  await settle();
  const states = [...host.querySelectorAll(".runes-bare-line-state")];
  assert.equal(states[0].textContent, "Import Failed");
  assert.equal(states[0].title, "boom");
  assert.ok(!host.textContent.includes("boom"));
  const labels = [...host.querySelectorAll(".runes-bare-line-path")].map((s) => s.textContent);
  assert.equal(labels.at(-1), "Skills, Agents and Hooks");
  assert.equal(states.at(-1).textContent, "Done");
  assert.ok(button(host, "Back"));
  dispose();
});

test("the switch toggles through the flow without opening, the Off card dims; Update shows on deltas", async () => {
  const lib = (on) => ({ library: "glob", source: "C:/h/CLAUDE.md", scope: "global", sourceGone: false,
    bricks: [active("a", ["Doc", "Response Style"], on, { kind: "fact", activate: "recall" }), active("b", ["Doc", "Platform"], true)] });
  const ro = { library: "vidar-recall", source: null, scope: "global", sourceGone: false, bricks: [active("r", ["Recall"], true)] };
  const gone = { library: "old", source: "C:/gone.md", scope: "project", sourceGone: true, bricks: [active("g", ["G"], true)] };
  const state = { actives: { rowKey: ROW, libraries: [lib(true), ro, gone], skills: ["C:/h/skills/ctx"], agents: [], guards: [], guardsKey: false } };
  state.scans = { "C:/h/CLAUDE.md": { library: "glob", bricks: [brick("a"), brick("b"), brick("n", { status: "new", kept: false })] } };
  state.onApply = (a) => { state.actives.libraries[0] = lib(a.rows[ROW].includes("a")); };
  const io = fakeIo(state);
  const opened = [];
  const { host, dispose, handle, modify } = mount({ ...CTX, card: { openInDocument: (p) => opened.push(p), note: () => {} } }, io);
  await settle();
  // View is the default: runes that are on, read-only, no switches; Off runes hidden; Update shows as a notice
  assert.equal(host.querySelector(".runes-bare-switch"), null, "View: no switches");
  assert.equal(handle.modeButton.hidden, false);
  assert.equal(handle.modeButton.textContent, "Modify");
  assert.equal(host.querySelectorAll(".runes-set[data-kind] .rp-source:not(.is-ro)").length, 0, "View: ticked items are read-only");
  assert.deepEqual([...host.querySelectorAll(".runes-set[data-kind] .rp-source")].map((r) => r.dataset.path), ["C:/h/skills/ctx", "C:/h/hooks/block.mjs"], "View: only ticked items (the locked-on block guard counts)");
  assert.ok(button(host, "Update from Source"), "Update from Source still shows in View");
  await modify();
  assert.equal(handle.modeButton.textContent, "Done");
  assert.equal(handle.modeButton.classList.contains("is-editing"), true, "Done takes the accent");
  const card = (lib = "glob", id = "a") => host.querySelector(`.runes-set[data-library="${lib}"] .runes-rn[data-id="${id}"]`);
  const sw = (lib, id) => card(lib, id).querySelector(".runes-bare-switch");
  // the shared card: kind, name (last heading), scope from lib.scope, activate, then the switch
  const chip = (c, sel) => c.querySelector(sel);
  assert.equal(chip(card(), ".runes-kslot .runes-chip").title, "Kind: Fact");
  assert.equal(card().querySelector(".runes-rname").textContent, "Response Style");
  const chips = [...card().querySelectorAll(".runes-chips > *")];
  assert.deepEqual(chips.map((c) => c.title), ["Scope: Global", "Activate: Recall", "On"]);
  assert.ok(chips[0].querySelector("img").src.includes("/globe."), "global scope reads globe");
  assert.ok(card("old", "g").querySelector(".runes-chips img").src.includes("/folder."), "project scope reads folder");
  assert.equal(card("old", "g").querySelector(".runes-chips > .runes-chip").title, "Scope: Project");
  assert.equal(card().classList.contains("is-dim"), false);
  assert.equal(sw("glob", "a").getAttribute("aria-pressed"), "true");
  assert.ok(button(host, "Update from Source"), "the scan found a new brick");
  assert.ok(host.querySelector('.runes-set[data-library="glob"] .runes-cond .runes-chip').textContent === "+1");
  // library sets start collapsed; one the user opens stays open across redraws
  const libSet = (lib) => host.querySelector(`.runes-set[data-library="${lib}"]`);
  assert.deepEqual(["glob", "vidar-recall", "old"].map((l) => libSet(l).open), [false, false, false], "library sets start closed");
  libSet("glob").querySelector(":scope > summary").click();
  await settle();
  assert.equal(libSet("glob").open, true);
  // the summary click opens the card in place: frontmatter bar, body, Edit opens the rune file
  card("glob", "b").querySelector("summary").click();
  await settle();
  assert.equal(card("glob", "b").open, true);
  assert.ok(card("glob", "b").querySelector(".runes-rt").textContent.includes("Body of b."));
  assert.equal([...card("glob", "b").querySelectorAll(".runes-fm .runes-fv")].map((v) => v.textContent).join("|"), "b|Rule|Global|Always");
  card("glob", "b").querySelector('.runes-act[aria-label="Edit"]').click();
  assert.deepEqual(opened, ["C:/r/rules/b.md"]);
  // the switch toggles and does not open
  sw("glob", "a").click();
  await settle();
  const apply = io.calls.filter((c) => c[0] === "apply").at(-1)[1];
  assert.equal(apply.rows[ROW].includes("a"), false);
  assert.equal(card().classList.contains("is-dim"), true);
  assert.equal(card().open, false, "the switch never opens the card");
  assert.equal(card("glob", "b").open, true, "an open card stays open across the redraw");
  assert.equal(libSet("glob").open, true, "a user-opened set stays open across the redraw");
  assert.equal(libSet("old").open, false);
  assert.equal(sw("glob", "a").getAttribute("aria-pressed"), "false");
  // read-only and gone libraries: no toggles, their tooltips; their cards still open
  const roHead = host.querySelector('.runes-set[data-library="vidar-recall"] .runes-set-head');
  assert.ok(roHead.title.includes("This set wasn't imported here, so it can't be changed from this tab."));
  assert.equal(sw("vidar-recall", "r").disabled, true);
  const goneSet = host.querySelector('.runes-set[data-library="old"]');
  assert.equal(goneSet.querySelector(".runes-cond").textContent, "Source Not Found");
  assert.ok(goneSet.querySelector(".runes-set-head").title.includes("The source file is gone, so this set stays as it is until it's back."));
  assert.equal(sw("old", "g").disabled, true);
  // Inherited Runes: per-item ticks, a tick writes only the layer
  const every = [...host.querySelectorAll(".runes-group-head")].find((h) => h.textContent === "Inherited Runes");
  assert.equal(every.title, "Inherited runes: skills reach every Bare row, agents every Bare row of their own agent, hooks every Claude Bare row. An open Bare tab may pick them up when another one starts.");
  assert.equal(button(host, "Update from Source").title, "Rescans the source; other rows that use this library get its new text too.");
  assert.equal(sw("glob", "a").title, "Off\nRescans the source; other rows that use this library get its new text too.");
  assert.ok(host.textContent.includes("Changes load in the next Bare tab you open; this tab keeps what it started with."));
  const kinds = [...host.querySelectorAll(".runes-set[data-kind] .runes-sn")].map((s) => s.textContent);
  assert.deepEqual(kinds, ["Skills", "Agents", "Hooks"]);
  const icons = [...host.querySelectorAll(".runes-set[data-kind] .runes-scp img")].map((i) => i.getAttribute("src").split("/").pop().replace(/\.\w+$/, ""));
  assert.deepEqual(icons, ["skill", "agent", "hook"], "the Gear section icons");
  for (const set of host.querySelectorAll(".runes-set[data-kind]")) {
    const rows = [...set.querySelectorAll(".rp-source")];
    assert.ok(rows.length > 0 || set.dataset.kind === "hook", "kind tray rows");
    for (const r of rows) assert.equal(r.dataset.kind, set.dataset.kind, "each row carries its kind");
  }
  const agent = host.querySelector('.runes-set[data-kind="agent"] .rp-source[data-path="C:/h/agents/a.md"]');
  assert.equal(agent.dataset.kind, "agent");
  assert.equal(agent.getAttribute("aria-pressed"), "false");
  const before = io.calls.length;
  agent.click();
  await settle();
  const after = io.calls.slice(before).map((c) => c[0]);
  assert.deepEqual(after.filter((c) => c === "layerSet" || c === "apply"), ["layerSet"]);
  const set = io.calls.find((c) => c[0] === "layerSet")[1];
  assert.deepEqual(set.agents, ["C:/h/agents/a.md"]);
  assert.equal(set.skills, undefined, "unchanged skills are left alone");
  // Done returns to View: switches gone, the Off rune hidden, the reload note gone
  await modify();
  assert.equal(handle.modeButton.textContent, "Modify");
  assert.equal(host.querySelector(".runes-bare-switch"), null);
  assert.equal(card("glob", "a"), null, "the Off rune is hidden in View");
  assert.ok(!host.textContent.includes("Changes load in the next Bare tab"));
  dispose();
});

test("no rowKey: the dim line, toggles disabled, no io called", async () => {
  const io = fakeIo({ actives: null });
  const { host, dispose } = mount({ ...CTX, rowKey: null }, io);
  await settle();
  assert.ok(host.textContent.includes("Open this Bare tab from the launcher to change its runes."));
  assert.equal(button(host, "Add Local Files").disabled, true);
  assert.equal(io.calls.length, 0);
  dispose();
});

const CODEX_SOURCES = {
  memoryDir: null, guardsKey: false,
  files: [
    file("C:/h/AGENTS.md", "rules", { library: "agents-md", agent: "codex" }),
    file("C:/h/CLAUDE.md", "rules", { library: "c" }),
    file("C:/h/skills/ctx", "skill", { agent: "codex" }),
    file("C:/h/skills/claude", "skill"),
    file("C:/h/agents/rev.toml", "agent", { agent: "codex" }),
    file("C:/h/c.toml#notion", "mcp", { agent: "codex", hosted: "notion", shown: "notion" }),
    file("C:/h/c.toml#local", "mcp", { agent: "codex", shown: "local", pickable: false, ticked: false, reason: "stdio" }),
  ],
};

const ONE_LIB = { library: "agents-md", source: "C:/h/AGENTS.md", scope: "global", sourceGone: false, bricks: [] };

test("the Claude Bare view drops every agent: codex row", async () => {
  const io = fakeIo({ actives: { rowKey: ROW, libraries: [ONE_LIB], skills: [], agents: [], guards: [], guardsKey: false } });
  io.localSources = async () => CODEX_SOURCES;
  const { host, dispose, modify } = mount({ ...CTX, rowKey: ROW }, io);
  await settle();
  await modify();
  const paths = [...host.querySelectorAll(".rp-source")].map((r) => r.dataset.path);
  assert.deepEqual(paths, ["C:/h/skills/claude"]);
  assert.equal(host.querySelector('.runes-set[data-kind="mcp"]'), null);
  dispose();
});

test("a Codex layer agent click sends codexAgents and never agents; the Claude view is unchanged", async () => {
  const io = fakeIo({ actives: { rowKey: "codex-bare", libraries: [ONE_LIB], skills: [], agents: ["C:/h/agents/a.md"], guards: [], guardsKey: false, codexSkills: [], codexMcp: [] } });
  io.localSources = async () => CODEX_SOURCES;
  const sets = [];
  io.layerSet = async (a) => { sets.push(a); return { written: [] }; };
  const { host, dispose, modify } = mount({ ...CTX, agent: "codex", rowKey: "codex-bare" }, io);
  await settle();
  await modify();
  const row = host.querySelector('.runes-set[data-kind="agent"] .rp-source[data-path="C:/h/agents/rev.toml"]');
  assert.equal(row.getAttribute("aria-pressed"), "false", "an agent starts as the row holds it (absent = none)");
  row.click();
  await settle();
  assert.deepEqual(sets, [{ codexAgents: ["C:/h/agents/rev.toml"] }]);
  assert.equal("agents" in sets[0], false, "bareAgents is Claude's");
  dispose();
});

test("a Codex save sends bareCodexSkills and bareCodexMcp, and a refusal shows as-is", async () => {
  const io = fakeIo({ actives: { rowKey: "codex-bare", libraries: [ONE_LIB], skills: [], agents: [], guards: [], guardsKey: false, codexSkills: [], codexMcp: [] } });
  io.localSources = async () => CODEX_SOURCES;
  const sets = [];
  io.layerSet = async (a) => { sets.push(a); if (a.codexMcp) throw "Slack is not hosted; bareCodexMcp not saved"; return { written: [] }; };
  const { host, dispose, modify } = mount({ ...CTX, agent: "codex", rowKey: "codex-bare" }, io);
  await settle();
  await modify();
  host.querySelector('.rp-source[data-path="C:/h/skills/ctx"]').click();
  await settle();
  assert.deepEqual(sets[0].codexSkills, ["C:/h/skills/ctx"]);
  assert.equal("skills" in sets[0], false, "bareSkills is Claude's");
  assert.deepEqual(sets[0].codexMcp, undefined, "an unchanged server list is not sent");
  host.querySelector('.rp-source[data-path="C:/h/c.toml#notion"]').click();
  await settle();
  assert.deepEqual(sets[1].codexMcp, ["notion"]);
  assert.ok(host.textContent.includes("Import Failed") && host.querySelector(".rp-error").title.includes("bareCodexMcp not saved"));
  dispose();
});

test("every Local Files reason has a tip, and the new Codex tips are verbatim", async () => {
  const reasons = ["pathScoped", "notMjs", "guardDriver", "blockTarget", "tooLarge", "shadowed", "summaryOnly", "notHosted", "stdio"];
  const io = fakeIo({ actives: { rowKey: "codex-bare", libraries: [], skills: [], agents: [], guards: [], guardsKey: false } });
  io.localSources = async () => ({ memoryDir: null, guardsKey: false,
    files: reasons.map((r) => file("C:/h/" + r, "rules", { agent: "codex", reason: r, pickable: false, ticked: false })) });
  const { host, dispose } = mount({ ...CTX, agent: "codex", rowKey: "codex-bare" }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  const tips = Object.fromEntries(reasons.map((r) => [r, host.querySelector(`.rp-source[data-path="C:/h/${r}"]`).title]));
  assert.ok(Object.values(tips).every((t) => t && t !== "undefined"));
  assert.equal(tips.shadowed, "AGENTS.override.md replaces this file.");
  assert.equal(tips.summaryOnly, "Only the memory summary imports; MEMORY.md stays in its home.");
  assert.equal(tips.tooLarge, "This file is over 256 KB, so it does not import.");
  assert.equal(tips.notHosted, "Codex Bare carries only the Notion and Atlassian servers.");
  assert.equal(tips.stdio, "Local command servers stay out of Codex Bare.");
  dispose();
});

test("a Codex Bare tab shows runesets, Skills only, the launch trace, and its own note and tooltips", async () => {
  const lib = { library: "agents-md", source: "C:/h/AGENTS.md", scope: "global", sourceGone: false, bricks: [active("a", ["Doc", "A"], true)] };
  const state = { actives: { rowKey: "codex-bare", libraries: [lib], skills: ["C:/h/skills/claude"], agents: ["C:/h/agents/a.md"], guards: [], guardsKey: false,
    codexSkills: ["C:/h/skills/ctx"], codexMcp: ["notion"] } };
  state.scans = { "C:/h/AGENTS.md": { library: "agents-md", bricks: [brick("a"), brick("n", { status: "new", kept: false })] } };
  const io = fakeIo(state);
  io.localSources = async () => CODEX_SOURCES;
  const { host, dispose, modify } = mount({ ...CTX, agent: "codex", rowKey: "codex-bare" }, io);
  await settle();
  assert.ok(!host.textContent.includes("Codex Bare Has No Runesets Yet"));
  assert.ok(host.querySelector('.runes-set[data-library="agents-md"]'));
  assert.equal(host.querySelector(".runes-bare-trace summary"), null, "no Active Runes section");
  await modify();
  assert.deepEqual([...host.querySelectorAll(".runes-set[data-kind] .runes-sn")].map((s) => s.textContent), ["Skills", "Agents", "MCP Servers"]);
  assert.deepEqual([...host.querySelectorAll(".rp-source")].map((r) => r.dataset.path), ["C:/h/skills/ctx", "C:/h/agents/rev.toml", "C:/h/c.toml#notion", "C:/h/c.toml#local"], "no Claude skill, agent or server");
  assert.equal(host.querySelector(".runes-bare-note").textContent, "Changes load on the next start, including /clear or Retry.");
  const every = [...host.querySelectorAll(".runes-group-head")].find((h) => h.textContent === "Inherited Runes");
  assert.equal(every.title, "Inherited runes: skills reach every Bare row, agents every Bare row of their own agent, hooks every Claude Bare row. An open Bare tab may pick them up when another one starts.");
  assert.equal(button(host, "Update from Source").title, "Rescans the source; other rows that use this library get its new text too.");
  button(host, "Add Local Files").click();
  await settle();
  const heads = [...host.querySelectorAll(".runes-group-head")];
  assert.equal(heads[0].title, "Codex Bare loads rules, memories, skills, agents and hosted MCP servers.");
  assert.deepEqual(heads.map((h) => h.textContent), ["Local Files", "Rules", "Skills", "Agents", "MCP Servers"]);
  button(host, "Import Raw");
  dispose();
});

test("a Codex Generate shows a Skills layer line and no layer write without a skill change", async () => {
  const io = fakeIo({ actives: { rowKey: "codex-bare", libraries: [], skills: [], agents: [], guards: [], guardsKey: false } });
  io.localSources = async () => ({ memoryDir: null, guardsKey: false, files: [file("C:/h/AGENTS.md", "rules", { library: "agents-md", agent: "codex" }), file("C:/h/CLAUDE.md", "rules", { library: "c", agent: "codex" }), file("C:/h/skills/ctx", "skill", { ticked: false, agent: "codex" })] });
  io.scan = async () => ({ library: "agents-md", bricks: [brick("a")] });
  const { host, dispose } = mount({ ...CTX, agent: "codex", rowKey: "codex-bare" }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  assert.equal(host.querySelector('.rp-source[data-path="C:/h/AGENTS.md"]').getAttribute("aria-pressed"), "true");
  assert.equal(host.querySelector('.rp-source[data-path="C:/h/CLAUDE.md"]').getAttribute("aria-pressed"), "false");
  button(host, "Import Raw").click();
  await settle();
  assert.equal(io.calls.some((c) => c[0] === "layerSet"), false);
  dispose();
});

test("Local Files with nothing found shows the empty line and a disabled Generate", async () => {
  const io = fakeIo({ actives: { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false } });
  io.localSources = async () => ({ files: [], memoryDir: null, guardsKey: false });
  const { host, dispose } = mount(CTX, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  assert.equal(host.querySelector(".rp-empty").textContent, "No Local Files Found");
  assert.equal(button(host, "Import Raw").disabled, true);
  button(host, "Back").click();
  assert.ok(button(host, "Create Runes"));
  dispose();
});

// ---- agent Generate (run 2026-10-17-rune-generator, ipc.md) ----
const CLAUDE_GEN = { models: [{ value: "claude-opus-5-5", label: "Opus 5.5" }, { value: "claude-sonnet-5", label: "Sonnet 5" }] };
const CODEX_GEN = { models: [{ value: "gpt-5", label: "GPT 5", effortLevels: ["low", "medium", "high"] }, { value: "gpt-6", label: "GPT 6", effortLevels: ["high"] }] };
const GEN_RES = { library: "gen-claude-bare-0a1b2c3d", runes: 2, on: 2, encodedChars: null, costUsd: null,
  inputTokens: 1000, outputTokens: 500, durationMs: 130000, warnings: [] };
const genLib = (o = {}, bricks = [active("r1", ["Rules", "R1"], true), active("r2", ["Rules", "R2"], false)]) => ({
  library: "gen-claude-bare-0a1b2c3d", source: null, scope: "global", sourceGone: false, bricks,
  generated: { agent: "claude", model: "claude-sonnet-5", effort: "medium", date: "2026-10-17", inputs: [], warnings: [], encodedChars: null, ...o },
});
function genIo(state, over = {}) {
  const io = fakeIo(state);
  io.generate = async (a) => { io.calls.push(["generate", a]); return GEN_RES; };
  io.generateCancel = async (id) => { io.calls.push(["cancel", id]); return null; };
  io.generateToggle = async (a) => { io.calls.push(["gtoggle", a]); return { library: a.library, written: 1, rows: [a.rowKey] }; };
  return Object.assign(io, over);
}
const EMPTY = { rowKey: ROW, libraries: [], skills: [], agents: [], guards: [], guardsKey: false };
const sel = (host, label) => host.querySelector(`select[aria-label="${label}"]`);
const picked = (s) => s.selectedOptions[0].textContent;

test("Local Files offers Model and Effort selects, Generate, Import Raw and Back; Claude defaults Sonnet 5 / Medium", async () => {
  const io = genIo({ actives: EMPTY });
  const { host, dispose } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  assert.equal(picked(sel(host, "Model")), "Sonnet 5");
  assert.equal(picked(sel(host, "Effort")), "Medium");
  assert.ok(sel(host, "Model").classList.contains("sc-select"));
  const gen = button(host, "Generate");
  assert.ok(gen.classList.contains("ws-add"));
  assert.equal(gen.title, "Sends the ticked rules to Sonnet 5.");
  assert.ok(button(host, "Import Raw") && button(host, "Back"));
  // nothing ticked: Generate off
  host.querySelector('.rp-source[data-path="C:/proj/CLAUDE.md"]').click();
  host.querySelector('.rp-source[data-path="C:/h/skills/ctx"]').click();
  assert.equal(button(host, "Generate").disabled, true);
  // picking another model moves the tooltip
  sel(host, "Model").value = "claude-opus-5-5";
  sel(host, "Model").dispatchEvent(new window.Event("change"));
  assert.equal(button(host, "Generate").title, "Sends the ticked rules to Opus 5.5.");
  dispose();
});

test("selects follow a Codex tab: its models, their efforts, and the read-only note on the tooltip", async () => {
  const io = genIo({ actives: { ...EMPTY, rowKey: "codex-bare" } });
  io.localSources = async () => ({ memoryDir: null, guardsKey: false, files: [file("C:/h/AGENTS.md", "rules", { library: "agents-md", agent: "codex" })] });
  const { host, dispose } = mount({ ...CTX, agent: "codex", rowKey: "codex-bare", gen: () => CODEX_GEN }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  assert.equal(picked(sel(host, "Model")), "GPT 5");
  assert.equal(picked(sel(host, "Effort")), "Medium");
  assert.deepEqual([...sel(host, "Effort").options].map((o) => o.textContent), ["—", "Low", "Medium", "High"]);
  assert.equal(button(host, "Generate").title, "Sends the ticked rules to GPT 5. Codex can read files while generating; it cannot write them.");
  button(host, "Generate").click();
  await settle();
  const a = io.calls.find((c) => c[0] === "generate")[1];
  assert.deepEqual([a.agent, a.model, a.effort, a.budget], ["codex", "gpt-5", "medium", 9000]);
  dispose();
});

test("a kept view's setTrace and reload leave a live run's Cancel and Generating line alone", async () => {
  let release;
  const io = genIo({ actives: EMPTY }, { generate: () => new Promise((r) => { release = () => r(GEN_RES); }) });
  const { host, dispose, handle } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  button(host, "Generate").click();
  await settle();
  assert.ok(button(host, "Cancel"), "running");
  const loads = io.calls.filter((c) => c[0] === "actives").length;
  const line = document.createElement("div");
  line.textContent = "New Trace";
  handle.setTrace([line]);
  handle.reload();
  await settle();
  assert.ok(button(host, "Cancel"), "Cancel stays");
  assert.equal(host.querySelector(".runes-bare-note").textContent, "Generating…");
  assert.equal(io.calls.filter((c) => c[0] === "actives").length, loads, "no re-read mid-run");
  release();
  await settle();
  assert.equal(host.querySelector(".runes-bare-trace").textContent, "New Trace", "the new trace shows once Actives is back");
  dispose();
});

test("Generate runs through Actives: generating line, Cancel with the run id, then the Done line tooltip", async () => {
  const state = { actives: EMPTY };
  let release;
  const io = genIo(state, { generate: (a) => { io.calls.push(["generate", a]); return new Promise((r) => { release = () => r(GEN_RES); }); } });
  const { host, dispose } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  button(host, "Generate").click();
  await settle();
  assert.equal(host.querySelector(".runes-bare-note").textContent, "Generating…");
  assert.equal(host.querySelector(".runes-bare-line-path").textContent, "Runes");
  const a = io.calls.find((c) => c[0] === "generate")[1];
  assert.match(a.runId, /^[0-9a-f]{8}$/);
  assert.deepEqual([a.agent, a.model, a.effort, a.rowKey], ["claude", "claude-sonnet-5", "medium", ROW]);
  button(host, "Cancel").click();
  assert.deepEqual(io.calls.find((c) => c[0] === "cancel"), ["cancel", a.runId]);
  state.actives = { ...EMPTY, libraries: [genLib()] };
  release();
  await settle();
  const done = host.querySelector('.runes-bare-line[data-state="done"] .runes-bare-line-state');
  assert.equal(done.textContent, "Done");
  assert.equal(done.title, "Sonnet 5 · Medium · 2m 10s · 2K Tokens");
  assert.ok(host.querySelector('.runes-set[data-library="gen-claude-bare-0a1b2c3d"]'), "back on Actives with the library");
  dispose();
});

test("progress rows replace the single Runes row while a chunked run goes; an error turns unfinished rows Stopped", async () => {
  let push;
  let fail;
  const io = genIo({ actives: EMPTY }, {
    generateProgress: async (fn) => { push = fn; return () => {}; },
    generate: (a) => { io.calls.push(["generate", a]); return new Promise((_, rej) => { fail = rej; }); },
  });
  const { host, dispose } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  button(host, "Generate").click();
  await settle();
  const id = io.calls.find((c) => c[0] === "generate")[1].runId;
  push({ runId: id, stage: "plan", chunks: [
    { files: [{ path: "a.md", part: null }] }, { files: [{ path: "b.md", part: { k: 1, of: 2 } }] }, { files: [{ path: "b.md", part: { k: 2, of: 2 } }] },
  ] });
  push({ runId: id, stage: "chunk", index: 0, state: "done", runes: 4 });
  push({ runId: id, stage: "chunk", index: 1, state: "running", runes: null });
  await settle();
  const rows = () => [...host.querySelectorAll(".runes-gen-card")].map((r) => [r.querySelector(".runes-gen-path").textContent, r.dataset.state, r.querySelector(".runes-gen-state").textContent]);
  assert.deepEqual(rows(), [["a.md", "done", "4 Runes"], ["b.md", "running", ""], ["b.md", "pending", ""], ["Merge", "pending", ""]]);
  assert.ok(host.querySelector('[data-bare-view="agent"]') ?? (host.dataset.bareView === "agent" ? host : null), "the run marks the view so the key hides");
  assert.equal(host.querySelector(".runes-bare-note").textContent, "Generating…");
  fail("output: bad");
  await settle();
  assert.deepEqual(rows().slice(1, 4).map((r) => r[1]), ["stopped", "stopped", "stopped"]);
  assert.equal(rows()[1][2], "Stopped");
  dispose();
});

test("each failure reads its label, with the detail only in the tooltip", async () => {
  const cases = [
    ["cancelled", "Cancelled", ""], ["timeout", "Timed Out", ""], ["login: no session", "Not Logged In", "no session"],
    ["spawn: no exe", "Generation Failed", "no exe"], ["output: junk", "Generation Failed", "junk"],
    ["stale: moved", "Row Changed While Generating", "moved"], ["busy: x", "Generating in Another Tab", "x"],
    ["invalid: a\nb\nc\nd\ne\nf", "Output Rejected", "a\nb\nc\nd\ne"],
  ];
  for (const [err, label, title] of cases) {
    const io = genIo({ actives: EMPTY }, { generate: async () => { throw err; } });
    const { host, dispose } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
    await settle();
    button(host, "Create Runes").click();
    await settle();
    button(host, "Generate").click();
    await settle();
    const st = host.querySelector(".runes-bare-line-state");
    assert.equal(st.textContent, label, err);
    assert.equal(st.title, title, err);
    assert.ok(st.classList.contains("rp-error"));
    assert.ok(!host.textContent.includes("no exe") && !host.textContent.includes("junk"));
    button(host, "Back").click();
    assert.ok(button(host, "Create Runes"));
    dispose();
  }
});

test("another tab's run disables Generate with its tooltip; the row's own run disables switches and Import Raw", async () => {
  const lib = genLib();
  let release;
  const slow = genIo({ actives: { ...EMPTY, rowKey: "codex-bare" } }, { generate: () => new Promise((r) => { release = () => r(GEN_RES); }) });
  slow.localSources = async () => ({ memoryDir: null, guardsKey: false, files: [file("C:/h/AGENTS.md", "rules", { agent: "codex" })] });
  const io = genIo({ actives: { ...EMPTY, libraries: [lib] } });
  const a = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  const b = mount({ ...CTX, agent: "codex", rowKey: "codex-bare", gen: () => CODEX_GEN }, slow);
  await settle();
  await a.modify();
  button(a.host, "Add Local Files").click();
  button(b.host, "Create Runes").click();
  await settle();
  assert.equal(button(a.host, "Generate").disabled, false);
  button(b.host, "Generate").click();
  await settle();
  assert.equal(button(a.host, "Generate").disabled, true);
  assert.equal(button(a.host, "Generate").title, "Generating in Another Tab");
  release();
  await settle();
  assert.equal(button(a.host, "Generate").disabled, false);
  a.dispose(); b.dispose();

  // the row's own run: switches and Import Raw off with "Generating…"
  const io2 = genIo({ actives: { ...EMPTY, libraries: [lib] } }, { generate: () => new Promise((r) => { release = () => r(GEN_RES); }) });
  const c = mount({ ...CTX, gen: () => CLAUDE_GEN }, io2);
  const d = mount({ ...CTX, gen: () => CLAUDE_GEN }, genIo({ actives: { ...EMPTY, libraries: [lib] } }));
  await settle();
  await c.modify();
  await d.modify();
  button(c.host, "Add Local Files").click();
  await settle();
  button(c.host, "Generate").click();
  await settle();
  const sw = d.host.querySelector(".runes-bare-switch");
  assert.equal(sw.disabled, true);
  assert.equal(sw.title, "Generating…");
  button(d.host, "Add Local Files").click();
  await settle();
  assert.equal(button(d.host, "Import Raw").disabled, true);
  assert.equal(button(d.host, "Import Raw").title, "Generating…");
  release();
  await settle();
  c.dispose(); d.dispose();
});

test("a generated library with every rune Off is still listed; its switches use rules_generate_toggle", async () => {
  const lib = genLib({}, [active("r1", ["Rules", "R1"], false), active("r2", ["Rules", "R2"], false)]);
  const state = { actives: { ...EMPTY, libraries: [lib] } };
  const io = genIo(state);
  const { host, dispose, modify } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  assert.equal(host.querySelector(".runes-set[data-library]"), null, "View hides a set with every rune Off");
  await modify();
  assert.ok(host.querySelector('.runes-set[data-library="gen-claude-bare-0a1b2c3d"]'));
  assert.equal(button(host, "Create Runes"), undefined, "not the empty-row state");
  const sw = host.querySelector(".runes-bare-switch");
  assert.equal(sw.disabled, false);
  sw.click();
  await settle();
  assert.deepEqual(io.calls.find((c) => c[0] === "gtoggle")[1], { library: lib.library, rowKey: ROW, id: "r1", on: true });
  assert.equal(io.calls.some((c) => c[0] === "scan" || c[0] === "apply"), false);
  dispose();
});

test("set heads carry the hue: generated libraries get hue-generated, Inherited Runes heads their kind", async () => {
  const gen = genLib({}, [active("r1", ["Rules", "R1"], true)]);
  const imp = { library: "glob", source: "C:/h/CLAUDE.md", scope: "global", sourceGone: false, bricks: [active("a", ["Doc", "A"], true)] };
  const ro = { library: "vidar-x", source: null, scope: "global", sourceGone: false, bricks: [active("b", ["Doc", "B"], true)] };
  const io = genIo({ actives: { ...EMPTY, libraries: [gen, imp, ro], skills: ["C:/h/skills/ctx"] } });
  const { host, dispose } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  const set = (lib) => host.querySelector(`.runes-set[data-library="${lib}"]`);
  assert.ok(set(gen.library).classList.contains("hue-generated"));
  assert.ok(set("glob").classList.contains("hue-claude"));
  assert.ok(set("vidar-x").classList.contains("hue-none"));
  assert.ok(host.querySelector('.runes-set[data-kind="skill"]').classList.contains("hue-skill"));
  dispose();
});

test("a generated card is named by its id; an import card keeps its section heading", async () => {
  const gen = genLib({}, [active("report-every-finding", ["Responses"], true), active("keep-it-short", ["Responses"], true)]);
  const imp = { library: "glob", source: "C:/h/CLAUDE.md", scope: "global", sourceGone: false,
    bricks: [active("report-every-finding", ["Doc", "Responses"], true)] };
  const io = genIo({ actives: { ...EMPTY, libraries: [gen, imp] } });
  const { host, dispose } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  const names = (lib) => [...host.querySelectorAll(`.runes-set[data-library="${lib}"] .runes-rname`)].map((n) => n.textContent);
  assert.deepEqual(names(gen.library), ["Report Every Finding", "Keep It Short"]);
  assert.deepEqual(names("glob"), ["Responses"]);
  dispose();
});

test("a generated library draws no warning count, and a large Codex payload shows no note", async () => {
  const lib = genLib({ agent: "codex", warnings: ["Line 4 of ~/a.md is not cited."], encodedChars: 14140 });
  const io = genIo({ actives: { ...EMPTY, rowKey: "codex-bare", libraries: [lib] } });
  const { host, dispose } = mount({ ...CTX, agent: "codex", rowKey: "codex-bare", gen: () => CODEX_GEN }, io);
  await settle();
  const set = host.querySelector(".runes-set");
  assert.equal(set.querySelector(".runes-err"), null);
  assert.equal(set.querySelectorAll(".runes-bare-note").length, 0, "no warning-count note");
  dispose();
});

test("the Inherited Runes head is a toggle button that collapses its body", async () => {
  const lib = { library: "proj", source: "C:/proj/CLAUDE.md", scope: "project", sourceGone: false, bricks: [active("a", ["Doc", "A"], true)] };
  const io = fakeIo({ actives: { rowKey: ROW, libraries: [lib], skills: ["C:/h/skills/ctx"], agents: [], guards: [], guardsKey: false } });
  io.localSources = async () => ({ memoryDir: null, guardsKey: false, files: [file("C:/h/skills/ctx", "skill", { ticked: true })] });
  const { host, dispose } = mount(CTX, io);
  await settle();
  const head = [...host.querySelectorAll(".runes-group-head")].find((h) => h.textContent === "Inherited Runes");
  assert.equal(head.tagName, "BUTTON");
  assert.equal(head.getAttribute("aria-expanded"), "true");
  const body = host.querySelector(".runes-group-body");
  assert.equal(body.hidden, false);
  assert.ok(body.querySelector(".runes-set[data-kind=\"skill\"]"));
  head.click();
  assert.equal(head.getAttribute("aria-expanded"), "false");
  assert.equal(body.hidden, true);
  head.click();
  assert.equal(body.hidden, false);
  dispose();
});

test("Import Raw runs today's scan and apply path with the agent controls present", async () => {
  const state = { actives: EMPTY, scans: { "C:/proj/CLAUDE.md": { library: "p", bricks: [brick("a")] } } };
  const io = genIo(state);
  const { host, dispose } = mount({ ...CTX, gen: () => CLAUDE_GEN }, io);
  await settle();
  button(host, "Create Runes").click();
  await settle();
  button(host, "Import Raw").click();
  await settle();
  assert.ok(io.calls.some((c) => c[0] === "scan") && io.calls.some((c) => c[0] === "apply"));
  assert.equal(io.calls.some((c) => c[0] === "generate"), false);
  dispose();
});

test("warningSummary counts advisory warnings and keeps the merge failure visible", async () => {
  const { warningSummary } = await import("../src/runes/bare/agent-view.ts");
  assert.deepEqual(warningSummary([]), { label: null, tip: "", merge: [] });
  assert.deepEqual(warningSummary(["a"]), { label: "1 Warning", tip: "a", merge: [] });
  assert.deepEqual(warningSummary(["a", "b", "c"]), { label: "3 Warnings", tip: "a\nb\nc", merge: [] });
  const m = warningSummary(["Merge pass failed: x", "a", "b"]);
  assert.deepEqual(m, { label: "2 Warnings", tip: "a\nb", merge: ["Merge pass failed: x"] });
  assert.equal(warningSummary(["Merge pass failed: x"]).label, null);
});

test("Inherited Runes leaves out a kind with no files; a kind with files but none ticked still draws", async () => {
  const lib = { library: "proj", source: "C:/proj/CLAUDE.md", scope: "project", sourceGone: false, bricks: [active("a", ["Doc", "A"], true)] };
  const io = fakeIo({ actives: { rowKey: ROW, libraries: [lib], skills: [], agents: [], guards: [], guardsKey: false } });
  io.localSources = async () => ({ memoryDir: null, guardsKey: false, files: [file("C:/h/skills/ctx", "skill", { ticked: false })] });
  const { host, dispose, modify } = mount(CTX, io);
  await settle();
  assert.equal(host.querySelector('.runes-set[data-kind="skill"]'), null, "View: nothing ticked, no head");
  await modify();
  assert.equal(host.querySelector('.runes-set[data-kind="agent"]'), null, "no files: no head");
  assert.equal(host.querySelector('.runes-set[data-kind="hook"]'), null);
  const skill = host.querySelector('.runes-set[data-kind="skill"]');
  assert.ok(skill, "offered but unticked still draws");
  assert.equal(skill.querySelectorAll(".rp-source").length, 1);
  dispose();
  const none = fakeIo({ actives: { rowKey: ROW, libraries: [lib], skills: [], agents: [], guards: [], guardsKey: false } });
  none.localSources = async () => ({ memoryDir: null, guardsKey: false, files: [] });
  const m = mount(CTX, none);
  await settle();
  assert.ok(![...m.host.querySelectorAll(".runes-group-head")].some((h) => h.textContent === "Inherited Runes"), "all kinds empty: no group");
  m.dispose();
});

test("genLabel names generated libraries from the row key and a run-id produce word", async () => {
  const { genLabel } = await import("../src/runes/bare/view.ts");
  const LIST = ["Apple", "Pear", "Plum", "Peach", "Cherry", "Grape", "Lemon", "Lime", "Mango", "Melon", "Fig", "Kiwi", "Olive",
    "Apricot", "Carrot", "Pea", "Bean", "Leek", "Onion", "Turnip", "Radish", "Beet", "Kale", "Celery", "Pepper", "Potato",
    "Tomato", "Corn", "Garlic", "Cabbage", "Lettuce", "Pumpkin"];
  const word = (hex) => LIST[parseInt(hex, 16) % LIST.length];
  assert.equal(genLabel("gen-codex-rendered-bare-9c0a5540"), `Runes-Codex-Bare-Rendered-${word("9c0a5540")}`);
  assert.equal(genLabel("gen-claude-bare-00000001"), `Runes-Claude-Bare-${word("00000001")}`);
  assert.equal(genLabel("gen-claude-bare-00000001"), genLabel("gen-claude-bare-00000001"));
  assert.equal(genLabel("proj-claude-md"), null);
  assert.equal(genLabel("gen-claude-bare-9C0A5540"), null);
  assert.equal(genLabel("gen-claude-bare-1234567"), null);
});

test("ticking a set's skill writes that set's sidecar and redraws it ticked; the shared list is not written", async () => {
  const setLayer = (skills) => ({ set: "row-claude-bare", editable: true, skills, agents: [], guards: [], codexSkills: skills, warnings: [] });
  const lib = (skills) => ({ library: "claude-user", source: "C:/h/CLAUDE.md", scope: "global", sourceGone: false,
    bricks: [active("a", ["Doc", "Style"], true)], sets: [setLayer(skills)] });
  const state = { actives: { rowKey: ROW, libraries: [lib([])], skills: [], agents: [], guards: [], guardsKey: false } };
  const io = fakeIo(state);
  io.setLayerWrite = async (a) => { io.calls.push(["setLayerWrite", a]); state.actives.libraries[0] = lib(a.layer.skills ?? []); return null; };
  const { host, dispose, modify } = mount(CTX, io);
  await settle();
  assert.equal(host.querySelector('.runes-set[data-set="row-claude-bare"]'), null, "View: a set with nothing attached draws no group");
  await modify();
  const row = () => host.querySelector('.runes-set[data-set="row-claude-bare"][data-kind="skill"] .rp-source[data-path="C:/h/skills/ctx"]');
  assert.equal(row().getAttribute("aria-pressed"), "false");
  assert.deepEqual([...host.querySelectorAll('.runes-set[data-set="row-claude-bare"]')].map((d) => d.dataset.kind), ["skill", "agent", "hook"],
    "skills, agents and hooks are offered (the block guard is not)");
  row().click();
  await settle();
  assert.deepEqual(io.calls.filter((c) => c[0] === "setLayerWrite").map((c) => c[1]),
    [{ library: "claude-user", set: "row-claude-bare", layer: { skills: ["C:/h/skills/ctx"] } }]);
  assert.equal(io.calls.filter((c) => c[0] === "layerSet").length, 0, "the shared list is not written");
  assert.equal(row().getAttribute("aria-pressed"), "true", "re-read: ticked");
  dispose();
});