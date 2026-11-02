// The Runes panel's Pick state for a tab waiting on its Rune Vault (src/runes/bare/vault-pick-view.ts):
// the head checkbox picks (single-select), a click on the card expands, Start hands the pick on, New Rune Vault opens a draft and returns, and runes.ts shows
// the state only for a pending focused tab.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const LOOKUP = `
export const getFocusedSession = () => globalThis.__focus ?? null;
export const renderedSessionId = () => null;
export const renderedBody = () => null;
export const sessionLaunchInfo = () => null;
export const pendingVaultTab = (id) => (globalThis.__pending?.has(id) ? { pendingVault: { pending: true } } : null);`;
const VAULT_PICK = `export const pickTabVault = (tab, vault) => { (globalThis.__picks ??= []).push([tab, vault]); return true; };`;

const ROSTER = `export const agentKind = (id) => id; export const defaultVault = () => "base-daily"; export const rememberVault = () => {};`;
const ZOOM = `export const showSessionsToast = () => {};`;
const dom = setupDom({ stubs: { "panels/sessions/lookup": LOOKUP, "launcher/vault-pick": VAULT_PICK, "launcher/roster": ROSTER, "panels/sessions/zoom": ZOOM } });
const { mountVaultPick } = await import("../src/runes/bare/vault-pick-view.ts");
const { mountRunesView, onRunesShown, disposeRunesView } = await import("../src/panels/runes.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const rune = (kind, id) => ({ library: "vidar", id, set: null, kind, activate: "always", description: id, section: [], recall: false, body: id, drift: false });
const view = (id, name) => ({
  vault: { id, name, hash: "h", lockedUtc: null, runesets: [], runes: [{ library: "vidar", id: "guide" }], pins: {} },
  runes: [rune("rule", "guide"), rune("hook", "h1"), rune("hook", "h2")], warnings: [], drift: [],
});
const listed = [
  { id: "base-daily", name: "Base Daily", template: false, hash: "h", lockedUtc: null },
  { id: "team-daily", name: "Team Daily", template: false, hash: "h", lockedUtc: null },
];
const mkIo = (over = {}) => {
  const calls = { pick: [], create: [] };
  let all = listed;
  return { calls, io: {
    list: async () => all,
    read: async (id) => view(id, id),
    last: () => "base-daily",
    create: async (name, base, ops) => {
      calls.create.push([name, base, ops]);
      all = [...all, { id: "daily-work", name, template: false, hash: "h", lockedUtc: null }];
      return { id: "daily-work" };
    },
    pick: (tab, vault) => { calls.pick.push([tab, vault]); return true; },
    ...over,
  } };
};
// the panel's draft editor (view.ts on draftIo) stands in as a plain root that remembers its hooks
const mkDraft = () => {
  const d = { opened: 0, disposed: 0, hooks: null };
  d.open = (hooks) => {
    d.opened++; d.hooks = hooks;
    const root = document.createElement("div");
    root.className = "draft-editor";
    return { root, dispose: () => { d.disposed++; root.remove(); } };
  };
  return d;
};
const mount = async (over, onStarted = () => {}) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const { io, calls } = mkIo(over);
  const draft = mkDraft();
  const h = mountVaultPick(host, { tab: "t1", agent: "claude", card: { openInDocument() {}, note() {} }, onStarted, io, draft: draft.open });
  await settle();
  return { h, calls, draft, root: h.root };
};
const newVault = (root) => [...root.querySelectorAll("button")].find((b) => b.textContent === "New Rune Vault");
const card = (root, id) => root.querySelector(`.vpick-card[data-vault="${id}"]`);
const tickOf = (root, id) => card(root, id).querySelector(".vpick-top .runes-check");
const start = (root) => [...root.querySelectorAll("button")].find((b) => b.textContent === "Start Session");

test("one card per vault, then the green New Rune Vault button; the Last Vault is picked on arrival", async () => {
  const { root } = await mount();
  assert.deepEqual([...root.querySelectorAll(".vpick-card")].map((c) => c.dataset.vault), ["base-daily", "team-daily"]);
  const add = newVault(root);
  assert.ok(add.classList.contains("ws-add") && add.classList.contains("ws-btn"), "Start's green primary classes");
  const slot = root.querySelector(".vpick-list").lastElementChild;
  assert.ok(slot.classList.contains("vpick-add") && slot.contains(add), "it sits in a vault-shaped card under the vaults (user, 2026-11-01)");
  assert.ok(card(root, "base-daily").classList.contains("is-picked"));
  assert.equal(root.querySelector(".vpick-kinds"), null, "no kind counts on the cards (user, 2026-10-31)");
});

test("ticking a vault's checkbox picks it and leaves it expanded", async () => {
  const { root } = await mount();
  tickOf(root, "team-daily").click();
  assert.ok(card(root, "team-daily").classList.contains("is-picked"));
  assert.equal(tickOf(root, "team-daily").getAttribute("aria-checked"), "true");
  assert.equal(tickOf(root, "team-daily").getAttribute("aria-label"), "Team Daily");
  assert.ok(card(root, "team-daily").querySelector(".vpick-body"));
});

test("cards start expanded, each head prefixed by the safe icon", async () => {
  const { root } = await mount();
  for (const c of root.querySelectorAll(".vpick-card")) {
    assert.ok(c.open);
    assert.ok(c.querySelector(".vpick-body"));
    assert.match(c.querySelector(".vpick-name-row > img.vpick-icon").getAttribute("src"), /\/safe-gold\.svg$/);
  }
});

test("ticking B unticks A, and ticking the picked one keeps it ticked", async () => {
  const { root } = await mount();
  assert.equal(tickOf(root, "base-daily").getAttribute("aria-checked"), "true");
  tickOf(root, "team-daily").click();
  assert.equal(tickOf(root, "base-daily").getAttribute("aria-checked"), "false");
  assert.equal(tickOf(root, "team-daily").getAttribute("aria-checked"), "true");
  assert.equal(root.querySelectorAll(".vpick-top .runes-check[aria-checked=\"true\"]").length, 1);
  tickOf(root, "team-daily").click();
  assert.equal(tickOf(root, "team-daily").getAttribute("aria-checked"), "true");
});

test("a click on the card head collapses and expands again, read-only, without picking", async () => {
  const { root } = await mount();
  const c = card(root, "team-daily");
  assert.ok(c.querySelector(".vpick-body details.runes-set"), "the Runes read view drew");
  assert.equal(c.querySelector(".vpick-body .runes-check"), null, "no switches before Start");
  c.querySelector(".vpick-top").click();
  assert.equal(card(root, "team-daily").querySelector(".vpick-body"), null);
  assert.ok(!card(root, "team-daily").open);
  assert.ok(!card(root, "team-daily").classList.contains("is-picked"), "collapsing does not pick");
  card(root, "team-daily").querySelector(".vpick-top").click();
  assert.ok(card(root, "team-daily").open);
  assert.ok(card(root, "base-daily").classList.contains("is-picked"), "the earlier pick stays");
});

test("the checkbox does not toggle the card's expansion, and a collapse survives the repaint", async () => {
  const { root } = await mount();
  card(root, "team-daily").querySelector(".vpick-top").click();
  tickOf(root, "team-daily").click();
  assert.ok(!card(root, "team-daily").open);
});

test("Start is disabled until a pick and calls the pick with the picked id", async () => {
  const { root, calls } = await mount({ last: () => "none" });
  assert.ok(start(root).disabled);
  tickOf(root, "team-daily").click();
  assert.ok(!start(root).disabled);
  start(root).click();
  await settle();
  assert.deepEqual(calls.pick, [["t1", "team-daily"]]);
  assert.deepEqual(calls.create, []);
});

test("New Rune Vault opens the draft with no base vault; Cancel returns with the pick kept and nothing made", async () => {
  const { root, calls, draft } = await mount();
  tickOf(root, "team-daily").click();
  newVault(root).click();
  assert.equal(draft.opened, 1);
  assert.ok(root.querySelector(".draft-editor"), "the editor replaced the list");
  assert.equal(root.querySelector(".vpick-list"), null);
  draft.hooks.cancel();
  assert.equal(draft.disposed, 1);
  assert.equal(root.querySelector(".draft-editor"), null);
  assert.ok(card(root, "team-daily").classList.contains("is-picked"), "the earlier pick stays");
  assert.deepEqual(calls.create, []);
});

test("the draft's Done makes the vault and returns with its card picked and expanded, ready for Start", async () => {
  const { root, calls, draft } = await mount();
  card(root, "base-daily").querySelector(".vpick-top").click();
  newVault(root).click();
  const ops = [{ op: "removeRune", ref: { library: "vidar", id: "guide" } }];
  await draft.hooks.create("Daily Work", null, ops);
  assert.deepEqual(calls.create, [["Daily Work", null, ops]]);
  assert.equal(draft.disposed, 1);
  const made = card(root, "daily-work");
  assert.ok(made.classList.contains("is-picked"));
  assert.ok(made.open && made.querySelector(".vpick-body"));
  assert.ok(!card(root, "base-daily").open, "other cards keep their collapse");
  start(root).click();
  await settle();
  assert.deepEqual(calls.pick, [["t1", "daily-work"]]);
});

test("a refused create stays in the draft; an edit that failed after the create returns with its error shown", async () => {
  const refused = await mount({ create: async () => { throw new Error("exists: Daily Work"); } });
  newVault(refused.root).click();
  await assert.rejects(refused.draft.hooks.create("Daily Work", null, []), /exists/);
  assert.ok(refused.root.querySelector(".draft-editor"), "the draft stays for another name");
  const half = await mount({ create: async () => ({ id: "team-daily", error: "No Room" }) });
  newVault(half.root).click();
  await half.draft.hooks.create("Team Daily", null, []);
  assert.ok(card(half.root, "team-daily").classList.contains("is-picked"));
  assert.equal(half.root.querySelector(".vpick-error").textContent, "No Room");
});

test("a Last Vault that is a copy pre-picks the vault it was started from", async () => {
  const copy = "copy-261031-101010-ab12";
  const { root } = await mount({
    last: () => copy,
    read: async (id) => (id === copy ? { ...view(id, id), vault: { ...view(id, id).vault, from: { vault: "team-daily", hash: "h" } } } : view(id, id)),
  });
  assert.ok(card(root, "team-daily").classList.contains("is-picked"));
  assert.equal(card(root, copy), null);
});

test("a failed pick shows the error inline and keeps the pick", async () => {
  const { root } = await mount({ pick: async () => { throw new Error("No Room"); } });
  start(root).click();
  await settle();
  assert.equal(root.querySelector(".vpick-error").textContent, "No Room");
  assert.ok(!start(root).disabled);
});

test("the panel shows the Pick state for a pending focused tab and not for a normal one", async () => {
  dom.ipc.answers.runes_catalog = { libraries: [] };
  dom.ipc.answers.runes_loaded = { source: "none", reason: "No Loads Recorded", files: [] };
  dom.ipc.answers.rune_vault_list = listed;
  dom.ipc.answers.rune_vault_read = (a) => view(a.id, a.id);
  dom.ipc.answers.bare_sets_list = [];
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  mountRunesView(parent, () => {}, () => {});
  globalThis.__pending = new Set(["p1"]);
  globalThis.__focus = { id: "p1", title: "P", agent: "claude", art: "claude", cwd: "C:/proj" };
  onRunesShown();
  await settle();
  assert.ok(parent.querySelector(".runes-list .vpick"), "Pick state for the pending tab");
  globalThis.__focus = { id: "n1", title: "N", agent: "claude", art: "claude", cwd: "C:/proj" };
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(parent.querySelector(".vpick"), null, "no Pick state for a normal tab");
  globalThis.__focus = { id: "p1", title: "P", agent: "claude", art: "claude", cwd: "C:/proj" };
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  parent.querySelector(".vpick-top .runes-check").click();
  start(parent).click();
  await settle();
  assert.deepEqual(globalThis.__picks?.at(-1)?.[0], "p1");
  disposeRunesView();
});

test("the pick card stays in the list, Start busy, until the vault view has resolved", async () => {
  dom.ipc.answers.runes_catalog = { libraries: [] };
  dom.ipc.answers.runes_loaded = { source: "none", reason: "No Loads Recorded", files: [] };
  dom.ipc.answers.rune_vault_list = listed;
  dom.ipc.answers.rune_vault_read = (a) => view(a.id, a.id);
  dom.ipc.answers.bare_sets_list = [];
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  mountRunesView(parent, () => {}, () => {});
  globalThis.__pending = new Set(["p2"]);
  globalThis.__focus = { id: "p2", title: "P", agent: "claude", art: "claude", cwd: "C:/proj", profile: "bare" };
  onRunesShown();
  await settle();
  assert.ok(parent.querySelector(".runes-list .vpick"), "pick shown while pending");
  // the load the refresh waits on is held, as in the gap between Start and the vault view
  let release;
  dom.ipc.answers.runes_loaded = () => new Promise((r) => { release = r; });
  parent.querySelector(".vpick-top .runes-check").click();
  globalThis.__pending = new Set();
  start(parent).click();
  await settle();
  assert.ok(parent.querySelector(".runes-list .vpick"), "the card stays while the vault view has not painted");
  assert.equal(start(parent).disabled, true, "Start stays in its busy state");
  release({ source: "none", reason: "No Loads Recorded", files: [] });
  await settle();
  assert.equal(parent.querySelector(".vpick"), null, "the vault view replaced the card once resolved");
  assert.ok(parent.querySelector(".runes-list .runes-bare"), "the bare vault view is on screen");
  disposeRunesView();
});

// Live freeze, 2026-10-31: a cover change re-lays the sessions slot, whose layout() dispatches `vidar-focus`; the
// refresh it queued redrew the Pick state, which dropped the draft's cover and set it again, and each change queued the
// next refresh with no task boundary between them (a microtask loop pegging the renderer).
test("New Rune Vault in the panel opens the draft with its cover once, without a refresh loop", async () => {
  const { getLeftCover, onLeftCoverChange } = await import("../src/panels/sessions/left-cover.ts");
  dom.ipc.answers.runes_catalog = { libraries: [] };
  dom.ipc.answers.runes_loaded = { source: "none", reason: "No Loads Recorded", files: [] };
  dom.ipc.answers.rune_vault_list = listed;
  dom.ipc.answers.rune_vault_read = (a) => (a.id === null ? view("blank-claude", "") : view(a.id, a.id));
  dom.ipc.answers.rune_vault_library_runes = { runes: [rune("rule", "guide")], warnings: [], runesets: [] };
  dom.ipc.answers.bare_sets_list = [];
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  mountRunesView(parent, () => {}, () => {});
  globalThis.__pending = new Set(["p3"]);
  globalThis.__focus = { id: "p3", title: "P", agent: "claude", art: "claude", cwd: "C:/proj" };
  onRunesShown();
  await settle();
  // sessions.ts: onLeftCoverChange(() => layout(false)), and layout() ends in dispatchFocus(); capped so a loop fails, not hangs
  let pings = 0;
  const unsub = onLeftCoverChange(() => { if (++pings <= 50) document.dispatchEvent(new window.CustomEvent("vidar-focus")); });
  try {
    newVault(parent).click();
    await settle();
    assert.ok(pings <= 4, `cover changes after New Rune Vault: ${pings}`);
    assert.ok(parent.querySelector(".runes-list .runes-bare.is-modifying"), "the draft opened in Modify");
    assert.ok(getLeftCover(), "the draft's Rune Library covers the left slot");
    const cancel = [...parent.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    assert.ok(cancel, "Cancel in the head");
    pings = 0;
    cancel.click();
    await settle();
    assert.ok(pings <= 4, `cover changes after Cancel: ${pings}`);
    assert.equal(getLeftCover(), null, "Cancel takes the cover down");
    assert.ok(parent.querySelector(".runes-list .vpick-list"), "Cancel returns to the picker");
  } finally {
    unsub();
    disposeRunesView();
  }
});
