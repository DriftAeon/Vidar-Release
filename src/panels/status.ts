import { invoke, listen } from "../ipc";
import type { CodexLimits } from "../ipc";
import type { FocusedSession } from "./sessions";
import { prettyModel } from "../format";
import { ago } from "../launcher/ago";
import { dispatchCharacterStatus } from "../character/events";

// One entry per Vidar tab that has a live Claude statusline. Written by the
// statusline script (keyed on VIDAR_TAB), watched by status.rs, which emits only when a file
// changes. The bar shows the FOCUSED tab's entry only — a powershell or other non-Claude tab
// has none and shows idle, and a closed tab's file is deleted by the pty layer.
interface TabStatus {
  tab: string;
  age_secs: number;
  /** the file's last write; absent in the browser mock, where `age_secs` stands */
  mtime_ms?: number;
  payload: Record<string, any>;
}

// Claude rewrites the statusline on activity; past a minute the numbers are
// probably idle-but-live, so keep them but drop the accent.
const STALE_SECS = 60;

let latest = new Map<string, TabStatus>();
// Raw Codex tabs: written by codex-model.ts from the rollout, kept apart so a Claude `status-update`
// (which replaces `latest` whole) cannot wipe them.
const codexLatest = new Map<string, TabStatus>();
let focusedTab: string | null = null;
let compact: HTMLElement;
let expanded: HTMLElement;
let lastCharacterStatus = "";
// Nothing re-emits an unchanged file, so ages come from the clock: one timer, re-armed by render().
let timer: ReturnType<typeof setTimeout> | undefined;
// What the two elements hold now; writes happen only on change.
let compactHtml = "";
let expandedHtml = "";
// Counts status-update events, so a snapshot reply that lost the race to one is dropped.
let updates = 0;

/** Whole seconds since the file was written; the Rust age when the entry has no mtime. */
function ageOf(s: TabStatus): number {
  return typeof s.mtime_ms === "number"
    ? Math.max(0, Math.floor((Date.now() - s.mtime_ms) / 1000))
    : s.age_secs;
}

/** Ms until `age > STALE_SECS` first holds under the floor, plus a small margin. */
function untilStale(s: TabStatus): number {
  const left = typeof s.mtime_ms === "number"
    ? s.mtime_ms + (STALE_SECS + 1) * 1000 - Date.now()
    : (STALE_SECS + 1 - s.age_secs) * 1000;
  // Capped at the longest honest wait: a future mtime would overflow setTimeout's 2^31-1 and spin.
  return Math.min(Math.max(0, left) + 50, (STALE_SECS + 1) * 1000 + 50);
}

/** A raw Codex tab's rollout reading (`read_codex_limits`), or null to forget it. No model, no entry. */
export function setCodexStatus(tab: string, payload: CodexLimits | null): void {
  if (!payload) codexLatest.delete(tab);
  else if (payload.model) {
    codexLatest.set(tab, {
      tab,
      age_secs: 0,
      mtime_ms: payload.observed_ms,
      payload: {
        session_name: "Codex",
        model: { id: payload.model },
        rate_limits: { five_hour: payload.five_hour ?? undefined, seven_day: payload.seven_day ?? undefined },
      },
    });
  } else return;
  if (compact) render();
}

function applyTabs(tabs: TabStatus[]) {
  latest = new Map(tabs.map((t) => [t.tab, t]));
  render();
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string),
  );
}

function bar(label: string, p: unknown, sub = ""): string {
  if (typeof p !== "number") return "";
  const clamped = Math.round(Math.max(0, Math.min(100, p)));
  return `
    <div class="stat">
      <div class="row"><span>${esc(label)}</span><span>${clamped}%</span></div>
      <div class="bar"><div class="bar-fill" style="width:${clamped}%"></div></div>
      ${sub ? `<div class="dim sub">${esc(sub)}</div>` : ""}
    </div>`;
}

function resetStr(epochSec: unknown): string {
  if (typeof epochSec !== "number") return "";
  return (
    "resets " +
    new Date(epochSec * 1000).toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
  );
}

function setCompact(html: string) {
  if (html === compactHtml) return;
  compactHtml = html;
  compact.innerHTML = html;
}

