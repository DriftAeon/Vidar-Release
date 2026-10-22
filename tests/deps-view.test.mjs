// Dependencies page view: renderDependencies is pure DOM over the catalog, the detect
// report, the detection error and the setup blocker. jsdom stands in for WebView2.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { packsDir } from "../tools/lib/release-layout.mjs";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
});
Object.assign(globalThis, { SVGElement: window.SVGElement });
const { renderDependencies, usedByLabels } = await import("../src/settings/dependencies-view.ts");
// icons.ts has no imports, so node loads it directly; the page passes the same factory.
const { lucide } = await import("../src/icons.ts");
// icon-img.ts imports only the JSON manifest (with its extension), so node loads it too.
const { iconImg } = await import("../src/icon-img.ts");

// The page's catalog at runtime: the static entries, then the pack deps (claude's and codex's from their packs).
const catalog = JSON.parse(readFileSync(new URL("../contracts/dependencies.json", import.meta.url), "utf8"));
for (const id of ["claude", "codex"]) catalog.deps.push(...JSON.parse(readFileSync(join(packsDir(), id, "pack.json"), "utf8")).module.deps);

function actions() {
  const calls = { recheck: 0, setup: 0, copy: [], openUrl: [] };
  return {
    calls,
    recheck: () => { calls.recheck++; },
    setup: () => { calls.setup++; },
    copy: (t) => { calls.copy.push(t); },
    openUrl: (u) => { calls.openUrl.push(u); },
  };
}

function render(report, error, blocker, acts = actions()) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  renderDependencies(root, catalog, report, error, blocker, acts, [], {}, lucide, iconImg);
  return root;
}

/** The colour icon a row's mark draws, read back from its img src (/icons/color/<name>.svg). */
function glyphOf(mark) {
  return mark.querySelector("img.icn")?.getAttribute("src")?.match(/\/icons\/color\/([\w-]+)\./)?.[1];
}

function allFoundExcept(...ids) {
  return { deps: catalog.deps.map((d) => ({ id: d.id, found: !ids.includes(d.id) })) };
}

test("a missing required entry is marked and offers its winget command", () => {
  const dep = catalog.deps.find((d) => d.required && d.install.winget);
  assert.ok(dep, "catalog has no required entry with a winget route");
  const root = render(allFoundExcept(dep.id), null, null);
  const row = root.querySelector(`.deps-row[data-id="${dep.id}"]`);
  assert.ok(row, `no row for ${dep.id}`);
  assert.ok(row.classList.contains("is-missing"));
  const texts = [...row.querySelectorAll(".deps-copy[data-text]")].map((b) => b.dataset.text);
  assert.ok(texts.includes(`winget install --id ${dep.install.winget} -e`), `copy texts: ${JSON.stringify(texts)}`);
  const others = [...root.querySelectorAll(".deps-row.is-missing")].map((r) => r.dataset.id);
  assert.deepEqual(others, [dep.id]);
});

test("a missing Codex CLI row says where to run the command and what Recheck does", () => {
  const root = render(allFoundExcept("codex"), null, null);
  const row = root.querySelector('.deps-row[data-id="codex"]');
  assert.ok(row.classList.contains("is-missing"));
  assert.ok(row.querySelector('.deps-copy[data-text="npm install -g @openai/codex"]'));
  // Optional misses fold into Ready as dimmed items, so the note rides in the tooltip.
  const note = row.title;
  assert.match(note, /PowerShell/);
  assert.match(note, /installs nothing/);
  assert.match(note, /Recheck/);
});

test("Node's usage names Rendered Codex", () => {
  const root = render(allFoundExcept("node"), null, null);
  assert.match(root.querySelector('.deps-row[data-id="node"]').title, /Rendered Codex/);
});

// The running set as moduleListed reads it: core-level modules always, plus the set's include
// (src-tauri modules/set.rs). The page cuts usedBy the same way (dependencies.ts shippedDeps).
function nodeTipFor(listed) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const deps = catalog.deps.map((d) => ({ ...d, usedBy: usedByLabels(d, listed) }));
  renderDependencies(root, { ...catalog, deps }, allFoundExcept(), null, null, actions(), [], {}, lucide);
  return root.querySelector('.deps-row[data-id="node"]').title;
}

