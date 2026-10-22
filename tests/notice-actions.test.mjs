// The Rendered Bare notice cards (src/panels/rendered/notice-actions.ts): the trust card first, one
// Ask-only card per other warning, the Trust Folder, Dismiss and Ask Agent to Fix button states, and the
// one-caller guard on `codex_trust_folder`.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setupDom } from "./helpers/dom-mount.mjs";

const h = setupDom();
const { bareNotices } = await import("../src/panels/rendered/notice-actions.ts");
const { setFixOpener } = await import("../src/panels/rendered/fix-seam.ts");

const TRUST = { folder: "C:\\work\\Proj", text: "Trust this Folder in your Codex Config to Load its Project Settings." };
function mount(warnings, trust, extra = {}) {
  const root = document.createElement("div");
  const host = { tabId: "tab-1", agent: "codex", cwd: "C:\\work\\Proj", append: (n) => root.appendChild(n), sealGroup() {}, ...extra };
  bareNotices(host, warnings, trust);
  return root;
}
const labels = (card) => [...card.querySelectorAll("button")].map((b) => b.textContent);
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the trust card comes first with both buttons, then one Ask-only card per other warning", () => {
  const root = mount(["Skill x was skipped", "No guard hooks"], TRUST);
  const cards = [...root.children];
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.classList.contains("blk-notice-card")));
  assert.equal(cards[0].querySelector(".blk-notice").textContent, TRUST.text);
  assert.deepEqual(labels(cards[0]), ["Trust Folder", "Dismiss"]);
  assert.ok(cards[0].querySelector("button").classList.contains("notice-trust"));
  assert.deepEqual(labels(cards[1]), ["Ask Agent to Fix"]);
  assert.equal(cards[2].querySelector(".blk-notice").textContent, "No guard hooks");
  assert.ok(cards[0].querySelector(".notice-acts").classList.contains("wb-actions"));
  assert.ok(cards[0].querySelector("button").classList.contains("wb-card-btn"));
  assert.equal(mount([], null).children.length, 0, "nothing to show draws nothing");
});

test("Dismiss removes only the trust card, never calls the fix seam, and has no busy or error state", () => {
  let opened = 0;
  setFixOpener({ available: () => true, open: () => { opened++; return Promise.resolve(); } });
  const root = mount(["w"], TRUST);
  const dismiss = root.firstElementChild.querySelectorAll("button")[1];
  dismiss.click();
  assert.equal(dismiss.hasAttribute("aria-busy"), false);
  assert.equal(root.children.length, 1);
  assert.deepEqual(labels(root), ["Ask Agent to Fix"]);
  assert.equal(opened, 0);
  setFixOpener(null);
});

test("Ask Agent to Fix is disabled with a tooltip while no launcher row can open the fix tab", () => {
  setFixOpener(null);
  const ask = mount(["w"], null).querySelector("button");
  assert.equal(ask.disabled, true);
  assert.equal(ask.title, "Claude isn't in the launcher");
});

test("Trust Folder shows Trusting, sends the card's folder, and the card becomes the done line", async () => {
  let release;
  let sent;
  h.ipc.answers.codex_trust_folder = (args) => { sent = args; return new Promise((r) => { release = r; }); };
  const root = mount([], TRUST);
  const card = root.firstElementChild;
  const trust = card.querySelector("button");
  trust.click();
  assert.equal(trust.getAttribute("aria-busy"), "true");
  assert.equal(trust.textContent, "Trusting");
  trust.click();
  assert.equal(h.ipc.invoked.filter((c) => c === "codex_trust_folder").length, 1, "a busy button ignores a second click");
  release();
  await tick();
  assert.deepEqual(sent, { id: "tab-1", folder: TRUST.folder });
  assert.equal(root.querySelector(".blk-notice-card"), null);
  const done = root.querySelector(".blk-notice.done");
  assert.equal(done.textContent, "Trusted. Reopen the tab to load project settings.");
  assert.equal(root.querySelector("button"), null, "no reopen action (the Runes trace): no Refresh button");
});

