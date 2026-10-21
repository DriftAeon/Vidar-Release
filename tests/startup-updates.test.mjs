import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { compareVersions, explicitCheck, offeredUpdates, quietCheck, skippedVersions } from "../src/startup-updates/core.ts";
import { renderStartupUpdateRows } from "../src/settings/dependencies-view.ts";
import { GEMINI_HIDDEN_PRELOAD, geminiHiddenArgs } from "../src/startup-updates/gemini-launch.ts";
import cp from "node:child_process";
import { SKEW_KEY, SKEW_TEXT, warnCodexSkew } from "../src/startup-updates/codex-skew.ts";

test("update ordering handles numeric releases, prereleases, build metadata and unreadable versions", () => {
  for (const [a, b] of [["1.10.0", "1.9.9"], ["2.0.0", "1.999.0"], ["1.2.3", "1.2.3-rc.2"],
    ["1.2.3-beta.10", "1.2.3-beta.9"], ["1.2.3-rc", "1.2.3-9"], ["1.2.3-beta.1", "1.2.3-beta"]]) {
    assert.equal(compareVersions(a, b), 1, `${a} > ${b}`);
    assert.equal(compareVersions(b, a), -1);
  }
  assert.equal(compareVersions("v1.2.3+build.1", "1.2.3+build.2"), 0);
  for (const text of ["unknown", "1.2", "1.2.3-01", "01.2.3", "1.2.3;evil"]) {
    assert.equal(compareVersions(text, "1.2.3"), null);
  }
});

test("skip survives state round trips and only a newer release reoffers", () => {
  const skipped = skippedVersions(JSON.parse(JSON.stringify({
    "startupUpdates.skip.gemini": "1.10.0", "startupUpdates.skip.codex": 123,
    "startupUpdates.skip.claude": "invalid", "theme": "dark",
  })));
  assert.deepEqual(skipped, { gemini: "1.10.0" });
  const offer = { id: "gemini", label: "Gemini CLI", installed: "1.8.0", latest: "1.10.0" };
  assert.deepEqual(offeredUpdates([offer], skipped), []);
  assert.deepEqual(offeredUpdates([{ ...offer, latest: "1.9.0" }], skipped), []);
  assert.equal(offeredUpdates([{ ...offer, latest: "1.11.0" }], skipped).length, 1);
  assert.deepEqual(offeredUpdates([{ ...offer, latest: "1.7.0" }], {}), []);
  assert.deepEqual(offeredUpdates([{ ...offer, installed: "unknown" }], {}), []);
});

test("offline check settles quietly on timeout/rejection and discards a late result", async () => {
  let finish;
  const started = performance.now();
  const result = await quietCheck(() => new Promise((resolve) => { finish = resolve; }), 15);
  assert.equal(result, null);
  assert.ok(performance.now() - started < 1000);
  finish(["late"]);
  assert.equal(await quietCheck(() => Promise.reject(new Error("offline")), 100), null);
  assert.deepEqual(await quietCheck(() => Promise.resolve(["ready"]), 100), ["ready"]);
});

test("explicit check offers skipped versions, drops not-newer ones and rejects on error or timeout", async () => {
  const offer = { id: "gemini", label: "Gemini CLI", installed: "1.8.0", latest: "1.10.0" };
  const skipped = { gemini: "1.10.0" };
  assert.deepEqual(offeredUpdates([offer], skipped), [], "the startup filter hides the skipped version");
  const found = await explicitCheck(async () => [
    offer,
    { ...offer, id: "pi", installed: "2.0.0", latest: "2.0.0" },
    { ...offer, id: "codex", installed: "2.0.0", latest: "1.0.0" },
    { ...offer, id: "claude", installed: "unknown" },
  ]);
  assert.deepEqual(found, [offer]);
  assert.equal(found.length, 1);
  assert.deepEqual(await explicitCheck(async () => []), []);
  await assert.rejects(explicitCheck(async () => { throw new Error("npm Unreachable"); }), /npm Unreachable/);
  await assert.rejects(explicitCheck(() => new Promise(() => {}), 15), /^Error: Check Timed Out$/);
});

