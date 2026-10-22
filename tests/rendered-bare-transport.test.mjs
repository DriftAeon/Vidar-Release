// The Rendered Bare Claude tab's transport (src/panels/rendered/transport.ts): every Falcon spawn
// carries the profile and no rules file, and a re-adopted bare session keeps the profile on /clear,
// taken from the host's summary (launcher/hosted.ts adoptHosted, src/falcon.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

// attachRenderedBody builds its transport from the tab, then hands it to createRenderedBody: the
// stub captures that call's options and re-exports the real transports.
const rig = { opts: null, real: null };
globalThis.__bareTransportRig = rig;
const h = setupDom({ stubs: {
  "panels/rendered": `const r = globalThis.__bareTransportRig;
    export const createFalconAdoptTransport = (...a) => r.real.createFalconAdoptTransport(...a);
    export const falconAgentTransport = { spawn: (...a) => r.real.falconAgentTransport.spawn(...a) };
    export function createRenderedBody(o) { r.opts = o; return { el: document.createElement("div"), focus() {}, dispose() {} }; }`,
} });
const { createFalconProfileTransport, createFalconAdoptTransport, falconAgentTransport } = await import("../src/panels/rendered/transport.ts");
rig.real = { createFalconAdoptTransport, falconAgentTransport };
const rules = { file: "C:\\v\\runtime\\rules\\built\\0123456789ab.md", codex: null, warnings: [] };
const params = { tabId: "tab", agent: "claude", cwd: "work", permissionMode: "auto", rules };

test("a profiled Falcon spawn carries the profile and drops the rules file", async () => {
  let payload;
  h.ipc.answers.falcon_spawn = (args) => { payload = args; return 7; };
  await falconAgentTransport.spawn(params);
  assert.equal(Object.hasOwn(payload, "profile"), false, "a default spawn sends no profile");
  assert.equal(payload.rulesFile, rules.file);
  await createFalconProfileTransport("bare").spawn(params);
  assert.equal(payload.profile, "bare");
  assert.equal(payload.rulesFile, null);
});

test("a Falcon spawn reply's bare_warnings reach onBareWarnings; a bare number or an empty list reaches nothing", async () => {
  const seen = [];
  const onBareWarnings = (ws) => seen.push(ws);
  h.ipc.answers.falcon_spawn = () => ({ view_generation: 5, bare_warnings: ["No guard hooks", "Git identity not set"] });
  assert.equal((await createFalconProfileTransport("bare").spawn({ ...params, onBareWarnings })).gen, 5);
  assert.deepEqual(seen, [["No guard hooks", "Git identity not set"]]);
  h.ipc.answers.falcon_spawn = () => ({ view_generation: 6 });
  assert.equal((await createFalconProfileTransport("bare").spawn({ ...params, onBareWarnings })).gen, 6);
  h.ipc.answers.falcon_spawn = () => 7;
  assert.equal((await createFalconProfileTransport("bare").spawn({ ...params, onBareWarnings })).gen, 7);
  assert.equal(seen.length, 1);
});

test("a Codex Bare spawn asks for the trust offer and passes it with the warnings, hosted or in-process", async () => {
  const seen = [];
  const onBareWarnings = (ws, trust) => seen.push([ws, trust]);
  const codex = { ...params, agent: "codex", onBareWarnings };
  const offer = { folder: "C:\\work", text: "Trust this Folder in your Codex Config to Load its Project Settings." };
  let asked;
  h.ipc.answers.codex_trust_offer = (args) => { asked = args; return offer; };
  // Hosted: a reply with no warnings still reports the offer.
  h.ipc.answers.falcon_spawn = () => ({ view_generation: 5 });
  assert.equal((await createFalconProfileTransport("bare").spawn(codex)).gen, 5);
  assert.deepEqual(asked, { id: "tab" });
  assert.deepEqual(seen.pop(), [[], offer]);
  // In-process: bareWarnings ride the reply, and the generation still comes back.
  h.ipc.answers.spawn_codex_appserver = () => ({ gen: 3, developerInstructions: null, bareWarnings: ["No guard hooks"] });
  const { createProfileTransport } = await import("../src/panels/rendered/transport.ts");
  assert.equal((await createProfileTransport("bare").spawn(codex)).gen, 3);
  assert.deepEqual(seen.pop(), [["No guard hooks"], offer]);
  // Trusted folder, no warnings: nothing is reported. A failed offer lookup reports the warnings alone.
  h.ipc.answers.codex_trust_offer = () => null;
  h.ipc.answers.spawn_codex_appserver = () => ({ gen: 4, developerInstructions: null });
  assert.equal((await createProfileTransport("bare").spawn(codex)).gen, 4);
  assert.equal(seen.length, 0);
  h.ipc.answers.codex_trust_offer = () => { throw new Error("gone"); };
  h.ipc.answers.spawn_codex_appserver = () => ({ gen: 3, developerInstructions: null, bareWarnings: ["No guard hooks"] });
  await createProfileTransport("bare").spawn(codex);
  assert.deepEqual(seen.pop(), [["No guard hooks"], null]);
  // A Claude spawn never asks.
  asked = undefined;
  h.ipc.answers.codex_trust_offer = (args) => { asked = args; return offer; };
  h.ipc.answers.falcon_spawn = () => ({ view_generation: 6, bare_warnings: ["w"] });
  await createFalconProfileTransport("bare").spawn({ ...params, onBareWarnings });
  assert.equal(asked, undefined);
  assert.deepEqual(seen.pop(), [["w"], null]);
});

test("re-adopt keeps the profile:/clear after an adopt respawns bare", async () => {
  let spawned;
  h.ipc.answers.falcon_adopt = () => 8;
  h.ipc.answers.falcon_spawn = (args) => { spawned = args; return 9; };
  const transport = createFalconAdoptTransport("s1", undefined, "bare");
  assert.equal((await transport.spawn(params)).gen, 8);
  assert.equal(spawned, undefined, "the adopt itself spawns nothing");
  assert.equal((await transport.spawn(params)).gen, 9);
  assert.equal(spawned.profile, "bare");
  assert.equal(spawned.rulesFile, null);
});

test("an adopted tab body (attachRenderedBody) spawns bare on /clear: the tab's profile reaches the Falcon payload", async () => {
  const { attachRenderedBody } = await import("../src/panels/sessions/rendered-body.ts");
  const tab = (extra) => ({
    id: "tab", agent: "claude", body: "rendered", cwd: "work", falconSession: "s1",
    button: document.createElement("button"), container: document.createElement("div"), ...extra,
  });
  let spawned;
  h.ipc.answers.falcon_adopt = () => 8;
  h.ipc.answers.falcon_spawn = (args) => { spawned = args; return 9; };

  attachRenderedBody(tab({ profile: "bare" }), undefined, undefined, undefined, false);
  const bare = rig.opts.transport;
  assert.equal((await bare.spawn(params)).gen, 8, "the adopt");
  assert.equal((await bare.spawn(params)).gen, 9, "the /clear respawn");
  assert.equal(spawned.profile, "bare");
  assert.equal(spawned.rulesFile, null);

  spawned = undefined;
  attachRenderedBody(tab({}), undefined, undefined, undefined, false);
  await rig.opts.transport.spawn(params);
  await rig.opts.transport.spawn(params);
  assert.equal(Object.hasOwn(spawned, "profile"), false, "a default adopted tab respawns with no profile");
});
