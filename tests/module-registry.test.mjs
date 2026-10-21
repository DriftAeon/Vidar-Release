// The TS module registry: modules_list in, an ordered registry out, and it never throws. Packs whose
// dependsOn names an absent module (transitively) go inactive; a duplicate id or a cycle falls back
// to the core modules and the bundled Codex agent plus a broken row; a failed IPC does the same, so
// no fallback is ever without an agent. The registry reads false
// before loadModules settles (main.ts awaits it ahead of buildTypeMenu).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url).href;
globalThis.__modStub = { list: null, fail: false, detect: null };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const url = new URL(specifier, context.parentURL);
      if (url.href === `${SRC}ipc.ts` || url.href === `${SRC}ipc`) {
        const code = `export function invoke(cmd) {
          const s = globalThis.__modStub;
          if (cmd === "detect_dependencies") return s.detect();
          if (cmd !== "modules_list") return Promise.reject(new Error("unstubbed invoke: " + cmd));
          return s.fail ? Promise.reject(new Error("ipc down")) : Promise.resolve(s.list);
        }
        export function listen() { return Promise.resolve(() => {}); }`;
        return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
      }
      if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(`${url.href}.ts`))) {
        return next(`${url.href}.ts`, context);
      }
    }
    return next(specifier, context);
  },
});

const reg = await import("../src/modules/registry.ts");
const depsState = await import("../src/deps/state.ts");
const currentReport = () => ({ root: "C:\\V", deps: depsState.CATALOG.deps.map((d) => ({ id: d.id, found: true })) });
globalThis.__modStub.detect = () => Promise.resolve(currentReport());

// when.deps names a static catalog id (git; codex's dep now arrives with its pack, not the catalog).
const core = (id) => ({ id, label: id, level: "core", kind: "agent", source: "core", when: { deps: ["git"] } });
const pack = (id, extra = {}) => ({ id, label: id, level: "optional", kind: "agent", source: "pack", folder: id, ...extra });
const list = (...modules) => ({ modules, broken: [] });
const load = async (l) => { globalThis.__modStub.list = l; globalThis.__modStub.fail = false; return reg.loadModules(); };

test("moduleOn reads false before loadModules settles, true after", async () => {
  assert.equal(reg.moduleOn("base"), false);
  assert.equal(reg.moduleListed("lab"), true, "before the list resolves every surface reads listed");
  await load(list(core("base")));
  assert.equal(reg.moduleOn("base"), true);
});

test("an unknown dependsOn goes inactive without throwing, and so do its dependants", async () => {
  const built = await load(list(
    core("base"),
    pack("acme", { dependsOn: ["ghost"], when: undefined }),
    pack("acme-two", { dependsOn: ["acme"] }),
    pack("fine", { dependsOn: ["base"] }),
  ));
  assert.deepEqual(built.ordered.map((m) => m.id), ["base", "fine"]);
  const reasons = Object.fromEntries(built.dropped.map((d) => [d.row.id, d.reason]));
  assert.deepEqual(reasons, { acme: "Needs ghost", "acme-two": "Needs ghost" });
  assert.equal(reg.moduleOn("acme"), false);
  assert.equal(reg.moduleOn("fine"), true);
  assert.deepEqual(reg.modulesOf("agent").map((m) => m.id), ["base", "fine"]);
});

test("a dependency cycle or a duplicate id falls back to core modules and the bundled Codex agent, with a broken row", async () => {
  const bundled = reg.FALLBACK_AGENT;
  const cyc = await load(list(core("base"), bundled, pack("a", { dependsOn: ["b"] }), pack("b", { dependsOn: ["a"] })));
  assert.deepEqual(cyc.ordered.map((m) => m.id), ["base", "codex"]);
  assert.equal(cyc.broken.length, 1);
  assert.deepEqual(cyc.dropped.map((d) => d.row.id).sort(), ["a", "b"]);
  assert.ok(cyc.deps.some((d) => d.id === "codex"), "the bundled agent brings its own dep");

  const dup = await load(list(core("base"), bundled, pack("x"), pack("x")));
  assert.deepEqual(dup.ordered.map((m) => m.id), ["base", "codex"]);
  assert.match(dup.broken[0].reason, /twice/);

  // A listed codex pack is the one the fallback keeps, not the compiled-in copy.
  const listed = { ...bundled, label: "Listed Codex" };
  const own = await load(list(core("base"), listed, pack("y"), pack("y")));
  assert.equal(own.ordered.find((m) => m.id === "codex").label, "Listed Codex");
});

