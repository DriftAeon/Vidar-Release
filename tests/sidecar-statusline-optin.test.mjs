// Trust boundary: tools\claude-sidecar.mjs writes under ~\.claude only when vidar.json opts in
// (`statuslineMirror: true`), and with the key off it removes only the mirror files it marked.
//
// Same offline harness as sidecar-falcon-permissions.test.mjs: the sidecar runs as a child against
// a stub SDK, laid out as a Vidar root (<root>\tools\claude-sidecar.mjs beside <root>\vidar.json)
// with HOME pointed into the temp dir. Nothing outside the temp dir is read or written.
//
//   node --test tests\sidecar-statusline-optin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR = fileURLToPath(new URL("../tools/claude-sidecar.mjs", import.meta.url));
// Sibling modules the sidecar imports by relative path (the mirror itself lives in one of them).
const SIDECAR_MODULES = ["claude-sidecar-shrink.mjs", "claude-sidecar-statusline.mjs", "claude-sidecar-seed.mjs", "claude-sidecar-bare.mjs", "claude-sidecar-recover.mjs", "claude-sidecar-ledger.mjs", "claude-sidecar-trust.mjs"];
const SID = "11111111-2222-3333-4444-555555555555";

const STUB = `
export async function getSessionMessages() { return []; }
export function query() {
  async function* run() {
    yield { type: "system", subtype: "init", session_id: "${SID}" };
    yield { type: "assistant", parent_tool_use_id: null, message: { usage: { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } } };
  }
  const it = run();
  return {
    [Symbol.asyncIterator]: () => it,
    initializationResult: async () => ({ models: [] }),
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
  };
}
`;

function vidarRoot(config) {
  const root = mkdtempSync(join(tmpdir(), "vidar-statusline-"));
  const pkg = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-stub", type: "module", main: "index.mjs", exports: "./index.mjs" }));
  writeFileSync(join(pkg, "index.mjs"), STUB);
  mkdirSync(join(root, "tools"));
  copyFileSync(SIDECAR, join(root, "tools", "claude-sidecar.mjs"));
  for (const m of SIDECAR_MODULES) copyFileSync(fileURLToPath(new URL(`../tools/${m}`, import.meta.url)), join(root, "tools", m));
  if (config) writeFileSync(join(root, "vidar.json"), JSON.stringify(config));
  mkdirSync(join(root, "home"));
  return root;
}

function run(root) {
  const home = join(root, "home");
  const args = [join(root, "tools", "claude-sidecar.mjs"), "--cwd", root, "--permission-mode", "default", "--claude", join(root, "claude.exe")];
  const env = { ...process.env, USERPROFILE: home, HOME: home, HOMEPATH: home };
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => { stdout += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`sidecar did not exit\n${stderr}`)); }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("statuslineMirror true writes the marked mirror file", async () => {
  const root = vidarRoot({ statuslineMirror: true });
  try {
    await run(root);
    const file = join(root, "home", ".claude", "statusline", `${SID}.json`);
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(data.session_id, SID);
    assert.equal(data.writer, "vidar-sidecar");
    assert.equal(data.context_window.current_usage.input_tokens, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("key absent writes nothing and removes only the sidecar's own marked files", async () => {
  const root = vidarRoot({});
  try {
    const dir = join(root, "home", ".claude", "statusline");
    mkdirSync(dir, { recursive: true });
    const ours = join(dir, "old-ours.json");
    const theirs = join(dir, "old-theirs.json");
    writeFileSync(ours, JSON.stringify({ session_id: "old-ours", writer: "vidar-sidecar" }));
    writeFileSync(theirs, JSON.stringify({ session_id: "old-theirs" }));
    const { code, stdout, stderr } = await run(root);
    // Prove the stub's assistant message was handled, so the absent file means the key-off path ran.
    assert.equal(code, 0, `sidecar exited ${code}\n${stderr}`);
    assert.match(stdout, /"type":"assistant"/, "assistant message never reached stdout");
    assert.equal(existsSync(join(dir, `${SID}.json`)), false, "mirror written with the key off");
    assert.equal(existsSync(ours), false, "marked file not removed");
    assert.equal(existsSync(theirs), true, "unmarked file removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
