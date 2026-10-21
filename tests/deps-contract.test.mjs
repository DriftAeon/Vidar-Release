// Cross-language contract: contracts\dependencies.json is the dependency catalog.
// Rust reads each entry's probe through include_str! (src-tauri\src\deps.rs), the frontend reads
// the copy fields through a JSON import (src\deps\state.ts), and the roster's `requires` ids join
// against it. All three must agree on one file and one id set.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packsDir } from "../tools/lib/release-layout.mjs";
import { buildSetupPrompt, pickSetupRunner } from "../src/deps/setup-prompt.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTRACT = resolve(ROOT, "contracts/dependencies.json");
const catalog = JSON.parse(readFileSync(CONTRACT, "utf8"));
const PROBE_KINDS = ["exe", "vidar", "config", "env", "falcon"];

test("Rust and the frontend read the same dependency catalog", () => {
  const rustFile = "src-tauri/src/deps.rs";
  const rust = readFileSync(resolve(ROOT, rustFile), "utf8");
  const inc = rust.match(/include_str!\(\s*"([^"]*dependencies\.json)"\s*\)/);
  assert.ok(inc, `${rustFile} has no include_str! of dependencies.json`);
  assert.equal(resolve(dirname(resolve(ROOT, rustFile)), inc[1]), CONTRACT);

  const tsFile = "src/deps/state.ts";
  const ts = readFileSync(resolve(ROOT, tsFile), "utf8");
  const imp = ts.match(/from\s+["']([^"']*dependencies\.json)["']/);
  assert.ok(imp, `${tsFile} does not import dependencies.json`);
  assert.equal(resolve(dirname(resolve(ROOT, tsFile)), imp[1]), CONTRACT);
});

test("catalog ids are unique and every probe kind is one Rust knows", () => {
  const ids = catalog.deps.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(",")}`);
  for (const d of catalog.deps) {
    assert.ok(PROBE_KINDS.includes(d.probe.kind), `${d.id}: unknown probe kind ${d.probe.kind}`);
    if (d.probe.minVersion !== undefined) {
      // Rust (deps.rs Probe::Exe) deserializes minVersion on exe probes only; elsewhere it is ignored.
      assert.equal(d.probe.kind, "exe", `${d.id}: minVersion on a ${d.probe.kind} probe`);
      assert.match(d.probe.minVersion, /^\d+\.\d+(\.\d+)?$/, `${d.id}: minVersion ${d.probe.minVersion}`);
    }
  }
});

// roster.ts does not load under node (value import of the "../panels/sessions" directory:
// ERR_UNSUPPORTED_DIR_IMPORT), so the BUILTIN_AGENTS literal and the gateway row template
// (gatewayRows) are parsed as text instead. Catalog ids = the static catalog plus every pack's deps[].
test("every requires id on BUILTIN_AGENTS and the gateway template exists in the catalog", () => {
  const roster = readFileSync(resolve(ROOT, "src/launcher/roster.ts"), "utf8");
  const start = roster.indexOf("export const BUILTIN_AGENTS");
  assert.ok(start >= 0, "roster.ts has no BUILTIN_AGENTS");
  const end = roster.indexOf("\n];", start);
  assert.ok(end > start, "BUILTIN_AGENTS literal not closed by a line-leading ];");
  const tStart = roster.indexOf("function gatewayRows");
  assert.ok(tStart >= 0, "roster.ts has no gatewayRows template");
  const tEnd = roster.indexOf("\n}", tStart);
  assert.ok(tEnd > tStart, "gatewayRows not closed by a line-leading }");
  const body = roster.slice(start, end) + roster.slice(tStart, tEnd);
  const lists = [...body.matchAll(/requires:\s*\[([^\]]*)\]/g)];
  assert.ok(lists.length > 0, "no requires on any BUILTIN_AGENTS row: the gating has nothing to check");
  const known = new Set(catalog.deps.map((d) => d.id));
  const packs = resolve(ROOT, "content/packs");
  for (const dir of readdirSync(packs)) {
    const file = resolve(packs, dir, "pack.json");
    if (!existsSync(file)) continue;
    for (const d of JSON.parse(readFileSync(file, "utf8")).module?.deps ?? []) known.add(d.id);
  }
  for (const [, list] of lists) {
    for (const [, id] of list.matchAll(/["']([^"']+)["']/g)) {
      assert.ok(known.has(id), `requires "${id}" is not a catalog id`);
    }
  }
});

// A detected `claude` may be the npm `claude.cmd` shim: pwsh hands the prompt to cmd.exe, which
// re-parses it. A `"` there ends the argument and a `%` expands a variable, so catalog text that
// reaches buildSetupPrompt must carry neither; the pwsh single quotes do not protect this hop.
// Both agents are packs (registry order by folder: claude, codex); setup.order, not registry order,
// puts Claude ahead of Codex. The modules are the real pack declarations, listed Codex first here.
test("setup picks Claude before Codex by agent.setup.order, whatever the registry order", () => {
  const pack = (id) => JSON.parse(readFileSync(resolve(packsDir(ROOT), id, "pack.json"), "utf8")).module;
  const modules = [pack("codex"), pack("claude")];
  assert.deepEqual(modules.map((m) => m.id), ["codex", "claude"]);
  const report = (claudeFound) => ({ deps: [{ id: "codex", found: true, location: "C:\\bin\\codex.cmd" }, { id: "claude", found: claudeFound, location: claudeFound ? "C:\\bin\\claude.exe" : undefined }] });
  assert.deepEqual(pickSetupRunner(modules, report(true)), { id: "claude", exe: "C:\\bin\\claude.exe" });
  assert.deepEqual(pickSetupRunner(modules, report(false)), { id: "codex", exe: "C:\\bin\\codex.cmd" });
  const unordered = modules.map((m) => ({ ...m, agent: { setup: { dep: m.agent.setup.dep } } }));
  assert.equal(pickSetupRunner(unordered, report(true)).id, "codex", "without order, registry order decides");
});

test("the setup prompt over every catalog entry survives cmd.exe parsing", () => {
  const prompt = buildSetupPrompt(catalog.deps);
  assert.doesNotMatch(prompt, /"/, "setup prompt contains a double quote");
  assert.doesNotMatch(prompt, /%/, "setup prompt contains a percent sign");
});
