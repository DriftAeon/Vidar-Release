// The Bare row's `profile` reaches spawn_pty from every launch path and never turns into a default
// Claude tab: the launcher row (roster.ts spawnFrom), the spawn payload (sessions/pty-spawn.ts),
// the successor/relaunch info (sessions/lookup.ts sessionLaunchInfo) and the rules skip
// (rules/prepare.ts); a Rendered Bare row's key reaches falcon_spawn (rendered/transport.ts). No
// pty, CLI or host is started; IPC and createSession are stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

const rig = { created: [] };
globalThis.__bareRig = rig;
const dom = setupDom({ stubs: {
  "panels/sessions": `const r = globalThis.__bareRig;
    export async function createSession(opts) { r.created.push(opts); return "s" + r.created.length; }
    export function hasArmedAstra() { return false; }`,
  "tab-names": "export function mintTabName() { return 'Tab'; }",
  "capabilities/registry": "export function use() { return null; }",
} });

const { BUILTIN_AGENTS, builtinAgents, defaultVault, setGatewayModules, setRoster, rosterView, spawnFrom } = await import("../src/launcher/roster.ts");
const { ptySpawnPayload } = await import("../src/panels/sessions/pty-spawn.ts");
const lookup = await import("../src/panels/sessions/lookup.ts");
const { prepareRules } = await import("../src/rules/prepare.ts");
const { createFalconAdoptTransport, createFalconProfileTransport, createProfileTransport, falconAgentTransport, tauriAgentTransport } = await import("../src/panels/rendered/transport.ts");

const bareRow = BUILTIN_AGENTS.find((a) => a.key === "claude-bare");
const LOC = { label: "Trial", cwd: "C:\\work\\trial-repo" };

test("spawnFrom: a Bare launch names one vault; the row's sets and workspace add-ons are never read", async () => {
  const row = { ...bareRow, sets: [{ set: "Base" }], permissionMode: "plan" };
  rig.created.length = 0;
  await spawnFrom(row, { ...LOC, sets: [{ set: "Added" }] });
  assert.equal(rig.created.at(-1).vault, "stock-claude", "a plain click with no last vault launches the stock vault");
  assert.equal(Object.hasOwn(rig.created.at(-1), "sets"), false);
  assert.equal(rig.created.at(-1).permissionMode, undefined, "a Bare row's mode comes from its vault (D-c)");
  await spawnFrom(row, LOC, undefined, undefined, undefined, undefined, undefined, "team-kit");
  assert.equal(rig.created.at(-1).vault, "team-kit");
  assert.equal(defaultVault("claude"), "team-kit", "the last vault launched is the next pre-pick");
  await spawnFrom(row, LOC);
  assert.equal(rig.created.at(-1).vault, "team-kit");
  // The set-list transition (a resumed thread's manifest sets): no vault, the sets ride as given.
  await spawnFrom(row, LOC, undefined, undefined, undefined, undefined, []);
  assert.deepEqual(rig.created.at(-1).sets, []);
  assert.equal(Object.hasOwn(rig.created.at(-1), "vault"), false);
  assert.equal(defaultVault("codex"), "stock-codex");
});

test("spawn transports: a vault rides instead of sets, and a session record's vault wins on respawn", async () => {
  const params = { tabId: "t", agent: "claude", cwd: LOC.cwd, permissionMode: "default" };
  const sent = [];
  dom.ipc.answers.falcon_spawn = (args) => { sent.push(args); return 1; };
  await createFalconProfileTransport("bare", "claude-rendered-bare", [{ set: "x" }], "team-kit").spawn(params);
  assert.equal(sent.at(-1).vault, "team-kit");
  assert.equal(Object.hasOwn(sent.at(-1), "sets"), false);
  dom.ipc.answers.rune_vault_session = (args) => (args.tab === "t" ? { vault: { id: "custom-abc123", hash: "h" } } : null);
  await createFalconProfileTransport("bare", "claude-rendered-bare", undefined, "team-kit").spawn(params);
  assert.equal(sent.at(-1).vault, "custom-abc123", "/clear and Retry load the recorded vault (D-g)");
  const codex = [];
  dom.ipc.answers.spawn_codex_appserver = (args) => { codex.push(args); return { gen: 1, developerInstructions: null }; };
  await createProfileTransport("bare", "codex-rendered-bare", undefined, "stock-codex").spawn({ ...params, agent: "codex" });
  assert.equal(codex.at(-1).vault, "custom-abc123");
  delete dom.ipc.answers.rune_vault_session;
  await createProfileTransport("bare", "codex-rendered-bare", undefined, "stock-codex").spawn({ ...params, agent: "codex" });
  assert.equal(codex.at(-1).vault, "stock-codex");
  delete dom.ipc.answers.spawn_codex_appserver;
  delete dom.ipc.answers.falcon_spawn;
  const raw = ptySpawnPayload({ id: "t", cols: 80, rows: 24, cwd: LOC.cwd, tabName: null, ptyGen: 1,
    profile: "bare", rowKey: "claude-bare", agent: "claude", sets: [{ set: "x" }], vault: "team-kit" });
  assert.equal(raw.payload.vault, "team-kit");
  assert.equal(Object.hasOwn(raw.payload, "sets"), false);
});

