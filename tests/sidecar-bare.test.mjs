// The Rendered Bare sidecar mapping (tools/claude-sidecar-bare.mjs, plan P5): a `--profile bare`
// sidecar takes its SDK options from profiles/bare/claude.json alone, never from vidar.json, and
// writes only inside its own agent home (statusline mirror, first system/init record).
//
// Offline: the sidecar runs as a child against a stub SDK that records the options it was given,
// laid out as a Vidar root in a temp dir with USERPROFILE/HOME inside it. Nothing outside the temp
// dir is read or written.
//
//   node --test tests\sidecar-bare.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bareOptions } from "../tools/claude-sidecar-bare.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SIDECAR_FILES = ["claude-sidecar.mjs", "claude-sidecar-shrink.mjs", "claude-sidecar-statusline.mjs", "claude-sidecar-seed.mjs", "claude-sidecar-bare.mjs", "claude-sidecar-recover.mjs", "claude-sidecar-ledger.mjs", "claude-sidecar-trust.mjs"];
const SID = "11111111-2222-3333-4444-555555555555";
const FALCON_SESSION = "s1234abcd-00000001";

const STUB = `
import { writeFileSync } from "node:fs";
export async function getSessionMessages() { return []; }
export function query({ options }) {
  writeFileSync(process.env.STUB_OPTIONS, JSON.stringify({ ...options, hasEnv: "env" in options }));
  async function* run() {
    yield { type: "system", subtype: "init", session_id: "${SID}", plugins: [{ name: "vidar" }, { name: "vidar-gate" }], permissionMode: "auto" };
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

/** A temp Vidar root: the shipped bare profile and payload, the two rendered plugins, a vidar.json
 *  naming a third plugin and the mirror opt-out, a stub SDK, and an agent home. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vidar-sidecar-bare-"));
  const pkg = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-stub", type: "module", main: "index.mjs", exports: "./index.mjs" }));
  writeFileSync(join(pkg, "index.mjs"), STUB);
  mkdirSync(join(root, "tools"));
  for (const f of SIDECAR_FILES) copyFileSync(join(REPO, "tools", f), join(root, "tools", f));
  mkdirSync(join(root, "profiles", "bare"), { recursive: true });
  for (const f of ["claude.json", "payload.md"]) copyFileSync(join(REPO, "profiles", "bare", f), join(root, "profiles", "bare", f));
  for (const p of ["vidar-app", "gate", "other"]) mkdirSync(join(root, "plugins", p), { recursive: true });
  writeFileSync(join(root, "vidar.json"), JSON.stringify({ pluginDirs: ["plugins/other"], statuslineMirror: false }));
  const home = join(root, "agent-home");
  mkdirSync(join(home, "claude-config"), { recursive: true });
  mkdirSync(join(root, "userprofile"));
  return { root, home };
}

function run({ root, home }, extra = [], { falcon = true } = {}) {
  const userprofile = join(root, "userprofile");
  const args = [join(root, "tools", "claude-sidecar.mjs"), ...(falcon ? ["--falcon"] : []), "--cwd", root, "--permission-mode", "auto",
    "--claude", join(root, "claude.exe"), "--profile", "bare", "--root", root, "--home", home, ...extra];
  const env = { ...process.env, USERPROFILE: userprofile, HOME: userprofile, FALCON_SESSION, STUB_OPTIONS: join(root, "options.json") };
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

test("the bare mapping takes the profile's plugins and payload and ignores vidar.json", () => {
  const f = fixture();
  try {
    const o = bareOptions({ profile: "bare", root: f.root, home: f.home });
    assert.deepEqual(o.settingSources, ["user"]);
    assert.deepEqual(o.plugins, [
      { type: "local", path: join(f.root, "plugins", "vidar-app") },
      { type: "local", path: join(f.root, "plugins", "gate") },
    ]);
    assert.deepEqual(o.allowedTools, ["mcp__plugin_vidar_drive"]);
    assert.equal(o.systemPrompt.append, readFileSync(join(f.root, "profiles", "bare", "payload.md"), "utf8"));
    assert.equal(o.extraArgs["append-system-prompt-file"], undefined);
    assert.equal(o.configDir, `${f.home}\\claude-config`);
    assert.throws(() => bareOptions({ profile: "lean", root: f.root, home: f.home }), /unknown launch profile/);
    assert.throws(() => bareOptions({ profile: "bare", root: "relative", home: f.home }), /absolute/);
    rmSync(join(f.root, "plugins", "gate"), { recursive: true });
    assert.throws(() => bareOptions({ profile: "bare", root: f.root, home: f.home }), /plugin gate not found/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

/** A row payload under `<dir>` named by its own bytes' SHA-256 prefix (or by `name` when given). */
function payloadIn(dir, text = "row payload", name) {
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 12);
  const file = join(dir, name ?? `payload-${hash}.md`);
  writeFileSync(file, text);
  return file;
}

test("a --payload in home\\layer replaces the profile's payload, and reaches the SDK from the sidecar", async () => {
  const f = fixture();
  try {
    const file = payloadIn(join(f.home, "layer"));
    const o = bareOptions({ profile: "bare", root: f.root, home: f.home, payload: file });
    assert.equal(o.systemPrompt.append, "row payload");
    assert.equal(o.extraArgs["append-system-prompt-file"], undefined);
    const { code, stderr } = await run(f, ["--payload", file]);
    assert.equal(code, 0, `sidecar exited ${code}\n${stderr}`);
    const seen = JSON.parse(readFileSync(join(f.root, "options.json"), "utf8"));
    assert.equal(seen.systemPrompt.append, "row payload");
    assert.equal(seen.extraArgs?.["append-system-prompt-file"], undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

/** `<parent>\<name>\.claude-plugin\plugin.json`; the folder. */
function setPluginIn(parent, name) {
  const dir = join(parent, name);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{\"name\":\"s\"}");
  return dir;
}

test("--set-plugin folders in home\\layer\\plugins follow the profile's plugins; bad ones are dropped, not refused", async () => {
  const f = fixture();
  try {
    const plugins = join(f.home, "layer", "plugins");
    const a = setPluginIn(plugins, "core-0123456789ab");
    const b = setPluginIn(plugins, "core-2-fedcba987654");
    const outside = setPluginIn(f.home, "far-0123456789ab");
    const badName = setPluginIn(plugins, "core");
    const empty = join(plugins, "empty-aaaaaaaaaaaa");
    mkdirSync(empty);
    const warned = [];
    const o = bareOptions({ profile: "bare", root: f.root, home: f.home, setPlugins: [a, outside, badName, empty, b], warn: (m) => warned.push(m) });
    assert.deepEqual(o.plugins, [
      { type: "local", path: join(f.root, "plugins", "vidar-app") },
      { type: "local", path: join(f.root, "plugins", "gate") },
      { type: "local", path: realpathSync.native(a) },
      { type: "local", path: realpathSync.native(b) },
    ]);
    assert.equal(warned.length, 3, warned.join("\n"));
    assert.match(warned.join("\n"), /far-0123456789ab dropped: outside/);
    assert.match(warned.join("\n"), /core dropped: not named/);
    assert.match(warned.join("\n"), /empty-aaaaaaaaaaaa dropped/);
    // From argv: every --set-plugin in order, reaching the SDK's plugins option.
    const { code, stderr } = await run(f, ["--set-plugin", a, "--set-plugin", outside, "--set-plugin", b]);
    assert.equal(code, 0, `sidecar exited ${code}\n${stderr}`);
    const seen = JSON.parse(readFileSync(join(f.root, "options.json"), "utf8"));
    assert.deepEqual(seen.plugins.slice(2).map((p) => p.path), [realpathSync.native(a), realpathSync.native(b)]);
    assert.match(stderr, /far-0123456789ab dropped/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a payload changed on disk after bareOptions returned does not change the returned text", () => {
  const f = fixture();
  try {
    const file = payloadIn(join(f.home, "layer"));
    const o = bareOptions({ profile: "bare", root: f.root, home: f.home, payload: file });
    writeFileSync(file, "swapped after the check");
    assert.equal(o.systemPrompt.append, "row payload");
    assert.equal(o.systemPrompt.preset, "claude_code");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a --payload outside home\\layer throws", async () => {
  const f = fixture();
  try {
    for (const dir of [f.home, f.root, join(f.home, "layer", "nested")]) {
      const file = payloadIn(dir);
      assert.throws(() => bareOptions({ profile: "bare", root: f.root, home: f.home, payload: file }), /outside|layer unavailable/);
    }
    assert.throws(() => bareOptions({ profile: "bare", root: f.root, home: f.home, payload: "layer\\payload-0123456789ab.md" }), /absolute/);
    const missing = join(f.home, "layer", "payload-0123456789ab.md");
    assert.throws(() => bareOptions({ profile: "bare", root: f.root, home: f.home, payload: missing }), /unavailable/);
    const named = payloadIn(join(f.home, "layer"), "x", "0123456789ab.md");
    assert.throws(() => bareOptions({ profile: "bare", root: f.root, home: f.home, payload: named }), /payload-<hash12>\.md/);
    // The sidecar reports the refusal and never starts the SDK.
    const refused = await run(f, ["--payload", payloadIn(f.home)]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout, /launch profile: payload .* is outside/);
    assert.equal(existsSync(join(f.root, "options.json")), false, "the SDK started");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a junctioned home\\layer is refused even when the payload sits in its target", () => {
  const f = fixture();
  try {
    const elsewhere = join(f.root, "elsewhere");
    const file = payloadIn(elsewhere);
    symlinkSync(elsewhere, join(f.home, "layer"), "junction");
    const linked = join(f.home, "layer", basename(file));
    assert.throws(() => bareOptions({ profile: "bare", root: f.root, home: f.home, payload: linked }), /home layer .* resolves to .*, not itself/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a --payload whose hash does not match its name throws", () => {
  const f = fixture();
  try {
    const file = payloadIn(join(f.home, "layer"), "edited after the build", "payload-0123456789ab.md");
    assert.throws(() => bareOptions({ profile: "bare", root: f.root, home: f.home, payload: file }), /does not match its hash/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a bare sidecar runs on the profile's options and writes only inside its home", async () => {
  const f = fixture();
  try {
    const { code, stderr, stdout } = await run(f);
    assert.equal(code, 0, `sidecar exited ${code}\n${stderr}`);
    assert.match(stdout, /"type":"assistant"/);
    const o = JSON.parse(readFileSync(join(f.root, "options.json"), "utf8"));
    assert.deepEqual(o.settingSources, ["user"]);
    assert.deepEqual(o.plugins.map((p) => p.path), [join(f.root, "plugins", "vidar-app"), join(f.root, "plugins", "gate")]);
    assert.ok(!JSON.stringify(o.plugins).includes("other"), "a vidar.json pluginDirs entry reached a bare tab");
    assert.deepEqual(o.allowedTools, ["mcp__plugin_vidar_drive"]);
    assert.equal(o.systemPrompt.append, readFileSync(join(f.root, "profiles", "bare", "payload.md"), "utf8"));
    assert.equal(o.extraArgs?.["append-system-prompt-file"], undefined);
    assert.equal(o.hasEnv, false, "the SDK env option replaces Falcon's built env");
    // The first system/init, create-new, under the home's manifests.
    const init = JSON.parse(readFileSync(join(f.home, "manifests", `falcon-${FALCON_SESSION}.init.json`), "utf8"));
    assert.equal(init.subtype, "init");
    assert.equal(init.permissionMode, "auto");
    // The mirror is on for a bare tab (vidar.json says off) and lives in its config dir.
    const mirror = JSON.parse(readFileSync(join(f.home, "claude-config", "statusline", `${SID}.json`), "utf8"));
    assert.equal(mirror.context_window.current_usage.input_tokens, 7);
    assert.equal(existsSync(join(f.root, "userprofile", ".claude")), false, "wrote under the user profile");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a bare sidecar refuses a gateway, and a profile without --falcon, as sidecar errors", async () => {
  const f = fixture();
  try {
    const gateway = await run(f, ["--gateway", "acme"]);
    assert.notEqual(gateway.code, 0);
    assert.match(gateway.stdout, /"subtype":"error","message":"a launch profile carries no gateway"/);
    const plain = await run(f, [], { falcon: false });
    assert.notEqual(plain.code, 0);
    assert.match(plain.stdout, /"subtype":"error","message":"a launch profile needs --falcon"/);
    assert.equal(existsSync(join(f.root, "options.json")), false, "the SDK never started");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a bare sidecar refuses a rules file and never writes an existing init record twice", async () => {
  const f = fixture();
  try {
    const refused = await run(f, ["--rules-file", join(f.root, "r.md")]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout, /no rules file/);
    const dir = join(f.home, "manifests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `falcon-${FALCON_SESSION}.init.json`), "kept");
    const { code } = await run(f);
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, `falcon-${FALCON_SESSION}.init.json`), "utf8"), "kept");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
