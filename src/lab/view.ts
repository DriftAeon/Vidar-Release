// Lab tab detail DOM: Cases list, Runs table, delta-per-commit chart and the copy-command
// buttons. Series building lives in chart.ts; this file only draws it.
import { copyText } from "../clipboard";
import { iconImg, type ColorIcon } from "../icon-img";
import { buildSeries, linePath, project, shortCommit, type ChartBox } from "./chart";
import { dryCommand, liveCommand, type LabLib } from "./commands";
import { casesFor, rowMatches, type LabTarget } from "./items";
import type { LabItem, LabRun } from "./types";

export type { LabLib };

/** Icon for each Lab item kind; new kinds add one mapping here. */
export const LAB_KIND_ICONS: Readonly<Record<string, ColorIcon>> = {
  rune: "runelib",
};

export interface DetailCtx {
  note: (msg: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SVG = "http://www.w3.org/2000/svg";
function svg(tag: string, cls: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  e.setAttribute("class", cls);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const score = (v: number | null): string => (v === null ? "—" : v.toFixed(2));
const signed = (v: number | null): string => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);
const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

/** Row markers, in table order; `true` marks the failure tone. */
function markers(r: LabRun): [string, boolean][] {
  const out: [string, boolean][] = [];
  if (r.partial) out.push(["Partial", false]);
  if (!r.comparable || r.dry) out.push(["Not Comparable", false]);
  if (r.isolation === "unverified") out.push(["Isolation Unverified", false]);
  if (r.isolation === "failed") out.push(["Isolation Failed", true]);
  return out;
}

function section(title: string): HTMLElement {
  const s = el("section", "lab-sec");
  s.appendChild(el("h3", "lab-sec-head", title));
  return s;
}

function casesSection(item: LabItem): HTMLElement {
  const s = section("Cases");
  if (!item.cases.length) {
    s.appendChild(item.suiteError ? el("div", "lab-err", item.suiteError) : el("div", "lab-empty", "No Suite Yet"));
    return s;
  }
  const list = el("ul", "lab-cases");
  for (const c of item.cases) {
    const li = el("li", "lab-case");
    li.appendChild(el("span", "lab-case-name", c.name));
    if (c.error) li.appendChild(el("span", "lab-err", c.error));
    list.appendChild(li);
  }
  s.appendChild(list);
  return s;
}

const BOX: ChartBox = { width: 320, height: 120, pad: 12 };
const LABEL_H = 16;

function chart(runs: LabRun[]): SVGElement {
  const series = buildSeries(runs);
  const { px, py } = project(series, BOX);
  const root = svg("svg", "lab-chart", { viewBox: `0 0 ${BOX.width} ${BOX.height + LABEL_H}`, role: "img" });
  root.setAttribute("aria-label", "Delta per Commit");
  root.appendChild(svg("line", "lab-zero", { x1: BOX.pad, x2: BOX.width - BOX.pad, y1: py(0), y2: py(0) }));
  const d = linePath(series, BOX);
  if (d) root.appendChild(svg("path", "lab-line", { d }));
  for (const p of series.points) {
    const dot = svg("circle", p.comparable ? "lab-dot" : "lab-dot is-hollow", { cx: px(p.x), cy: py(p.delta), r: 3 });
    const tip = document.createElementNS(SVG, "title");
    tip.textContent = `${shortCommit(series.commits[p.x])} ${signed(p.delta)}`;
    dot.appendChild(tip);
    root.appendChild(dot);
  }
  series.commits.forEach((c, x) => {
    const t = svg("text", "lab-tick", { x: px(x), y: BOX.height + LABEL_H - 4, "text-anchor": "middle" });
    t.textContent = shortCommit(c);
    root.appendChild(t);
  });
  return root;
}

function runsTable(runs: LabRun[]): HTMLTableElement {
  const t = el("table", "lab-runs");
  const head = el("tr", "");
  for (const h of ["Commit", "Date", "With", "Without", "Delta", "Sessions", ""]) head.appendChild(el("th", "", h));
  t.appendChild(el("thead", "")).appendChild(head);
  const body = t.appendChild(el("tbody", ""));
  for (const r of [...runs].reverse()) { // newest first
    const tr = el("tr", r.comparable && !r.dry ? "" : "is-dim");
    const commit = el("td", "lab-num", shortCommit(r.itemCommit));
    if (r.itemCommit) commit.title = r.itemCommit;
    tr.append(commit, el("td", "lab-num", day(r.startedAt)), el("td", "lab-num", score(r.scores.with)),
      el("td", "lab-num", score(r.scores.without)), el("td", "lab-num", signed(r.scores.delta)), el("td", "lab-num", String(r.sessions)));
    const marks = el("td", "lab-marks");
    for (const [text, bad] of markers(r)) marks.appendChild(el("span", bad ? "lab-mark lab-mark-err" : "lab-mark", text));
    tr.appendChild(marks);
    body.appendChild(tr);
  }
  return t;
}

function runsSection(item: LabItem): HTMLElement {
  const s = section("Runs");
  if (!item.runs.length) {
    s.appendChild(item.historyError ? el("div", "lab-err", item.historyError) : el("div", "lab-empty", "No Runs Yet"));
    return s;
  }
  s.appendChild(chart(item.runs));
  const wrap = el("div", "lab-table");
  wrap.appendChild(runsTable(item.runs));
  s.appendChild(wrap);
  return s;
}

function copyButton(label: string, cmd: string, ctx: DetailCtx): HTMLButtonElement {
  const b = el("button", "lab-act");
  b.type = "button";
  b.title = cmd;
  b.append(iconImg("copy"), el("span", "", label));
  b.addEventListener("click", async () => {
    b.disabled = true;
    const ok = await copyText(cmd);
    b.disabled = false;
    ctx.note(ok ? "Command Copied" : "Copy Failed");
  });
  return b;
}

/** The selected item's detail; commands only when the runner exists and every case is clean (the
 *  runner refuses the whole run on one bad case). Live is hidden past the runner's session cap. */
export function itemDetail(id: string, lib: LabLib, target: LabTarget, item: LabItem, ctx: DetailCtx): HTMLElement[] {
  const parts: HTMLElement[] = [];
  const mine: LabItem = {
    ...item,
    cases: casesFor(item.cases, target),
    runs: item.runs.filter((r) => rowMatches(r, target)),
  };
  if (mine.runnerPresent && mine.cases.length && mine.cases.every((c) => !c.error)) {
    const acts = el("div", "lab-acts");
    acts.appendChild(copyButton("Copy Dry Run Command", dryCommand(id, lib, target), ctx));
    const live = liveCommand(id, lib, mine.cases.length, target);
    if (live) acts.appendChild(copyButton("Copy Live Command", live, ctx));
    parts.push(acts);
  }
  parts.push(casesSection(mine), runsSection(mine));
  return parts;
}
