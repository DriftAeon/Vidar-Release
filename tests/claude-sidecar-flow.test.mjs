// A Flow Claude stage's sidecar extras (run 2026-10-19-codex-primary, W3e2; flow/claude_mcp.rs builds the argv):
// `--flow-payload bare --root <root>` sends the Bare profile's static payload text as systemPrompt.append, and
// `--mcp-servers <json>` becomes options.mcpServers with exactly type and url. With neither arg the SDK options
// are what they were (every other caller, Falcon's Rendered tabs among them, passes neither).
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
import { flowMcpServers, flowOptions, flowPayload } from "../tools/claude-sidecar-bare.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SIDECAR_FILES = ["claude-sidecar.mjs", "claude-sidecar-shrink.mjs", "claude-sidecar-statusline.mjs", "claude-sidecar-seed.mjs", "claude-sidecar-bare.mjs", "claude-sidecar-recover.mjs", "claude-sidecar-ledger.mjs", "claude-sidecar-trust.mjs"];

const STUB = `
import { writeFileSync } from "node:fs";
export async function getSessionMessages() { return []; }
export function query({ options }) {
  writeFileSync(process.env.STUB_OPTIONS, JSON.stringify(options));
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
  return root;
}

function run(root, extra = []) {
  const userprofile = join(root, "userprofile");
  const args = [join(root, "tools", "claude-sidecar.mjs"), "--cwd", root, "--model", "claude-opus-5-5", "--permission-mode", "auto",
    "--claude", join(root, "claude.exe"), ...extra];
  const env = { ...process.env, USERPROFILE: userprofile, HOME: userprofile, STUB_OPTIONS: join(root, "options.json") };
  delete env.ANTHROPIC_MODEL;
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

const options = (root) => JSON.parse(readFileSync(join(root, "options.json"), "utf8"));
const SERVERS = { proxy: { type: "http", url: "http://127.0.0.1:8765/mcp" }, events: { type: "sse", url: "https://events.example/sse" } };

test("the payload and carried servers map into the SDK options; neither arg leaves them unchanged", async () => {
  const root = fixture();
  try {
    let r = await run(root);
    assert.equal(r.code, 0, `sidecar exited ${r.code}\n${r.stderr}`);
    const plain = options(root);
    assert.equal(plain.systemPrompt, undefined);
    assert.equal(plain.mcpServers, undefined);
    assert.deepEqual(plain.settingSources, ["user"]); // the fixture home trusts no folder (sidecar-trust.test.mjs)

    r = await run(root, ["--flow-payload", "bare", "--root", root, "--mcp-servers", JSON.stringify(SERVERS)]);
    assert.equal(r.code, 0, `sidecar exited ${r.code}\n${r.stderr}`);
    const flow = options(root);
    const payload = readFileSync(join(root, "profiles", "bare", "payload.md"), "utf8");
    assert.deepEqual(flow.systemPrompt, { type: "preset", preset: "claude_code", append: payload });
    assert.deepEqual(flow.mcpServers, SERVERS);
    // Everything else is Flow's own: permission mode, model, setting sources, plugins, allowed tools.
    const { systemPrompt, mcpServers, ...rest } = flow;
    assert.deepEqual(rest, plain);
    assert.equal(flow.permissionMode, "auto");
    assert.equal(flow.model, "claude-opus-5-5");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the flow args are refused with a launch profile, and a bad server list fails the sidecar", async () => {
  const root = fixture();
  try {
    const home = join(root, "agent-home");
    mkdirSync(join(home, "claude-config"), { recursive: true });
    let r = await run(root, ["--falcon", "--profile", "bare", "--root", root, "--home", home, "--flow-payload", "bare"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /flow stage: a launch profile carries no flow arguments/);
    r = await run(root, ["--mcp-servers", JSON.stringify({ k: { type: "stdio", command: "node" } })]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /flow stage: MCP server k is not http or sse/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("flowOptions is {} with neither arg, and omits an empty server list", () => {
  const never = (m) => assert.fail(m);
  assert.deepEqual(flowOptions({ profile: "bare", payload: undefined, servers: undefined, root: undefined }, never), {});
  assert.deepEqual(flowOptions({ servers: "{}" }, never), {});
  const seen = [];
  assert.deepEqual(flowOptions({ servers: "[" }, (m) => seen.push(m)), {});
  assert.deepEqual(seen, ["flow stage: --mcp-servers is not JSON"]);
});

test("flowMcpServers keeps type and url only and refuses the rest", () => {
  assert.deepEqual(flowMcpServers(JSON.stringify({ a: { type: "http", url: "https://x", extra: 1 } })), { a: { type: "http", url: "https://x" } });
  assert.throws(() => flowMcpServers("[]"), /JSON object/);
  assert.throws(() => flowMcpServers("{"), /not JSON/);
  assert.throws(() => flowMcpServers(JSON.stringify({ plugin_vidar_drive: { type: "http", url: "https://x" } })), /bad MCP server name/);
  assert.throws(() => flowMcpServers(JSON.stringify({ a: { type: "http", url: "file:///x" } })), /no http\(s\) url/);
});

test("flowPayload is the profile's static payload text and refuses a relative root", () => {
  const root = fixture();
  try {
    const p = flowPayload({ profile: "bare", root });
    assert.equal(p.append, readFileSync(join(root, "profiles", "bare", "payload.md"), "utf8"));
    assert.throws(() => flowPayload({ profile: "bare", root: "relative" }), /absolute/);
    assert.throws(() => flowPayload({ profile: "lean", root }), /unknown launch profile/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