test("Node's usage lists only the features the running set ships", (t) => {
  const modules = JSON.parse(readFileSync(new URL("../contracts/modules.json", import.meta.url), "utf8"));
  const setTip = (id) => {
    const set = JSON.parse(readFileSync(new URL(`../tools/release/sets/${id}.json`, import.meta.url), "utf8"));
    const core = modules.core.filter((m) => m.level === "core").map((m) => m.id);
    const ids = new Set([...core, ...set.include]);
    return nodeTipFor((m) => ids.has(m));
  };
  // The release set files are not shipped; without them only the set-independent checks below run.
  if (existsSync(new URL("../tools/release/sets/codex.json", import.meta.url))) {
    const codexTip = setTip("codex");
    assert.equal(codexTip.split("\n")[0], "Used by Rendered Codex");
    assert.doesNotMatch(codexTip, /claude/i);
    const claudeTip = setTip("claude");
    assert.equal(claudeTip.split("\n")[0], "Used by Claude Rendered Tabs");
    assert.doesNotMatch(claudeTip, /codex/i);
  } else {
    t.diagnostic("per-set tips skipped: tools/release/sets/codex.json is not in this tree (not shipped)");
  }
  assert.equal(nodeTipFor(() => true).split("\n")[0], "Used by Rendered Codex, Claude Rendered Tabs");
  // A plain-string entry (every pack dep) is never cut.
  assert.deepEqual(usedByLabels({ usedBy: ["Acme Tabs"] }, () => false), ["Acme Tabs"]);
});

test("a disabled Setup Via Agent shows the missing-agent reason as visible text", () => {
  const reason = "No Setup Agent Found: Install Codex CLI, Then Recheck";
  // Setup shows only with a required miss (node); the optional Codex CLI alone would hide it.
  const root = render(allFoundExcept("codex", "node"), null, reason);
  assert.equal(root.querySelector(".deps-setup").disabled, true);
  assert.equal(root.querySelector(".deps-blocker").textContent, reason);
});

// Unknown state (not loaded, failed with no prior report) must not read as "everything missing".
test("a null report with no error marks nothing missing", () => {
  const root = render(null, null, null);
  assert.equal(root.querySelectorAll(".deps-row.is-missing").length, 0);
});

test("a detection error is shown", () => {
  const root = render(null, "detect_dependencies failed", null);
  assert.ok(root.querySelector(".deps-error"));
});

test("a setup blocker disables Set up and shows the reason", () => {
  const blocker = "Claude Code is missing";
  const root = render(allFoundExcept("claude", "node"), null, blocker);
  const setup = root.querySelector(".deps-setup");
  assert.ok(setup, "no .deps-setup");
  assert.equal(setup.disabled, true);
  const reason = root.querySelector(".deps-blocker");
  assert.ok(reason, "no .deps-blocker");
  assert.equal(reason.hidden, false);
  assert.ok(reason.textContent.includes(blocker), `blocker text: ${reason.textContent}`);
});

test("all found hides Setup and the blocker line", () => {
  const root = render(allFoundExcept(), null, "Nothing Required Missing");
  assert.equal(root.querySelector(".deps-setup"), null);
  assert.equal(root.querySelector(".deps-blocker"), null);
});

// First-run smoke 2026-10-08: a logged-out Claude Code read as ✓. Found + warning must not.
test("a found entry with a warning is marked, not ticked, and offers its login command", () => {
  const report = allFoundExcept();
  report.deps.find((d) => d.id === "claude").warning = "Not Logged In";
  const root = render(report, null, null);
  const row = root.querySelector('.deps-row[data-id="claude"]');
  assert.ok(row.classList.contains("is-warning"));
  assert.equal(row.querySelector(".deps-mark").getAttribute("aria-label"), "Warning");
  assert.equal(glyphOf(row.querySelector(".deps-mark")), "warning");
  assert.equal(row.querySelector(".deps-where").textContent, "Not Logged In");
  const login = catalog.deps.find((d) => d.id === "claude").install.login;
  assert.deepEqual([...row.querySelectorAll(".deps-copy[data-text]")].map((b) => b.dataset.text), [login]);
  assert.equal(root.querySelectorAll(".deps-row.is-missing").length, 0);
});

