// Module contract v1 (contracts/modules.json, docs/reference/modules.md). Pins the shape the
// Rust scanner and the TS registry build against, and that every fixture case under
// tests/fixtures/modules/ has an expected outcome in its README. Validating the fixtures is the
// scanners' job (Rust modules/mod.rs tests); the node rules of modules-resolve.mjs are checked here.
import baseTest from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { rel } from "../tools/lib/paths.mjs";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

const skip = missingInputs(import.meta.url, "../tools/release/modules-resolve.mjs");
const { checkPackRules, loadModules, ownsOverlap, ownsPathOk } = skip ? {} : await import("../tools/release/modules-resolve.mjs");
const test = guard(baseTest, skip);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(resolvePath(ROOT, p), "utf8");
const FIXTURES = resolvePath(ROOT, "tests/fixtures/modules");
const contract = JSON.parse(read("contracts/modules.json"));

test("modules.json parses with the v1 id pattern, kinds and limits", () => {
  assert.equal(contract.version, 1);
  assert.equal(contract.idPattern, "^[a-z][a-z0-9-]{0,31}$");
  assert.deepEqual(contract.kinds, ["agent", "content", "surface", "capability"]);
  assert.deepEqual(contract.surfacePlacements, ["workbench", "rail"]);
  assert.deepEqual(contract.packLevels, ["required-hideable", "optional"]);
  for (const k of ["manifestBytes", "traceTerms", "flowModels", "nameChars"]) {
    assert.ok(Number.isInteger(contract.limits[k]) && contract.limits[k] > 0, `limits.${k}`);
  }
  assert.equal(contract.voice.modelIdPattern, "^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,95}$");
  assert.deepEqual(contract.depText.forbiddenChars, ['"', "%"]);
  assert.equal(contract.gateway.baseUrlPrefix, "https://");
  assert.deepEqual(contract.gateway.keyVarForbiddenPrefixes, ["ANTHROPIC_", "CLAUDE_"]);
  assert.equal(contract.launch.maxArguments, 16);
});

test("the id and model id patterns accept and reject as stated", () => {
  const id = new RegExp(contract.idPattern);
  for (const ok of ["a", "acme", "voice-stock", "a".repeat(32)]) assert.match(ok, id);
  for (const bad of ["", "1acme", "Acme", "-a", "a_b", "a".repeat(33)]) assert.doesNotMatch(bad, id);
  const model = new RegExp(contract.voice.modelIdPattern);
  for (const ok of ["m-1", "org/model:q4@v2"]) assert.match(ok, model);
  for (const bad of ["-x", "", "a b"]) assert.doesNotMatch(bad, model);
});

test("the trace boundary matches a whole term only", () => {
  const { boundary, termToken } = contract.trace;
  assert.ok(boundary.includes(termToken));
  const re = new RegExp(boundary.replace(termToken, "acme|a\\.cme"), "iu");
  for (const hit of ["acme", "use ACME now", "a.cme/api", "x-acme-y"]) assert.match(hit, re);
  for (const miss of ["acmes", "bacme", "acme1"]) assert.doesNotMatch(miss, re);
});

test("core declares no agent; codex and claude are their own packs", () => {
  assert.deepEqual(contract.core.filter((m) => m.kind === "agent"), []);
  const id = new RegExp(contract.idPattern);
  for (const m of contract.core) assert.match(m.id, id);
  const path = `${rel("packs")}/codex/pack.json`;
  assert.ok(statSync(resolvePath(ROOT, path)).size <= contract.limits.manifestBytes);
  const pack = JSON.parse(read(path));
  const m = pack.module;
  assert.equal(pack.id, "codex");
  assert.deepEqual([m.id, m.level, m.kind], ["codex", "optional", "agent"]);
  assert.deepEqual(m.when.deps, ["codex"]);
  assert.deepEqual(m.agent.setup, { dep: "codex", order: 1 });
  assert.equal(m.agent.gatewayEnv, undefined);
  assert.deepEqual(m.deps.map((d) => d.id), ["codex"]);
  assert.deepEqual(m.deps[0].update, { package: "@openai/codex" });
  const catalog = JSON.parse(read("contracts/dependencies.json")).deps.map((d) => d.id);
  assert.ok(!catalog.includes("codex"), "codex left the static catalog");
  // A core-level module never drops at runtime (registry.ts dropAbsent), so its dependsOn may name
  // core-level modules only.
  const coreLevel = new Set(contract.core.filter((c) => c.level === "core").map((c) => c.id));
  for (const c of contract.core.filter((c) => c.level === "core")) {
    for (const d of c.dependsOn ?? []) assert.ok(coreLevel.has(d), `${c.id}: core-level dependsOn ${d} is not core-level`);
  }
  assert.ok(!contract.reservedKeys.includes("owns"), "owns is a v1 key now");
  assert.equal(contract.gateway.envKeysFrom, undefined);
  assert.ok(contract.gateway.envAllowlist.length > 0);
  for (const k of contract.gateway.envAllowlist) assert.match(k, /^[A-Z][A-Z0-9_]*$/);
});

