// Capability registry. contracts/modules.json names dependency ids from
// contracts/dependencies.json and host element ids from index.html; the two id namespaces must
// not overlap. The ordering test pins what the registry's lifecycle promises: dependents mount
// after and dispose before what they depend on, and overlapping diffs never double-mount.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createApplier, order, resolve } from "../src/capabilities/core.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(resolvePath(ROOT, p), "utf8");
const contract = JSON.parse(read("contracts/modules.json"));
// Capability modules: the compiled core ones, then the pack-declared ones (none today).
const packModules = readdirSync(resolvePath(ROOT, "content/packs"))
  .map((f) => JSON.parse(read(`content/packs/${f}/pack.json`)).module)
  .filter((m) => m?.kind === "capability");
const capModules = [...contract.core.filter((m) => m.kind === "capability"), ...packModules];
const capIds = new Set(capModules.map((m) => m.id));
// registry.ts keeps only capability ids in dependsOn; a pack may also name an agent module.
const caps = capModules.map((m) => ({
  id: m.id, label: m.label, when: m.when ?? {}, dependsOn: m.dependsOn?.filter((d) => capIds.has(d)), host: m.capability?.host,
}));
const factIds = new Set(["characters"]);
// The merged catalog: contracts/dependencies.json, then every pack's deps[] (codex lives in its pack).
const packDeps = readdirSync(resolvePath(ROOT, "content/packs"))
  .flatMap((f) => JSON.parse(read(`content/packs/${f}/pack.json`)).module?.deps ?? []);
const depIds = new Set([...JSON.parse(read("contracts/dependencies.json")).deps, ...packDeps].map((d) => d.id));

test("module capability declarations agree with the dependency catalog and index.html", () => {
  assert.deepEqual(caps.map((c) => c.id), [
    "speak", "auto-speak", "character","dictation", "listen",
  ]);
  for (const m of contract.core.filter((m) => m.kind === "capability")) {
    assert.equal(m.level, "core", m.id);

    assert.ok(m.capability, `${m.id}: missing capability shape`);
  }
  assert.ok(!capIds.has("codex"), "codex is an agent, so registry.ts filters it out of the capability order");

  for (const c of caps) {
    assert.ok(!depIds.has(c.id), `capability id "${c.id}" is also a dependency id`);
    for (const d of c.when.deps ?? []) assert.ok(depIds.has(d), `${c.id}: unknown dependency "${d}"`);
  }
  order(caps, depIds, factIds); // throws on unknown dependsOn, dependency or fact id, or a cycle
  assert.throws(() => order([{ id: "x", label: "x", when: { facts: ["ghost"] } }], depIds, factIds), /unknown fact/);
  const html = read("index.html");
  for (const c of caps) {
    if (c.host === undefined) continue; // a service capability (start(ctx)) has no host
    const tag = html.match(new RegExp(`<[^>]*\\bid="${c.host}"[^>]*>`))?.[0] ?? "";
    assert.match(tag, /\bstyle="display: none"/, `${c.id}: host #${c.host} missing or not shipped hidden`);
  }
  // The module shape follows the declaration (registry.ts throws a mount failure
  // otherwise), and a stops/<id>.ts is re-exported by its mount so a switch-off runs the same body.
  const exports = (src, name) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(src);
  for (const c of caps) {
    const src = read(`src/capabilities/mounts/${c.id}.ts`);
    const hosted = c.host !== undefined;
    assert.equal(exports(src, "mount"), hosted, `${c.id}: mounts/${c.id}.ts must export mount exactly when it has a host`);
    assert.equal(exports(src, "start"), !hosted, `${c.id}: mounts/${c.id}.ts must export start exactly when it has no host`);
  }
  const ids = new Set(caps.map((c) => c.id));
  for (const f of readdirSync(resolvePath(ROOT, "src/capabilities/stops"))) {
    const id = f.replace(/\.ts$/, "");
    assert.ok(ids.has(id), `stops/${f} names no declared capability`);
    assert.match(
      read(`src/capabilities/mounts/${id}.ts`),
      new RegExp(`export\\s*\\{\\s*stop\\s*\\}\\s*from\\s*"\\.\\./stops/${id}"`),
      `mounts/${id}.ts must re-export stop from ../stops/${id}`,
    );
  }
});

