// src\launcher\locations.ts — the launcher's location column and what hangs off it: bodies (Raw /
// Rendered / Resume), Active (adopt an external Claude session) and Select Workspace (none saved yet). Split from main.ts.
import { invoke } from "../ipc";
import { DASH } from "../format";
import { createSession } from "../panels/sessions";
import { resolveDefaultCwd } from "../config";
import type { AgentType, Location } from "../config";
import { agentKind, shownRoots, shownVariants, spawnFrom, typeLabel } from "./roster";
import { falconRowParent } from "./roster-shown";
import { effectivePrimary } from "../agents/primary";
import { depsReport, isAvailable, loadDeps } from "../deps/state";
import { rel } from "../paths";
import { codexBareRefusesCwd } from "./codex-vidar-cwd";
import { showVidarPath } from "./vidar-path";
import { appendHostedRow } from "./hosted";
import { closeLauncher, launcherSub } from "./menu";
import { hideColsFrom, hoverOpen, openColumn, placeColumn } from "./columns";
import { markFor, menuRow } from "./menu-rows";
import { ago } from "./ago";
import { openRecent } from "./recent";
import { prefetchCodexRecent } from "./codex-recent";
import { pickWorkspace } from "./workspaces";
import { showSessionsToast } from "../panels/sessions/zoom";
import { prepareRules } from "../rules/prepare";
import { isGateway } from "./agent-kind";
import { attachSetPick } from "./set-pick";
import { bodyOrder, launcherLead, resumeVariant } from "./body-order";

// spawnFrom closes the launcher before it resolves a `{vidar}` cwd, so its rejection ("Vidar Folder
// Unknown", vidar-path.ts) has no menu left to land in; every click here goes through this so the
// reason reaches the toast instead of an unhandled rejection.
function go(t: AgentType, loc: Location, title?: string, vault?: string): void {
  spawnFrom(t, loc, title, undefined, undefined, undefined, undefined, vault).catch((e) => showSessionsToast(e instanceof Error ? e.message : String(e), 6000));
}

