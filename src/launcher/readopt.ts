// Startup re-adopt of Falcon-hosted Claude sessions (and Codex ones, hosted-Codex gate on). A release swap closes Vidar,
// Falcon keeps the sessions alive and records the lease release, but no tab list survives the
// relaunch; without this the only way back is Launcher › Claude › Falcon. Only sessions Vidar
// itself drove last come back: one Jettisoned to a shell (last holder `falcon-shell`) stays in
// the Falcon row. A webview reload is the other boot: the tabs go, but this process's Rust views
// (`falcon_hosted_held`) and their attachment stay, so those come back too, moved onto new tabs
// (docs/projects/falcon/falcon-idle-reap.md §Decision 1). Held and relaunch adopts share one loop
// in `falcon_list` order; held views get no priority. The one runtime import is agents/id.ts
// (itself import-free), so the predicates are testable under plain node.
import type { FalconHeldView, FalconSessionSummary } from "../ipc";
// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { AGENT_IDS, isAgentId } from "../agents/id.ts";
import type { AgentId } from "../agents/id";

/** Client name Vidar negotiates with (src-tauri/src/falcon.rs `CLIENT_NAME`). */
const VIDAR_CLIENT = "vidar";

/* The hosted-Codex opt-in (vidar.json `falcon.hostedCodex`, docs/reference/settings.md), read once
   at start by sessions.ts initSessions, so it applies after a restart. Off: Codex sessions are
   neither re-adopted nor adopted as Codex, and Codex tabs stay in-process. Held here because this
   module has no runtime imports and every reader (readopt, launcher/hosted.ts, rendered-body)
   can import it. */
let hostedGateEnabled = false;
const hostedEnabled: Record<AgentId, () => boolean> = {
  claude: () => true,
  codex: () => hostedGateEnabled,
};
const hostedRefusal: Record<AgentId, string | null> = {
  claude: null,
  codex: "Codex session: turn falcon.hostedCodex on in vidar.json and restart Vidar to open it.",
};
const fallbackAgent: AgentId = AGENT_IDS.find((id) => hostedRefusal[id] === null)!;

/** The gate's value from vidar.json's `falcon` key: on only for `{ "hostedCodex": true }`. */
export function readHostedCodexGate(falcon: unknown): boolean {
  return !!falcon && typeof falcon === "object" && (falcon as { hostedCodex?: unknown }).hostedCodex === true;
}
export function setHostedCodexGate(on: boolean): void {
  hostedGateEnabled = on;
}
export function hostedCodexOn(): boolean {
  return hostedGateEnabled;
}

/** The agent an adopted session's tab runs: Codex only with the gate on, else Claude (today's). */
export function adoptAgent(s: Pick<FalconSessionSummary, "agent">): AgentId {
  return isAgentId(s.agent) && hostedEnabled[s.agent]() ? s.agent : fallbackAgent;
}

/** Why a session cannot be adopted as its own agent, or null when it can. Gate off, a Codex
 *  session would open as a Claude tab parsing Codex JSON-RPC (adoptAgent's "claude"), so every
 *  adopt path (Falcon row, Dock, readopt) refuses it instead (review-fix C3). */
export function adoptRefusal(s: Pick<FalconSessionSummary, "agent">): string | null {
  if (s.agent === adoptAgent(s)) return null;
  return isAgentId(s.agent) ? hostedRefusal[s.agent] : `Unknown agent "${s.agent}": Vidar cannot open this session.`;
}

/** Claude always; Codex only with the gate on. */
function readoptable(agent: string): boolean {
  return isAgentId(agent) && hostedEnabled[agent]();
}

/** Live, unattached, Claude (or Codex, gate on), and last driven by Vidar. A host built before
 *  `last_holder` existed never sends it, so an absent field adopts nothing (manual adopt still works). */
export function shouldReadopt(s: FalconSessionSummary): boolean {
  return readoptable(s.agent)
    && s.exited === null
    && s.attached === 0
    && s.last_holder === VIDAR_CLIENT;
}