test("dependents mount after, dispose before, cycles throw, overlapping diffs never double-mount", async () => {
  const decl = (id, dependsOn = []) => ({ id, label: id, when: {}, dependsOn, host: id });
  const decls = order([decl("child", ["base"]), decl("base")]);
  assert.deepEqual(decls.map((d) => d.id), ["base", "child"]);
  assert.throws(() => order([decl("a", ["b"]), decl("b", ["a"])]), /cycle/);
  assert.throws(() => order([decl("a", ["ghost"])]), /unknown capability/);

  const facts = { deps: null, packs: new Set(), config: {}, facts: new Set(), off: new Set(["base"]) };
  assert.deepEqual([...resolve(decls, facts)], [], "off overlay on base turns its dependent off too");

  const log = [];
  const live = new Set();
  const applier = createApplier(decls, {
    load: (id) => new Promise((done) => setTimeout(() => done(id), 5)),
    mount(id) {
      assert.ok(!live.has(id), `${id} mounted twice`);
      live.add(id);
      log.push(`mount ${id}`);
    },
    dispose(id, switchedOff) {
      live.delete(id);
      log.push(`dispose ${id}${switchedOff ? " off" : ""}`);
    },
  });
  const both = new Set(["base", "child"]);
  const all = () => ({ want: both, ready: both });
  // Three overlapping Refreshes while loads are in flight.
  await Promise.all([applier.apply(all), applier.apply(all), applier.apply(all)]);
  assert.deepEqual(log, ["mount base", "mount child"]);

  log.length = 0;
  await applier.apply(() => ({ want: new Set(), ready: both }));
  assert.deepEqual(log, ["dispose child off", "dispose base off"]);

  log.length = 0;
  const pending = applier.apply(all);
  setTimeout(() => applier.disposeAll(), 1); // pagehide mid-load: nothing mounts after teardown
  await pending;
  assert.deepEqual(log, []);
  assert.equal(live.size, 0);
});

// State migration: a vidar.json written while auto-catapult existed may still list it as off. The
// overlay keeps any false key, and resolve checks `off` only against declared ids, so the stale id
// resolves exactly like an empty overlay.
test("a stale auto-catapult entry in the off overlay resolves like an empty one", () => {
  const decl = (id, dependsOn = []) => ({ id, label: id, when: {}, dependsOn, host: id });
  const decls = order([decl("child", ["base"]), decl("base")]);
  const facts = (off) => ({ deps: null, packs: new Set(), config: {}, facts: new Set(), off });
  let stale;
  assert.doesNotThrow(() => { stale = resolve(decls, facts(new Set(["auto-catapult"]))); });
  assert.deepEqual([...stale], [...resolve(decls, facts(new Set()))]);
  const real = caps.map((c) => ({ ...c, dependsOn: c.dependsOn ?? [] }));
  assert.deepEqual(
    [...resolve(order(real, depIds, factIds), facts(new Set(["auto-catapult"])))],
    [...resolve(order(real, depIds, factIds), facts(new Set()))],
  );
});

// Launch stop. Gates open per capability (registry.ts), so "the first step" is not "the
// facts settled": an id is judged once, in the first completed step where it is ready, and
// stopped only when that step left it unmounted. The step-2 case is the regression: a first-step
// pass would have stopped `late` before its gate opened, or never.
test("launch stop: once per id at its first ready step, dependents first, never after", async () => {
  const decl = (id, dependsOn = []) => ({ id, label: id, when: {}, dependsOn, host: id });
  const decls = order([decl("child", ["base"]), decl("base"), decl("broken"), decl("late"), decl("up")]);
  const log = [];
  const applier = createApplier(decls, {
    load: async (id) => id,
    mount(id) {
      if (id === "broken") throw new Error("mount fails");
      log.push(`mount ${id}`);
    },
    dispose: (id, switchedOff) => log.push(`dispose ${id}${switchedOff ? " off" : ""}`),
    offAtStart: (id) => log.push(`off ${id}`),
  });
  const set = (...ids) => new Set(ids);
  const errors = console.error;
  console.error = () => {}; // the failed mount logs
  try {
    // Step 1: up mounts, base and child are switched off, broken fails to mount, late's gate is
    // still closed.
    await applier.apply(() => ({ want: set("up", "broken"), ready: set("up", "base", "child", "broken") }));
    assert.deepEqual(log, ["mount up", "off broken", "off child", "off base"]);

    // Step 2: late's gate opens after the others settled; only late is judged.
    log.length = 0;
    const ready = () => set("up", "base", "child", "broken", "late");
    await applier.apply(() => ({ want: set("up"), ready: ready() }));
    assert.deepEqual(log, ["off late"]);

    // Later steps: base mounts, then a diff switches it off (the stop hook's path, not this
    // one), then teardown. None of it reaches offAtStart.
    log.length = 0;
    await applier.apply(() => ({ want: set("up", "base"), ready: ready() }));
    await applier.apply(() => ({ want: set("up"), ready: ready() }));
    await applier.apply(() => ({ want: set("up", "base"), ready: ready() }));
    applier.disposeAll();
    assert.deepEqual(log, ["mount base", "dispose base off", "mount base", "dispose base", "dispose up"]);
  } finally {
    console.error = errors;
  }
});