test("marks are colour icons, never text glyphs: found check, required dismiss, optional dismiss dimmed", () => {
  const req = catalog.deps.find((d) => d.required);
  const opt = catalog.deps.find((d) => !d.required && d.id !== "claude");
  const report = { root: "C:\\V", deps: catalog.deps.map((d) => ({ id: d.id, found: d.id !== req.id && d.id !== opt.id })) };
  const root = render(report, null, null);
  for (const m of root.querySelectorAll(".deps-row[data-id] .deps-mark")) {
    assert.equal(m.textContent, "", "a mark carries text");
    assert.ok(glyphOf(m), "a mark without an icon");
    assert.equal(m.title, m.getAttribute("aria-label"), "a mark's tooltip names its state");
  }
  const mark = (id) => root.querySelector(`.deps-row[data-id="${id}"] .deps-mark`);
  assert.equal(glyphOf(mark(req.id)), "dismiss-circle");
  assert.equal(mark(req.id).getAttribute("aria-label"), "Missing");
  assert.ok(!mark(req.id).classList.contains("is-dim"));
  assert.equal(glyphOf(mark(opt.id)), "dismiss-circle");
  assert.equal(mark(opt.id).getAttribute("aria-label"), "Not Installed");
  assert.ok(mark(opt.id).classList.contains("is-dim"));
  assert.ok(root.querySelector(`.deps-row[data-id="${opt.id}"]`).classList.contains("is-optional"));
  const found = catalog.deps.find((d) => d.id !== req.id && d.id !== opt.id);
  assert.equal(glyphOf(mark(found.id)), "check-circle");
  const unknown = render(null, null, null).querySelector(".deps-row .deps-mark");
  assert.equal(glyphOf(unknown), "question-circle", "unknown before a report");
  assert.ok(unknown.classList.contains("is-dim"));
});

test("a miss a restart would fix takes the warning mark, named by its detail", () => {
  const opt = catalog.deps.find((d) => !d.required && d.id !== "claude");
  const report = allFoundExcept(opt.id);
  Object.assign(report.deps.find((d) => d.id === opt.id), { detail: "Installed After Launch: Restart Vidar" });
  const root = render(report, null, null);
  const mark = root.querySelector(`.deps-row[data-id="${opt.id}"] .deps-mark`);
  assert.equal(glyphOf(mark), "warning");
  assert.equal(mark.title, "Installed After Launch: Restart Vidar");
});

test("the summary's state class follows the worst state: missing over warning over done", () => {
  const req = catalog.deps.find((d) => d.required);
  const stateOf = (report) => {
    const root = render(report, null, null);
    const s = root.querySelector(".deps-bar .deps-summary");
    const cls = ["is-checking", "is-done", "is-warning", "is-missing"].filter((c) => s.classList.contains(c));
    assert.deepEqual([...root.querySelector(".deps-bar").classList].filter((c) => c.startsWith("is-")), cls, "bar and summary agree");
    return cls.join(" ");
  };
  const warned = (report) => { report.deps.find((d) => d.id === "claude").warning = "Not Logged In"; return report; };
  assert.equal(stateOf(null), "is-checking");
  assert.equal(stateOf(allFoundExcept()), "is-done");
  assert.equal(stateOf(warned(allFoundExcept())), "is-warning");
  assert.equal(stateOf(warned(allFoundExcept(req.id))), "is-missing");
});

test("Open Site and Setup Via Agent are icon buttons with a tooltip and an aria-label", () => {
  const node = catalog.deps.find((d) => d.id === "node");
  assert.ok(node.install.url, "node has no site url");
  const root = render(allFoundExcept("node"), null, null);
  const open = root.querySelector('.deps-row[data-id="node"] .deps-site');
  assert.equal(open.textContent, "");
  assert.match(open.querySelector("img.icn")?.getAttribute("src") ?? "", /\/globe\./, "Open Site has no globe");
  assert.equal(open.title, `Open site: ${node.install.url}`);
  assert.equal(open.getAttribute("aria-label"), open.title);
  const setup = root.querySelector(".deps-setup");
  assert.equal(setup.textContent, "");
  assert.match(setup.querySelector("img.icn").getAttribute("src"), /\/agent\./);
  assert.equal(setup.title, "Setup via Agent");
  assert.equal(setup.getAttribute("aria-label"), "Setup via Agent");
});

