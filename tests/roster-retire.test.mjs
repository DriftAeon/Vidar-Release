// Retire: the Bare rows lead Claude and Codex; the plain rows are an escape hatch that is off until
// Settings › Agents turns it on. vidar.json shadows of a retired row migrate onto its Bare successor
// in memory (config-agents.ts). Pure rows only: IPC and createSession are stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: {
  "panels/sessions": "export async function createSession() { return 's1'; } export function hasArmedAstra() { return false; }",
  "tab-names": "export function mintTabName() { return 'Tab'; }",
  "capabilities/registry": "export function use() { return null; }",
} });

const { BUILTIN_AGENTS, PLAIN_KEYS, builtinAgents, rosterView, setPlainRowsSource, setRoster } = await import("../src/launcher/roster.ts");
const { orderRoots, setPrimaryRootSource, setRootOrderSource, shownRootsOf, shownVariantsOf } = await import("../src/launcher/roster-shown.ts");
const { migrateOverlay, overlayAgents } = await import("../src/config-agents.ts");

const keys = (rows) => rows.map((r) => r.key);

function resolve(rows) {
  const warned = [];
  const was = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try { setRoster(rows); } finally { console.warn = was; }
  return { ...rosterView(), warned };
}

test("builtins through resolveAgents: zero console.warn, plain rows hidden by default", () => {
  setPlainRowsSource(() => false);
  const { launcherTypes, variantsOf, warned } = resolve(builtinAgents());
  assert.deepEqual(warned, []);
  assert.ok(keys(launcherTypes).includes("claude-bare") && keys(launcherTypes).includes("codex-bare"));
  for (const k of PLAIN_KEYS) assert.ok(!keys(builtinAgents()).includes(k), `${k} hidden`);
  assert.deepEqual(variantsOf.get(launcherTypes.find((t) => t.key === "claude-bare")).map((v) => v.key), ["claude-rendered-bare"]);
  assert.deepEqual(variantsOf.get(launcherTypes.find((t) => t.key === "codex-bare")).map((v) => v.key), ["codex-rendered-bare", "astra"]);
});

test("builtins with plain on: still zero warnings; each Rendered variant hangs off its own kind of root", () => {
  setPlainRowsSource(() => true);
  try {
    const { launcherTypes, variantsOf, warned } = resolve(builtinAgents());
    assert.deepEqual(warned, []);
    const of = (key) => variantsOf.get(launcherTypes.find((t) => t.key === key)).map((v) => v.key);
    assert.deepEqual(of("claude"), ["claude-rendered"]);
    assert.deepEqual(of("claude-bare"), ["claude-rendered-bare"]);
    assert.deepEqual(of("codex"), ["codex-rendered"]);
    assert.deepEqual(of("codex-bare"), ["codex-rendered-bare", "astra"], "Astra stays on the Bare root");
    assert.deepEqual(launcherTypes.filter((t) => PLAIN_KEYS.has(t.key)).map((t) => t.label), ["Plain", "Plain"]);
    assert.deepEqual(BUILTIN_AGENTS.filter((a) => PLAIN_KEYS.has(a.key) && a.under).map((a) => a.label), ["Plain Rendered", "Plain Rendered"]);
  } finally {
    setPlainRowsSource(() => false);
  }
});

test("every profiled variant has a profiled root; no claude or codex root lacks a profile (roles excepted)", () => {
  setPlainRowsSource(() => false);
  const rows = builtinAgents();
  const roots = rows.filter((r) => !r.under);
  for (const v of rows.filter((r) => r.under && r.profile)) {
    assert.ok(roots.some((r) => r.id === v.under && r.profile), `${v.key} has a profiled root`);
  }
  for (const r of roots.filter((x) => (x.id === "claude" || x.id === "codex") && !x.role)) {
    assert.ok(r.profile, `${r.key} carries a profile`);
  }
});

test("plain off hides the plain rows; on shows them after the Bare ones of the same kind", () => {
  const off = builtinAgents();
  assert.ok(!off.some((r) => PLAIN_KEYS.has(r.key)));
  setPlainRowsSource(() => true);
  try {
    const on = builtinAgents();
    assert.deepEqual(keys(on).filter((k) => PLAIN_KEYS.has(k)), ["claude", "claude-rendered", "codex", "codex-rendered"]);
    setRootOrderSource(() => undefined);
    setPrimaryRootSource(() => null);
    const roots = shownRootsOf(on.filter((r) => !r.under), () => true);
    assert.deepEqual(keys(roots).slice(0, 4), ["claude-bare", "claude", "codex-bare", "codex"]);
  } finally {
    setPlainRowsSource(() => false);
  }
});

