// src\runes\bare\agent-view.ts — the agent Generate flow of the Bare Runes tab (run 2026-10-17-rune-generator, W3):
// the Model and Effort selects, the Generate button and its tooltips, the generating line, the done line and
// the extras a generated library carries in Actives. Reuses the existing controls and rows; strings are verbatim
// from docs/runs/2026-10-17-rune-generator/ipc.md. No roster import: the panel hands the model lists in, so
// `node --test` loads this.
import { EFFORT_LEVELS } from "../../agents/protocol";
import { titleCase } from "../../format";
import { codexEffortLevels, effortSelect, modelSelect } from "../../settings/agent-selects";
import {
  generating, type BareActiveLibrary, type BareFlow, type BareLocalSources, type GenOutcome, type GenState,
} from "./flow";
import {
  ADD_TO_VAULT_LABEL, elapsedLabel, emptyProgress, progressCards, reduceProgress, stopProgress, type GeneratedRef, type ProgressState,
} from "./progress";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function btn(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.disabled = disabled;
  b.addEventListener("click", run);
  return b;
}

/** The choices for the focused tab's agent: the Claude roster or the saved Codex catalog. */
export interface GenModel { value: string; label: string; effortLevels?: readonly string[] }
export interface GenCtx { models: GenModel[] }

const TIP_CODEX_READS = " Codex can read files while generating; it cannot write them.";
export const TIP_GENERATING = "Generating…";
const CLAUDE_DEFAULT = "claude-sonnet-5";

const END_LABEL: Record<Exclude<GenState, "done" | "readOnly">, string> = {
  failed: "Generation Failed", login: "Not Logged In", timeout: "Timed Out", cancelled: "Cancelled",
  rejected: "Output Rejected", stale: "Row Changed While Generating", busy: "Generating in Another Tab",
};

/** Pure: the done line's tooltip, "<Model> · <Effort> · <m>m <s>s · <N>K Tokens"; tokens omitted when null. */
export function doneTitle(model: string, effort: string, r: { durationMs: number; inputTokens: number | null; outputTokens: number | null }): string {
  const secs = Math.round(r.durationMs / 1000);
  const parts = [model, titleCase(effort), `${Math.floor(secs / 60)}m ${secs % 60}s`];
  if (r.inputTokens !== null && r.outputTokens !== null) parts.push(`${Math.round((r.inputTokens + r.outputTokens) / 1000)}K Tokens`);
  return parts.join(" · ");
}

/** Pure: the Generate tooltip (ipc.md); no size is known per file, so the token count is left out. */
export function generateTip(model: string, codex: boolean, tokensK: number | null = null): string {
  const what = tokensK === null ? "Sends the ticked rules" : `Sends about ${tokensK}K tokens of rules`;
  return `${what} to ${model}.${codex ? TIP_CODEX_READS : ""}`;
}

/** Pure: splits generator warnings into the "N Warnings" label with its tooltip and the merge failures kept visible. */
export function warningSummary(warnings: string[]): { label: string | null; tip: string; merge: string[] } {
  const merge = warnings.filter((w) => w.startsWith("Merge pass failed"));
  const rest = warnings.filter((w) => !w.startsWith("Merge pass failed"));
  const label = rest.length === 0 ? null : rest.length === 1 ? "1 Warning" : `${rest.length} Warnings`;
  return { label, tip: rest.join("\n"), merge };
}

export interface AgentViewDeps {
  codex: boolean;
  flow: BareFlow;
  gen?: () => GenCtx;
  paint(): void;
  /** A run starts: show its screen. */
  enter(): void;
  /** The run ended Done, or Back was pressed: return to Actives. */
  done(): void;
  /** The clock for the card timers; tests inject one so nothing waits in real time. */
  clock?: CardClock;
  /** Add to Vault on the Done line: puts the generated runeset in the tab's vault; true once it landed. Absent, no button. */
  addToVault?(r: GeneratedRef): Promise<boolean>;
}

/** `now` in ms and a repeating tick whose returned function stops it. */
export interface CardClock { now(): number; every(fn: () => void, ms: number): () => void }
const realClock: CardClock = {
  now: () => Date.now(),
  every: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h); },
};

const SVG_NS = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string>, cls?: string): SVGElement => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (cls) e.setAttribute("class", cls);
  return e;
};