test("nothing required missing reads as done: no Setup, no blocker; optional rows keep their install line", () => {
  const opt = catalog.deps.find((d) => !d.required && d.install.winget);
  assert.ok(opt, "catalog has no optional entry with a winget route");
  const root = render({ root: "C:\\V", ...allFoundExcept(opt.id) }, null, "Nothing Required Missing");
  const summary = root.querySelector(".deps-bar .deps-summary");
  assert.ok(summary.classList.contains("is-done"));
  assert.equal(summary.textContent, "All Required Found");
  assert.equal(root.querySelector(".deps-setup"), null);
  assert.equal(root.querySelector(".deps-blocker"), null);
  const row = root.querySelector(`.deps-row[data-id="${opt.id}"]`);
  assert.ok(row.classList.contains("is-missing") && row.classList.contains("is-optional"));
  assert.ok(row.querySelector(`.deps-copy[data-text="winget install --id ${opt.install.winget} -e"]`));
  assert.ok(root.querySelector(".deps-recheck svg"), "Recheck keeps its icon");
  assert.ok(root.querySelector(".deps-open-voice-slots"), "Voice Slots link kept");
});

test("a required miss shows its count in the bar and keeps Setup", () => {
  const req = catalog.deps.find((d) => d.required);
  const root = render({ root: "C:\\V", ...allFoundExcept(req.id) }, null, null);
  const summary = root.querySelector(".deps-bar .deps-summary");
  assert.ok(summary.classList.contains("is-missing"));
  assert.equal(summary.textContent, "1 Required Missing");
  assert.equal(root.querySelector(".deps-setup").disabled, false);
  assert.equal(summary.title, "C:\\V", "the root folder is the summary's tooltip");
  assert.equal(root.querySelector(".deps-folder-path"), null);
});

test("Re-check calls actions.recheck once", () => {
  const acts = actions();
  const root = render(allFoundExcept("node"), null, null, acts);
  const btn = root.querySelector(".deps-recheck");
  assert.ok(btn, "no .deps-recheck");
  btn.click();
  assert.equal(acts.calls.recheck, 1);
});

test("Trust Current appears only on a pack row Changed Since Pinned", () => {
  const asked = [];
  const acts = { ...actions(), askTrust: (f) => { asked.push(f); }, trust: () => {}, cancelTrust: () => {} };
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  renderDependencies(root, catalog, null, null, null, acts, [
    { name: "acme", reason: "Changed Since Pinned", folder: "acme" },
    { name: "beta", reason: "Model -acme Does Not Match modelPattern", folder: "beta" },
    { name: "Gamma", reason: "Changed Since Pinned" },
  ], {}, lucide, iconImg);
  const buttons = [...root.querySelectorAll(".deps-row[data-module] .vs-trust")];
  assert.deepEqual(buttons.map((b) => b.closest(".deps-row").getAttribute("data-module")), ["acme"]);
  assert.equal(buttons[0].textContent, "");
  assert.match(buttons[0].querySelector("img.icn").getAttribute("src"), /\/shield\./);
  assert.equal(buttons[0].title, "Trust current: re-pin this pack as it is now");
  assert.equal(buttons[0].getAttribute("aria-label"), buttons[0].title);
  buttons[0].click();
  assert.deepEqual(asked, ["acme"]);
});

test("Check for Updates is an icon button in the page head, disabled while running, with its note", () => {
  let clicks = 0;
  const acts = { ...actions(), openVoiceSlots() {}, checkUpdates: () => { clicks++; } };
  const paint = (state) => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    renderDependencies(root, catalog, null, null, null, acts, [], {}, lucide, iconImg, state);
    return root;
  };
  let root = paint({});
  const btn = root.querySelector(".deps-bar .deps-check-updates");
  assert.equal(btn.textContent, "");
  assert.ok(btn.querySelector("svg"), "no icon");
  assert.equal(btn.title, "Check for Updates");
  assert.equal(btn.getAttribute("aria-label"), btn.title);
  assert.equal(btn.disabled, false);
  btn.click();
  assert.equal(clicks, 1);
  root = paint({ checking: true });
  assert.equal(root.querySelector(".deps-check-updates").disabled, true);
  assert.equal(root.querySelector(".deps-check-updates").title, "Checking…");
  root = paint({ note: "All CLIs Up to Date" });
  assert.ok([...root.querySelectorAll(".deps-note")].some((n) => n.textContent === "All CLIs Up to Date"));
});

const sectionIds = (root, section) => [...root.querySelectorAll(`.${section} .deps-row[data-id]`)].map((r) => r.dataset.id);