test("explicit empty sets survive Raw and Rendered Bare spawn payloads", async () => {
  const raw = ptySpawnPayload({ id: "t", cols: 80, rows: 24, cwd: LOC.cwd, tabName: null, ptyGen: 1,
    profile: "bare", rowKey: "claude-bare", agent: "claude", sets: [] });
  assert.deepEqual(raw.payload.sets, []);
  assert.equal(Object.hasOwn(ptySpawnPayload({ id: "t", cols: 80, rows: 24, cwd: LOC.cwd,
    tabName: null, ptyGen: 1, profile: "bare", rowKey: "claude-bare", agent: "claude" }).payload, "sets"), false);

  const params = { tabId: "t", agent: "claude", cwd: LOC.cwd, permissionMode: "auto" };
  const sent = [];
  dom.ipc.answers.falcon_spawn = (args) => { sent.push(args); return 1; };
  await createFalconProfileTransport("bare", "claude-rendered-bare", []).spawn(params);
  assert.deepEqual(sent.at(-1).sets, []);
  await createFalconProfileTransport("bare", "claude-rendered-bare").spawn(params);
  assert.equal(Object.hasOwn(sent.at(-1), "sets"), false);
  delete dom.ipc.answers.falcon_spawn;

  const codex = [];
  dom.ipc.answers.spawn_codex_appserver = (args) => { codex.push(args); return { gen: 1, developerInstructions: null }; };
  await createProfileTransport("bare", "codex-rendered-bare", []).spawn({ ...params, agent: "codex" });
  assert.deepEqual(codex.at(-1).sets, []);
  delete dom.ipc.answers.spawn_codex_appserver;
});

test("roster: Bare is the Claude root, profile bare, with Rendered in its flyout", () => {
  assert.deepEqual(bareRow, { key: "claude-bare", id: "claude", label: "Claude", profile: "bare", requires: ["claude"] });
  setRoster(builtinAgents());
  const { variantsOf, launcherTypes } = rosterView();
  const claude = launcherTypes.find((t) => t.key === "claude-bare");
  assert.equal(claude.label, "Claude");
  assert.deepEqual(variantsOf.get(claude).map((v) => v.key), ["claude-rendered-bare"],
    "a cwd-less profiled variant is kept, not dropped like a cwd-less plain variant");
  assert.ok(launcherTypes.includes(claude), "a top-level row");
});

test("spawnFrom: the Bare row sends profile and no shell, args or rules (no rules_prepare call)", async () => {
  rig.created.length = 0;
  dom.ipc.invoked.length = 0;
  // a vidar.json overlay that hands the row shell, args and rules still sends none of them
  await spawnFrom({ ...bareRow, shell: "pwsh", args: ["-NoExit", "-Command", "claude"], rules: ["x"] }, LOC, "Bare");
  const opts = rig.created[0];
  assert.equal(opts.profile, "bare");
  assert.equal(opts.agent, "claude");
  assert.equal(opts.cwd, LOC.cwd);
  assert.equal(opts.shell, undefined);
  assert.equal(opts.args, undefined);
  assert.equal(opts.rules, undefined);
  assert.equal(opts.body, undefined, "a Raw body");
  assert.deepEqual(dom.ipc.invoked.filter((c) => c === "rules_prepare"), []);
});

test("spawnFrom: the Codex Bare row creates a Raw Codex tab carrying the profile and its key", async () => {
  rig.created.length = 0;
  const row = BUILTIN_AGENTS.find((a) => a.key === "codex-bare");
  assert.deepEqual(row, { key: "codex-bare", id: "codex", label: "Codex", profile: "bare", requires: ["codex", "node"] });
  await spawnFrom(row, LOC, "Codex");
  assert.equal(rig.created[0].profile, "bare");
  assert.equal(rig.created[0].agent, "codex");
  assert.equal(rig.created[0].rowKey, "codex-bare");
  assert.equal(rig.created[0].args, undefined);
  assert.equal(rig.created[0].body, undefined);
});