function render() {
  clearTimeout(timer);
  timer = undefined;
  const s = focusedTab ? (latest.get(focusedTab) ?? codexLatest.get(focusedTab)) : undefined;
  if (!s) {
    compact.dataset.tier = "idle";
    // nothing to open: the CSS hides the opener rather than leave a dead control
    setCompact("");
    expanded.classList.add("hidden");
    return;
  }

  const p = s.payload;
  const age = ageOf(s);
  const rl = p.rate_limits ?? {};
  const name = p.session_name ?? p.session_id ?? "unknown";
  const stale = age > STALE_SECS;
  const characterStatus = {
    id: s.tab,
    model: typeof p.model?.id === "string" ? p.model.id
      : typeof p.model?.display_name === "string" ? p.model.display_name : null,
    contextUsedPercentage: typeof p.context_window?.used_percentage === "number"
      ? p.context_window.used_percentage : null,
    fresh: !stale,
  };
  const characterKey = JSON.stringify(characterStatus);
  if (characterKey !== lastCharacterStatus) {
    lastCharacterStatus = characterKey;
    dispatchCharacterStatus(characterStatus);
  }
  compact.dataset.tier = stale ? "stale" : "fresh";

  // The bar carries no session text any more: every agent already draws its own
  // status line, so this was doubled information. What is left
  // is the opener; the flyout below keeps the name, the model and all three bars.
  setCompact('<span class="dim">▴</span>');

  // Open: the "As of" text moves, so tick every 2 s. Closed: wake once, when the bar goes stale.
  const open = !expanded.classList.contains("hidden");
  if (open) timer = setTimeout(render, 2000);
  else if (!stale && typeof s.mtime_ms === "number") timer = setTimeout(render, untilStale(s));
  // Closed flyout: the next click renders it before it shows, so skip the write.
  if (!open) return;

  const html = `
    <h3>${esc(name)}</h3>
    <p class="dim">As of ${ago(age)} · ${esc(p.model?.id ? prettyModel(p.model.id) : (p.model?.display_name ?? "?"))}</p>
    ${typeof p.context_window?.used_percentage === "number"
      ? `<h4>This Session</h4>${bar("Context", p.context_window.used_percentage)}` : ""}
    <h4>Account (Global)</h4>
    ${bar("5H window", rl.five_hour?.used_percentage, resetStr(rl.five_hour?.resets_at))}
    ${bar("7D window", rl.seven_day?.used_percentage, resetStr(rl.seven_day?.resets_at))}
  `;
  if (html !== expandedHtml) {
    expandedHtml = html;
    expanded.innerHTML = html;
  }
}

// The bar's 10 side padding and the 6 the flyout always stood above its top (bottom: 36 over the 30 row).
const BAR_PAD = 10;
const BAR_GAP = 6;

/** Opens above the bar's right end wherever sessions/bottombar-dock.ts docked it (its own row, the
 *  workbench or the right pane): the bar's rect, not offsets from the rail width. */
function placeExpanded() {
  if (expanded.classList.contains("hidden")) return;
  const r = (compact.closest<HTMLElement>("#bottombar") ?? compact).getBoundingClientRect();
  expanded.style.right = `${Math.max(0, window.innerWidth - r.right + BAR_PAD)}px`;
  expanded.style.bottom = `${Math.max(0, window.innerHeight - r.top + BAR_GAP)}px`;
}

export async function initStatus(
  compactEl: HTMLElement,
  expandedEl: HTMLElement,
  signal?: AbortSignal,
) {
  compact = compactEl;
  expanded = expandedEl;
  clearTimeout(timer);
  latest = new Map();
  codexLatest.clear();
  focusedTab = null;
  lastCharacterStatus = "";
  compactHtml = "";
  expandedHtml = "";
  compact.addEventListener("click", () => {
    // nothing to expand when idle
    if (compact.dataset.tier !== "idle") expanded.classList.toggle("hidden");
    render(); // after the toggle: it fills the flyout when open and arms the 2 s tick
    placeExpanded();
  }, { signal });
  // sessions.ts dispatches this from render(); null when the last tab closes
  document.addEventListener("vidar-focus", (e) => {
    const focused = (e as CustomEvent<FocusedSession | null>).detail;
    focusedTab = focused?.id ?? null;
    render();
    placeExpanded(); // render() may have re-docked the bar
  }, { signal });
  render();

  signal?.addEventListener("abort", () => clearTimeout(timer));
  const unlisten = await listen<TabStatus[]>("status-update", (e) => {
    updates++;
    applyTabs(e.payload);
  });
  // Aborted while the listen registration was in flight: undo it now.
  if (signal?.aborted) { unlisten(); return; }
  signal?.addEventListener("abort", unlisten);

  // The poller emits on change only, so a webview that mounted (or reloaded) after the last
  // emit asks once for the current state. An event that arrives first is newer: it wins.
  const seen = updates;
  invoke("status_snapshot").then((tabs) => {
    if (updates === seen && !signal?.aborted) applyTabs(tabs as TabStatus[]);
  }).catch(() => {});
}