test("surface and capability fields have one typed home", () => {
  const cases = [
    ["ok-capability", "required-hideable", "capability", { host: "acme-host" }],
    ["ok-service-capability", "optional", "capability", {}],
  ];
  for (const [folder, level, kind, capability] of cases) {
    const m = JSON.parse(read(`tests/fixtures/modules/${folder}/acme/pack.json`)).module;
    assert.equal(m.level, level);
    assert.equal(m.kind, kind);
    assert.deepEqual(m.capability, capability);
  }
  const m = JSON.parse(read("tests/fixtures/modules/ok-capability/acme/pack.json")).module;
  assert.deepEqual(m.when, { deps: ["voice"], facts: ["characters"], config: ["voice"], packs: ["notes"] });
});

test("the claude pack: optional agent, setup before codex, flow script in its owns, under manifestBytes", () => {
  const file = `${rel("packs")}/claude/pack.json`;
  const bytes = statSync(resolvePath(ROOT, file)).size;
  assert.ok(bytes <= contract.limits.manifestBytes, `claude pack.json is ${bytes} bytes`);
  const m = JSON.parse(read(file)).module;
  assert.deepEqual([m.id, m.level, m.kind], ["claude", "optional", "agent"]);
  assert.deepEqual(m.when.deps, ["claude"]);
  assert.deepEqual(m.agent.setup, { dep: "claude", order: 0 });
  assert.equal(m.agent.flow.script, "tools/claude-sidecar.mjs");
  assert.ok(m.owns.includes(m.agent.flow.script));
  assert.deepEqual(m.deps.map((d) => d.id), ["claude"]);
  assert.deepEqual(m.dependsOn, ["falcon"]);
  assert.ok(!m.owns.some((o) => o.startsWith("tools/falcon")), "the falcon pack owns tools/falcon/");
  assert.deepEqual(m.trace, ["claude-agent-sdk", "@anthropic-ai", "claude-sidecar", "claude\\.exe"]);
  for (const o of m.owns) assert.ok(existsSync(resolvePath(ROOT, o)), `owns ${o} is not in the tree`);
  const catalog = JSON.parse(read("contracts/dependencies.json")).deps.map((d) => d.id);
  assert.ok(!catalog.includes("claude") && !catalog.includes("falcon"), "claude and falcon left the static catalog");
});

test("Gemini and Pi packs declare bounded raw launches using existing dependency IDs", () => {
  const dependencies = JSON.parse(read("contracts/dependencies.json")).deps;
  const executable = new RegExp(contract.launch.executablePattern);
  const argument = new RegExp(contract.launch.argumentPattern);
  for (const id of ["gemini", "pi"]) {
    const path = `${rel("packs")}/${id}/pack.json`;
    assert.ok(statSync(resolvePath(ROOT, path)).size <= contract.limits.manifestBytes);
    const m = JSON.parse(read(path)).module;
    assert.deepEqual([m.id, m.level, m.kind], [id, "optional", "agent"]);
    assert.deepEqual(m.when.deps, [id]);
    assert.ok(dependencies.some((dep) => dep.id === id && dep.probe.kind === "exe"));
    assert.deepEqual(m.agent.rows, ["raw"]);
    assert.equal(m.agent.launch.executable, id);
    assert.match(m.agent.launch.executable, executable);
    assert.ok(m.agent.launch.args.length <= contract.launch.maxArguments);
    for (const arg of m.agent.launch.args) assert.match(arg, argument);
  }
  for (const bad of ["../gemini", "C:\\gemini.exe", "gemini;whoami", "pi | more", "$(whoami)"]) {
    assert.doesNotMatch(bad, executable);
  }
  for (const bad of ["", "--mode;whoami", "$(whoami)", "a & b", "`whoami`", "a|b"]) {
    assert.doesNotMatch(bad, argument);
  }
});

test("Local pack declares its existing script as an owned raw launch", () => {
  const file = `${rel("packs")}/local/pack.json`;
  assert.ok(statSync(resolvePath(ROOT, file)).size <= contract.limits.manifestBytes);
  const m = JSON.parse(read(file)).module;
  assert.deepEqual([m.id, m.level, m.kind], ["local", "optional", "agent"]);
  assert.deepEqual(m.when.deps, ["pwsh", "node"]);
  assert.deepEqual(m.agent.rows, ["raw"]);
  assert.equal(m.agent.launch.executable, "pwsh");
  assert.deepEqual(m.agent.launch.args.slice(-2), ["-File", "tools/local/local-tab.ps1"]);
  assert.ok(m.owns.some((o) => o.endsWith("/") && m.agent.launch.args.at(-1).startsWith(o)));
  assert.ok(existsSync(resolvePath(ROOT, m.agent.launch.args.at(-1))));

  const outside = JSON.parse(read("tests/fixtures/modules/launch-script-outside.json"));
  assert.equal(outside.agent.launch.args[0], "-File");
  assert.ok(!outside.owns.some((o) => outside.agent.launch.args[1].startsWith(o)));
});