export function openLocations(t: AgentType, anchor: HTMLElement, locations: Location[]) {
  const sub = openColumn(0, anchor);
  // A type with a rendered variant gets a body column after the location
  // (Claude › Vidar › Raw / Rendered / Resume) — picking "Rendered" blind left the
  // user not knowing the model, mode or folder it opened in.
  // shownVariants: dependency-gated; a Rendered variant whose deps are missing
  // drops the body column and the locations spawn raw
  const rendered = shownVariants(t).find((v) => v.body === "rendered" && !v.profile);
  // A profiled (Bare) variant is the same kind of body choice: it opens the column too
  // (Claude › Bare is Raw, Claude › Rendered Bare and Codex › Rendered Bare are Rendered; each
  // label names it), one row per profiled variant.
  const bare = shownVariants(t).filter((v) => v.profile);
  const bodies = !!rendered || bare.length > 0;
  for (const loc of locations) {
    const b = menuRow(sub, loc.label);
    b.title = loc.cwd;
    if (!bodies) {
      b.addEventListener("click", () => go(t, loc)); // shell: click only, hover never spawns
      continue;
    }
    b.classList.add("has-sub");
    const open = () => openBodies(t, rendered, bare, loc, b);
    hoverOpen(b, 1, open); // same synthetic-mouseenter gate as the type rows (kbNav)
    b.addEventListener("click", (e) => { e.stopPropagation(); open(); });
  }
  // No workspaces yet: one Select Workspace… row. Same hover-to-bodies as a workspace, but a
  // pick first opens the folder picker and saves the folder as a workspace,
  // after which this row gives way to the list. Workspaces are otherwise added in Settings.
  if (!locations.length) {
    // Home first: the backend's default folder, resolved at click time and never saved as a workspace.
    const h = menuRow(sub, "Home");
    h.classList.add("launcher-home");
    h.title = "Open In Your Default Folder";
    // Codex always refuses the home folder (codex_cwd.rs): once the backend says so, the row keeps its
    // look and opens the folder picker, as Select Workspace… does. Until the check
    // settles it behaves as for any other type.
    let refused = false;
    let bareRefused = false;
    if (!bodies) {
      const launch = withLocation(homeLocation, (loc) => go(t, loc));
      const pick = withPicked((loc) => go(t, loc));
      h.addEventListener("click", (e) => (refused ? pick(e) : launch(e)));
    } else {
      h.classList.add("has-sub");
      const open = () => {
        if (refused) openBodies(t, rendered, bare, null, h);
        else openBodies(t, rendered, bare, null, h, homeLocation, bareRefused);
      };
      hoverOpen(h, 1, open);
      h.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    }
    if (agentKind(t.id) === "codex") {
      // Codex Bare also refuses Vidar's folder and its parents (bare/mod.rs refuse_vidar_cwd): the
      // Bare body rows under Home dim once the resolved folder is known to hit that rule.
      void codexBareRefusesHome().then((r) => { bareRefused = r; }, (err) => console.error("codex bare home check:", err));
      void codexRefusesHome().then((r) => {
        if (!r) return;
        refused = true;
        h.title = "Codex can't open in your home folder; choose a project folder";
        // A body column already open from this row was built for Home: it reopens on the picker.
        if (h.classList.contains("open")) { h.classList.remove("open"); hideColsFrom(1); }
      }, (err) => console.error("codex home check:", err));
    }
    const b = menuRow(sub, "Select Workspace…");
    b.classList.add("launcher-pick");
    b.title = "Choose A Folder; It Becomes Your First Workspace";
    if (!bodies) {
      b.addEventListener("click", withPicked((loc) => go(t, loc)));
    } else {
      b.classList.add("has-sub");
      const open = () => openBodies(t, rendered, bare, null, b);
      hoverOpen(b, 1, open);
      b.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    }
  }
  // Variants (Astra under Codex): pinned cwd, so no location step — the row
  // spawns directly, titled by its own label. The first one carries the rule.
  const variants = shownVariants(t).filter((v) => v.body !== "rendered" && !v.profile);
  variants.forEach((v, i) => {
    const b = menuRow(launcherSub, typeLabel(v), markFor(`${v.id} ${v.label ?? ""}`));
    if (i === 0) b.classList.add("launcher-variant");
    b.title = showVidarPath(v.cwd!); // a `{vidar}` cwd shows the real folder once deps report
    b.addEventListener("click", () => go(v, { label: typeLabel(v), cwd: v.cwd! }, typeLabel(v)));
  });
  // Falcon sits under the primary agent's root (else the other one's, when the primary's is hidden),
  // so Jettisoned Codex sessions stay reachable without the Claude root. The first shown root with
  // that id hosts it, as variants attach (roster.ts resolveAgents).
  const roots = shownRoots();
  const falconAt = falconRowParent(effectivePrimary(), roots.map((r) => r.id), isAvailable("falcon"));
  if (falconAt !== null && !isGateway(t.id) && roots.find((r) => r.id === falconAt) === t) {
    appendHostedRow(launcherSub);
  }
  if (agentKind(t.id) === "claude" && !isGateway(t.id)) {
    // live Claude sessions outside Vidar, pulled in — Claude-only
    // because discovery rides Claude Code's own session registry
    const active = menuRow(launcherSub, "Active");
    active.classList.add("launcher-active");
    active.addEventListener("click", (e) => {
      e.stopPropagation();
      void beginActiveList(t, anchor, locations);
    });
  }
  placeSub(anchor);
}

/** Wraps a launch for the Select Workspace row: close the launcher, open the folder picker,
 *  launch in the picked (and now saved) folder. Cancel does nothing. */
function withPicked(launch: (loc: Location) => void): (e: Event) => void {
  return withLocation(pickWorkspace, launch);
}

/** The Home row's location: the backend-resolved default folder (vidar.json `defaultCwd`, else
 *  home). Not saved as a workspace; null when nothing resolves. */
async function homeLocation(): Promise<Location | null> {
  const cwd = await resolveDefaultCwd();
  return cwd ? { label: "Home", cwd } : null;
}