/** The 12px state glyph of a card: hollow dot queued, arc running or retrying, check done, X failed, square stopped. */
export function cardGlyph(state: string): SVGElement {
  const svg = svgEl("svg", { width: "12", height: "12", viewBox: "0 0 12 12", "aria-hidden": "true" }, `rg-glyph rg-${state}`);
  if (state === "running" || state === "retrying") {
    svg.append(svgEl("circle", { cx: "6", cy: "6", r: "4.5", fill: "none", "stroke-width": "1.5" }, "rg-ring"),
      svgEl("path", { d: "M6 1.5 A4.5 4.5 0 0 1 10.5 6", fill: "none", "stroke-width": "1.5" }, "rg-arc"));
  } else if (state === "done") svg.append(svgEl("path", { d: "M2.5 6.2 L5 8.5 L9.5 3.5", fill: "none", "stroke-width": "1.5" }));
  else if (state === "failed") svg.append(svgEl("path", { d: "M3 3 L9 9 M9 3 L3 9", fill: "none", "stroke-width": "1.5" }));
  else if (state === "stopped") svg.append(svgEl("rect", { x: "3", y: "3", width: "6", height: "6" }));
  else svg.append(svgEl("circle", { cx: "6", cy: "6", r: "3.5", fill: "none" }));
  return svg;
}

export interface AgentView {
  /** False when no model list was handed in: the Generate controls are not offered. */
  readonly available: boolean;
  /** True while this view's own run is in flight. */
  readonly running: boolean;
  selects(): HTMLElement[];
  /** Null when unavailable. Disabled with nothing ticked (`any` false) and while any run is live app-wide. */
  generateButton(sources: BareLocalSources, ticked: ReadonlySet<string>, any: boolean): HTMLButtonElement | null;
  generatingView(): HTMLElement[];
  /** The Done line kept at the top of Actives after a run. */
  doneLine(): HTMLElement | null;
  /** Warning lines under a generated library's header (no Codex size note is drawn). */
  libraryExtras(lib: BareActiveLibrary): HTMLElement[];
  /** Stops the card timer; the tab calls it on unmount. */
  dispose(): void;
}