test("with a reopen action the trusted card keeps its place and ends in one green Refresh button", async () => {
  h.ipc.answers.codex_trust_folder = () => undefined;
  const calls = [];
  let turns = false;
  let fail = null;
  const root = mount([], TRUST, { reopenHere: (keep) => { calls.push(keep); return fail ? Promise.reject(fail) : Promise.resolve(); }, hasTurns: () => turns });
  const card = root.firstElementChild;
  card.querySelector("button").click();
  await tick();
  assert.equal(root.firstElementChild, card);
  assert.equal(card.querySelector(".blk-notice").textContent, "Trusted. Refresh to load the project settings.");
  assert.deepEqual(labels(card), ["Refresh"]);
  const refresh = card.querySelector("button");
  assert.ok(refresh.classList.contains("wb-card-btn-primary") && refresh.classList.contains("notice-trust"));
  assert.equal(refresh.title, "");

  // busy state, then the new tab opens and this one closes (no turns)
  let release;
  const base = calls.length;
  fail = null;
  const pending = new Promise((r) => { release = r; });
  card.remove();
  const root2 = mount([], TRUST, { reopenHere: (keep) => { calls.push(keep); return pending; }, hasTurns: () => turns });
  const card2 = root2.firstElementChild;
  card2.querySelector("button").click();
  await tick();
  const r2 = card2.querySelector("button");
  r2.click();
  assert.equal(r2.getAttribute("aria-busy"), "true");
  assert.equal(r2.textContent, "Refreshing");
  r2.click();
  assert.equal(calls.length, base + 1, "a busy button ignores a second click");
  assert.equal(calls[base], false);
  release();
  await tick();
  assert.equal(r2.textContent, "Refresh");

  // a chat with turns keeps this tab and says so; a failure shows the fixed line and a retry works
  turns = true;
  fail = "spawn blew up";
  const root3 = mount([], TRUST, { reopenHere: (keep) => { calls.push(keep); return fail ? Promise.reject(fail) : Promise.resolve(); }, hasTurns: () => turns });
  const card3 = root3.firstElementChild;
  card3.querySelector("button").click();
  await tick();
  const r3 = card3.querySelector("button");
  assert.equal(r3.title, "Opens a fresh tab here; this chat stays open.");
  r3.click();
  await tick();
  assert.equal(calls.at(-1), true);
  assert.ok(r3.classList.contains("is-error"));
  assert.equal(card3.querySelector(".notice-err").textContent, "Couldn't refresh: reopen the tab yourself");
  fail = null;
  r3.click();
  await tick();
  assert.equal(r3.classList.contains("is-error"), false);
});

test("a failed trust keeps the card, marks the button, shows the error line, and a retry works", async () => {
  let fail = "Couldn't write C:\\Users\\u\\.codex\\config.toml: access denied";
  h.ipc.answers.codex_trust_folder = () => (fail ? Promise.reject(fail) : undefined);
  const root = mount([], TRUST);
  const card = root.firstElementChild;
  const trust = card.querySelector("button");
  trust.click();
  await tick();
  assert.ok(trust.classList.contains("is-error"));
  assert.equal(trust.disabled, false);
  assert.equal(trust.hasAttribute("aria-busy"), false);
  assert.equal(trust.textContent, "Trust Folder");
  const line = card.querySelector(".notice-err");
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, fail);
  // Any other failure text becomes the fixed line.
  fail = "trust task failed: boom";
  trust.click();
  await tick();
  assert.equal(line.textContent, "Couldn't trust this folder: reopen the tab and try again");
  fail = "";
  trust.click();
  await tick();
  assert.equal(trust.classList.contains("is-error"), false);
  assert.ok(root.querySelector(".blk-notice.done"));
});

test("Ask Agent to Fix shows Opening, passes the request, and shows an error state when the opener rejects", async () => {
  let req;
  let reject = false;
  setFixOpener({ available: () => true, open: (r) => { req = r; return reject ? Promise.reject(new Error("no row")) : Promise.resolve(); } });
  const root = mount(["Skill x was skipped"], null);
  const card = root.firstElementChild;
  const ask = card.querySelector("button");
  assert.equal(ask.disabled, false);
  ask.click();
  assert.equal(ask.textContent, "Opening");
  await tick();
  assert.deepEqual(req, { agentLabel: "Codex", folder: "C:\\work\\Proj", warning: "Skill x was skipped" });
  assert.equal(ask.textContent, "Ask Agent to Fix");
  assert.equal(ask.classList.contains("is-error"), false);
  reject = true;
  ask.click();
  await tick();
  assert.ok(ask.classList.contains("is-error"));
  assert.equal(card.querySelector(".notice-err").textContent, "Couldn't open a Claude tab to fix this");
  setFixOpener(null);
});

test("codex_trust_folder has one caller under src: notice-actions.ts, none in control or drive", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs|js)$/.test(name) && readFileSync(p, "utf8").includes('invoke("codex_trust_folder"')) hits.push(relative(src, p).replaceAll("\\", "/"));
    }
  };
  walk(src);
  assert.deepEqual(hits, ["panels/rendered/notice-actions.ts"]);
});
