// src\launcher\hosted.ts — the Falcon hosted-sessions seam of the launcher: the Falcon row inside
// Claude's column, its session flyout, and adoptHosted. Split from menu.ts; closeLauncher arrives
// once through setHostedClose (registered by initLauncherMenu), so this module never imports
// menu.ts. Rows and columns come from menu-rows.ts and columns.ts.
import { AGENTS, isAgentId } from "../agents/descriptor";
import type { AgentId } from "../agents/id";
import type { RulesLaunch } from "../rules/inject";
import { invoke } from "../ipc";
import { DASH } from "../format";
import type { FalconSessionSummary } from "../ipc";
import { activate, createSession, dropUnadoptedTab, findTabByFalconSession, findTabByFalconSessionHosted, openFalconSessionIds } from "../panels/sessions";
import { nextTabName, recordedVault, tabTitleTaken } from "../panels/sessions/lookup";
import { hostedNames } from "./hosted-names-pref";
import { finishAdopt, shouldShowShellAfterDrop, startAdopt } from "./adopt-settle";
import { adoptAgent, adoptRefusal, heldElsewhere } from "./readopt";
import { readDriverOn, setDriverOn } from "../panels/sessions/driver-mode";
import { hoverOpen, openColumn, placeColumn } from "./columns";
import { MODE_LABEL, menuRow, twoLineRow } from "./menu-rows";
import claudeIcon from "../assets/claude.png";

let closeLauncher: (() => void) | null = null;
/** Registered once by initLauncherMenu. */
export function setHostedClose(fn: () => void): void {
  closeLauncher = fn;
}

// falcon_list's wire shape lives in ipc.ts (FalconList). `host_warning` is set when the host
// had to launch inside Vidar's own job (no breakaway), so it will die with Vidar; null once a
// clean launch clears it.
type FalconHostedSession = FalconSessionSummary;
const rulesFromHost = (file: string): RulesLaunch => ({ file, codex: null, warnings: [] });
const hostedRules: Record<AgentId, (file: string) => RulesLaunch> = {
  claude: rulesFromHost,
  codex: rulesFromHost,
};

let hostedGen = 0;

// Cached per launcher opening (cleared through resetHostedProbe in closeLauncher) so hovering
// the Claude row back and forth doesn't re-probe the host each time.
let hostedRowLiveCheck: Promise<boolean> | null = null;

/** Drop the cached live-session probe; the launcher calls it on close. */
export function resetHostedProbe(): void {
  hostedRowLiveCheck = null;
}

// falcon_available is a pure probe — unlike falcon_list (which goes through
// Falcon::control), it never launches a host when none is alive. Only once it
// reports a live host is it safe to call falcon_list to see if any session is live.
function hasLiveFalconSessions(): Promise<boolean> {
  if (!hostedRowLiveCheck) {
    hostedRowLiveCheck = (async () => {
      let available = false;
      try {
        available = await invoke("falcon_available");
      } catch (e) {
        console.error("falcon_available:", e);
        return false;
      }
      if (!available) return false;
      try {
        const { sessions } = await invoke("falcon_list");
        return sessions.some((s) => s.exited === null);
      } catch (e) {
        console.error("falcon_list:", e);
        return false;
      }
    })();
  }
  return hostedRowLiveCheck;
}

// Falcon is a durable host, so its sessions are a launcher source of their own:
// selecting one adopts its event stream and never starts another Claude process.
// Sits inside the primary agent's column (after its variants; locations.ts picks it), not
// at top level: on its own the row read as a separate agent rather than a source.
// No live Falcon sessions: no expand arrow, no submenu, no host-launching probe
// (falcon_list alone would spin one up — see hasLiveFalconSessions).
export function appendHostedRow(parent: HTMLElement) {
  if (!closeLauncher) return;
  const hosted = menuRow(parent, "Falcon", { match: /^$/, icon: claudeIcon, tint: "var(--agent-falcon)" });
  const open = () => void openHosted(hosted);
  void hasLiveFalconSessions().then((live) => {
    if (!live || !hosted.isConnected) return;
    hosted.classList.add("has-sub");
    hoverOpen(hosted, 1, open);
    hosted.addEventListener("click", (e) => { e.stopPropagation(); open(); });
  });
}

