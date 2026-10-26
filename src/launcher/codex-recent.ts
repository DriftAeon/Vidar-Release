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
import { cachedList } from "./recent-cache";


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
      console.error("codex threads:", e);
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
  for (const r of list) {
    const inVidar = codexThreadHolder(r.id) !== null;
    const age = `${ago(r.ageSecs)} · ${r.model ? prettyModel(r.model) : r.id.slice(0, 8)}`;
    const why = inVidar ? "open in Vidar" : age;
    const b = twoLineRow(sub, r.label, why, `${r.cwd}\n${r.id}`);
    if (inVidar) { b.classList.add("inert"); continue; }
    b.addEventListener("click", () => {
      void spawnFrom({ ...rendered, model: r.model || rendered.model, cwd: undefined }, { label: loc.label, cwd: r.cwd || loc.cwd }, undefined, r.id); // the vault comes from the thread's session record (spawnFrom, rune_vault_session); no title: createSession mints a themed name
    });
  }
  placeColumn(depth, anchor);
}