test("a saved order [codex, claude] ranks codex-bare first; a saved order naming the Bare keys keeps plain apart", () => {
  setPlainRowsSource(() => true);
  try {
    const roots = builtinAgents().filter((r) => !r.under);
    assert.deepEqual(keys(orderRoots(roots, ["codex", "claude"])).slice(0, 2), ["codex-bare", "claude-bare"]);
    assert.deepEqual(keys(orderRoots(roots, ["claude-bare", "codex-bare", "claude", "codex"])).slice(0, 4), ["claude-bare", "codex-bare", "claude", "codex"]);
  } finally {
    setPlainRowsSource(() => false);
  }
});

test("Astra needs desks: the codex set (no desks pack) hides it, the full set shows it", () => {
  setPlainRowsSource(() => false);
  const { launcherTypes, variantsOf } = resolve(builtinAgents());
  const codex = launcherTypes.find((t) => t.key === "codex-bare");
  const shown = (have) => shownVariantsOf(codex, launcherTypes, variantsOf, (id) => have.includes(id)).map((v) => v.key);
  assert.deepEqual(shown(["codex", "node"]), ["codex-rendered-bare"], "codex set: no desks");
  assert.deepEqual(shown(["codex", "node", "desks"]), ["codex-rendered-bare", "astra"]);
});

const BUILT = builtinAgents();
const warnsOf = (overlay) => { const w = []; overlayAgents(BUILT, overlay, w); return w; };
const row = (rows, key) => rows.find((r) => r.key === key);

test("shadow migration: claude-rendered carries model, effort, cwd to claude-rendered-bare; the rest is dropped with one warning", () => {
  const overlay = [{ key: "claude-rendered", model: "opus", effort: "high", cwd: "C:\\w", shell: "pwsh", args: ["-x"], rules: ["a"], body: "terminal", profile: "other" }];
  const rows = overlayAgents(BUILT, overlay);
  const r = row(rows, "claude-rendered-bare");
  assert.equal(r.model, "opus", "the Fable guard rides over");
  assert.equal(r.effort, "high");
  assert.equal(r.cwd, "C:\\w");
  assert.equal(r.profile, "bare");
  assert.equal(r.body, "rendered");
  for (const f of ["shell", "args", "rules"]) assert.equal(r[f], undefined, f);
  assert.equal(rows.length, BUILT.length, "no row appended");
  const w = warnsOf(overlay);
  assert.equal(w.length, 1);
  assert.match(w[0], /claude-rendered.*claude-rendered-bare.*shell, args, rules, body, profile/);
});

test("shadow migration: claude, codex and codex-rendered land on their Bare successors", () => {
  for (const [from, to] of [["claude", "claude-bare"], ["codex", "codex-bare"], ["codex-rendered", "codex-rendered-bare"]]) {
    const rows = overlayAgents(BUILT, [{ key: from, model: "m1", args: ["-NoExit"] }]);
    assert.equal(row(rows, to).model, "m1", to);
    assert.equal(row(rows, to).args, undefined, `${to}: args dropped`);
    assert.equal(rows.length, BUILT.length);
  }
});

test("shadow migration: a retired entry's disabled does not take the Bare row with it", () => {
  const rows = overlayAgents(BUILT, [{ key: "claude", disabled: true }]);
  assert.ok(row(rows, "claude-bare"));
  assert.equal(migrateOverlay([{ key: "claude", disabled: true }])[0].disabled, undefined);
});

test("shadow migration: key-less legacy entries", () => {
  const cases = [
    [{ id: "claude", model: "m" }, "claude-bare"],
    [{ id: "claude", label: "Claude", model: "m" }, "claude-bare"],
    [{ id: "codex", model: "m" }, "codex-bare"],
    [{ id: "codex", under: "codex", label: "Rendered", model: "m" }, "codex-rendered-bare"],
    [{ id: "claude", under: "claude", label: "Rendered", model: "m" }, "claude-rendered-bare"],
  ];
  for (const [entry, to] of cases) {
    const rows = overlayAgents(BUILT, [entry]);
    assert.equal(row(rows, to).model, "m", to);
    assert.equal(rows.length, BUILT.length, `${to}: no custom row appended`);
  }
});

test("shadow migration: a user-made row stays as it is", () => {
  const rows = overlayAgents(BUILT, [{ id: "blender", label: "Blender", args: ["-NoExit", "-Command", "blender"] }, { id: "claude", label: "Claude Work", args: ["-NoExit", "-Command", "claude"] }]);
  assert.equal(rows.length, BUILT.length + 2);
  assert.deepEqual(rows.at(-2).args, ["-NoExit", "-Command", "blender"]);
  assert.equal(rows.at(-1).label, "Claude Work");
  assert.deepEqual(warnsOf([{ id: "blender", label: "Blender" }]), []);
});

test("shadow migration: a clean carry (model only) warns nothing", () => {
  assert.deepEqual(warnsOf([{ key: "claude-rendered", model: "opus" }]), []);
});
