// W4 of the soft lock: the launcher opens a Rendered Bare tab at once (pending) and reveals Runes; Raw and Resume rows
// are not pending; the scrim covers a waiting tab with no buttons and lifts on the pick, which refreshes the panel.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

const src = readFileSync(new URL("../src/launcher/locations.ts", import.meta.url), "utf8");
const bodies = src.slice(src.indexOf("function openBodies"), src.indexOf("// Resume serves"));

test("the launcher has no inline vault pick any more", () => {
  assert.doesNotMatch(src, /attachSetPick|set-pick/);
});

test("only a Bare row whose body is rendered launches pending, in the loc and !loc branches alike", () => {
  const bare = bodies.match(/kind === "bare"\) rows\.push\([^\n]*\n/)[0];
  assert.match(bare, /go\(\{ \.\.\.o\.variant, cwd: undefined \}, l, undefined, o\.variant\.body === "rendered"\)/);
  assert.doesNotMatch(bare, /attachSetPick/);
  const raw = bodies.match(/kind === "raw"\) rows\.push\([^\n]*\n/)[0];
  const rendered = bodies.match(/kind === "rendered" && rendered\) rows\.push\([^\n]*\n/)[0];
  assert.doesNotMatch(raw + rendered, /pending|body ===/);
  // both branches launch through r.launch, so one place decides
  assert.match(bodies, /withLocation\(resolve, r\.launch\)/);
  assert.match(bodies, /r\.row\.addEventListener\("click", \(\) => r\.launch\(loc\)\)/);
  const resume = bodies.slice(bodies.indexOf('bodyRow("Resume"'));
  assert.doesNotMatch(resume, /pending/);
});

test("a pending launch asks for the pending bare option and then reveals Runes", () => {
  const go = src.slice(src.indexOf("function go("), src.indexOf("export function openLocations"));
  assert.match(go, /pending \? \{ pending: true \} : undefined/);
  assert.match(go, /\.then\(\(\) => \{ if \(pending\) revealRunesForPick\(\); \}\)/);
});

delete globalThis.CustomEvent; // Node's own would not pass jsdom's dispatchEvent; the harness then installs jsdom's
setupDom({ stubs: {
  "panels/sessions/lookup": `export const pendingVaultTab = (id) => globalThis.__tabs[id]?.pendingVault?.pending ? globalThis.__tabs[id] : null;
    export const getFocusedSession = () => ({ id: "t1" });`,
  "launcher/roster": "export function rememberVault() {}",
}, answers: {
  rune_vault_read: { vault: { hash: "h" }, drift: [] },
  rune_vault_create: { id: "copy-260101-000000-ab12" },
} });
globalThis.__tabs = {};
const { createVaultGate } = await import("../src/panels/rendered/vault-gate.ts");
const { mountVaultScrim, VAULT_SCRIM_NOTE } = await import("../src/panels/rendered/vault-scrim.ts");
const { pickTabVault } = await import("../src/launcher/vault-pick.ts");

function tabRoot() {
  const root = document.createElement("div");
  root.className = "rendered";
  for (const c of ["rendered-scroll", "rendered-status", "rendered-composer"]) {
    const el = document.createElement("div");
    el.className = c;
    root.append(el);
  }
  root.querySelector(".rendered-composer").append(document.createElement("textarea"));
  return root;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("scrim covers transcript and composer while pending, holds one line and no buttons, lifts on the pick", async () => {
  const gate = createVaultGate();
  const root = tabRoot();
  mountVaultScrim(root, gate);
  const scrim = root.querySelector(".vault-scrim");
  assert.ok(scrim);
  assert.equal(scrim.textContent, "Pick a Rune Vault in the Runes Panel →");
  assert.equal(scrim.querySelector(".vault-scrim-key")?.textContent, "Rune Vault");
  assert.equal(VAULT_SCRIM_NOTE, scrim.textContent);
  assert.equal(scrim.querySelectorAll("button, input, textarea, a").length, 0);
  for (const c of ["rendered-scroll", "rendered-status", "rendered-composer"]) assert.equal(root.querySelector("." + c).inert, true, `${c} is inert`);
  gate.pick("team-main");
  await tick();
  assert.equal(root.querySelector(".vault-scrim"), null);
  assert.equal(root.querySelector(".rendered-composer").inert, false);
});

test("scrim lifts when the tab closes while pending, and never mounts for a tab without a pending gate", async () => {
  const gate = createVaultGate();
  const root = tabRoot();
  mountVaultScrim(root, gate);
  gate.cancel();
  await tick();
  assert.equal(root.querySelector(".vault-scrim"), null);
  const plain = tabRoot();
  mountVaultScrim(plain, null);
  mountVaultScrim(plain, gate);
  assert.equal(plain.querySelector(".vault-scrim"), null);
});

test("a landed pick dispatches the focus refresh; a refused pick does not", async () => {
  const gate = createVaultGate();
  globalThis.__tabs.t1 = { agent: "claude", pendingVault: gate };
  let focus = 0;
  document.addEventListener("vidar-focus", () => { focus++; });
  assert.equal(await pickTabVault("t1", "copy-old-1"), true);
  assert.equal(focus, 1);
  assert.equal(globalThis.__tabs.t1.vault, "copy-260101-000000-ab12", "the tab holds the copy, not its source");
  assert.equal(await pickTabVault("t1", "copy-old-1"), false);
  assert.equal(focus, 1);
});