test("spawnFrom: a profile on a gateway, gateway Rendered, Astra or Terminal row refuses, nothing created", async () => {
  // gateway rows come from a gateway module (fixture id acme), not from BUILTIN_AGENTS
  setGatewayModules(() => [{ id: "acme", label: "Acme", agent: { gateway: { model: "acme-1" } } }]);
  let rows;
  try { rows = builtinAgents(); } finally { setGatewayModules(() => []); }
  for (const key of ["acme", "acme-rendered", "astra", "terminal"]) {
    rig.created.length = 0;
    const row = rows.find((a) => a.key === key);
    assert.ok(row, key);
    await assert.rejects(spawnFrom({ ...row, profile: "bare" }, LOC), /Claude and Codex rows without a role only/, key);
    assert.deepEqual(rig.created, [], `${key}: no session created`);
  }
});

test("spawnFrom: the Claude Rendered Bare row opens a Rendered Claude tab carrying the profile and no rules", async () => {
  rig.created.length = 0;
  dom.ipc.invoked.length = 0;
  const row = BUILTIN_AGENTS.find((a) => a.key === "claude-rendered-bare");
  assert.deepEqual(row, { key: "claude-rendered-bare", id: "claude", label: "Rendered", under: "claude", body: "rendered", profile: "bare", permissionMode: "auto", requires: ["claude", "node", "falcon"] });
  await spawnFrom({ ...row, rules: ["x"] }, LOC, "Rendered");
  const opts = rig.created[0];
  assert.equal(opts.profile, "bare");
  assert.equal(opts.agent, "claude");
  assert.equal(opts.body, "rendered");
  assert.equal(opts.rules, undefined);
  assert.equal(opts.args, undefined);
  assert.deepEqual(dom.ipc.invoked.filter((c) => c === "rules_prepare"), []);
});

test("spawnFrom: the Codex Rendered Bare row opens a Rendered Codex tab carrying the profile and no rules", async () => {
  rig.created.length = 0;
  const row = BUILTIN_AGENTS.find((a) => a.key === "codex-rendered-bare");
  assert.deepEqual(
    { id: row.id, label: row.label, under: row.under, body: row.body, profile: row.profile, requires: row.requires },
    { id: "codex", label: "Rendered", under: "codex", body: "rendered", profile: "bare", requires: ["codex", "node"] },
  );
  await spawnFrom({ ...row, rules: ["x"] }, LOC, "Rendered");
  const opts = rig.created[0];
  assert.equal(opts.profile, "bare");
  assert.equal(opts.agent, "codex");
  assert.equal(opts.body, "rendered");
  assert.equal(opts.rules, undefined);
  assert.equal(opts.args, undefined);
  assert.deepEqual(dom.ipc.invoked.filter((c) => c === "rules_prepare"), []);
});

test("spawnFrom: the plain Claude row carries no profile and keeps its args", async () => {
  rig.created.length = 0;
  assert.equal(BUILTIN_AGENTS.find((a) => a.key === "claude").label, "Plain");
  const claude = BUILTIN_AGENTS.find((a) => a.key === "claude");
  await spawnFrom(claude, LOC);
  assert.equal(rig.created[0].profile, undefined);
  assert.deepEqual(rig.created[0].args, claude.args);
});

test("prepareRules: a profiled row ignores rules (Design 9)", async () => {
  dom.ipc.invoked.length = 0;
  assert.equal(await prepareRules({ key: "k", id: "claude", rules: ["a"], profile: "bare" }), undefined);
  assert.deepEqual(dom.ipc.invoked, []);
});

const BASE = { id: "s1-x", cols: 120, rows: 30, cwd: "C:\\work", tabName: "Bare", ptyGen: 4 };

test("spawn payload: a bare tab sends exactly id, size, cwd, tabName, ptyGen, profile and agent", () => {
  const rules = { file: "C:\\v\\built\\a.md", codex: null, warnings: [] };
  const { payload, warning } = ptySpawnPayload({ ...BASE, rules, profile: "bare", agent: "claude" });
  assert.deepEqual(payload, { ...BASE, profile: "bare", agent: "claude" });
  assert.deepEqual(Object.keys(payload).sort(), ["agent", "cols", "cwd", "id", "profile", "ptyGen", "rows", "tabName"]);
  assert.equal(warning, undefined, "no rules warning: rules never ride a bare spawn");
  assert.equal(ptySpawnPayload({ ...BASE, cwd: "", profile: "bare" }).payload.cwd, null);
  assert.equal(ptySpawnPayload({ ...BASE, profile: "bare", agent: "acme" }).payload.agent, "acme", "passed through for Rust to refuse");
  assert.equal(ptySpawnPayload({ ...BASE, profile: "bare" }).payload.agent, null, "no agent: Rust refuses");
});