// The node half of "the Rust scanner and modules-resolve.mjs reach the same outcome": the rules
// modules-resolve.mjs checks (owns, agent.flow.script, agent.gatewayEnv) accept every ok-* case and
// reject each case built for them; the shipped packs pass.
test("modules-resolve.mjs pack rules agree with the fixtures and accept the shipped packs", () => {
  const nodeRules = { "bad-gateway-env": "agent.gatewayEnv Is Not a Pack Key", "bad-flow-script": "Is Not One of Its owns Files", "bad-owns-dotdot": "Is Not a Repo-Relative Path", "bad-owns-overlap": "Overlaps Module" };
  for (const c of readdirSync(FIXTURES).filter((n) => statSync(join(FIXTURES, n)).isDirectory())) {
    const broken = checkPackRules(loadModules({ packsRoot: join(FIXTURES, c) }));
    if (c.startsWith("ok-")) assert.deepEqual(broken, [], c);
    else if (nodeRules[c]) {
      assert.deepEqual(broken.map((b) => b.folder), readdirSync(join(FIXTURES, c)).sort(), c);
      for (const b of broken) assert.ok(b.reason.includes(nodeRules[c]), `${c}: ${b.reason}`);
    }
  }
  assert.deepEqual(checkPackRules(loadModules()), []);
  assert.ok(ownsPathOk("tools/falcon/") && !ownsPathOk("../x") && !ownsPathOk("/x") && !ownsPathOk("C:/x"));
  assert.ok(ownsOverlap("tools/x/", "tools/x/y.mjs") && !ownsOverlap("tools/x/", "tools/xy.mjs"));
  assert.ok(ownsOverlap("Tools/X/", "tools/x/") && ownsOverlap("TOOLS/x/y.mjs", "tools/X/"), "owns overlap folds case");
});

test("contract lists the gateway env and icon rules, and the resolver enforces each", () => {
  assert.equal(contract.pack.noGatewayEnv, true);
  assert.equal(contract.pack.artIconIsPng, true);
  const root = mkdtempSync(join(tmpdir(), "vidar-icon-"));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    mkdirSync(join(root, "acme", "art"), { recursive: true });
    writeFileSync(join(root, "acme", "art", "ok.png"), png);
    writeFileSync(join(root, "acme", "art", "bad.png"), "not a png at all");
    const mod = (agent) => ({ source: "pack", folder: "acme", packRoot: root, id: "acme", owns: [], agent });
    assert.deepEqual(checkPackRules([mod({ art: { icon: "art/ok.png" } })]), []);
    const reasons = (icon) => checkPackRules([mod({ art: { icon } })]).map((b) => b.reason);
    assert.deepEqual(reasons("art/none.png"), ["Icon art/none.png Is Missing"]);
    assert.deepEqual(reasons("art/bad.png"), ["Icon art/bad.png Is Not A PNG"]);
    assert.deepEqual(reasons("../x.png"), ["Icon ../x.png Is Not A Path Inside The Pack"]);
    assert.deepEqual(checkPackRules([mod({ gatewayEnv: { A: "b" } })]).map((b) => b.reason), ["agent.gatewayEnv Is Not a Pack Key"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every fixture case has a README row and only ok-* cases accept", () => {
  const rows = new Map();
  for (const line of readFileSync(join(FIXTURES, "README.md"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\|\s*([a-z0-9-]+)\s*\|\s*(accept|reject)\s*\|/);
    if (m) rows.set(m[1], m[2]);
  }
  const cases = readdirSync(FIXTURES).filter((n) => statSync(join(FIXTURES, n)).isDirectory());
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.ok(rows.has(c), `${c}: no README row`);
    assert.equal(rows.get(c), c.startsWith("ok-") ? "accept" : "reject", `${c}: outcome`);
  }
  for (const r of rows.keys()) assert.ok(cases.includes(r), `README row ${r} has no folder`);
  // Each case is a packs root; only bad-oversize may exceed the manifest limit.
  for (const c of cases) {
    for (const pack of readdirSync(join(FIXTURES, c))) {
      const bytes = statSync(join(FIXTURES, c, pack, "pack.json")).size;
      assert.equal(bytes > contract.limits.manifestBytes, c === "bad-oversize", `${c}/${pack}: ${bytes} bytes`);
    }
  }
});
