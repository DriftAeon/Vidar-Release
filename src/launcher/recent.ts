// src\launcher\recent.ts — the Resume flyout: past Claude sessions for a location (list_recent_sessions)
// and the "/resume" answer for a rendered body (vidar-open-resume). Split from main.ts.
import { invoke } from "../ipc";
import { DASH } from "../format";
import { openRenderedSessionIds } from "../panels/sessions";
import type { AgentType, Location } from "../config";
import type { Effort } from "../agents/protocol";
import { agentKind, launcherTypes, shownRoots, shownVariants, spawnFrom, variantsOf } from "./roster";
import { onboardingOpen } from "../onboarding/shell";
import { newBtn, openLauncher } from "./menu";
import { openColumn, placeColumn } from "./columns";
import { openCodexRecent } from "./codex-recent";
import { cachedList } from "./recent-cache";
import { showSessionsToast } from "../panels/sessions/zoom";
import { twoLineRow } from "./menu-rows";
import { ago } from "./ago";
import { launcherLead, resumeVariant } from "./body-order";
import { workspaces } from "./workspaces";

export interface RecentSession {
  sessionId: string;
  label: string;
  cwd: string;
  ageSecs: number;
  live: boolean;
  note: string | null;
  /** set refs (`library/set`) of the Bare home the transcript sits in; absent for the user's own `.claude` */
  sets?: string[];
}

let recentGen = 0;
const resumeInFlight = new Set<string>(); // session ids mid-click (meta read, then spawn)

// Recent column: Claude sessions started from this location, newest first,
// from the transcript folder. Live ones (registry, or open in a Vidar tab) are
// inert with the reason; Rust re-checks at spawn, which is the real guard.
export async function openRecent(t: AgentType, rendered: AgentType, loc: Location, anchor: HTMLElement, depth = 2) {
  const gen = ++recentGen;
  if (agentKind(t.id) === "codex") return openCodexRecent(t, rendered, loc, anchor, depth, () => gen !== recentGen);
  const sub = openColumn(depth, anchor);
  const note = (text: string, cls = "launcher-note") => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    sub.appendChild(d);
  };
  // a Bare Rendered row lists its own home (the profile rides on the variant, not the root type)
  const profile = rendered.profile ?? t.profile ?? null;
  const cached = cachedList<RecentSession[]>(`claude|${loc.cwd}|${profile ?? ""}`, () =>
    invoke("list_recent_sessions", { cwd: loc.cwd, profile }),
  );
  let list: RecentSession[];
  if (cached.hit) list = cached.hit; // settled earlier in this opening: rows now, no Loading…
  else {
    note("Loading…");
    placeColumn(depth, anchor);
    try {
      list = await cached.promise;
    } catch (e) {
      if (gen !== recentGen || sub.classList.contains("hidden")) return;
      sub.innerHTML = "";
      console.error("recent sessions:", e);
      note("Can't Read Sessions", "launcher-note launcher-note-err");
      placeColumn(depth, anchor);
      return;
    }
  }
  if (gen !== recentGen || sub.classList.contains("hidden")) return; // the menu moved on meanwhile
  sub.innerHTML = "";
  const open = new Set(openRenderedSessionIds());
  if (!list.length) note(DASH);
  for (const s of list) {
    const inVidar = open.has(s.sessionId);
    const why = inVidar ? "open in Vidar" : s.note;
    const b = twoLineRow(sub, s.label, why ?? `${ago(s.ageSecs)} · ${s.sessionId.slice(0, 8)}`, `${s.cwd}\n${s.sessionId}`);
    if (s.live || inVidar) { b.classList.add("inert"); continue; }
    b.addEventListener("click", async () => {
      if (resumeInFlight.has(s.sessionId)) return; // the meta read takes a while: a second click would spawn twice
      resumeInFlight.add(s.sessionId);
      const subLine = b.querySelector<HTMLElement>(".launcher-sub-line");
      const was = subLine?.textContent ?? "";
      b.disabled = true;
      b.classList.add("inert");
      if (subLine) subLine.textContent = "Opening…";
      try {
        // resume on what the conversation last ran on; never block the resume on a failed read
        let entry: AgentType = rendered;
        try {
          const meta = await invoke("read_session_meta", { cwd: s.cwd, sessionId: s.sessionId, profile: rendered.profile ?? null });
          entry = { ...rendered, model: meta.model ?? rendered.model, effort: (meta.effort as Effort | null) ?? rendered.effort };
        } catch (e) {
          console.error("session meta:", e);
        }
        // the transcript's own cwd spelling, so Claude Code resolves the same project
        // a Bare transcript resumes on the vault its session record names (spawnFrom reads it)
        await spawnFrom({ ...entry, cwd: undefined }, { label: loc.label, cwd: s.cwd }, undefined, s.sessionId); // the vault comes from the session record (spawnFrom); no title: createSession mints a themed name
      } catch (e) {
        showSessionsToast(e instanceof Error ? e.message : String(e), 6000);
        b.disabled = false; // the launcher stays open on a failed spawn: the row is usable again
        b.classList.remove("inert");
        if (subLine) subLine.textContent = was;
      } finally {
        resumeInFlight.delete(s.sessionId);
      }
    });
  }
  placeColumn(depth, anchor);
}

