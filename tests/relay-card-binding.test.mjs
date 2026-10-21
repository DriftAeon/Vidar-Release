// Relay card binding (trust boundary; src/relay/card.ts, strip.ts, large.ts): a card's verdict binds
// to the bytes that card painted, never to the item open large; one verdict per item across every
// surface; a card whose thumbnail never painted cannot give a verdict.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
// display-render tells an svg <img> from an html <iframe> by class; the harness installs neither global
globalThis.HTMLImageElement ??= dom.window.HTMLImageElement;
globalThis.HTMLIFrameElement ??= dom.window.HTMLIFrameElement;
const { mountRelayPane, mountRelayTab } = await import("../src/panels/relay.ts");
const { refresh } = await import("../src/relay/source-display.ts");

// request-id names (source-display hasRequestId): only those are gate items
const A = { path: "D:\\display\\2026-10-11-alpha-aaaaaaaa.svg", kind: "svg", mtime_ms: 100 };
const B = { path: "D:\\display\\2026-10-11-beta-bbbbbbbb.svg", kind: "svg", mtime_ms: 200 };
const C = { path: "D:\\display\\2026-10-11-gamma-cccccccc.svg", kind: "svg", mtime_ms: 300 };
const SHA = { [A.path]: "sha-a", [B.path]: "sha-b", [C.path]: "sha-c" };
let files = [A, B];
const saves = [];
let hold = null;
Object.assign(dom.ipc.answers, {
  list_display: () => ({ files, docs: [], newest: files[0].path }),
  read_display_decision: null,
  read_display_file: ({ path }) => ({ kind: "svg", content: `<svg xmlns="http://www.w3.org/2000/svg"><text>${SHA[path]}</text></svg>`, sha256: SHA[path] }),
  save_display_decision: (args) => { saves.push(args); return hold?.promise; },
  list_pending_asks: { items: [] },
});

const host = document.createElement("div");
document.body.append(host);
mountRelayPane(host, { openRelay() {}, activate() {}, active: () => null });
const tab = mountRelayTab(host, () => {});

const settle = async () => { for (let i = 0; i < 10; i++) await dom.flush(); };
const card = (f) => [...tab.querySelectorAll(".relay-card")].find((c) => c.dataset.id === f.path);
const large = () => host.querySelector(".relay-large");

test("relay card: Approve on card B saves B's path and sha while A is open large", async () => {
  await settle();
  assert.ok(card(A) && card(B), "both items have a card");
  card(A).querySelector('[data-act="open-large"]').click();
  await settle();
  assert.equal(large().classList.contains("hidden"), false, "Open Large did not show the item");
  assert.equal(card(A).classList.contains("current"), true);
  assert.equal(large().querySelector(".relay-approve").disabled, false, "Large did not paint A");
  const approve = card(B).querySelector(".relay-approve");
  assert.equal(approve.disabled, false, "card B did not paint");
  approve.click();
  await settle();
  assert.deepEqual(saves, [{ path: B.path, sha256: "sha-b", verdict: "approve", comment: "" }]);
});

test("relay card: one verdict per item across the card and Large", async () => {
  saves.length = 0;
  card(B).querySelector('[data-act="open-large"]').click();
  await settle();
  let release;
  hold = { promise: new Promise((r) => { release = r; }) };
  card(B).querySelector(".relay-approve").click();
  await dom.flush();
  const lgDeny = large().querySelector(".relay-deny");
  assert.equal(lgDeny.disabled, true, "Large stayed live while the card's verdict was in flight");
  lgDeny.click();
  await dom.flush();
  release();
  hold = null;
  await settle();
  assert.equal(saves.length, 1, "two surfaces both saved");
  assert.equal(saves[0].verdict, "approve");
});

test("relay card: a card whose thumbnail never painted gives no verdict", async () => {
  saves.length = 0;
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  try {
    files = [C, A, B];
    await refresh();
    await settle();
    const approve = card(C).querySelector(".relay-approve");
    assert.equal(approve.disabled, true, "an unpainted card offered Approve");
    approve.disabled = false; // a click that slips through still finds no snapshot
    approve.click();
    await settle();
    assert.deepEqual(saves, []);
  } finally {
    delete globalThis.IntersectionObserver;
  }
});