test("a listed codex row that breaks ordering falls back to the bundled agent and keeps core", async () => {
  const typo = await load(list(core("base"), { ...reg.FALLBACK_AGENT, when: { deps: ["codexx"] } }));
  assert.deepEqual(typo.ordered.map((m) => m.id), ["base", "codex"]);
  assert.equal(typo.ordered.find((m) => m.id === "codex").label, reg.FALLBACK_AGENT.label);
  assert.equal(typo.broken.length, 1);

  const astra = { id: "cap-needs-agent", label: "A", level: "required-hideable", kind: "capability", source: "core", when: {}, dependsOn: ["codex"], capability: {} };
  const cycle = await load(list(core("base"), astra, { ...reg.FALLBACK_AGENT, dependsOn: ["cap-needs-agent"] }));
  assert.ok(cycle.ordered.some((m) => m.id === "base") && cycle.ordered.some((m) => m.id === "codex"));
  assert.equal(cycle.broken.length, 1);
});

test("the ordering fallback brings no codex back when the catalog has no codex dep row", async () => {
  const built = await load(list(core("base"), pack("a", { dependsOn: ["b"] }), pack("b", { dependsOn: ["a"] })));
  assert.deepEqual(built.ordered.map((m) => m.id), ["base"]);
  assert.equal(built.broken.length, 1);
});

test("a failed modules_list still yields an agent: the core modules plus the bundled Codex pack", async () => {
  globalThis.__modStub.fail = true;
  const built = await reg.loadModules();
  const ids = built.ordered.map((m) => m.id);
  assert.ok(ids.includes("codex") && !ids.includes("claude"), "only Codex is bundled into the fallback");
  assert.ok(built.ordered.every((m) => m.source === "core" || m.id === "codex"));
  assert.equal(built.broken.length, 1);
  const agents = built.ordered.filter((m) => m.kind === "agent");
  assert.ok(agents.length >= 1, "a failed modules_list leaves at least one agent");
  assert.ok(reg.modulesOf("agent").some((m) => m.id === "codex"), "with codex found, the fallback agent is on");
  assert.ok(depsState.CATALOG.deps.some((d) => d.id === "codex"), "the codex dep joins the catalog");
});

test("a core[] row at a pack level drops with an absent dependsOn; a core-level row does not", async () => {
  const astra = { id: "astra-like", label: "A", level: "required-hideable", kind: "capability", source: "core", when: {}, dependsOn: ["gone"], capability: {} };
  const built = await load(list(core("base"), astra));
  assert.deepEqual(built.ordered.map((m) => m.id), ["base"]);
  assert.deepEqual(built.dropped.map((d) => [d.row.id, d.reason]), [["astra-like", "Needs gone"]]);
  assert.deepEqual(built.broken, []);
});

test("pack deps[] join the catalog so order() does not reject their ids; a reload replaces them", async () => {
  const dep = (id) => ({ id, label: id, required: false, usedBy: [], probe: { kind: "env", name: "ACME_API_KEY" }, install: {} });
  const built = await load(list(core("base"), pack("acme", { dependsOn: ["base"], deps: [dep("acme-key")], when: { deps: ["acme-key"] } })));
  assert.deepEqual(built.ordered.map((m) => m.id), ["base", "acme"]);
  assert.ok(depsState.CATALOG.deps.some((d) => d.id === "acme-key"));
  await load(list(core("base")));
  assert.ok(!depsState.CATALOG.deps.some((d) => d.id === "acme-key"));
});

test("the claude pack brings its own claude dep, so its when.deps orders and its gateways follow it", async () => {
  const dep = (id) => ({ id, label: id, required: false, usedBy: [], probe: { kind: "exe", names: [`${id}.exe`] }, install: {} });
  const claude = pack("claude", { deps: [dep("claude"), dep("falcon")], when: { deps: ["claude"] }, agent: { setup: { dep: "claude", order: 0 } } });
  const built = await load(list(core("codex"), claude, pack("acme", { dependsOn: ["claude"] })));
  assert.deepEqual(built.ordered.map((m) => m.id), ["codex", "claude", "acme"]);
  assert.deepEqual(built.broken, []);
  const without = await load(list(core("codex"), pack("acme", { dependsOn: ["claude"] })));
  assert.deepEqual(without.dropped.map((d) => [d.row.id, d.reason]), [["acme", "Needs claude"]]);
});

