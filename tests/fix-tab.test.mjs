// The fix tab opener (src/launcher/fix-tab.ts): row choice, the prompt, and the draft/onAdopted spawn.
import test from "node:test";
import assert from "node:assert/strict";
import { fixPrompt, findFixRow, createFixOpener } from "../src/launcher/fix-tab.ts";

const raw = { key: "claude-bare", id: "claude", label: "Claude", profile: "bare" };
const rendered = { key: "claude-rendered-bare", id: "claude", label: "Rendered", under: "claude", body: "rendered", profile: "bare", permissionMode: "auto", cwd: "C:\\elsewhere" };
const codexRendered = { key: "codex-rendered-bare", id: "codex", label: "Rendered", under: "codex", body: "rendered" };
const astra = { key: "astra", id: "codex", label: "Astra", role: "astra", body: "rendered" };
const variants = (root) => (root === raw ? [rendered] : []);

test("the fix row is the shown Rendered Claude child, never the Raw root, Codex or a role row", () => {
  assert.equal(findFixRow([raw, astra, codexRendered], variants), rendered);
  assert.equal(findFixRow([codexRendered, astra], () => []), null);
  assert.equal(findFixRow([raw], () => []), null, "the Raw root alone is not a Rendered row");
});

test("the prompt quotes the warning, strips control characters and never starts with a bang", () => {
  const p = fixPrompt({ agentLabel: "Codex", folder: "C:\\work\\P", warning: "!rm\r\n -rf\u0007 x" });
  assert.equal(p, `Vidar showed this warning when it opened a Rendered Codex tab in C:\\work\\P: "!rm -rf x" Find out what causes it and fix it. Tell me what you'll change before you change anything.`);
  assert.ok(!p.startsWith("!"));
  assert.ok(!/[\u0000-\u001f]/.test(p));
});

test("open spawns the row's own fields in the warned folder with the draft and no resume", async () => {
  let call;
  const opener = createFixOpener({ roots: () => [raw], variants, toast() {}, spawn: async (...a) => { call = a; return "t1"; } });
  assert.equal(opener.available(), true);
  await opener.open({ agentLabel: "Codex", folder: "C:\\work\\P", warning: "w" });
  const [t, loc, title, resume, draft, onAdopted] = call;
  assert.equal(t.key, "claude-rendered-bare");
  assert.equal(t.body, "rendered");
  assert.equal(t.cwd, undefined);
  assert.equal(t.role, undefined);
  assert.deepEqual(loc, { label: "C:\\work\\P", cwd: "C:\\work\\P" });
  assert.equal(title, undefined);
  assert.equal(resume, undefined);
  assert.match(draft, /^Vidar showed this warning/);
  assert.equal(typeof onAdopted, "function");
});

test("onAdopted(false) toasts the reason and rejects when it settled first; a later one only toasts", async () => {
  const toasts = [];
  let adopt;
  const mk = (early) => createFixOpener({ roots: () => [raw], variants, toast: (m) => toasts.push(m), spawn: async (...a) => { adopt = a[5]; if (early) adopt(false, "no host"); return "t"; } });
  await assert.rejects(mk(true).open({ agentLabel: "Claude", folder: "f", warning: "w" }), /no host/);
  assert.deepEqual(toasts, ["no host"]);
  await mk(false).open({ agentLabel: "Claude", folder: "f", warning: "w" });
  adopt(false, "late");
  assert.deepEqual(toasts, ["no host", "late"]);
});

test("with no Rendered Claude row it is unavailable and open rejects", async () => {
  const opener = createFixOpener({ roots: () => [codexRendered], variants: () => [], toast() {}, spawn: async () => "x" });
  assert.equal(opener.available(), false);
  await assert.rejects(opener.open({ agentLabel: "Codex", folder: "f", warning: "w" }), /Claude isn't in the launcher/);
});