/** Live Claude (or Codex, gate on) session this process still holds a view of. `attached` and
 *  `last_holder` are ignored: the holder and the attachment are this process's own view. */
export function shouldReadoptHeld(s: FalconSessionSummary, held: ReadonlySet<string>): boolean {
  return readoptable(s.agent) && s.exited === null && held.has(s.session);
}

/** Live session another client (the Falcon shell) holds: attached, and its last holder is not
 *  Vidar. A proxy (I): the summary has no controller field. */
export function heldElsewhere(s: FalconSessionSummary): boolean {
  return s.exited === null
    && s.attached > 0
    && s.last_holder != null
    && s.last_holder !== VIDAR_CLIENT;
}

export interface ReadoptDeps {
  /** Pure probe: never launches a host (see hosted.ts hasLiveFalconSessions). */
  available: () => Promise<boolean>;
  list: () => Promise<{ sessions: FalconSessionSummary[] }>;
  openIds: () => Promise<string[]>;
  /** Views the Rust side still holds; non-empty at boot only after a webview reload. */
  held: () => Promise<FalconHeldView[]>;
  /** Detach one held view by its old tab and generation; a no-op once adopt moved it. */
  detach: (tab: string, gen: number) => Promise<void>;
  /** Also adopt sessions a previous Vidar left (`shouldReadopt`); false in a dev build. */
  relaunch: boolean;
  /** Resolves to the new tab id; a background adopt never selects it. */
  adopt: (s: FalconSessionSummary) => Promise<string>;
  /** The selected tab, or null when none is (a fresh launch opens with no tab). */
  activeId: () => string | null;
  select: (tab: string) => void;
}

/** Adopt every held session and (on `relaunch`) every session `shouldReadopt` accepts, one
 *  at a time in `list` order. Each adopt resolves once its lease and attach are in; its history
 *  replays afterwards on the Rust reader thread (`falcon/events.rs` `start_event_reader`), so this
 *  loop attaches every session before any long hydration runs and none sits unattached past the
 *  host's orphan grace behind another's replay. Every held view not moved by then (exited, gone, a
 *  failed adopt) is detached, so nothing stays attached without a tab. Never throws: a
 *  failure is logged and the rest still run. A `list` error after a live probe counts as
 *  "no host": logged, nothing adopted. A background adopt leaves the selection alone, so with
 *  no tab open the first adopted tab is selected; checked after each adopt, never replacing a
 *  tab the user picked meanwhile. */
export async function readoptHostedSessions(deps: ReadoptDeps): Promise<void> {
  let held: FalconHeldView[] = [];
  try {
    held = await deps.held();
  } catch (e) {
    console.error("re-adopt: falcon_hosted_held failed:", e);
  }
  try {
    if (!held.length && !deps.relaunch) return;
    if (!(await deps.available())) return;
    let sessions: FalconSessionSummary[];
    try {
      ({ sessions } = await deps.list());
    } catch (e) {
      console.error("re-adopt: falcon_list failed after a live probe; treating as no host:", e);
      return;
    }
    const heldSessions = new Set(held.map((h) => h.session));
    const open = new Set(await deps.openIds());
    for (const s of sessions) {
      if (open.has(s.session)) continue;
      if (!shouldReadoptHeld(s, heldSessions) && !(deps.relaunch && shouldReadopt(s))) continue;
      try {
        const tab = await deps.adopt(s);
        open.add(s.session);
        if (deps.activeId() === null) deps.select(tab);
      } catch (e) {
        console.error(`re-adopt ${s.session}:`, e);
      }
    }
  } catch (e) {
    console.error("re-adopt hosted sessions:", e);
  } finally {
    for (const h of held) {
      try {
        await deps.detach(h.tab, h.gen);
      } catch (e) {
        console.error(`re-adopt: detach held ${h.session}:`, e);
      }
    }
  }
}
