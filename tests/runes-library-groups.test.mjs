// The Rune Library groups by runeset (view-library.ts): one runeset card per library runeset, shaped as the vault
// pane's (set head with its checkbox, kind groups inside), then the Rune Satchel holding every rune no shown runeset
// holds. The library read comes back filtered to the tab's agent, so a runeset whose members are all filtered out is
// left out and its runes never show.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { libraryPane } = await import("../src/runes/bare/view-library.ts");
const { runeGroups, SATCHEL_TITLE } = await import("../src/runes/bare/rune-groups.ts");
const P = await import("../src/runes/bare/vault-pending.ts");

const rune = (library, id, kind = "rule") => ({ id, library, set: null, kind, activate: "", description: "D", section: [], recall: false, body: "b", drift: false, path: `${id}.md` });
const ref = (library, id) => ({ library, id });
const set = (library, name, members, fixed = false) => ({ library, set: name, members, fixed });

function draw(runes, runesets, vault = { id: "v", runesets: [], runes: [], lockedUtc: null }) {
  const changes = new Map();
  const pend = { on: (t, b) => P.effectiveOn(changes, t, b), pending: (t) => P.isPending(changes, t), flip: (t, b) => P.flip(changes, t, b),
    set: (ts, on) => { for (const x of ts) P.setWanted(changes, x.target, x.base, on); }, get count() { return changes.size; }, staged: () => [...changes.values()] };
  const root = document.createElement("div");
  root.append(...libraryPane({ runes, runesets, view: { vault, runes: [], drift: [], warnings: [] }, changes, pend, still: false, busy: false,
    card: { openInDocument() {}, note() {} }, trackOpen() {}, deleting: null, askDelete() {}, confirmDelete() {}, cancelDelete() {} }));
  return { root, changes };
}
const heads = (root) => [...root.querySelectorAll(".runes-lib-groups > details.runes-set > .runes-set-head .runes-sn")].map((e) => e.textContent);
const ids = (card) => [...card.querySelectorAll("details.runes-rn")].map((d) => `${d.dataset.library}/${d.dataset.id}`);

test("runesets come first in reply order, the Rune Satchel last with every rune no runeset holds", () => {
  const runes = [rune("mine", "b"), rune("mine", "a", "skill"), rune("mine", "loose"), rune("base", "gate")];
  const { root } = draw(runes, [set("mine", "team", [ref("mine", "a"), ref("mine", "b"), ref("base", "gate")]), set("mine", "empty", [])]);
  assert.deepEqual(heads(root), ["Team", "Empty", "Rune Satchel"]);
  assert.equal(SATCHEL_TITLE, "Rune Satchel");
  assert.ok(!heads(root).includes("Runes"), "no group is titled Runes");
  const [team, , satchel] = root.querySelectorAll(".runes-lib-groups > details.runes-set");
  assert.equal(team.dataset.library, "mine");
  assert.equal(team.dataset.runeset, "team");
  // kind groups inside, as the vault pane's runeset cards (kind-groups.ts order: rules, then skills), names in order
  assert.deepEqual(ids(team), ["mine/b", "base/gate", "mine/a"]);
  assert.deepEqual([...team.querySelectorAll(":scope > details.runes-set")].length, 2, "one kind group per kind");
  assert.ok(team.querySelector(".runes-set-head.has-check > .runes-check"), "a runeset head carries its checkbox");
  assert.ok(satchel.classList.contains("runes-satchel"));
  assert.deepEqual(ids(satchel), ["mine/loose"]);
  assert.equal(satchel.querySelector(".runes-set-head > .runes-check"), null, "the satchel has no runeset to add");
});

test("a runeset's head checkbox stages the runeset; a row in it stages a one-off", () => {
  const runes = [rune("mine", "a"), rune("mine", "loose")];
  const { root, changes } = draw(runes, [set("mine", "team", [ref("mine", "a")])]);
  root.querySelector('.runes-check[data-keep="libset:mine/team"]').click();
  assert.deepEqual(P.pendingOps(changes), [{ op: "addRuneset", ref: { library: "mine", set: "team" } }]);
  root.querySelector('.runes-check[data-keep="lib:mine/loose"]').click();
  assert.deepEqual(P.pendingOps(changes).at(-1), { op: "addRune", ref: { library: "mine", id: "loose" } });
});

test("a placed runeset's head reads on", () => {
  const vault = { id: "v", runesets: [{ source: { library: "mine", set: "team" } }], runes: [], lockedUtc: null };
  const { root } = draw([rune("mine", "a")], [set("mine", "team", [ref("mine", "a")])], vault);
  assert.equal(root.querySelector('.runes-check[data-keep="libset:mine/team"]').getAttribute("aria-checked"), "true");
});

test("model filter: a runeset whose members the agent's read left out is hidden; a member it kept still shows", () => {
  // the read for this agent left out codex-only `cx` (frontmatter agent: codex), so only `a` and `shared` came back
  const runes = [rune("mine", "a"), rune("mine", "shared")];
  const sets = [set("mine", "codex-kit", [ref("mine", "cx")]), set("mine", "mixed", [ref("mine", "cx"), ref("mine", "shared")]), set("mine", "empty", [])]
    .map((s) => ({ source: { library: s.library, set: s.set }, members: s.members, on: false }));
  const g = runeGroups({ sets, runes });
  assert.deepEqual(g.sets.map((s) => [s.source.set, s.runes.map((r) => r.id)]), [["mixed", ["shared"]], ["empty", []]]);
  assert.deepEqual(g.satchel.map((o) => o.rune.id), ["a"]);
});

test("a rune naming its set joins it (an unlisted set appended off), and the satchel never repeats a rune", () => {
  const inSet = { ...rune("mine", "m"), set: { library: "mine", set: "kit" } };
  const g = runeGroups({ sets: [], runes: [inSet, rune("mine", "x"), rune("mine", "x")], off: [rune("mine", "x")] });
  assert.deepEqual(g.sets.map((s) => [s.source.set, s.on, s.runes.map((r) => r.id)]), [["kit", false, ["m"]]]);
  assert.deepEqual(g.satchel.map((o) => o.rune.id), ["x"]);
});

test("the title sits in a head row with the vault pane head's classes", () => {
  const { root } = draw(null, []);
  const head = root.querySelector(".runes-lib-head");
  assert.ok(head.classList.contains("wb-pane-head") && head.classList.contains("runes-head"));
  assert.equal(head.querySelector(".runes-lib-title").textContent, "Rune Library");
});

test("a library-pane runeset card takes the Satchel hue; the same runeset in the vault pane keeps its own", async () => {
  const { libCard } = await import("../src/runes/bare/view-vault.ts");
  const runes = [rune("installed", "a")];
  const host = { view: { warnings: [] }, loads: [], card: { openInDocument() {}, note() {} }, trackOpen() {} };
  const ctl = () => ({ tail: [], title: "", reason: null });
  const lib = libCard(host, runes, "Installed", "installed", false, ctl, () => false, undefined, () => false, "installed", true);
  const vault = libCard(host, runes, "Installed", "installed", false, ctl, () => false, undefined, () => false, "installed", false);
  assert.ok(lib.classList.contains("hue-set") && !lib.classList.contains("hue-installed"), lib.className);
  assert.ok(vault.classList.contains("hue-installed") && !vault.classList.contains("hue-set"), vault.className);
});