test("an unmet when.deps resolves a module off along with its dependants", () => {
  const ordered = [core("base"), pack("acme", { dependsOn: ["base"] })].map((m) => ({ ...m, when: m.when ?? {} }));
  const report = { root: "C:\\V", deps: [{ id: "git", found: false }] };
  assert.deepEqual([...reg.resolveOn(ordered, report)], []);
  assert.deepEqual([...reg.resolveOn(ordered, { root: "C:\\V", deps: [{ id: "git", found: true }] })], ["base", "acme"]);
});

test("a pack listed during detection gets a fresh report, and matching reloads reuse it", async () => {
  const previousDetect = globalThis.__modStub.detect;
  const firstReport = currentReport();
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let detects = 0;
  globalThis.__modStub.detect = () => {
    detects++;
    return detects === 1 ? first : Promise.resolve(currentReport());
  };
  try {
    const firstDetection = depsState.loadDeps();
    const dep = { id: "late-key", label: "Late Key", required: false, usedBy: [], probe: { kind: "env", name: "LATE_KEY" }, install: {} };
    const modules = list(core("base"), pack("late", { deps: [dep], when: { deps: [dep.id] } }));
    const pending = load(modules);
    await new Promise(setImmediate);
    assert.ok(depsState.CATALOG.deps.some((d) => d.id === dep.id));
    assert.equal(detects, 1, "the registry waits for the first detection");

    releaseFirst(firstReport);
    await firstDetection;
    await pending;
    assert.equal(detects, 2);
    assert.ok(depsState.depsReport().deps.some((d) => d.id === dep.id));
    assert.equal(reg.moduleOn("late"), true);

    await load(modules);
    assert.equal(detects, 2, "a report containing the pack id needs no more detection");
  } finally {
    releaseFirst(firstReport);
    globalThis.__modStub.detect = previousDetect;
  }
});

// Release builds hide rows they cannot run: a dep that ships inside Vidar (probe kind "vidar", e.g.
// desks) read missing leaves its modules absent; a dep the user can install (exe, e.g. git) does not.
test("releaseDeadDeps: only a missing vidar-kind dep, only in a release build with a report", () => {
  const deps = depsState.CATALOG.deps.filter((d) => ["git", "desks", "voice"].includes(d.id));
  const rep = { root: "C:\\V", deps: [{ id: "git", found: false }, { id: "desks", found: false }, { id: "voice", found: true }] };
  assert.deepEqual([...depsState.releaseDeadDeps(deps, rep, true)], ["desks"]);
  assert.deepEqual([...depsState.releaseDeadDeps(deps, rep, false)], [], "dev checkout: unchanged");
  assert.deepEqual([...depsState.releaseDeadDeps(deps, null, true)], [], "no report yet: nothing dead");
});

test("releaseAbsent: when.deps on a dead dep drops a non-core module and its dependants, never a core one", () => {
  const rows = [
    { id: "speak", label: "Speak", level: "core", kind: "capability", source: "core", when: { deps: ["desks"] } },
    { id: "astra", label: "Astra", level: "required-hideable", kind: "capability", source: "core", when: { deps: ["desks", "git"] } },
    pack("rider", { dependsOn: ["astra"] }),
    pack("gitty", { when: { deps: ["git"] } }),
  ];
  assert.deepEqual([...reg.releaseAbsent(rows, new Set(["desks"]))], ["astra", "rider"]);
  assert.deepEqual([...reg.releaseAbsent(rows, new Set())], []);
});

test("a release build leaves out a module needing a missing desks and the desks row; dev keeps both", async () => {
  const previousDetect = globalThis.__modStub.detect;
  const missingDesks = () => ({ root: "C:\\V", deps: depsState.CATALOG.deps.map((d) => ({ id: d.id, found: d.id !== "desks" && d.id !== "git" })) });
  globalThis.__modStub.detect = () => Promise.resolve(missingDesks());
  const astra = pack("astra", { level: "required-hideable", source: "core", folder: undefined, when: { deps: ["desks"] } });
  const modules = [core("base"), astra, pack("rider", { dependsOn: ["astra"] })];
  try {
    await load({ ...list(...modules), set: "codex" });
    await depsState.loadDeps();
    const viewed = reg.moduleViews().map((v) => v.row.id);
    assert.ok(!viewed.includes("astra") && !viewed.includes("rider"), `absent in a release build: ${viewed}`);
    assert.equal(reg.moduleOn("astra"), false);
    const shown = depsState.shownDeps().map((d) => d.id);
    assert.ok(!shown.includes("desks"), "the missing desks row is not listed");
    assert.ok(shown.includes("git"), "a missing installable dep keeps its row");
    assert.ok(!depsState.missingEntries().some((d) => d.id === "desks"), "setup is not asked to install desks");

    await load(list(...modules));
    await depsState.loadDeps();
    const dev = reg.moduleViews().map((v) => v.row.id);
    assert.ok(dev.includes("astra") && dev.includes("rider"), `dev checkout lists them: ${dev}`);
    assert.ok(depsState.shownDeps().some((d) => d.id === "desks"), "dev checkout lists the desks row");
  } finally {
    globalThis.__modStub.detect = previousDetect;
    await load(list(core("base")));
    await depsState.loadDeps();
  }
});