test("spawn payload: a profiled tab handed a resume line passes it through for Rust to refuse", () => {
  // never stripped to a fresh launch: the backend's refusal shows as a tab error
  const args = ["-NoExit", "-Command", "claude --resume x"];
  const { payload } = ptySpawnPayload({ ...BASE, args, profile: "bare" });
  assert.deepEqual(payload.args, args, "untouched: no app layer, no rules flag");
  assert.equal(payload.profile, "bare");
});

test("spawn payload: a default Claude tab keeps shell, app layer and rules, and has no profile", () => {
  const rules = { file: "C:\\v\\built\\a.md", codex: null, warnings: [] };
  const { payload } = ptySpawnPayload({ ...BASE, shell: "pwsh", args: ["-NoExit", "-Command", "claude"], rules });
  assert.equal(payload.shell, "pwsh");
  assert.match(payload.args[2], /^claude --plugin-dir .*--append-system-prompt-file/);
  assert.equal("profile" in payload, false);
});

test("relaunch info: a bare tab's successor keeps its profile", () => {
  const tabs = new Map();
  lookup.bindLookup({ sessions: tabs, getActiveId: () => null });
  tabs.set("s1-x", { id: "s1-x", agent: "claude", body: "terminal", cwd: "C:\\work", profile: "bare" });
  tabs.set("s2-x", { id: "s2-x", agent: "claude", body: "terminal", cwd: "C:\\work" });
  assert.equal(lookup.sessionLaunchInfo("s1-x").profile, "bare");
  assert.equal(lookup.sessionLaunchInfo("s2-x").profile, undefined);
});

test("rowKey: the Raw Bare row's key reaches createSession, the spawn payload and the successor info", async () => {
  rig.created.length = 0;
  await spawnFrom({ ...bareRow, sets: [{ set: "a" }] }, LOC, "Bare");
  assert.equal(rig.created[0].rowKey, "claude-bare");
  const { payload } = ptySpawnPayload({ ...BASE, profile: "bare", agent: "claude", rowKey: "claude-bare" });
  assert.equal(payload.rowKey, "claude-bare");
  assert.equal("rowKey" in ptySpawnPayload({ ...BASE, profile: "bare", agent: "claude" }).payload, false, "no key, no field");
  assert.equal("rowKey" in ptySpawnPayload({ ...BASE, shell: "pwsh", rowKey: "x" }).payload, false, "never on a default tab");
  const tabs = new Map();
  lookup.bindLookup({ sessions: tabs, getActiveId: () => null });
  tabs.set("s1-x", { id: "s1-x", agent: "claude", body: "terminal", cwd: "C:\\work", profile: "bare", rowKey: "claude-bare" });
  assert.equal(lookup.sessionLaunchInfo("s1-x").rowKey, "claude-bare", "Resume, Retry and successors keep the key");
});

test("spawnFrom: a vault or set pick on a row that is not Bare throws and creates nothing", async () => {
  const MSG = /A Rune Vault loads only on a Bare row; this row would launch without it\.$/;
  const plain = BUILTIN_AGENTS.find((a) => a.key === "claude");
  for (const [pick, vault] of [[undefined, "stock-claude"], [[{ set: "a" }], undefined]]) {
    rig.created.length = 0;
    await assert.rejects(spawnFrom(plain, LOC, undefined, undefined, undefined, undefined, pick, vault), MSG);
    assert.deepEqual(rig.created, []);
  }
  rig.created.length = 0;
  await spawnFrom({ ...plain, sets: [{ set: "a" }] }, LOC);
  assert.equal(rig.created.length, 1, "a row's own sets are never read");
  assert.equal(Object.hasOwn(rig.created[0], "vault"), false, "no vault on a plain row");
  const { key: _k, ...keyless } = bareRow;
  rig.created.length = 0;
  await spawnFrom(keyless, LOC, "Bare");
  assert.ok(rig.created[0].vault, "a keyless Bare row still loads a vault");
});