async function openHosted(anchor: HTMLElement) {
  const close = closeLauncher;
  if (!close) return;
  const gen = ++hostedGen;
  const sub = openColumn(1, anchor);
  const note = (text: string, cls = "launcher-note") => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    sub.appendChild(d);
  };
  note("Loading…");
  placeColumn(1, anchor);
  let hosted: FalconHostedSession[] = [];
  let hostWarning: string | null = null;
  try {
    ({ sessions: hosted, host_warning: hostWarning = null } = await invoke("falcon_list"));
    hostedNames.prune(hosted.map((x) => x.session)); // an ended session's rename dies with it
  } catch (e) {
    if (gen !== hostedGen || sub.classList.contains("hidden") || !anchor.classList.contains("open")) return;
    sub.innerHTML = "";
    console.error("hosted sessions:", e);
    note("Can't Read Falcon Sessions", "launcher-note launcher-note-err");
    placeColumn(1, anchor);
    return;
  }
  const open = new Set(await openFalconSessionIds());
  if (gen !== hostedGen || sub.classList.contains("hidden") || !anchor.classList.contains("open")) return;
  sub.innerHTML = "";
  const visible = hosted.filter((s) => open.has(s.session) || s.exited === null);
  if (!visible.length) note(DASH);
  const driverOn = new Map(await Promise.all(visible.map(async (s): Promise<[string, boolean]> => [s.session, await readDriverOn(s.session)])));
  if (gen !== hostedGen || sub.classList.contains("hidden") || !anchor.classList.contains("open")) return;
  for (const s of visible) {
    const inVidar = open.has(s.session);
    const folder = s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd;
    const refusal = adoptRefusal(s);
    const state = inVidar ? "open in Vidar" : s.exited !== null ? `exited ${s.exited}` : heldElsewhere(s) ? "held elsewhere" : refusal ? "hostedCodex off" : s.degraded ? "degraded" : "falcon";
    const queued = s.queued_prompts.length ? ` · ${s.queued_prompts.length} queued` : "";
    const mode = MODE_LABEL[s.permission_mode] ?? s.permission_mode;
    // Session ids are `<host incarnation>-<ordinal>`; the prefix is the same for
    // every session on one host, so the ordinal is the part a human can tell apart.
    const ordinal = Number.parseInt(s.session.split("-").pop() ?? "", 10);
    const label = s.conversation
      ? `${AGENTS[isAgentId(s.agent) ? s.agent : adoptAgent(s)].name} · ${s.conversation.slice(0, 8)}`
      : `Falcon · ${Number.isFinite(ordinal) ? `#${ordinal}` : s.session}`;
    const subLine = (on: boolean) => `${state} · ${folder}${queued}${on ? " · Driver" : ""}`;
    const b = twoLineRow(
      sub,
      label,
      subLine(driverOn.get(s.session) ?? false),
      `${s.model ?? "default model"} · ${mode}\n${s.cwd}\nFalcon ${s.session}\nConversation ${s.conversation ?? "pending"}${hostWarning ? `\n${hostWarning}` : ""}${refusal && !inVidar ? `\n${refusal}` : ""}`,
    );
    // a session Vidar cannot adopt as its own agent (Codex, gate off) shows inert, like one in a tab
    if (inVidar || (refusal && !heldElsewhere(s))) {
      b.classList.add("inert");
      b.disabled = true;
      continue;
    }
    b.addEventListener("click", () => {
      close();
      if (heldElsewhere(s)) {
        void invoke("falcon_show").catch((e) => console.error("falcon_show:", e));
        return;
      }
      adoptHosted(s, undefined, { dropOnFail: true }).catch((e) => void showShellAfterDrop(s.session, e));
    });
    // Right-click flips Driver Mode for this session (same truth file as the tab menu row).
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const on = !(driverOn.get(s.session) ?? false);
      void setDriverOn(s.session, on).then(() => {
        driverOn.set(s.session, on);
        const line = b.querySelector(".launcher-sub-line");
        if (line) line.textContent = subLine(on);
      }).catch((err) => console.error("driver mode:", err));
    });
  }
  placeColumn(1, anchor);
}

/** A launcher adopt failed: re-list, and raise the Falcon shell when the session turns out to
 *  be held there (decision in adopt-settle.ts). */
