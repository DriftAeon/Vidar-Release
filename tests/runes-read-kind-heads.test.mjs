// The Bare read view groups each runeset card's runes under nested kind heads (Modify keeps its flat tray).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const kindGroups = await import("../src/runes/kind-groups.ts");

const set = { library: "kit", set: "kit" };
const m = (id, kind) => ({ set, library: "kit", id, kind, activate: "always", description: id, section: [], recall: false, body: "b", drift: false });
const view = (runes) => ({ vault: { id: "v", runesets: [{ source: set }], runes: [], lockedUtc: null }, runes, drift: [], warnings: [] });
function draw(runes, extra = {}) {
  const root = document.createElement("div");
  const tracked = [];
  root.append(...vaultModify({ view: view(runes), removed: [], pending: null, busy: false, card: { openInDocument: () => {}, note: () => {} },
    trackOpen: (d, key, dflt) => { tracked.push([key, dflt]); }, edit: () => {}, pick: async () => {}, ...extra }));
  return { root, tracked };
}
const heads = (root) => [...root.querySelectorAll("details[data-kind-head]")].map((d) =>
  [d.dataset.kindHead, d.querySelector(".runes-sn").textContent, d.querySelector(".runes-sc").textContent, d.className,
    [...d.querySelectorAll(".runes-rn")].map((c) => c.dataset.id)]);

test("read mode: kind heads in Modify order, then KINDS order, each with its cards", () => {
  const { root, tracked } = draw([m("p", "plugin"), m("m", "mcp"), m("h", "hook"), m("s", "skill"), m("a", "agent"), m("r", "rule")], { readOnly: true });
  assert.deepEqual(heads(root), [
    ["skill", "Skills", "1/1", "runes-set hue-skill", ["s"]],
    ["agent", "Agents", "1/1", "runes-set hue-agent", ["a"]],
    ["hook", "Hooks", "1/1", "runes-set hue-hook", ["h"]],
    ["rule", "Rules", "1/1", "runes-set hue-rule", ["r"]],
    ["mcp", "MCPs", "1/1", "runes-set hue-mcp", ["m"]],
    ["plugin", "Plugins", "1/1", "runes-set hue-plugin", ["p"]],
  ]);
  assert.ok(tracked.filter(([k]) => k.startsWith("kind:")).every(([, dflt]) => dflt === true), "kind heads default open");
});

test("read mode: a single-kind runeset keeps its one head; an empty kind draws none", () => {
  const { root } = draw([m("a", "fact"), m("b", "fact")], { readOnly: true });
  assert.deepEqual(heads(root).map((h) => [h[1], h[2], h[4]]), [["Facts", "2/2", ["a", "b"]]]);
});

test("a card under a kind head keeps its kind icon (user reversed hiding it, 2026-10-29)", () => {
  const { root } = draw([m("s", "skill")], { readOnly: true });
  assert.ok(root.querySelector("details[data-kind-head] .runes-rn .runes-kslot"));
  const css = readFileSync(new URL("../src/styles/runes.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\[data-kind-head\] \.runes-kslot[^{]*\{ display: none/);
});

test("a kind group sorts on before off, then by name ignoring case; the kind groups keep their order", () => {
  const { root } = draw([m("guard-install", "hook"), m("Guard-bash", "hook"), m("alpha", "hook"), m("s", "skill")], { readOnly: true });
  const hook = [...root.querySelectorAll("details[data-kind-head='hook'] .runes-rn")].map((c) => c.dataset.id);
  assert.deepEqual(hook, ["alpha", "Guard-bash", "guard-install"]);
  assert.deepEqual([...root.querySelectorAll("details[data-kind-head]")].map((d) => d.dataset.kindHead), ["skill", "hook"]);
  const { sortRunes } = kindGroups;
  assert.deepEqual(sortRunes([{ n: "b", off: true }, { n: "C", off: false }, { n: "a", off: true }, { n: "c2", off: false }], (x) => x.off, (x) => x.n).map((x) => x.n), ["C", "c2", "a", "b"]);
});

test("Modify keeps its flat tray with no kind heads", () => {
  const { root } = draw([m("s", "skill"), m("r", "rule")]);
  assert.equal(root.querySelectorAll("details[data-kind-head]").length, 0);
  assert.equal(root.querySelectorAll(".runes-rn").length, 2);
});
