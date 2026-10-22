// src\runes\bare\view.ts — the Runes tab for a focused Bare tab.
// Views: Actives (the row's libraries as today's rune sets and cards, Inherited Runes as per-item ticks),
// Local Files (the onboarding tick list) and Generating (one line per source). The flow core in ./flow
// does every read and write; `io` is bound to the bare_* commands.
import { iconImg, type ColorIcon } from "../../icon-img";
import type { RuneItem } from "../types";
import { BARE_SCOPE, cardDetails, fillCard, openKeys, reopen, runeName, type CardCtx } from "../cards";
import {
  agentFiles, codexTicks, createBareFlow, defaultTicks,
  type ActionResult, type BareActiveLibrary, type BareActives, type BareFileKind, type BareFlow,
  rowGenerating, watchGenerating,
  type BareFlowIo, type BareGuard, type BareLocalFile, type BareLocalSources, type GenerateLine, type LibraryDelta,
} from "./flow";
import { attachedCount, setAttachments } from "./set-attach";
import { setCard, setHead } from "../set-card";
import { genLabel } from "./gen-label";
import { isFileRow, nameAndPath } from "./row-name";import { doneGate, startView } from "./view-entry";
export { genLabel };
import { TIP_GENERATING, btn, createAgentView, el, type GenCtx } from "./agent-view";

/** `traceParts`: the tab's launch warnings and transcript file loads, drawn once in View; Claude and Codex alike.
 *  `card`: the Runes panel's card actions (Edit opens Document); absent, a card's Edit does nothing. */
export interface BareViewCtx {
  agent: string; rowKey?: string | null; cwd: string; profile: string; traceParts?: HTMLElement[]; card?: CardCtx;
  /** The Generate models for this tab's agent; absent, the agent Generate is not offered. */
  gen?: () => GenCtx;
  /** Settles when a model fetch `gen` reads has landed (Codex: codex-models.ts); the view repaints then. */
  modelsReady?: Promise<unknown>;
  start?: "files"; onDone?(): void; // onboarding: open on Local Files; called back on Actives after a run
}

const NOTE_NEXT = "Changes load in the next Bare tab you open; this tab keeps what it started with.";
const NOTE_NEXT_CODEX = "Changes load on the next start, including /clear or Retry.";
const TIP_FILES_CODEX = "Codex Bare loads rules, memories, skills, agents and hosted MCP servers.";
const HEAD_CODEX_LAYER = "Skills, Agents and MCP Servers";
const TIP_RESCAN = "Rescans the source; other rows that use this library get its new text too.";
const NOTE_NO_ROW = "Open this Bare tab from the launcher to change its runes.";
const TIP_EVERY_ROW = "Inherited runes: skills reach every Bare row, agents every Bare row of their own agent, hooks every Claude Bare row. An open Bare tab may pick them up when another one starts.";
const TIP_READ_ONLY = "This set wasn't imported here, so it can't be changed from this tab.";
const TIP_PROJECT = "Imported from a project folder; this row loads it in every folder.";
const TIP_GONE = "The source file is gone, so this set stays as it is until it's back.";
const TIP_REASON: Record<NonNullable<BareLocalFile["reason"]>, string> = {
  pathScoped: "This file is path-scoped; a Bare tab loads it every session.",
  notMjs: "Only node .mjs hooks copy into a Bare home.",
  guardDriver: "Vidar runs this one itself in Bare.",
  tooLarge: "This file is over 256 KB, so it does not import.",
  shadowed: "AGENTS.override.md replaces this file.",
  summaryOnly: "Only the memory summary imports; MEMORY.md stays in its home.",
  notHosted: "Codex Bare carries only the Notion and Atlassian servers.",
  stdio: "Local command servers stay out of Codex Bare.",
};
const KIND_HEAD: [BareFileKind, string][] = [
  ["rules", "Rules"], ["memory", "Memories"], ["skill", "Skills"], ["agent", "Agents"], ["hook", "Hooks"], ["mcp", "MCP Servers"],
];
// heads carry the Gear section icons (loadout-rows.ts ROW_ICONS; 2026-10-18)
const LAYER_KINDS: [BareFileKind, string, ColorIcon][] = [
  ["skill", "Skills", "skill"], ["agent", "Agents", "agent"], ["hook", "Hooks", "hook"], ["mcp", "MCP Servers", "proxy"],
];