test("rows group by state: problems are cards under Needs You, everything working folds into Ready", () => {
  const req = catalog.deps.find((d) => d.required);
  const opt = catalog.deps.find((d) => !d.required && d.id !== "claude" && d.id !== "codex");
  const report = { root: "C:\\V", ...allFoundExcept(req.id, opt.id) };
  report.deps.find((d) => d.id === "claude").warning = "Not Logged In";
  const root = render(report, null, null);
  const titles = [...root.querySelectorAll(".deps-section-title")].map((h) => h.textContent);
  assert.deepEqual(titles, ["Needs You", "Ready"]);
  // Needs You: the required miss, then the warning; each a confirm-style card with a title-tile head.
  assert.deepEqual(sectionIds(root, "deps-needs"), [req.id, "claude"]);
  for (const c of root.querySelectorAll(".deps-needs .deps-card")) {
    assert.ok(c.classList.contains("vs-confirm"));
    assert.ok(c.querySelector(".swap-confirm-head .title-tile .deps-mark"), "head without a tile mark");
    assert.ok(c.querySelector(".swap-confirm-body"));
  }
  // Ready: the rest in catalog order, the dimmed optional miss included, Voice Slots last; no Required/Optional split.
  const ready = sectionIds(root, "deps-ready");
  assert.deepEqual(ready, catalog.deps.map((d) => d.id).filter((id) => id !== req.id && id !== "claude"));
  assert.ok(ready.includes(opt.id));
  assert.equal(root.querySelector(".deps-ready .deps-row:last-child").dataset.link, "voice-slots");
  assert.equal(root.querySelectorAll(".deps-needs .deps-item").length, 0);
  assert.equal(root.querySelectorAll(".deps-ready .deps-card").length, 0);
  assert.ok(![...root.querySelectorAll(".deps-section-title")].some((h) => /Required|Optional/.test(h.textContent)));
});

test("an all-found report has no Needs You group", () => {
  const root = render(allFoundExcept(), null, null);
  assert.equal(root.querySelector(".deps-needs"), null);
  assert.deepEqual([...root.querySelectorAll(".deps-section-title")].map((h) => h.textContent), ["Ready"]);
});

test("a CLI with a newer release is a Needs You card with its versions, Update and Skip; Updating… shows while it runs", () => {
  const calls = [];
  const acts = { ...actions(), updateCli: (u, skip) => { calls.push([u.id, skip]); } };
  const gemini = { id: "gemini", label: "Gemini CLI", installed: "0.65.0", latest: "0.66.0" };
  const paint = (busy) => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    renderDependencies(root, catalog, allFoundExcept(), null, null, acts, [], {}, lucide, iconImg, {}, { updates: [gemini], busy });
    return root;
  };
  let root = paint(null);
  const c = root.querySelector('.deps-needs .deps-card[data-id="gemini"]');
  assert.ok(c, "no update card");
  assert.ok(c.classList.contains("is-update"));
  assert.equal(c.querySelector(".deps-where").textContent, "0.65.0 → 0.66.0");
  assert.equal(c.querySelector(".deps-mark").getAttribute("aria-label"), "Update Available");
  c.querySelector(".deps-update").click();
  c.querySelector(".deps-skip").click();
  assert.deepEqual(calls, [["gemini", false], ["gemini", true]]);
  // A CLI without a known newer release shows no version.
  assert.equal(root.querySelector('.deps-ready .deps-row[data-id="pi"]').textContent.match(/\d+\.\d+/), null);
  root = paint({ id: "gemini", label: "Updating…" });
  const u = root.querySelector('.deps-card[data-id="gemini"] .deps-update');
  assert.equal(u.textContent, "Updating…");
  assert.equal(u.disabled, true);
  assert.equal(root.querySelector('.deps-card[data-id="gemini"] .deps-skip').disabled, true);
});

test("a pack awaiting Trust confirm asks inside its own card", () => {
  const acts = { ...actions(), askTrust() {}, trust() {}, cancelTrust() {} };
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  renderDependencies(root, catalog, allFoundExcept(), null, null, acts,
    [{ name: "acme", reason: "Changed Since Pinned", folder: "acme" }], { confirming: "acme" }, lucide, iconImg);
  const c = root.querySelector('.deps-needs .deps-card[data-module="acme"]');
  assert.equal(c.querySelector(".vs-confirm-text").textContent, "Re-Pin Pack acme As It Is Now?");
  assert.equal(c.querySelector(".swap-yes").textContent, "Trust");
  assert.equal(c.querySelector(".swap-no").textContent, "Cancel");
  assert.equal(root.querySelectorAll(".vs-confirm .vs-confirm").length, 0, "a confirm box inside a confirm box");
});