test("one dependency row per CLI dispatches Update / Skip and disables actions while working", () => {
  const { document } = new JSDOM("<!doctype html><body></body>").window;
  const root = document.createElement("aside");
  const offers = ["gemini", "codex", "claude", "pi"].map((id) => ({ id, label: id, installed: "1.0.0", latest: "1.1.0" }));
  const clicks = [];
  const actions = { update: (u) => clicks.push(["update", u.id]), skip: (u) => clicks.push(["skip", u.id]) };
  renderStartupUpdateRows(root, offers, null, null, actions);
  assert.equal(root.querySelectorAll(".deps-row").length, 4);
  root.querySelector('[data-cli="gemini"] .deps-update').click();
  root.querySelector('[data-cli="codex"] .deps-skip').click();
  assert.deepEqual(clicks, [["update", "gemini"], ["skip", "codex"]]);
  renderStartupUpdateRows(root, offers, { id: "gemini", label: "Updating…" }, "Update Failed", actions);
  assert.ok([...root.querySelectorAll("button")].every((b) => b.disabled));
  assert.equal(root.querySelector(".deps-update").textContent, "Updating…");
  assert.equal(root.querySelector(".deps-error").textContent, "Update Failed");
  renderStartupUpdateRows(root, offers, null, null, actions);
  assert.ok([...root.querySelectorAll("button")].every((b) => !b.disabled));
  // A CLI with a live tab keeps Skip but waits on Update, with the reason in the row.
  renderStartupUpdateRows(root, offers, null, null, { ...actions, blocked: (u) => u.id === "claude" ? "Close claude Tabs First" : null });
  assert.equal(root.querySelector('[data-cli="claude"] .deps-update').disabled, true);
  assert.equal(root.querySelector('[data-cli="claude"] .deps-skip').disabled, false);
  assert.equal(root.querySelector('[data-cli="claude"] .deps-note').textContent, "Close claude Tabs First");
  assert.equal(root.querySelector('[data-cli="codex"] .deps-update').disabled, false);
  assert.equal(root.querySelectorAll(".deps-note").length, 1);
});

test("Gemini preload hides both spawn signatures without dropping arguments or existing options", async () => {
  const original = cp.spawn;
  const calls = [];
  cp.spawn = (...args) => { calls.push(args); return "child"; };
  try {
    await import(`data:text/javascript;base64,${Buffer.from(GEMINI_HIDDEN_PRELOAD).toString("base64")}`);
    cp.spawn("npm install", { shell: true, detached: true, stdio: "ignore" });
    cp.spawn("node", ["gemini.js"], { env: { keep: "yes" }, windowsHide: false });
    cp.spawn("node", undefined, { env: { keep: "yes" } });
    assert.deepEqual(calls, [
      ["npm install", { shell: true, detached: true, stdio: "ignore", windowsHide: true }],
      // Only detached children are hidden; attached ones keep the caller's options untouched.
      ["node", ["gemini.js"], { env: { keep: "yes" }, windowsHide: false }],
      ["node", undefined, { env: { keep: "yes" } }],
    ]);
  } finally {
    cp.spawn = original;
    (await import("node:module")).syncBuiltinESMExports();
  }
});

test("configured Gemini flags survive wrapping and the caller's args stay unchanged", () => {
  const args = ["-NoExit", "-Command", "gemini --model flash"];
  const wrapped = geminiHiddenArgs(args);
  assert.deepEqual(args, ["-NoExit", "-Command", "gemini --model flash"]);
  assert.equal(wrapped[0], "-NoExit");
  assert.ok(wrapped[2].includes("gemini --model flash } finally"));
  assert.ok(wrapped[2].includes("$env:NODE_OPTIONS = $vidarGeminiNodeOptions"));
  const script = ["-File", "custom-gemini.ps1"];
  assert.equal(geminiHiddenArgs(script), script);
  const bash = ["-c", "gemini"];
  assert.equal(geminiHiddenArgs(bash, "bash.exe"), bash);
  assert.equal(geminiHiddenArgs(undefined), undefined);
});

test("codex skew toasts once per version pair across launches", async () => {
  const state = {};
  let skew = null;
  const toasts = [];
  const launch = () => warnCodexSkew({
    check: async () => skew,
    readState: async () => JSON.parse(JSON.stringify(state)),
    patch: async (entries) => { Object.assign(state, entries); },
    toast: (text) => toasts.push(text),
  });
  await launch();
  assert.deepEqual(toasts, [], "no skew: no toast");
  skew = { hosted: "0.162.1-win32-x64", tabs: "0.163.0-win32-x64" };
  await launch();
  assert.deepEqual(toasts, [SKEW_TEXT], "skew detected: one toast");
  assert.equal(state[SKEW_KEY], "0.162.1-win32-x64>0.163.0-win32-x64");
  await launch();
  assert.equal(toasts.length, 1, "same pair on the next launch: none");
  skew = { hosted: "0.162.1-win32-x64", tabs: "0.164.0-win32-x64" };
  await launch();
  assert.equal(toasts.length, 2, "new pair: one toast");
  skew = null;
  await launch();
  assert.equal(toasts.length, 2, "skew gone: none");
  assert.equal(SKEW_TEXT, "Codex updated. Hosted sessions keep the old version until Falcon is refreshed.");
});
