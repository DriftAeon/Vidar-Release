// Reuse the existing offline sidecar test pattern: a real Node child and a stub SDK.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("prepared gateway sidecar applies fence/plugin/prompt and redacts SDK output", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidar-gateway-sidecar-"));
  for (const file of ["claude-sidecar.mjs", "claude-sidecar-shrink.mjs", "claude-sidecar-statusline.mjs", "claude-sidecar-seed.mjs", "claude-sidecar-bare.mjs", "claude-sidecar-recover.mjs", "claude-sidecar-ledger.mjs", "claude-sidecar-trust.mjs"]) {
    copyFileSync(new URL(`../tools/${file}`, import.meta.url), join(dir, file));
  }
  const pkg = join(dir, "node_modules/@anthropic-ai/claude-agent-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  writeFileSync(join(pkg, "index.mjs"), `
    export async function getSessionMessages() { return []; }
    export function query({ options }) {
      return {
        initializationResult: async () => ({ models: [] }),
        async *[Symbol.asyncIterator]() {
          yield { type: "fixture", settings: options.settings, plugins: options.plugins,
            systemPrompt: options.systemPrompt, extraArgs: options.extraArgs,
            model: options.model, leaked: process.env.ANTHROPIC_AUTH_TOKEN };
        }
      };
    }
  `);
  const dump = join(dir, "dump.jsonl");
  const rules = join(dir, "fixture-rules.md");
  writeFileSync(rules, "Fixture built rules");
  const fixtureKey = 'fixture-token-"quoted"';
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, HOMEPATH: dir,
    ANTHROPIC_AUTH_TOKEN: fixtureKey, VIDAR_SIDECAR_DUMP: dump };
  const args = [join(dir, "claude-sidecar.mjs"), "--cwd", dir, "--model", "fixture-model",
    "--vendor-settings", "fixture.settings.json", "--vendor-plugin", "fixture-plugin",
    "--vendor-prompt", "Fixture vendor prompt", "--rules-file", rules];
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split(/\r?\n/).map((s) => JSON.parse(s));
  const fixture = messages.find((m) => m.type === "fixture");
  assert.deepEqual(fixture.plugins, [{ type: "local", path: "fixture-plugin" }]);
  assert.equal(fixture.settings, "fixture.settings.json");
  assert.equal(fixture.model, "fixture-model");
  assert.deepEqual(fixture.systemPrompt, { type: "preset", preset: "claude_code", append: "Fixture vendor prompt\n\nFixture built rules" });
  // systemPrompt.append would override the CLI's rules file, so the rules ride in the joined append.
  assert.equal(fixture.extraArgs, undefined);
  assert.equal(fixture.leaked, "[Redacted]");
  assert.equal(readFileSync(dump, "utf8").includes("fixture-token"), false);
});