/** Whether Codex would refuse the Home row's folder (codex_cwd.rs); false when none resolves. */
async function codexRefusesHome(): Promise<boolean> {
  const cwd = await resolveDefaultCwd();
  return cwd ? invoke("codex_cwd_refused", { cwd }) : false;
}

/** Whether Codex Bare would refuse the Home row's folder for being Vidar's folder, a parent of it or
 *  its runtime folder; false when the folder or the Vidar root is unknown. */
async function codexBareRefusesHome(): Promise<boolean> {
  const cwd = await resolveDefaultCwd();
  const root = depsReport()?.root ?? (await loadDeps())?.root;
  return !!cwd && !!root && codexBareRefusesCwd(cwd, root, rel("bridge").split("/")[0]);
}

/** Close the launcher, resolve a location (folder picker or Home), launch there. Null does nothing,
 *  except Home with no resolvable folder, which says so. */
function withLocation(resolve: () => Promise<Location | null>, launch: (loc: Location) => void): (e: Event) => void {
  return (e) => {
    e.stopPropagation();
    closeLauncher();
    void resolve().then((loc) => {
      if (loc) launch(loc);
      else if (resolve === homeLocation) showSessionsToast("Home Folder Unknown", 6000);
    }, (err) => console.error("launcher location:", err));
  };
}

// Body column: Raw (the type's own args in a pty), Rendered (headless, drawn by
// Vidar), Bare (Raw on the profile's own home and layer) or Resume › (a past session, rendered)
// at the chosen location. Each row is a plain label (cwd in the tooltip). `loc` null = the
// Select Workspace row: the folder is picked on click, and Resume has no folder to list.
// Rendered and Resume need a shown Rendered variant; Bare needs a shown profiled one.
function openBodies(t: AgentType, rendered: AgentType | undefined, bare: AgentType[], loc: Location | null, anchor: HTMLElement, resolve: () => Promise<Location | null> = pickWorkspace, bareRefused = false) {
  const sub = openColumn(1, anchor);
  // One-line rows: location and brand are already known, so no sub-line (2026-10-03).
  const bodyRow = (label: string, cwd: string) => {
    const b = menuRow(sub, label);
    if (cwd) b.title = cwd;
    return b;
  };
  const rows: { row: HTMLButtonElement; launch: (l: Location) => void; bare?: AgentType }[] = [];
  for (const o of bodyOrder(!!rendered, bare, launcherLead())) {
    if (o.kind === "raw") rows.push({ row: bodyRow("Raw", loc?.cwd ?? ""), launch: (l) => go(t, l) });
    else if (o.kind === "rendered" && rendered) rows.push({ row: bodyRow("Rendered", loc?.cwd ?? ""), launch: (l) => go({ ...rendered, cwd: undefined }, l) });
    else if (o.kind === "bare") rows.push({ row: bodyRow(typeLabel(o.variant), loc?.cwd ?? ""), launch: (l) => go({ ...o.variant, cwd: undefined }, l), bare: o.variant });
  }
  if (!loc) {
    for (const r of rows) {
      if (r.bare && bareRefused) {
        r.row.classList.add("inert");
        r.row.title = "Codex can't open in Vidar's folder or its parents";
        r.row.addEventListener("click", (e) => e.stopPropagation());
      } else r.row.addEventListener("click", withLocation(resolve, r.launch));
    }
    placeColumn(1, anchor);
    return;
  }
  for (const r of rows) {
    r.row.addEventListener("click", () => r.launch(loc));
    // Pick Vault: every Bare row loads one Rune Vault; a plain click launches the pre-pick
    if (r.bare) {
      const variant = { ...r.bare, cwd: undefined };
      attachSetPick(r.row, { variant: r.bare, launch: (vault) => go(variant, loc, undefined, vault), place: () => placeColumn(1, anchor) });
    }
  }
  // Resume serves the Rendered variant the launcher leads with (Bare Rendered when it leads, or
  // when it is the only one shown)
  const resumeRow = resumeVariant([...(rendered ? [rendered] : []), ...bare], launcherLead());
  if (resumeRow && (agentKind(t.id) === "claude" || agentKind(t.id) === "codex")) {
    // Claude: the transcript store and session registry; Codex: thread/list (codex-recent.ts)
    const resume = bodyRow("Resume", loc.cwd);
    resume.classList.add("has-sub");
    if (agentKind(t.id) === "codex") prefetchCodexRecent(resumeRow, loc); // warm the list before Resume is hovered
    const open = () => void openRecent(t, resumeRow, loc, resume);
    hoverOpen(resume, 2, open);
    resume.addEventListener("click", (e) => { e.stopPropagation(); open(); });
  }
  placeColumn(1, anchor);
}