type View = "actives" | "files" | "generating" | "agent";

const guardKey = (g: BareGuard): string => JSON.stringify([g.event, g.matcher ?? null, g.run]);
const lastSeg = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const dirOf = (p: string): string => p.replace(/[\\/][^\\/]*[\\/]?$/, "");

/** Pure: whether the row has no runes yet (the one-button state). Skills, agents and guards do not count:
 *  they are one Vidar-wide list every Bare row shares, and the flow preselects them (2026-10-18). */
export const isEmptyRow = (a: BareActives): boolean => !a.libraries.length;

/** Pure: a flow error as a visible line plus its tooltip; the raw error only ever reaches the tooltip. */
export function errorLine(r: ActionResult, what: "import" | "load" = "import"): { text: string; title: string } | null {
  if (r.ok) return null;
  if (r.reason === "readOnly") return { text: TIP_READ_ONLY, title: "" };
  return { text: what === "load" ? "Load Failed" : "Import Failed", title: r.error ?? "" };
}

/** Pure: Inherited Runes files: the offered skill, agent and hook files plus any bareSkills / bareAgents
 *  entry no longer offered (kept so a toggle round-trips it), ticked from what the row holds now. */
export function layerFiles(src: BareLocalSources | null, a: BareActives, codex = false): { files: BareLocalFile[]; ticked: Set<string> } {
  const files = agentFiles(src?.files ?? [], codex)
    .filter((f) => f.kind === "skill" || f.kind === "agent" || (codex ? f.kind === "mcp" : f.kind === "hook"));
  const lists: ["skill" | "agent", string[]][] = codex
    ? [["skill", a.codexSkills ?? []], ["agent", a.codexAgents ?? []]]
    : [["skill", a.skills], ["agent", a.agents]];
  for (const [kind, list] of lists) {
    for (const p of list) {
      if (!files.some((f) => f.kind === kind && f.path === p)) {
        files.push({ path: p, shown: p, kind, scope: "global", ticked: true, pickable: true });
      }
    }
  }
  const guards = new Set(a.guards.map(guardKey));
  const ticked = new Set<string>();
  for (const f of files) {
    const on = f.kind === "skill" ? (codex ? a.codexSkills ?? [] : a.skills).includes(f.path)
      : f.kind === "mcp" ? !!f.hosted && (a.codexMcp ?? []).includes(f.hosted)
      : f.kind === "agent" ? (codex ? a.codexAgents ?? [] : a.agents).includes(f.path)
      : !!f.guard && guards.has(guardKey(f.guard));
    if (on) ticked.add(f.path);
  }
  return { files, ticked };
}

/** Pure: the Local Files preselection. Starts from `defaultTicks`; with a populated row, a rules or memory
 *  file whose library is already on the row starts unticked (a re-import would reset its On/Off), and
 *  skills and agents follow what the row holds. */
export function filesTicks(files: readonly BareLocalFile[], a: BareActives | null, codex = false): Set<string> {
  const t = codex ? codexTicks(files) : defaultTicks(files);
  if (!a) return t;
  const libs = new Set(a.libraries.map((l) => l.library));
  for (const f of files) {
    if (!f.pickable) continue;
    if ((f.kind === "rules" || f.kind === "memory") && f.library && libs.has(f.library)) t.delete(f.path);
    if (f.kind === "mcp") {
      const held = a.codexMcp ?? [];
      if (f.hosted && held.includes(f.hosted)) t.add(f.path); else if (held.length) t.delete(f.path);
    } else if (f.kind === "skill" || f.kind === "agent") {
      const skills = codex ? a.codexSkills ?? [] : a.skills;
      const agents = codex ? a.codexAgents ?? [] : a.agents;
      const on = (f.kind === "skill" ? skills : agents).includes(f.path);
      if (on) t.add(f.path); else if (skills.length || agents.length) t.delete(f.path);
    }
  }
  return t;
}