test("rowKey: a Rendered Bare row's key reaches falcon_spawn on the first start, /clear and Retry", async () => {
  rig.created.length = 0;
  const renderedBare = BUILTIN_AGENTS.find((a) => a.key === "claude-rendered-bare");
  await spawnFrom({ ...renderedBare, sets: [{ set: "a" }] }, LOC, "Rendered Bare");
  assert.equal(rig.created[0].rowKey, "claude-rendered-bare");
  assert.equal(rig.created[0].body, "rendered");
  const sent = [];
  dom.ipc.answers.falcon_spawn = (args) => { sent.push(args); return sent.length; };
  const params = { tabId: "t", agent: "claude", cwd: "C:\\work", permissionMode: "auto" };
  const transport = createFalconProfileTransport("bare", "claude-rendered-bare");
  for (let i = 0; i < 3; i++) await transport.spawn(params); // first start, /clear, Retry
  assert.deepEqual(sent.map((a) => [a.profile, a.rowKey]), Array(3).fill(["bare", "claude-rendered-bare"]));
  sent.length = 0;
  await createFalconProfileTransport("bare").spawn(params);
  await falconAgentTransport.spawn({ ...params, rowKey: "stray" });
  assert.equal(Object.hasOwn(sent[0], "rowKey"), false, "no key, no field");
  assert.equal(Object.hasOwn(sent[1], "rowKey"), false, "never without a profile");
  delete dom.ipc.answers.falcon_spawn;
});

test("rowKey: a Codex Bare row's key reaches spawn_codex_appserver on the first start, /clear and Retry", async () => {
  rig.created.length = 0;
  const codexBare = BUILTIN_AGENTS.find((a) => a.key === "codex-rendered-bare");
  await spawnFrom({ ...codexBare, sets: [{ set: "a" }] }, LOC, "Rendered Bare");
  assert.equal(rig.created.length, 1, "a keyed Codex Bare row with sets launches");
  assert.equal(rig.created[0].rowKey, "codex-rendered-bare");
  const sent = [];
  dom.ipc.answers.spawn_codex_appserver = (args) => { sent.push(args); return { gen: sent.length, developerInstructions: null }; };
  const params = { tabId: "t", agent: "codex", cwd: "C:\\work" };
  const transport = createProfileTransport("bare", "codex-rendered-bare");
  for (let i = 0; i < 3; i++) await transport.spawn(params); // first start, /clear, Retry
  assert.deepEqual(sent.map((a) => [a.profile, a.rowKey]), Array(3).fill(["bare", "codex-rendered-bare"]));
  sent.length = 0;
  await createProfileTransport("bare").spawn(params);
  await tauriAgentTransport.spawn({ ...params, rowKey: "stray" });
  assert.equal(Object.hasOwn(sent[0], "rowKey"), false, "no key, no field");
  assert.equal(Object.hasOwn(sent[1], "rowKey"), false, "a non-profiled Codex spawn sends none");
  delete dom.ipc.answers.spawn_codex_appserver;
  const body = readFileSync(new URL("../src/panels/sessions/rendered-body.ts", import.meta.url), "utf8");
  assert.match(body, /createProfileTransport\(s\.profile, s\.rowKey, s\.sets, s\.vault\)/);
});

test("rowKey: a re-adopted Rendered Bare tab sends the host's echoed key again on /clear", async () => {
  // adoptHosted builds the tab from the host summary: the echoed row_key rides createSession.
  const hosted = readFileSync(new URL("../src/launcher/hosted.ts", import.meta.url), "utf8");
  assert.match(hosted, /rowKey: s\.profile \? s\.row_key : undefined/);
  // The tab's body adopts once, then /clear respawns with the profile and the key.
  const sent = [];
  dom.ipc.answers.falcon_adopt = () => 8;
  dom.ipc.answers.falcon_spawn = (args) => { sent.push(args); return 9; };
  const params = { tabId: "t", agent: "claude", cwd: "C:\\work", permissionMode: "auto" };
  const adopted = createFalconAdoptTransport("s1", undefined, "bare", false, "claude-rendered-bare");
  assert.equal((await adopted.spawn(params)).gen, 8, "the adopt spawns nothing");
  assert.equal((await adopted.spawn(params)).gen, 9);
  assert.equal(sent[0].rowKey, "claude-rendered-bare");
  // attachRenderedBody hands the tab's rowKey to that transport (src/panels/sessions/rendered-body.ts).
  const body = readFileSync(new URL("../src/panels/sessions/rendered-body.ts", import.meta.url), "utf8");
  assert.match(body, /createFalconAdoptTransport\(s\.falconSession, gateway, s\.profile, refused, s\.rowKey, s\.sets, s\.vault\)/);
  assert.match(body, /createFalconProfileTransport\(s\.profile, s\.rowKey, s\.sets, s\.vault\)/);
  delete dom.ipc.answers.falcon_adopt;
  delete dom.ipc.answers.falcon_spawn;
});