/* ---- Active: pull an external Claude session into a tab ----
   Rust lists live sessions from ~\.claude\sessions\<pid>.json checked against
   the process table, and adopt_session kills the hosting shell tree before we
   spawn the resuming tab (never two processes on one session id). */

export interface ExternalSession {
  pid: number;
  sessionId: string;
  name: string | null;
  cwd: string;
  status: string;
  host: string;
  ageSecs: number;
  adoptable: boolean;
  note: string | null;
}

let adoptInFlight = false;

async function beginActiveList(t: AgentType, anchor: HTMLElement, locations: Location[]) {
  launcherSub.innerHTML = "";
  const back = menuRow(launcherSub, "‹ Back");
  back.classList.add("launcher-back");
  back.addEventListener("click", (e) => {
    e.stopPropagation();
    openLocations(t, anchor, locations);
  });
  const note = (text: string, cls = "launcher-note") => {
    // a div, not a disabled button: moveFocus() can't land on a disabled
    // button and the keyboard walk would strand
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    launcherSub.appendChild(d);
  };
  let list: ExternalSession[] = [];
  try {
    list = await invoke("list_external_sessions");
  } catch (e) {
    console.error("external sessions:", e);
    note("Can't Read Sessions", "launcher-note launcher-note-err");
  }
  if (!launcherSub.contains(back)) return; // flyout moved on meanwhile
  if (!list.length) note(DASH);
  for (const s of list) {
    const leaf = s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || s.cwd;
    const b = menuRow(launcherSub, s.name ?? s.sessionId.slice(0, 8));
    b.classList.add("launcher-session");
    const sub = document.createElement("span");
    sub.className = "launcher-sub-line";
    sub.textContent = s.note ?? `${leaf} · ${s.host} · ${ago(s.ageSecs)}`;
    b.appendChild(sub);
    b.title = `${s.cwd}\n${s.sessionId}`;
    if (!s.adoptable) b.classList.add("inert");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!s.adoptable) return;
      void adopt(t, s, b);
    });
  }
  placeSub(anchor);
  back.focus();
}

async function adopt(t: AgentType, s: ExternalSession, row: HTMLButtonElement) {
  if (adoptInFlight) return; // a second click mid-await would kill twice
  if (!/^[0-9a-f-]{36}$/i.test(s.sessionId)) return;
  adoptInFlight = true;
  const sub = row.querySelector<HTMLElement>(".launcher-sub-line");
  if (sub) sub.textContent = "pulling in…";
  try {
    const r = await invoke("adopt_session", { pid: s.pid, sessionId: s.sessionId });
    closeLauncher();
    // S1: the adopted tab takes the plain Claude row's rules, prepared now like a fresh launch.
    // `t` is the Claude root (Active hangs off it), and the Bare root carries a profile: one sent
    // here would reach Rust beside the resume args and be refused as a tab error. The adopted
    // session lives in the default Claude home, so the tab is a plain one without a profile.
    const rules = await prepareRules({ ...t, profile: undefined });
    createSession({
      rules,
      agent: "claude",
      shell: t.shell,
      cwd: r.cwd,
      // the configured Claude args are for a fresh session; resume is its own form
      args: ["-NoExit", "-Command", `claude --resume ${r.sessionId}`],
    });
  } catch (e) {
    // the flyout stays open: the id is in the text so a hand --resume is possible
    if (sub) sub.textContent = `failed: ${String(e)} — ${s.sessionId}`;
    row.classList.add("inert");
  } finally {
    adoptInFlight = false;
  }
}

// column 0's in-place mode (Active) re-places it after refilling
function placeSub(anchor: HTMLElement) {
  placeColumn(0, anchor);
}
