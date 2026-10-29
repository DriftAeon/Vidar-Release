// Notion facets, bands and items (src/notion/facets.ts, model.ts): chip types and placement, the
// 12-facet cap, the group rule and its tones, "None" for empty values, the top-level bands, error copy and
// the partial-note plural.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const PREFS = `const s = (globalThis.__prefs ??= { store: {}, sets: [] });
  export function getPref(k) { return s.store[k]; }
  export function setPref(k, v) { s.sets.push([k, v]); s.store[k] = v; return true; }`;
setupDom({ stubs: { prefs: PREFS } });
const { buildBrowser } = await import("../src/browser/shell.ts");
const { EDITED, toneForColor, NONE, MAX_FACETS, planFor, groupOf, toneFor, topFacets, valueLabel } = await import("../src/notion/facets.ts");
const { hitItem, rowItem, errorCopy, connectCopy, partialNote, pageFields, subpageItems } = await import("../src/notion/model.ts");

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const prop = (pid, name, type, options = [], groups = []) => ({
  id: pid, name, type, options: options.map((o) => ({ name: o, color: "default" })), groups,
});
const STATUS = prop("st%3Aa", "Status", "status", ["Not started", "In progress", "In review", "Blocked", "Done", "Loose"], [
  { name: "To-do", options: ["Not started"] },
  { name: "In progress", options: ["In review", "In progress", "Blocked"] },
  { name: "Complete", options: ["Done", "Gone"] },
]);
const source = (props) => ({ id: id(0xd01), title: "Example Tasks", url: "https://www.notion.so/x", props });
const BASE = [
  prop("title", "Name", "title"),
  STATUS,
  prop("ty~1", "Type", "select", ["Bug", "Task"]),
  prop("pr_1", "Priority", "select", ["High", "Low"]),
  prop("tg.1", "Tags", "multi_select", ["a", "b"]),
  prop("ow:1", "Owner", "people"),
  prop("dn-1", "Done?", "checkbox"),
  prop("nt1", "Notes", "rich_text"),
  prop("nm1", "Points", "number"),
  prop("dt1", "Due", "date"),
  prop("fx1", "Formula", "formula"),
  prop("rl1", "Related", "relation"),
  prop("url1", "Link", "url"),
];
const row = (values, extra = {}) => ({ id: id(1), title: "Row", url: "https://www.notion.so/r", lastEdited: "2026-10-16T12:00:00.000Z", values, ...extra });

test("chips come only from status, select, multi_select, people and checkbox; Edited is the last More facet", () => {
  const plan = planFor(source(BASE));
  assert.deepEqual(plan.facets.map((f) => [f.id, f.place, f.kind]), [
    ["st%3Aa", "top", "multi"], ["pr_1", "top", "multi"], ["ty~1", "top", "multi"],
    ["dn-1", "more", "multi"], ["ow:1", "more", "multi"], ["tg.1", "more", "multi"],
    [EDITED, "more", "age"],
  ]);
  assert.deepEqual(plan.props, ["title", "st%3Aa", "pr_1", "ty~1", "dn-1", "ow:1", "tg.1"], "title then the chips");
  assert.deepEqual(plan.fields.map((p) => p.name), ["Done?", "Owner", "Priority", "Status", "Tags", "Type"], "card fields by name");
});

test("the top row holds at most 3 and the plan at most 12 facets", () => {
  const many = [STATUS, ...Array.from({ length: 20 }, (_, i) => prop(`s${i}`, `Sel ${String(i).padStart(2, "0")}`, "select", ["x"]))];
  const plan = planFor(source(many));
  assert.equal(plan.facets.length, MAX_FACETS);
  assert.equal(plan.facets.filter((f) => f.place === "top").length, 3);
  assert.equal(plan.facets.at(-1).id, EDITED);
  assert.deepEqual(plan.facets.slice(0, 3).map((f) => f.label), ["Status", "Sel 00", "Sel 01"]);
  assert.deepEqual(plan.facets.slice(3, 5).map((f) => f.label), ["Sel 02", "Sel 03"], "the rest by name behind More");
});

test("the top level has only Edited, behind More", () => {
  assert.deepEqual(topFacets().map((f) => [f.id, f.place, f.kind, f.label]), [[EDITED, "more", "age", "Edited"]]);
});

test("status groups band per option in groups[] order then option order, toned from the group", () => {
  const plan = planFor(source(BASE));
  const band = (v) => groupOf(plan, { "st%3Aa": v === null ? [] : [v] });
  const order = ["Not started", "In progress", "In review", "Blocked", "Done", "Loose"].map((v) => [v, band(v).group.rank, band(v).group.tone]);
  assert.deepEqual(order, [
    ["Not started", 0, "todo"], ["In progress", 1, "progress"], ["In review", 2, "review"],
    ["Blocked", 3, "blocked"], ["Done", 4, "done"], ["Loose", 5, "neutral"],
  ]);
  assert.equal(band("In review").status, "In review");
  const empty = band(null);
  assert.deepEqual([empty.group.label, empty.group.tone, empty.status], ["No Status", "neutral", ""]);
  assert.ok(empty.group.rank > band("Loose").group.rank, "No Status is last");
  assert.equal(band("Archived").group.rank, 6, "an option missing from the schema follows the known ones");
});

test("the first status by case-insensitive name groups, even when it is not first in the schema", () => {
  const b = prop("b", "beta", "status", ["One"]);
  const a = prop("a", "Alpha", "status", ["Two"]);
  const plan = planFor(source([b, a]));
  assert.equal(plan.group.prop.id, "a");
  assert.equal(plan.facets[0].id, "a");
});

test("exactly one select groups in option order with None last; two selects are flat", () => {
  const one = planFor(source([prop("ty", "Type", "select", ["Task", "Bug"]), prop("tg", "Tags", "multi_select")]));
  const t = (v) => groupOf(one, { ty: v ? [v] : [] });
  assert.deepEqual([t("Task").group.rank, t("Bug").group.rank, t("Task").group.tone], [0, 1, "neutral"]);
  assert.deepEqual([t(null).group.label, t(null).status], ["None", ""]);
  assert.ok(t(null).group.rank > t("Bug").group.rank);
  const two = planFor(source([prop("a", "A", "select", ["x"]), prop("b", "B", "select", ["y"])]));
  assert.deepEqual(groupOf(two, { a: ["x"] }), { group: undefined, status: "" });
  const none = planFor(source([prop("tg", "Tags", "multi_select")]));
  assert.equal(none.group, null);
});

test("tone patterns", () => {
  assert.equal(toneFor("Todo", "x"), "todo");
  assert.equal(toneFor("", "Not Started"), "todo");
  assert.equal(toneFor("Work in Progress", "Needs review"), "review");
  assert.equal(toneFor("In progress", "Blocked by legal"), "blocked");
  assert.equal(toneFor("In progress", "Preview build"), "progress", "review needs a word start");
  assert.equal(toneFor("Done", "x"), "done");
  assert.equal(toneFor("Later", "x"), "neutral");
});

test("a row maps values by property id, empty values to None, and fields by name then Edited", () => {
  const plan = planFor(source(BASE));
  const it = rowItem(row({ "st%3Aa": ["Done"], "tg.1": ["a", "b"], "ow:1": [], "dn-1": ["Checked"] }), plan);
  assert.equal(it.key, "");
  assert.deepEqual(it.facets["tg.1"], ["a", "b"]);
  assert.deepEqual(it.facets["ow:1"], [NONE]);
  assert.deepEqual(it.facets["ty~1"], [NONE], "a property missing from the reply reads None");
  assert.deepEqual(it.facets[EDITED], ["2026-10-16T12:00:00.000Z"]);
  assert.equal(valueLabel(NONE), "None");
  assert.equal(plan.facets[0].valueLabel(NONE), "None");
  assert.equal(it.status, "Done");
  assert.deepEqual(it.group.tone, "done");
  assert.deepEqual(it.fields.map((f) => f.label), ["Done?", "Owner", "Priority", "Status", "Tags", "Type", "Edited"]);
  assert.equal(it.fields.find((f) => f.label === "Tags").value, "a, b");
  assert.equal(rowItem(row({}, { title: "  " }), plan).title, "Untitled");
});

test("top-level hits band as Databases then Pages, neutral, with only the Edited facet", () => {
  const db = hitItem({ id: id(0xd01), kind: "source", title: "Tasks", url: "u", lastEdited: "2026-10-16T12:00:00Z" });
  const pg = hitItem({ id: id(1), kind: "page", title: "Home", url: "u", lastEdited: "" });
  assert.deepEqual([db.group.label, db.group.rank, db.group.tone], ["Databases", 0, "neutral"]);
  assert.deepEqual([pg.group.label, pg.group.rank, pg.group.tone], ["Pages", 1, "neutral"]);
  assert.deepEqual([db.key, db.status], ["", ""]);
  assert.deepEqual(Object.keys(db.facets), [EDITED]);
  assert.deepEqual(pg.facets[EDITED], []);
});

test("fullscreen fields skip labels the row shows and add Created; subpages are first-level child_page blocks", () => {
  const item = { id: id(1), key: "", title: "x", status: "", updated: "", facets: {}, fields: [{ label: "Status", value: "Done" }, { label: "Edited", value: "2h" }] };
  const page = { id: id(1), title: "x", url: "u", lastEdited: "2026-10-16T12:00:00Z", created: "2026-09-01T09:00:00Z",
    fields: [{ label: "Status", value: "Done" }, { label: "Notes", value: "", dim: true }, { label: "Points", value: "3" }] };
  const out = pageFields(page, item);
  assert.deepEqual(out.map((f) => f.label), ["Notes", "Points", "Created"]);
  assert.equal(out[0].dim, true);
  const subs = subpageItems([
    { object: "block", id: id(2), type: "child_page", child_page: { title: "Child" }, last_edited_time: "2026-10-01T00:00:00Z" },
    { object: "block", id: id(3), type: "paragraph", paragraph: { rich_text: [] } },
    { object: "block", id: "bad", type: "child_page", child_page: { title: "Bad" } },
    "junk",
  ]);
  assert.deepEqual(subs.map((s) => [s.id, s.title]), [[id(2), "Child"]]);
});

test("fullscreen fields never drop a property for sharing a label: both stay, in schema order", () => {
  const plan = planFor(source([...BASE.slice(0, 1), STATUS]));
  const item = rowItem(row({ [STATUS.id]: ["Done"] }), plan);
  assert.deepEqual(item.fields.map((f) => f.label), ["Status", "Edited"]);
  const page = { id: id(1), title: "x", url: "u", lastEdited: "", created: "2026-09-01T09:00:00Z", fields: [
    { label: "Edited", value: "Oct 1, 2026" }, { label: "Status", value: "Done" }, { label: "Status", value: "Alt" },
    { label: "Notes", value: "a" }, { label: "Notes", value: "b" },
  ] };
  const out = pageFields(page, item);
  // the row's Status hides one Status; the model's own Edited hides no property
  assert.deepEqual(out.map((f) => `${f.label}:${f.value}`).slice(0, 4), ["Edited:Oct 1, 2026", "Status:Alt", "Notes:a", "Notes:b"]);
  assert.deepEqual(out.map((f) => f.label).slice(4), ["Created"]);
});

test("error copy per kind, and the partial note's plural", () => {
  const t = (kind, extra = {}) => errorCopy({ kind, message: "<b>raw</b>", ...extra });
  assert.deepEqual(t("forbidden"), { title: "Notion Needs Read Content", message: "Turn on Read Content for the connection in Notion." });
  assert.deepEqual(t("missing"), { title: "Page Not Shared", message: "Share the page with the connection in Notion." });
  assert.deepEqual(t("rate", { retryAfter: 2.2 }), { title: "Notion Is Busy", message: "Try again in 3 s." });
  assert.deepEqual(t("network"), { title: "Notion Did Not Answer", message: "<b>raw</b>" });
  assert.deepEqual(t("endpoint"), { title: "Notion Couldn't Load This", message: "<b>raw</b>" });
  assert.equal(t("parse").title, "Notion Couldn't Load This");
  assert.equal(connectCopy({ kind: "auth", message: "" }).title, "Notion Refused the Token");
  assert.equal(connectCopy({ kind: "network", message: "" }).title, "Notion Did Not Answer");
  assert.equal(connectCopy({ kind: "endpoint", message: "" }).title, "Notion Couldn't Connect");
  assert.equal(partialNote(1), "Only 1 row loaded. Refresh to try again.");
  assert.equal(partialNote(40), "Only 40 rows loaded. Refresh to try again.");
});

const coloured = (pid, name, type, opts) => ({ id: pid, name, type, options: opts.map(([n, color]) => ({ name: n, color })), groups: [] });

test("option colours map to tones, select bands use them, and bands carry the facet they stand for", () => {
  const map = ["default", "gray", "brown", "blue", "yellow", "orange", "purple", "pink", "red", "green", "mauve"].map(toneForColor);
  assert.deepEqual(map, ["neutral", "neutral", "neutral", "todo", "progress", "progress", "review", "review", "blocked", "done", "neutral"]);
  const plan = planFor(source([coloured("ty", "Type", "select", [["Bug", "red"], ["Task", "blue"]])]));
  assert.equal(groupOf(plan, { ty: ["Bug"] }).group.tone, "blocked");
  assert.equal(groupOf(plan, { ty: ["Task"] }).group.tone, "todo");
  assert.deepEqual(groupOf(plan, { ty: ["Bug"] }).group.facet, { id: "ty", value: "Bug" });
  assert.deepEqual(groupOf(plan, { ty: [] }).group.facet, { id: "ty", value: NONE });
  const st = planFor(source(BASE));
  assert.deepEqual(groupOf(st, { "st%3Aa": ["Done"] }).group.facet, { id: "st%3Aa", value: "Done" });
  assert.equal(groupOf(st, { "st%3Aa": ["Done"] }).group.tone, "done", "status bands keep their name-based tone");
});

test("the tag property is the first multi-select by name, else a select that is not the group; pills show at most two", () => {
  const plan = planFor(source([
    prop("title", "Name", "title"), STATUS,
    coloured("z", "Zeta", "multi_select", [["x", "red"], ["y", "default"], ["w", "green"]]),
    coloured("a", "Alpha", "multi_select", [["lo", "blue"], ["hi", "red"], ["mid", "gray"]]),
  ]));
  assert.equal(plan.tags.prop.id, "a");
  const it = rowItem(row({ a: ["hi", "lo", "mid"] }), plan);
  assert.deepEqual(it.tags, [{ label: "hi", tone: "blocked" }, { label: "lo", tone: "todo" }]);
  assert.equal(rowItem(row({ a: [] }), plan).tags, undefined, "no values, no pills");
  const sel = planFor(source([coloured("g", "Grp", "select", [["a", "red"]]), coloured("h", "Hue", "select", [["b", "red"]])]));
  assert.equal(sel.tags.prop.id, "g", "two selects: the first by name");
  const one = planFor(source([coloured("g", "Grp", "select", [["a", "red"]])]));
  assert.equal(one.tags, null, "the only select is the group, never a tag");
});

test("a tag property that sorts last among more than 11 eligible properties is still requested", () => {
  const many = Array.from({ length: 14 }, (_, i) => coloured(`s${i}`, `Sel ${String(i).padStart(2, "0")}`, "select", [["x", "red"]]));
  const tag = coloured("tz", "Zzz Tags", "multi_select", [["t1", "green"]]);
  const plan = planFor(source([prop("title", "Name", "title"), STATUS, ...many, tag]));
  assert.equal(plan.tags.prop.id, "tz");
  assert.ok(!plan.chips.some((p) => p.id === "tz"), "it did not make the kept chips");
  assert.ok(plan.props.includes("tz"), "filter_properties still asks for it");
  assert.equal(plan.props.length, 1 + 1 + (MAX_FACETS - 1), "title, the tag, then the kept chips");
  assert.deepEqual(rowItem(row({ tz: ["t1"] }), plan).tags, [{ label: "t1", tone: "done" }]);
});

test("page icons: the emoji, else a glyph for top-level hits; a blank slot only when some data-source row has one", () => {
  const pg = hitItem({ id: id(1), kind: "page", title: "Home", url: "u", lastEdited: "", icon: "\u{1F4D8}" });
  const bare = hitItem({ id: id(2), kind: "page", title: "Bare", url: "u", lastEdited: "", icon: "" });
  const db = hitItem({ id: id(3), kind: "source", title: "Tasks", url: "u", lastEdited: "" });
  assert.deepEqual([pg.lead, bare.lead, db.lead], [{ emoji: "\u{1F4D8}" }, { color: "notion-page" }, { color: "notion-database" }]);
  const dbEmoji = hitItem({ id: id(4), kind: "source", title: "People", url: "u", lastEdited: "", icon: "\u{1F465}" });
  const dbNamed = hitItem({ id: id(5), kind: "source", title: "Projects", url: "u", lastEdited: "", iconName: "people", iconColor: "blue" });
  assert.deepEqual([dbEmoji.lead, dbNamed.lead], [{ color: "notion-database" }, { color: "notion-database" }]);
  const plan = planFor(source(BASE));
  assert.deepEqual(rowItem(row({}, { icon: "\u{1F41E}" }), plan, true).lead, { emoji: "\u{1F41E}" });
  assert.deepEqual(rowItem(row({}, { icon: "" }), plan, true).lead, { blank: true });
  assert.equal(rowItem(row({}, { icon: "" }), plan, false).lead, undefined);
});

test("built-in page icons: mapped glyph tinted by colour, unmapped name keeps the kind glyph, emoji wins", () => {
  const h = (extra) => hitItem({ id: id(1), kind: "page", title: "T", url: "u", lastEdited: "", icon: "", ...extra });
  assert.deepEqual(h({ iconName: "checklist", iconColor: "green" }).lead, { glyph: "list-checks", cls: "nb-c-green" });
  assert.deepEqual(h({ iconName: "nonesuch", iconColor: "red" }).lead, { glyph: "file-text", cls: "nb-c-red" });
  assert.deepEqual(h({ iconName: "bug", iconColor: "" }).lead, { glyph: "bug" });
  assert.deepEqual(h({ iconName: "toString", iconColor: "gray" }).lead, { glyph: "file-text", cls: "nb-c-gray" });
  assert.deepEqual(h({ icon: "\u{1F4D8}", iconName: "bug", iconColor: "red" }).lead, { emoji: "\u{1F4D8}" });
  const plan = planFor(source(BASE));
  assert.deepEqual(rowItem(row({}, { icon: "", iconName: "people", iconColor: "blue" }), plan).lead, { glyph: "users", cls: "nb-c-blue" });
});

test("the status strip keeps every segment while a filter empties one, holds the pressed state, and returns on clear", () => {
  const plan = planFor(source(BASE));
  const mk = (n, status) => ({ ...rowItem(row({ "st%3Aa": [status] }, { id: id(100 + n) }), plan), id: id(100 + n) });
  const items = [mk(1, "Not started"), mk(2, "In progress"), mk(3, "In progress"), mk(4, "Done")];
  const adapter = {
    source: "notion:strip", noun: "Rows", rich: { render: () => ({ el: document.createElement("div"), fellBack: false }), excerpt: () => "" },
    load: async () => ({ error: { title: "x", message: "y" } }), moreComments: async () => ({ error: { title: "x", message: "y" } }),
    send() {}, open() {}, openUrl() {},
  };
  const head = document.createElement("div");
  head.appendChild(document.createElement("span"));
  const b = buildBrowser(adapter, head);
  document.body.appendChild(b.root);
  b.setItems(items, plan.facets, { busy: false, note: null });
  const segs = () => [...b.root.querySelectorAll(".br-dist-seg")];
  assert.deepEqual(segs().map((s) => s.getAttribute("aria-label")), ["Not started · 1", "In progress · 2", "Done · 1"]);
  assert.equal(b.root.querySelector(".br-dist").hidden, false);
  segs()[1].click();
  assert.deepEqual(segs().map((s) => s.getAttribute("aria-label")), ["Not started · 0", "In progress · 2", "Done · 0"], "all segments stay");
  assert.deepEqual(segs().map((s) => s.getAttribute("aria-pressed")), ["false", "true", "false"]);
  assert.equal(b.root.querySelectorAll(".br-list .br-row").length, 2);
  segs()[1].click();
  assert.deepEqual(segs().map((s) => s.getAttribute("aria-label")), ["Not started · 1", "In progress · 2", "Done · 1"]);
  assert.equal(b.root.querySelectorAll(".br-list .br-row").length, 4);
  b.setItems(items.slice(0, 2).filter((it) => it.status === "Not started"), plan.facets, { busy: false, note: null });
  assert.equal(b.root.querySelector(".br-dist").hidden, true, "under two segments the strip hides");
  b.dispose();
});