export function initRecent(): void {
  /* A rendered Claude body typed "/resume" (rendered.ts, localCommand). It cannot
     resume itself — Rust refuses a resume of a live session and spawnFrom opens a
     new tab regardless — so the launcher answers it: the past-session list opens as
     the launcher's FIRST column (depth 0, measured against the visible menu rather
     than a hidden parent column) and a pick becomes a new tab, the asking body
     untouched. */
  document.addEventListener("vidar-open-resume", (ev) => {
    const d = (ev as CustomEvent<{ agent: string; cwd: string; profile?: string; rowKey?: string }>).detail;
    // only what the launcher shows: a type or Rendered variant hidden by a missing dependency
    // offers no resume
    const roots = shownRoots().filter((x) => x.id === d.agent);
    const plainRoot = roots.find((x) => !x.profile);
    // a plain tab keeps the plain Rendered row while it is shown; with the plain rows off it falls
    // back to the Bare one the launcher leads with
    const plainRendered = plainRoot && shownVariants(plainRoot).find((v) => v.body === "rendered" && !v.profile);
    const t = (d.profile ? roots.find((x) => x.profile) : plainRendered ? plainRoot : roots.find((x) => x.profile)) ?? roots[0];
    // a Bare tab resumes into its own row (its home's sessions)
    const rendered = t && (d.profile
      ? resumeVariant(shownVariants(t), launcherLead(), { profile: d.profile, rowKey: d.rowKey })
      : plainRendered ?? resumeVariant(shownVariants(t), launcherLead()));
    if (!t || !rendered) {
      // no shown rendered variant for this agent kind: say so in the launcher's first column, the
      // same way openRecent reports a list it cannot give, instead of a /resume that does nothing.
      // The cause picks the message: the unfiltered roster has the pair → a dependency hides it;
      // otherwise the agent is disabled in vidar.json or has no Rendered variant.
      const hiddenByDeps = launcherTypes.some(
        (x) => x.id === d.agent && (variantsOf.get(x) ?? []).some((v) => v.body === "rendered" && (!d.profile || v.profile === d.profile)),
      );
      if (onboardingOpen()) return; // onboarding gate: no launcher while the overlay is up
      ++recentGen; // an in-flight openRecent must not overwrite this note
      openLauncher();
      const sub = openColumn(0, newBtn);
      sub.innerHTML = "";
      const n = document.createElement("div");
      n.className = "launcher-note";
      n.textContent = hiddenByDeps
        ? "Resume Unavailable: Missing Dependency (Open Dependencies)"
        : "Resume Unavailable: No Rendered Variant";
      sub.appendChild(n);
      placeColumn(0, newBtn);
      return;
    }
    const key = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const loc = workspaces.find((l) => key(l.cwd) === key(d.cwd))
      ?? { label: d.cwd.split(/[\\/]/).filter(Boolean).pop() ?? d.cwd, cwd: d.cwd };
    if (onboardingOpen()) return; // onboarding gate
    openLauncher();
    void openRecent(t, rendered, loc, newBtn, 0);
  });
}