export function createAgentView(deps: AgentViewDeps): AgentView {
  const { codex, flow } = deps;
  const ctx = (): GenCtx => deps.gen?.() ?? { models: [] };
  let model = "";
  let effort = "";
  let runId: string | null = null;
  let outcome: GenOutcome | null = null;
  let phase: "idle" | "running" | "ended" = "idle";
  let doneText: { model: string; title: string; gen: GeneratedRef; added: boolean } | null = null;
  let progress: ProgressState = emptyProgress();

  const modelLabel = (v: string): string => ctx().models.find((m) => m.value === v)?.label ?? v;
  const efforts = (): readonly string[] => (codex ? codexEffortLevels(model, ctx().models.map((m) => ({ ...m, effortLevels: m.effortLevels ?? [] }))) : EFFORT_LEVELS);

  function ensureDefaults(): void {
    const models = ctx().models;
    if (!models.length) return;
    if (!models.some((m) => m.value === model)) {
      model = (!codex && models.find((m) => m.value === CLAUDE_DEFAULT)?.value) || models[0].value;
      effort = "";
    }
    const levels = efforts();
    if (!levels.includes(effort)) effort = levels.includes("medium") ? "medium" : levels[0] ?? "";
  }

  async function start(sources: BareLocalSources, ticked: ReadonlySet<string>): Promise<void> {
    const used = { model, effort, label: modelLabel(model) };
    phase = "running"; outcome = null; doneText = null; runId = null; progress = emptyProgress();
    deps.enter();
    deps.paint();
    const res = await flow.generateAgent({
      sources, ticked, model: used.model, effort: used.effort, effortLevels: efforts(),
      onRun: (id) => { runId = id; deps.paint(); },
      onProgress: (e) => { progress = reduceProgress(progress, e, clock.now()); syncTimer(); deps.paint(); },
    });
    outcome = res;
    if (res.state !== "done") progress = stopProgress(progress);
    phase = "ended";
    syncTimer();
    if (res.state === "done" && res.result) {
      doneText = { model: used.label, title: doneTitle(used.label, used.effort, res.result), gen: { library: res.result.library, set: res.result.set }, added: false };
      deps.done();
    } else deps.paint();
  }

  const lineRow = (state: string, label: string, title?: string, bad = false): HTMLElement => {
    const list = el("div", "runes-bare-lines");
    const row = el("div", "runes-bare-line");
    row.dataset.state = state;
    // the state says it: "Runes" before Done or Failed repeated the panel (2026-10-18); the bare placeholder keeps it
    if (!label) row.appendChild(el("span", "runes-bare-line-path", "Runes"));
    const st = el("span", "runes-bare-line-state", label);
    if (bad) st.classList.add("rp-error");
    if (title) st.title = title;
    row.appendChild(st);
    list.appendChild(row);
    return list;
  };

  // The card timers: one interval, alive only while a card is running; the labels are rewritten in place so a
  // tick never repaints the view (a repaint would restart every spinner and sweep).
  const clock = deps.clock ?? realClock;
  const timeEls = new Map<HTMLElement, number>();
  let stopTick: (() => void) | null = null;
  const paintTimes = (): void => {
    const n = clock.now();
    for (const [e, t0] of timeEls) e.textContent = elapsedLabel(n - t0);
  };
  const syncTimer = (): void => {
    const live = phase === "running" && progressCards(progress).some((c) => c.startedAt !== null);
    if (live && !stopTick) stopTick = clock.every(paintTimes, 1000);
    else if (!live && stopTick) { stopTick(); stopTick = null; }
  };

  /** One card per chunk, a separator, then the Merge card; the run's error text rides on the first failed card's tooltip. */
  const progressList = (error: string): HTMLElement => {
    const list = el("div", "runes-gen-cards");
    timeEls.clear();
    let tipped = false;
    const n = clock.now();
    for (const [i, r] of progressCards(progress).entries()) {
      const merge = i >= progress.chunks.length;
      if (merge) list.appendChild(el("div", "runes-gen-sep"));
      const card = el("div", merge ? "runes-gen-card runes-gen-merge" : "runes-gen-card");
      card.dataset.state = r.retrying ? "retrying" : r.state;
      const g = el("span", "runes-gen-glyph");
      g.appendChild(cardGlyph(card.dataset.state));
      card.appendChild(g);
      card.appendChild(el("span", "runes-gen-path", r.label));
      if (r.startedAt !== null) {
        const t = el("span", "runes-gen-time", elapsedLabel(n - r.startedAt));
        timeEls.set(t, r.startedAt);
        card.appendChild(t);
      }
      const st = el("span", "runes-gen-state", r.text);
      if (r.state === "failed") {
        st.classList.add("rp-error");
        if (!tipped && error) { st.title = error; tipped = true; }
      }
      card.appendChild(st);
      list.appendChild(card);
    }
    return list;
  };

  return {
    get available() { return ctx().models.length > 0; },
    get running() { return phase === "running"; },
    selects() {
      ensureDefaults();
      const m = modelSelect(model, ctx().models, (v) => { model = v; ensureDefaults(); deps.paint(); });
      const e = effortSelect(effort, (v) => { effort = v; deps.paint(); }, efforts());
      return [m, e];
    },
    generateButton(sources, ticked, any) {
      if (!this.available) return null;
      ensureDefaults();
      const other = generating();
      const b = btn("Generate", "ws-btn ws-add", () => { void start(sources, ticked); }, !any || other || !model || !effort);
      b.title = other ? "Generating in Another Tab" : generateTip(modelLabel(model), codex);
      return b;
    },
    generatingView() {
      const out: HTMLElement[] = [];
      if (phase === "running") out.push(el("div", "runes-bare-note", TIP_GENERATING)); // note-ok: docs/projects/bare/runes-tab-plan.md
      const cards = progressCards(progress).length;
      if (cards) out.push(progressList(outcome?.error ?? ""));
      if (outcome && outcome.state !== "done") {
        const s = outcome.state === "readOnly" ? "failed" : outcome.state;
        out.push(lineRow("failed", END_LABEL[s], outcome.error ?? "", true));
      } else if (!cards) out.push(lineRow(phase === "running" ? "running" : "pending", ""));
      const actions = el("div", "rp-actions");
      if (phase === "running") {
        actions.appendChild(btn("Cancel", "ws-btn", () => { if (runId) void flow.cancelGenerate(runId); }, !runId));
      } else actions.appendChild(btn("Back", "ws-btn", () => deps.done()));
      out.push(actions);
      return out;
    },
    dispose() {
      if (stopTick) { stopTick(); stopTick = null; }
      timeEls.clear();
    },
    doneLine() {
      if (!doneText) return null;
      const line = lineRow("done", "Done", doneText.title);
      const add = deps.addToVault;
      if (add && !doneText.added) {
        const d = doneText;
        const b = btn(ADD_TO_VAULT_LABEL, "ws-btn", () => {
          b.disabled = true;
          b.setAttribute("aria-busy", "true");
          void add(d.gen).then((ok) => { if (ok) d.added = true; }, () => undefined).finally(() => { b.disabled = false; b.removeAttribute("aria-busy"); deps.paint(); });
        });
        line.querySelector(".runes-bare-line")?.appendChild(b);
      }
      return line;
    },
    libraryExtras(lib) {
      const g = lib.generated;
      if (!g) return [];
      const sum = warningSummary(g.warnings);
      return sum.merge.map((w) => el("div", "runes-err", w)); // advisory warning count has no action: not drawn
    },
  };
}