export function hueOf(lib: Pick<BareActiveLibrary, "generated" | "source" | "library">): string {
  if (lib.generated) return "hue-generated";
  if (lib.source === null) return "hue-set";
  if (lib.library.startsWith("memory-")) return "hue-recall";
  return /agents(\.override)?\.md$/i.test(lib.source) ? "hue-agents" : "hue-claude";
}

/** A mounted Bare view the Runes panel can keep: `setTrace` swaps the trace body in place (open sets and
 *  cards stay open), `reload` re-reads the row only when nothing is running or shown over Actives. */
export interface BareViewHandle {
  root: HTMLElement;
  /** The View / Modify switch; the panel seats it on the Key's line. Hidden when there is nothing to switch. */
  modeButton: HTMLButtonElement;
  setTrace(parts: HTMLElement[]): void;
  reload(): void;
  dispose(): void;
}

/** Mount the Bare view into `host`; returns its handle. */
export function mountBareView(host: HTMLElement, ctx: BareViewCtx, io: BareFlowIo): BareViewHandle {
  const codex = ctx.agent === "codex";
  const layerKinds = codex ? LAYER_KINDS.filter(([k]) => k === "skill" || k === "agent" || k === "mcp") : LAYER_KINDS.filter(([k]) => k !== "mcp");
  const root = el("div", "runes-bare");
  host.appendChild(root);
  // the launch warnings and transcript file loads, shown once in View: built once so the panel's content survives redraws
  const trace = el("div", "runes-bare-trace");
  if (ctx.traceParts?.length) trace.append(...ctx.traceParts);
  trace.hidden = !trace.childElementCount;
  // View (read-only) is the default on every mount; Modify opens the editing controls (not persisted)
  let modify = false;
  const modeButton = el("button", "ws-btn runes-mode");
  modeButton.type = "button";
  modeButton.hidden = true;
  modeButton.addEventListener("click", () => { modify = !modify; paint(); });

  const flow: BareFlow = createBareFlow(io, { rowKey: ctx.rowKey, cwd: ctx.cwd, codex });
  const cardCtx: CardCtx = ctx.card ?? { openInDocument: () => {}, note: () => {} };
  let disposed = false;
  let view: View = "actives";
  let busy = false;
  let loaded = false;
  let loadErr: ActionResult | null = null;
  let actErr: ActionResult | null = null;
  let deltas: LibraryDelta[] = [];
  let sources: BareLocalSources | null = null;
  let sourcesErr: string | null = null;
  let ticked = new Set<string>();
  let lines: GenerateLine[] = [];
  let genDone = false;
  const openSets = new Map<string, boolean>();
  const gate = doneGate(ctx.onDone);
  const agentV = createAgentView({
    codex, flow, gen: ctx.gen, paint: () => paint(), enter: () => { view = "agent"; gate.ran(); },
    done: () => {
      view = "actives"; loaded = true; paint();
      void flow.check().then((d) => { if (!disposed) { deltas = d; paint(); } });
    },
  });
  // another tab's run flips Generate and the switches: repaint when the app-wide state moves
  const unwatch = watchGenerating(() => paint());
  // the `available` getter reads the models live: a landed fetch shows Generate on the next paint
  void ctx.modelsReady?.then(() => paint());

  /** This tab's agent only: the Claude view never lists Codex rows and the Codex view never lists Claude ones. */
  const scoped = (s: BareLocalSources): BareLocalSources => ({ ...s, files: agentFiles(s.files, codex) });

  const setBusy = (b: boolean): void => {
    busy = b;
    if (b) root.setAttribute("aria-busy", "true"); else root.removeAttribute("aria-busy");
  };

  /** Runs one flow action with every control disabled, then redraws. */
  async function act(fn: () => Promise<void>): Promise<void> {
    if (busy || disposed) return;
    setBusy(true);
    paint();
    try { await fn(); } finally {
      if (!disposed) { setBusy(false); paint(); }
    }
  }

  function errEl(r: ActionResult | null, what: "import" | "load" = "import"): HTMLElement | null {
    const e = r && errorLine(r, what);
    if (!e) return null;
    const d = el("div", "rp-error");
    if (r && !r.ok && r.reason === "failed") d.appendChild(el("b", "", e.text));
    else d.textContent = e.text;
    if (e.title) d.title = e.title;
    return d;
  }

  async function refreshActives(): Promise<void> {
    loadErr = null;
    const r = await flow.load();
    if (disposed) return;
    if (!r.ok) loadErr = r;
    loaded = true;
    const a = flow.actives();
    // sources feed the Inherited Runes ticks; a failed read leaves only what the row holds
    try { sources = scoped(await io.localSources(ctx.cwd)); sourcesErr = null; } catch (e) { sourcesErr = String(e); }
    if (disposed || !a) return;
    deltas = await flow.check();
  }

  function trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void {
    det.open = openSets.get(key) ?? dflt;
    fillCard(det); // an open card has its body now, not a task later
    det.addEventListener("toggle", () => openSets.set(key, det.open));
  }

  function librarySet(lib: BareActiveLibrary, delta: LibraryDelta | undefined): HTMLElement | null {
    // View: the runes that are on, read-only; a set with none on and nothing attached is not drawn
    const bricks = modify ? lib.bricks : lib.bricks.filter((b) => b.on);
    const attached = setGroups(lib);
    if (!bricks.length && !attached.length) return null;
    const cond = el("span", "runes-cond");
    if (lib.sourceGone) cond.textContent = "Source Not Found";
    else if (delta && (delta.added || delta.gone)) {
      for (const [n, sign] of [[delta.added, "+"], [delta.gone, "−"]] as const) {
        if (n) cond.appendChild(el("span", "runes-chip also", `${sign}${n}`));
      }
    }
    const label = lib.generated ? genLabel(lib.library) : null;
    // a user's library name shows with its first letter capitalised; the name on disk is untouched
    const shown = label ?? lib.library.charAt(0).toUpperCase() + lib.library.slice(1);
    const head = setHead(shown, bricks.length + attachedCount(sources, lib, codex), lib.scope === "project" ? "folder" : "globe", cond);
    const tips = [label ? lib.library : "", lib.source ?? "", lib.source === null && !lib.generated ? TIP_READ_ONLY : "", lib.sourceGone ? TIP_GONE : "",
      lib.scope === "project" ? TIP_PROJECT : ""].filter(Boolean);
    head.title = [...tips, ...(lib.sets ?? []).flatMap((s) => s.warnings)].join("\n");
    const det = setCard(hueOf(lib), head);
    det.dataset.library = lib.library;
    trackOpen(det, "lib:" + lib.library, false);
    const rowBusy = rowGenerating(ctx.rowKey);
    const locked = !flow.editable || (lib.source === null && !lib.generated) || lib.sourceGone || rowBusy;
    const tray = el("div", "runes-tray");
    for (const b of bricks) {
      // the switch: its own chip, so a click on the card opens it as in the ordinary view
      const sw = el("button", "runes-chip runes-bare-switch");
      sw.type = "button";
      sw.disabled = locked;
      sw.setAttribute("aria-pressed", String(b.on));
      sw.setAttribute("aria-label", b.on ? "On" : "Off");
      sw.title = rowBusy ? TIP_GENERATING : b.on ? "On" : lib.generated ? "Off" : `Off\n${TIP_RESCAN}`;
      sw.appendChild(iconImg(b.on ? "check-circle" : "dismiss-circle"));
      sw.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void act(async () => {
          const r = await flow.toggleBrick(lib.library, b.id, !b.on);
          actErr = r.ok ? null : r;
          if (r.ok) deltas = await flow.check();
        });
      });
      const rune = { id: b.id, kind: b.kind, scope: [], activate: b.activate, description: b.description, path: b.path, body: b.body };
      const card = cardDetails(rune, {
        // the name is the slug's Title Case form; a sentence description or heading goes to the tooltip (user, 2026-10-22)
        name: runeName({ id: b.id, path: b.path } as RuneItem),
        dim: modify && !b.on,
        title: [b.id, ...new Set([b.description, b.section.join(" / ")].filter(Boolean))].join("\n"),
        scopes: [{ icon: BARE_SCOPE.icons[lib.scope], title: `Scope: ${BARE_SCOPE.names[lib.scope]}` }],
        tail: modify ? [sw] : [],
        barScope: BARE_SCOPE.names[lib.scope],
      }, cardCtx);
      card.dataset.id = b.id;
      trackOpen(card, `rune:${lib.library}:${b.id}`, false);
      tray.appendChild(card);
    }
    // an empty tray still carries its vertical padding: with only attached groups it left a blank band above Skills
    det.append(...agentV.libraryExtras(lib), ...(bricks.length ? [tray] : []), ...attached);
    return det;
  }

  /** The set groups of `lib` (./set-attach): what each set the row names there attaches. */
  function setGroups(lib: BareActiveLibrary): HTMLElement[] {
    return setAttachments(lib, {
      codex, modify, editable: flow.editable, io, sources, kinds: layerKinds, setHead, trackOpen, tickRow,
      act: (fn) => void act(fn),
      done: async (err) => { actErr = err; await refreshActives(); },
    });
  }

  /** One tick row (Local Files and Inherited Runes share it). */
  function tickRow(f: BareLocalFile, on: boolean, flip: () => void, off: boolean): HTMLButtonElement {
    const b = btn(f.shown, "rp-source", flip, off || !f.pickable);
    b.dataset.path = f.path;
    b.setAttribute("aria-pressed", String(on));
    if (isFileRow(f)) {
      b.replaceChildren(...nameAndPath(f));
      b.title = f.reason ? `${f.path}\n${TIP_REASON[f.reason]}` : f.path;
    } else if (f.reason) b.title = TIP_REASON[f.reason];
    return b;
  }

  function everyRow(a: BareActives): HTMLElement | null {
    const h = setHead("Inherited Runes", null, "globe");
    h.title = TIP_EVERY_ROW;
    const group = setCard("hue-inherited", h);
    trackOpen(group, "every", true);
    const { files, ticked: on } = layerFiles(sources, a, codex);
    let drawn = 0;
    for (const [kind, name, icon] of layerKinds) {
      // View lists only what is ticked; Modify lists everything offered
      const kindFiles = files.filter((f) => f.kind === kind && (modify || on.has(f.path)));
      if (!kindFiles.length) continue; // nothing to show: no empty head
      drawn++;
      const det = el("details", `runes-set hue-${kind === "skill" || kind === "agent" || kind === "hook" ? kind : "none"}`);
      det.dataset.kind = kind;
      trackOpen(det, "kind:" + kind, false);
      det.appendChild(setHead(name, kindFiles.filter((f) => on.has(f.path)).length, icon));
      const list = el("div", "rp-sources runes-tray");
      for (const f of kindFiles) {
        if (!modify) {
          const ro = el("div", "rp-source is-ro", isFileRow(f) ? "" : f.shown);
          if (isFileRow(f)) ro.append(...nameAndPath(f));
          ro.dataset.path = f.path;
          ro.dataset.kind = kind;
          ro.title = f.path;
          list.appendChild(ro);
          continue;
        }
        const row = tickRow(f, on.has(f.path), () => {
          const next = new Set(on);
          if (!next.delete(f.path)) next.add(f.path);
          void act(async () => {
            const res = await flow.generate({
              sources: { files, memoryDir: null, guardsKey: a.guardsKey },
              ticked: next,
              current: { guards: a.guards, skills: a.skills, agents: a.agents, codexSkills: a.codexSkills, codexAgents: a.codexAgents, codexMcp: a.codexMcp },
            });
            const bad = res.find((l) => l.state === "failed");
            actErr = bad ? { ok: false, reason: bad.error === "readOnly" ? "readOnly" : "failed", error: bad.error } : null;
          });
        }, !flow.editable);
        row.dataset.kind = kind;
        list.appendChild(row);
      }
      det.appendChild(list);
      group.appendChild(det);
    }
    return drawn ? group : null;
  }

  function activesView(): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (!flow.editable) {
      out.push(el("div", "runes-bare-note", NOTE_NO_ROW)); // note-ok: docs/projects/bare/runes-tab-plan.md
      const actions = el("div", "rp-actions");
      actions.appendChild(btn("Add Local Files", "ws-btn", () => undefined, true));
      out.push(actions);
      out.push(trace);
      return out;
    }
    const tr = [trace];
    if (!loaded) return tr;
    const a = flow.actives();
    const e = errEl(loadErr, "load");
    if (e || !a) return [...(e ? [e] : []), ...tr];
    if (isEmptyRow(a)) {
      const center = el("div", "runes-bare-center");
      center.appendChild(btn("Create Runes", "ws-btn ws-add", () => void openFiles(), busy));
      return [center, ...tr];
    }
    const ae = errEl(actErr);
    if (ae) out.push(ae);
    const dl = agentV.doneLine();
    if (dl) out.push(dl);
    if (a.libraries.length) {
      const libs = el("section", "runes-group");
      for (const lib of a.libraries) {
        const s = librarySet(lib, deltas.find((d) => d.library === lib.library));
        if (s) libs.appendChild(s);
      }
      if (libs.childElementCount) out.push(libs);
    }
    const every = everyRow(a);
    if (every) out.push(every);
    if (sourcesErr && modify) { const se = errEl({ ok: false, reason: "failed", error: sourcesErr }); if (se) out.push(se); }
    if (modify) out.push(el("div", "runes-bare-note", codex ? NOTE_NEXT_CODEX : NOTE_NEXT)); // note-ok: docs/projects/bare/runes-tab-plan.md
    const actions = el("div", "rp-actions");
    if (modify) actions.appendChild(btn("Add Local Files", "ws-btn", () => void openFiles(), busy));
    if (deltas.some((d) => d.added || d.gone)) {
      const upd = btn("Update from Source", "ws-btn", () => {
        void act(async () => {
          const r = await flow.update();
          actErr = r.ok ? null : r;
          deltas = await flow.check();
        });
      }, busy);
      upd.title = TIP_RESCAN;
      actions.appendChild(upd);
    }
    if (actions.childElementCount) out.push(actions);
    if (!modify) out.push(trace);
    return out;
  }

  async function openFiles(): Promise<void> {
    await act(async () => {
      try {
        sources = scoped(await io.localSources(ctx.cwd));
        sourcesErr = null;
      } catch (e) { sourcesErr = String(e); }
      if (disposed) return;
      ticked = filesTicks(sources?.files ?? [], flow.actives(), codex);
      view = "files";
    });
  }

  function filesView(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const topHead = setHead("Local Files", null, "folder");
    if (codex) topHead.title = TIP_FILES_CODEX;
    const top = setCard("hue-none", topHead);
    trackOpen(top, "files", true);
    out.push(top);
    const files = sourcesErr ? [] : (sources?.files ?? []).filter((f) => !codex || f.kind === "rules" || f.kind === "memory" || f.kind === "skill" || f.kind === "agent" || f.kind === "mcp");
    if (sourcesErr) { const se = errEl({ ok: false, reason: "failed", error: sourcesErr }); if (se) { const t = el("div", "runes-tray"); t.appendChild(se); top.appendChild(t); } }
    else if (!files.length) { const t = el("div", "runes-tray"); t.appendChild(el("div", "rp-empty", "No Local Files Found")); top.appendChild(t); } // note-ok: docs/projects/bare/runes-tab-plan.md
    for (const [kind, name] of KIND_HEAD) {
      const kindFiles = files.filter((f) => f.kind === kind);
      if (!kindFiles.length) continue;
      const group = el("details", `runes-set hue-${kind === "skill" || kind === "agent" || kind === "hook" ? kind : "none"}`);
      group.dataset.kind = kind;
      trackOpen(group, "file:" + kind, true);
      group.appendChild(setHead(name, kindFiles.filter((f) => ticked.has(f.path)).length, LAYER_KINDS.find(([k]) => k === kind)?.[2] ?? null));
      const list = el("div", "rp-sources runes-tray");
      for (const f of kindFiles) {
        list.appendChild(tickRow(f, ticked.has(f.path), () => {
          if (busy) return;
          if (!ticked.delete(f.path)) ticked.add(f.path);
          paint();
        }, false));
      }
      group.appendChild(list);
      top.appendChild(group);
    }
    const any = files.some((f) => f.pickable && ticked.has(f.path));
    const actions = el("div", "rp-actions");
    const gen = sources && !sourcesErr ? agentV.generateButton(sources, ticked, any) : null;
    const asIs = btn("Import Raw","ws-btn", () => void runGenerate(), busy || !any || rowGenerating(ctx.rowKey));
    if (rowGenerating(ctx.rowKey)) asIs.title = TIP_GENERATING;
    actions.append(
      ...(gen ? [...agentV.selects(), gen] : []),
      asIs,
      btn("Back", "ws-btn", () => { view = "actives"; paint(); }, busy),
    );
    out.push(actions);
    return out;
  }

  async function runGenerate(): Promise<void> {
    if (!sources || busy) return;
    const src = sources;
    const a = flow.actives();
    view = "generating";
    genDone = false; gate.ran();
    lines = [];
    await act(async () => {
      lines = await flow.generate({
        sources: src, ticked,
        current: a ? { guards: a.guards, skills: a.skills, agents: a.agents, codexSkills: a.codexSkills, codexAgents: a.codexAgents, codexMcp: a.codexMcp } : undefined,
        onLine: (l) => { lines = [...l]; if (!disposed) paint(); },
      });
      actErr = null;
      loaded = true;
      deltas = await flow.check();
      genDone = true;
      if (lines.every((l) => l.state === "done")) view = "actives";
    });
  }

  function lineLabel(l: GenerateLine): string {
    if (l.kind === "layer") return codex ? HEAD_CODEX_LAYER : "Skills, Agents and Hooks";
    if (l.kind === "memory") {
      const m = sources?.files.find((f) => f.kind === "memory");
      return m ? dirOf(m.shown) : l.key;
    }
    return sources?.files.find((f) => f.path === l.key)?.shown ?? lastSeg(l.key);
  }

  function generatingView(): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (!genDone) out.push(el("div", "runes-bare-note", "Generating…")); // note-ok: docs/projects/bare/runes-tab-plan.md
    const list = el("div", "runes-bare-lines");
    for (const l of lines) {
      const row = el("div", "runes-bare-line");
      row.dataset.state = l.state;
      row.appendChild(el("span", "runes-bare-line-path", lineLabel(l)));
      const st = el("span", "runes-bare-line-state");
      if (l.state === "done") st.textContent = "Done";
      if (l.state === "failed") {
        st.textContent = "Import Failed";
        st.classList.add("rp-error");
        st.title = l.error === "readOnly" ? NOTE_NO_ROW : l.error ?? "";
      }
      row.appendChild(st);
      list.appendChild(row);
    }
    out.push(list);
    if (genDone) {
      const actions = el("div", "rp-actions");
      actions.appendChild(btn("Back", "ws-btn", () => { view = "actives"; paint(); }, busy));
      out.push(actions);
    }
    return out;
  }

  function paint(): void {
    if (disposed) return;
    const parts = view === "files" ? filesView() : view === "generating" ? generatingView()
      : view === "agent" ? agentV.generatingView() : activesView();
    root.dataset.bareView = view; // runes.css hides the icon key while a run shows: no runes to read it against
    root.replaceChildren(...parts);
    paintMode();
    if (view === "actives") gate.atActives();
  }

  /** The switch shows over Actives only, once the row has runes to view or change. */
  function paintMode(): void {
    const a = flow.actives();
    const show = view === "actives" && flow.editable && loaded && !loadErr && !!a && !isEmptyRow(a);
    modeButton.hidden = !show;
    modeButton.disabled = busy;
    modeButton.classList.toggle("is-editing", modify);
    modeButton.setAttribute("aria-pressed", String(modify));
    modeButton.replaceChildren(iconImg(modify ? "check-circle" : "document-edit"), el("span", "", modify ? "Done" : "Modify"));
  }

  paint();
  const first = flow.editable ? act(refreshActives) : Promise.resolve();
  if (startView(ctx.start) === "files") void first.then(openFiles);
  return {
    root,
    modeButton,
    setTrace(parts) {
      if (disposed) return;
      const open = openKeys(trace);
      trace.replaceChildren(...parts);
      trace.hidden = !parts.length;
      reopen(trace, open);
    },
    reload() {
      if (disposed || !flow.editable || view !== "actives" || busy) return;
      void act(refreshActives);
    },
    dispose() {
      disposed = true;
      agentV.dispose();
      unwatch();
      root.remove();
      modeButton.remove();
    },
  };
}