async function showShellAfterDrop(session: string, err: unknown) {
  console.error(`adopt ${session}:`, err);
  let relisted: FalconHostedSession | undefined;
  try {
    const { sessions } = await invoke("falcon_list");
    relisted = sessions.find((x) => x.session === session);
  } catch (e) {
    console.error("falcon_list after failed adopt:", e);
  }
  if (!shouldShowShellAfterDrop(err, relisted !== undefined && heldElsewhere(relisted))) return;
  try {
    await invoke("falcon_show");
  } catch (e) {
    console.error("falcon_show:", e);
  }
}

/** The title an adopted tab opens with: unique among open tabs (case-insensitive). */
function adoptTitle(s: FalconHostedSession): string {
  const name = hostedNames.get(s.session) ?? s.tab_name;
  return name && !tabTitleTaken(name) ? name : nextTabName();
}

/** Adopt one Falcon-hosted session into a new tab; never spawns a second
 *  Claude. Shared by the Hosted row click and the Dock ask-gate branch.
 *
 * The returned promise settles only once the adopt itself has settled — not
 * once `createSession` returns, which happens as soon as `attachRenderedBody`
 * is called and the actual `falcon_adopt` (lease acquire) is still in flight
 * (a Dock reporting `approved` before Vidar holds the
 * lease races the shell's own re-adopt on the handoff it just cleared). */
export async function adoptHosted(
  s: FalconHostedSession,
  draft?: string,
  opts: { background?: boolean; dropOnFail?: boolean; restoreSlot?: boolean } = {},
): Promise<string> {
  // D-g: a Bare session respawns (/clear, Retry) on the vault its session record names. Read before
  // the held-tab check below, so no await sits between that check and createSession.
  const vault = s.profile ? await recordedVault("", s.session) : null;
  // Already in a tab (readopt racing a Falcon-row click or a Dock):
  // focus that tab instead of adopting a second time. Checked now, not from a
  // snapshot; the sync re-check closes the gap across the async lookup's awaits.
  const existing = (await findTabByFalconSessionHosted(s.session)) ?? findTabByFalconSession(s.session);
  if (existing) {
    if (!opts.background) activate(existing);
    return existing;
  }
  // Bounded: a spawn that never settles (wedged host, a dropped event) must
  // not leave the dock branch's `await` — and its `report` — unresolved
  // forever (adopt-settle.ts; the timeout keeps the tab).
  // Gate off, a Codex session would open as a Claude tab: refused on every caller (row, Dock, readopt).
  const refusal = adoptRefusal(s);
  if (refusal) throw new Error(refusal);
  const adopt = startAdopt();
  // A Codex session opens as a Codex tab with the hosted-Codex gate on (readopt.ts); the host
  // refuses a gateway for Codex, so that stays Claude's. A Codex Bare session keeps its profile.
  const agent = adoptAgent(s);
  return createSession({
    agent,
    // A gateway session keeps the identity the host summary reports: tab art, and the gateway a /clear respawns under.
    art: s.gateway ?? AGENTS[agent].art,
    // A Rendered Bare session keeps its launch profile: a /clear respawn stays bare, and the panels
    // read the tab's own home (rack, loadout, handoffs).
    profile: s.profile,
    // and its row: a /clear respawn rebuilds that row's payload (the host echoes the key)
    rowKey: s.profile ? s.row_key : undefined,
    ...(vault ? { vault } : s.sets !== undefined ? { sets: s.sets } : {}),
    body: "rendered",
    cwd: s.cwd,
    model: s.model ?? undefined,
    falconSession: s.session,
    restoreSlot: opts.restoreSlot,
    // a Resume or /clear respawn of this tab keeps the rules the host launched it with
    rules: s.rules_file ? hostedRules[agent](s.rules_file) : undefined,
    // seeds the body's id: a resumed session with no turn yet has had no system/init
    resume: s.conversation ?? undefined,
    // The user's rename (hosted-names.ts), else the name the tab was spawned with, kept by the host;
    // none stored (an older host), or the name already on an open tab, gets a fresh themed name.
    title: adoptTitle(s),
    draft,
    background: opts.background,
    onAdopted: adopt.onAdopted,
  }).then((tab) => finishAdopt(tab, adopt.result, {
    dropOnFail: opts.dropOnFail,
    drop: dropUnadoptedTab,
    log: (reason) => console.error(`adopt ${s.session} refused, tab dropped:`, reason),
  }));
}