test("moduleListed: a release list without lab drops it from bench, Settings and the toolbar; dev lists all", async () => {
  const { createToolRegistry } = await import("../src/tools/registry.ts");
  const surface = (id) => ({ id, label: id, level: "optional", kind: "surface", source: "core" });
  const toolIds = () => createToolRegistry().map((t) => t.id);
  try {
    await load({ ...list(core("base"), surface("runelib"), surface("marquee")), set: "codex" });
    assert.equal(reg.moduleListed("lab"), false, "a release set that left lab out");
    assert.equal(reg.moduleListed("eyedropper"), false);
    assert.equal(reg.moduleListed("runelib"), true);
    assert.deepEqual(toolIds(), ["marquee"]);
    assert.deepEqual(createToolRegistry(() => true).map((t) => t.id), ["marquee"], "enabled cannot bring back an unlisted tool");

    await load(list(core("base")));
    assert.equal(reg.moduleListed("lab"), true, "dev: no set, every compiled surface stays");
    assert.deepEqual(toolIds(), ["marquee", "eyedropper"]);
  } finally {
    await load(list(core("base")));
  }
});

test("a failed reload after a release list keeps that set: no Codex or Lab comes back", async () => {
  const contract = (await import("../contracts/modules.json", { with: { type: "json" } })).default;
  const shipped = contract.core.filter((m) => m.id !== "lab").map((m) => ({ ...m, source: "core" }));
  assert.ok(contract.core.some((m) => m.id === "lab"), "the contract still has a lab row to leave out");
  try {
    await load({ ...list(...shipped), set: "t" });
    globalThis.__modStub.fail = true;
    const built = await reg.loadModules();
    const ids = [...built.ordered, ...built.dropped.map((v) => v.row)].map((m) => m.id);
    assert.ok(!ids.includes("codex") && !ids.includes("lab"), `fallback keeps the set: ${ids}`);
    assert.equal(built.broken.length, 1);
    assert.equal(reg.moduleListed("lab"), false);
    assert.equal(reg.moduleListed("codex"), false);

    await load(list(core("base")));
    globalThis.__modStub.fail = true;
    const dev = await reg.loadModules();
    assert.ok(dev.ordered.some((m) => m.id === "codex"), "dev: the fallback keeps the bundled Codex");
    assert.equal(reg.moduleListed("lab"), true);
  } finally {
    await load(list(core("base")));
  }
});

test("setup-agent message: a release build's dead vidar dep is not named", async () => {
  const { setupAgentBlocker } = await import("../src/deps/setup-agent.ts");
  const previousDetect = globalThis.__modStub.detect;
  globalThis.__modStub.detect = () => Promise.resolve({ root: "C:\\V", deps: depsState.CATALOG.deps.map((d) => ({ id: d.id, found: d.id !== "desks" })) });
  const helper = pack("helper", { label: "Helper", agent: { setup: { dep: "desks" } } });
  const desksLabel = depsState.CATALOG.deps.find((d) => d.id === "desks").label;
  try {
    await load(list(core("base"), helper));
    await depsState.loadDeps();
    assert.equal(setupAgentBlocker(), `No Setup Agent Found: Install ${desksLabel}, Then Recheck`, "dev names the dep");

    await load({ ...list(core("base"), helper), set: "codex" });
    await depsState.loadDeps();
    const message = setupAgentBlocker();
    assert.ok(!message.includes(desksLabel), `release omits the dead desks row: ${message}`);
    assert.equal(message, "No Setup Agent Found: Install Helper, Then Recheck");
  } finally {
    globalThis.__modStub.detect = previousDetect;
    await load(list(core("base")));
    await depsState.loadDeps();
  }
});
