// Cross-language contract (voice slots plan §1): contracts/voice-slots.json names the slots and
// the tokens each may use. Rust validates every manifest against it (src-tauri/src/voice_slots/
// manifest.rs, include_str!); this pins the stock pack to the same file, so a slot or token
// renamed on one side fails here instead of as a broken slot at runtime.
import baseTest from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

const skip = missingInputs(import.meta.url, "../tools/release/modules-resolve.mjs");
const { cutPaths, resolveSet, shippedPaths } = skip ? {} : await import("../tools/release/modules-resolve.mjs");
const test = guard(baseTest, skip);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
const contract = read("contracts/voice-slots.json");
const PACKS = ["voice-stock", "claude"];

const tokensOf = (s) => [...s.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);

test("listed stock and Claude manifests use the voice-slots contract", () => {
  for (const id of PACKS) {
    const pack = read(`content/packs/${id}/pack.json`);
    const listed = Object.entries(pack.slots).flatMap(([slot, files]) => files.map((f) => [slot, f]));
    assert.ok(listed.length > 0, `${id} lists no adapters`);
    for (const [slot, file] of listed) {
      const m = read(`content/packs/${id}/${file}`);
      assert.ok(contract.slots[slot], `pack.json lists unknown slot ${slot}`);
      assert.equal(m.slot, slot, `${file} is listed under ${slot}`);
      const own = new Set([...contract.slots[slot].tokens, ...contract.roots]);
      const life = new Set([...own, ...contract.lifecycle.tokens]);
      const check = (run, allowed, what) => {
        if (!run) return;
        const cmd = run.command.startsWith(`{${contract.pathCommand}`) ? [] : tokensOf(run.command);
        for (const t of [...cmd, ...run.args.flatMap(tokensOf)]) {
          assert.ok(allowed.has(t), `${file} ${what}: {${t}} is not a ${slot} token`);
        }
      };
      check(m.run, own, "run");
      for (const k of contract.lifecycle.commands) check(m[k], life, k);
      for (const t of tokensOf(m.fill ?? "")) assert.ok(contract.fillTokens.includes(t), `${file} fill: {${t}}`);
    }
  }
});

test("Claude rewrite ships with Claude and its former paths leave the no-Claude set", () => {
  const stock = read("content/packs/voice-stock/pack.json");
  const claude = read("content/packs/claude/pack.json");
  assert.ok(!stock.slots.rewrite.includes("voice/claude-p.json"));
  assert.ok(claude.slots.rewrite.includes("voice/claude-p.json"));
  const manifest = read("content/packs/claude/voice/claude-p.json");
  assert.equal(manifest.run.args[0], "{pack}/voice/rewrite_claude.py");
  const levels = read("contracts/effort-levels.json");
  assert.ok(manifest.efforts.length > 0 && manifest.efforts.every((e) => levels.includes(e)), "claude-p efforts must be a subset of contracts/effort-levels.json");
  const codexPack = read("content/packs/codex/pack.json");
  assert.ok(codexPack.slots.rewrite.includes("voice/codex-exec.json"));
  const codexManifest = read("content/packs/codex/voice/codex-exec.json");
  assert.equal(codexManifest.run.args[0], "{pack}/voice/rewrite_codex.py");
  assert.ok(codexManifest.efforts.length > 0 && codexManifest.efforts.every((e) => levels.includes(e)), "codex-exec efforts must be a subset of contracts/effort-levels.json");
  assert.ok(contract.slots.rewrite.tokens.includes("effort"));
  assert.ok(readFileSync(resolve(ROOT, "content/packs/claude/voice/rewrite_claude.py"), "utf8").includes("from rewrite_prompt import SYSTEM_PROMPT"));

  const full = resolveSet("full");
  const codex = resolveSet("codex");
  assert.ok(full.included.includes("claude"));
  assert.ok(!codex.included.includes("claude"));
  const cut = cutPaths(codex);
  for (const path of [
    "content/packs/claude/",
    "plugins/gate/",
    "plugins/vidar-app/",
  ]) assert.ok(cut.includes(path), `${path} is not cut from codex`);
  const codexShip = shippedPaths("codex");
  const fullShip = shippedPaths("full");
  for (const gone of ["plugins/gate/hooks/hooks.json", "plugins/vidar-app/.mcp.json", "content/packs/claude/voice/claude-p.json", "content/packs/claude/voice/rewrite_claude.py"]) {
    assert.ok(!codexShip.includes(gone), `${gone} ships in codex`);
    assert.ok(fullShip.includes(gone), `${gone} is missing from full`);
  }
});

// The rewrite adapter's warm/status JSON keys cross Python -> speak.py -> speak.rs -> speak.ts:
// rewrite_openai.py declares them, speak.ts types them, speak.rs passes the JSON through and
// judges only `ok`, which speak.py sets.
test("rewrite status keys agree across rewrite_openai.py, speak.py, speak.rs and speak.ts", () => {
  const text = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
  const py = text("content/local-voice/rewrite_openai.py");
  const speakPy = text("content/local-voice/speak.py");
  const rs = text("src-tauri/src/speak.rs");
  const ts = text("src/panels/speak.ts");
  const tuple = (name) => {
    const m = py.match(new RegExp(`^${name} = \\(([^)]*)\\)`, "m"));
    assert.ok(m, `rewrite_openai.py has no ${name}`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const warm = tuple("WARM_KEYS");
  const status = tuple("STATUS_KEYS");
  for (const k of warm) assert.match(py, new RegExp(`result\\["${k}"\\]|\\{"${k}":`), `warm() does not write ${k}`);
  for (const k of status) assert.ok(py.includes(`json.dumps({"${k}":`), `--status does not print ${k}`);
  const typeBody = (name) => {
    const m = ts.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\};`));
    assert.ok(m, `speak.ts has no ${name}`);
    return m[1];
  };
  const arm = typeBody("ArmResult");
  for (const k of warm) assert.match(arm, new RegExp(`\\b${k}\\?:`), `ArmResult lacks ${k}`);
  const rewriteStatus = ts.slice(ts.indexOf("export type SpeakStatusResult")).match(/^[^\n]*\n[^\n]*rewrite\?: \{([^}]*)\}/);
  assert.ok(rewriteStatus, "SpeakStatusResult lacks rewrite");
  for (const k of status) assert.match(rewriteStatus[1], new RegExp(`\\b${k}\\?:`), `SpeakStatusResult.rewrite lacks ${k}`);
  assert.match(speakPy, /result\["rewrite"\] = run_lifecycle\(slot, "status"/, "speak.py nests the rewrite status under rewrite");
  assert.match(speakPy, /rewrite_seconds=secs/, "speak.py reports rewrite_seconds");
  assert.match(typeBody("SpeakResult"), /\brewrite_seconds\?:/, "SpeakResult lacks rewrite_seconds");
  assert.ok(rs.includes('get("ok")') && /"ok": True/.test(speakPy), "speak.rs judges ok, which speak.py sets");
});
