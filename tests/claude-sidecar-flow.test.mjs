// A Flow Claude stage runs on its node's vault home (flow/claude.rs builds the argv):
// `--flow --profile bare --root <root> --home <home> [--payload] [--set-plugin] [--mcp-file]`, the same mapping a Bare
// tab gets (claude-sidecar-bare.mjs bareOptions), without Falcon. The stage keeps `canUseTool` and the
// `--permission-mode` it was given; the old `--flow-payload` and `--mcp-servers` args are gone, and an argv that still
// carries them is IGNORED like any unknown arg (the sidecar reads only the flags it knows).
//
// Offline: the sidecar runs as a child against a stub SDK that records the options it was given, laid out as a
// Vidar root in a temp dir with USERPROFILE/HOME inside it. Nothing outside the temp dir is read or written.
//
//   node --test tests\claude-sidecar-flow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bareModule from "../tools/claude-sidecar-bare.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SIDECAR_FILES = ["claude-sidecar.mjs", "claude-sidecar-shrink.mjs", "claude-sidecar-statusline.mjs", "claude-sidecar-seed.mjs", "claude-sidecar-bare.mjs", "claude-sidecar-recover.mjs", "claude-sidecar-ledger.mjs", "claude-sidecar-trust.mjs"];

const STUB = `
import { writeFileSync } from "node:fs";
export async function getSessionMessages() { return []; }
export function query({ options }) {
  writeFileSync(process.env.STUB_OPTIONS, JSON.stringify({ ...options, hasCanUseTool: typeof options.canUseTool === "function" }));
  async function* run() { yield { type: "system", subtype: "init", session_id: "s", permissionMode: "auto" }; }
  const it = run();
  return {
    [Symbol.asyncIterator]: () => it,
    initializationResult: async () => ({ models: [] }),
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
  };
}
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vidar-sidecar-flow-"));
  const pkg = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-stub", type: "module", main: "index.mjs", exports: "./index.mjs" }));
  writeFileSync(join(pkg, "index.mjs"), STUB);
  mkdirSync(join(root, "tools"));
  for (const f of SIDECAR_FILES) copyFileSync(join(REPO, "tools", f), join(root, "tools", f));
  mkdirSync(join(root, "profiles", "bare"), { recursive: true });
  for (const f of ["claude.json", "payload.md"]) copyFileSync(join(REPO, "profiles", "bare", f), join(root, "profiles", "bare", f));
  for (const p of ["vidar-app", "gate"]) mkdirSync(join(root, "plugins", p), { recursive: true });
  writeFileSync(join(root, "vidar.json"), JSON.stringify({ statuslineMirror: false }));
  mkdirSync(join(root, "userprofile"));
  const home = join(root, "agent-home");
  mkdirSync(join(home, "claude-config"), { recursive: true });
  return { root, home };
}

function run(f, extra = [], { mode = "auto", home = true } = {}) {
  const { root } = f;
  const userprofile = join(root, "userprofile");
  const args = [join(root, "tools", "claude-sidecar.mjs"), "--cwd", root, "--model", "claude-opus-5-5", "--permission-mode", mode,
    "--claude", join(root, "claude.exe"), ...extra];
  const env = { ...process.env, USERPROFILE: userprofile, HOME: userprofile, STUB_OPTIONS: join(root, "options.json") };
  delete env.ANTHROPIC_MODEL;
  delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`sidecar did not exit\n${stderr}`)); }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const flowArgs = (f) => ["--flow", "--profile", "bare", "--root", f.root, "--home", f.home];
const options = (root) => JSON.parse(readFileSync(join(root, "options.json"), "utf8"));

test("a Flow stage maps the profile onto the SDK options and keeps canUseTool and its mode", async () => {
  const f = fixture();
  try {
    const r = await run(f, flowArgs(f));
    assert.equal(r.code, 0, `sidecar exited ${r.code}\n${r.stderr}`);
    const o = options(f.root);
    const payload = readFileSync(join(f.root, "profiles", "bare", "payload.md"), "utf8");
    assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: payload });
    assert.deepEqual(o.settingSources, ["user"]);
    assert.equal(o.hasCanUseTool, true);
    assert.equal(o.permissionMode, "auto");
    assert.equal(o.model, "claude-opus-5-5");
    assert.equal(o.mcpServers, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("--permission-mode wins over a home defaultMode of plan or bypass", async () => {
  const f = fixture();
  try {
    for (const defaultMode of ["plan", "bypassPermissions"]) {
      writeFileSync(join(f.home, "claude-config", "settings.json"), JSON.stringify({ permissions: { defaultMode } }));
      const r = await run(f, flowArgs(f), { mode: "default" });
      assert.equal(r.code, 0, `sidecar exited ${r.code}\n${r.stderr}`);
      const o = options(f.root);
      assert.equal(o.permissionMode, "default", `home ${defaultMode} must not replace the launch mode`);
      assert.deepEqual(o.settingSources, ["user"]);
      assert.equal(o.hasCanUseTool, true);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a stage's --mcp-file becomes one strict MCP set", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, "layer"));
    const file = join(f.home, "layer", "mcp-0123456789ab.json");
    const servers = { plugin_vidar_drive: { command: "node", args: ["drive.mjs"] }, proxy: { type: "http", url: "http://127.0.0.1:8765/mcp" } };
    writeFileSync(file, JSON.stringify({ mcpServers: servers }));
    const r = await run(f, [...flowArgs(f), "--mcp-file", file]);
    assert.equal(r.code, 0, `sidecar exited ${r.code}\n${r.stderr}`);
    const o = options(f.root);
    assert.deepEqual(o.mcpServers, servers);
    assert.equal(o.strictMcpConfig, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an argv still carrying --flow-payload or --mcp-servers has them ignored", async () => {
  const f = fixture();
  try {
    const r = await run(f, [...flowArgs(f), "--flow-payload", "bare", "--mcp-servers", JSON.stringify({ k: { type: "stdio", command: "node" } })]);
    assert.equal(r.code, 0, `sidecar exited ${r.code}\n${r.stderr}`);
    assert.equal(options(f.root).mcpServers, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("--flow needs a profile; a profile without --flow or --falcon is still refused", async () => {
  const f = fixture();
  try {
    let r = await run(f, ["--flow"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /a Flow stage needs a launch profile/);
    r = await run(f, ["--profile", "bare", "--root", f.root, "--home", f.home]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /a launch profile needs --falcon/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the old Flow mappings are gone from the bare module", () => {
  for (const name of ["flowOptions", "flowPayload", "flowMcpServers"]) assert.equal(bareModule[name], undefined, name);
});
