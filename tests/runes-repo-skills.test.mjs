import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const { CODEX_FILES_TITLE, REPO_SKILLS_TITLE, TIP_CODEX_FILE, TIP_REPO_SKILL_OFF } = await import("../src/runes/bare/rune-groups.ts");
const rune = { library: "vidar", id: "guide", set: null, kind: "rule", activate: "always",
  description: "Guide", section: [], recall: false, body: "Guide", drift: false };
const view = { vault: { id: "main-codex", name: "Daily", hash: "h", lockedUtc: null, runesets: [],
  runes: [{ library: "vidar", id: "guide" }], pins: {} }, runes: [rune], warnings: [], drift: [] };

function modify(loads) {
  const root = document.createElement("div");
  root.className = "runes-bare";
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false, loads,
    card: { openInDocument() {}, note() {} }, trackOpen() {}, pick: async () => {} }));
  return root;
}
const loads = (extra) => ({ source: "rollout", files: [], truncated: false, ...extra });

test("Repo Skills card lists each turned-off name as a dimmed, read-only row", () => {
  const card = modify(loads({ repoSkillsOff: ["x", "y"] })).querySelector(".runes-repo-skills");
  assert.ok(card);
  assert.equal(card.querySelector(".runes-set-head").textContent.includes(REPO_SKILLS_TITLE), true);
  const rows = [...card.querySelectorAll("details[data-id]")];
  assert.deepEqual(rows.map((r) => r.dataset.id), ["x", "y"]);
  for (const r of rows) {
    assert.ok(r.title.includes(TIP_REPO_SKILL_OFF));
    assert.ok(!r.title.includes("Off in This Vault"), r.title);
    assert.ok(r.classList.contains("is-dim"));
  }
  assert.equal(card.querySelectorAll("input, .runes-check").length, 0);
});

test("Repo Skills rows draw with the off look an off vault rune gets; Codex Folder rows stay undimmed", () => {
  const offRune = { ...rune, id: "spare", description: "Spare", body: "Spare" };
  const root = document.createElement("div");
  root.className = "runes-bare";
  root.append(...vaultModify({ view: { ...view, off: [offRune] },
    removed: [], pending: null, busy: false, readOnly: true, loads: loads({ repoSkillsOff: ["x"], codexFiles: [".codex/config.toml"] }),
    card: { openInDocument() {}, note() {} }, trackOpen() {}, pick: async () => {} }));
  const vaultOff = root.querySelector(".runes-satchel details[data-id='spare']");
  assert.ok(vaultOff, root.innerHTML);
  const offClasses = [...vaultOff.classList].filter((c) => c.startsWith("is-"));
  assert.ok(offClasses.includes("is-dim"), offClasses.join(" "));
  const repo = root.querySelector(".runes-repo-skills details[data-id='x']");
  for (const c of offClasses) assert.ok(repo.classList.contains(c), c);
  const folder = root.querySelector(".runes-trusted-folder details[data-id]");
  assert.ok(!folder.classList.contains("is-dim"));
});

test("Codex Folder card lists each trusted .codex file as a read-only row named by its path", () => {
  const card = modify(loads({ codexFiles: [".codex/config.toml"] })).querySelector(".runes-trusted-folder");
  assert.ok(card);
  assert.equal(card.querySelector(".runes-set-head").textContent.includes(CODEX_FILES_TITLE), true);
  const rows = [...card.querySelectorAll("details[data-id]")];
  assert.deepEqual(rows.map((r) => r.dataset.id), ["codex-config-toml"]);
  assert.ok(rows[0].title.includes(TIP_CODEX_FILE));
  assert.ok(!rows[0].title.includes("Off in This Vault"), rows[0].title);
  assert.ok(!rows[0].classList.contains("is-dim"));
  assert.ok(rows[0].textContent.includes(".codex/config.toml"), rows[0].textContent);
  assert.equal(card.querySelectorAll("input, .runes-check").length, 0);
});

test("no Codex Folder card without the field", () => {
  assert.equal(modify(loads({})).querySelector(".runes-trusted-folder"), null);
  assert.equal(modify(null).querySelector(".runes-trusted-folder"), null);
});

test("no Repo Skills card without the field", () => {
  assert.equal(modify(loads({})).querySelector(".runes-repo-skills"), null);
  assert.equal(modify(null).querySelector(".runes-repo-skills"), null);
});
