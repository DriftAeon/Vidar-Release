// src\launcher\codex-recent.ts — the Codex Resume flyout: past Codex threads for a location
// (list_codex_threads). Same column and row look as the Claude one in recent.ts.
import { invoke } from "../ipc";
import type { CodexThreadRow } from "../ipc";
import { DASH, prettyModel } from "../format";
import { codexThreadHolder, refreshRawCodexThreads } from "../panels/sessions";
import type { AgentType, Location } from "../config";
import { spawnFrom } from "./roster";
import { openColumn, placeColumn } from "./columns";
import { twoLineRow } from "./menu-rows";
import { ago } from "./ago";
import { lucide } from "../icons";
import { cachedList } from "./recent-cache";


/** Rows shown before the Show More chevron; the list Rust returns is longer (display-only cap). */
const RESUME_CAP = 6;

/** Draw `list` into the Resume column `sub`: the newest RESUME_CAP rows, then, when there are more,
 *  a chevron row that expands the rest in place (and collapses it again). `place` re-measures the
 *  column; an expanded list scrolls inside the room left on screen. */
export function drawCapped<T>(sub: HTMLElement, list: readonly T[], draw: (item: T) => void, place: () => void): void {
  let expanded = false;
  const render = () => {
    sub.innerHTML = "";
    sub.style.maxHeight = "";
    for (const item of expanded ? list : list.slice(0, RESUME_CAP)) draw(item);
    if (list.length > RESUME_CAP) {
      const more = document.createElement("button");
      more.className = "launcher-more";
      // a chevron despite the no-chevron rule: this one toggles the Resume cap
      more.appendChild(lucide("chevron-down", "icn"));
      more.classList.toggle("is-open", expanded);
      more.title = more.ariaLabel = expanded ? "Show Less" : "Show More";
      more.addEventListener("click", () => { expanded = !expanded; render(); });
      sub.appendChild(more);
    }
    place();
    const top = parseFloat(sub.style.top) || 0;
    sub.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
  };
  render();
}

// The list and the held-thread refresh share one fetch per launcher opening (recent-cache): the
// Codex agent column starts them early (prefetchCodexRecent), Resume reuses the same promises.
function codexList(rendered: AgentType, loc: Location) {
  // a Bare row lists its own home (profile), never the default one; the cache key keeps them apart
  const profile = rendered.profile || undefined;
  return cachedList<CodexThreadRow[]>(`codex|${profile ?? ""}|${loc.cwd}`, () => invoke("list_codex_threads", { cwd: loc.cwd, profile }));
}
const rawRefresh = () => cachedList<void>("codex-raw", () => refreshRawCodexThreads());

/** Start the Resume reads when the Codex agent column opens. Errors surface when Resume opens. */
export function prefetchCodexRecent(rendered: AgentType, loc: Location): void {
  codexList(rendered, loc).promise.catch(() => {});
  rawRefresh().promise.catch(() => {});
}

// `stale()` is true once the menu moved on (recent.ts owns the generation counter).
export async function openCodexRecent(
  t: AgentType, rendered: AgentType, loc: Location, anchor: HTMLElement, depth: number, stale: () => boolean,
) {
  const sub = openColumn(depth, anchor);
  const note = (text: string, cls = "launcher-note") => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    sub.appendChild(d);
  };
  const cached = codexList(rendered, loc);
  let list: CodexThreadRow[];
  if (cached.hit) list = cached.hit; // settled earlier in this opening: rows now, no Loading…
  else {
    note("Loading…");
    placeColumn(depth, anchor);
    try {
      list = await cached.promise;
    } catch (e) {
      if (stale() || sub.classList.contains("hidden")) return;
      sub.innerHTML = "";
      console.error("thread list:", e);
      note("Can't Read Threads", "launcher-note launcher-note-err");
      placeColumn(depth, anchor);
      return;
    }
  }
  if (stale() || sub.classList.contains("hidden")) return;
  // the held-thread check: warm when the column-open prefetch settled, else wait on its in-flight read
  const raw = rawRefresh();
  if (!raw.hit) await raw.promise.catch(() => {});
  if (stale() || sub.classList.contains("hidden")) return;
  sub.innerHTML = "";
  if (!list.length) note(DASH);
  const draw = (r: CodexThreadRow) => {
    const holder = codexThreadHolder(r.id);
    const inVidar = Boolean(holder);
    const age = `${ago(r.ageSecs)} · ${r.model ? prettyModel(r.model) : r.id.slice(0, 8)}`;
    const why = inVidar ? "open in Vidar" : age;
    const b = twoLineRow(sub, r.label, why, `${r.cwd}\n${r.id}`);
    if (inVidar) { b.classList.add("inert"); return; }
    b.addEventListener("click", () => {
      void spawnFrom({ ...rendered, model: r.model || rendered.model, cwd: undefined }, { label: loc.label, cwd: r.cwd || loc.cwd }, undefined, r.id); // the vault comes from the thread's session record (spawnFrom, rune_vault_session); no title: createSession mints a themed name
    });
  };
  if (!list.length) return placeColumn(depth, anchor);
  drawCapped(sub, list, draw, () => placeColumn(depth, anchor));
}
