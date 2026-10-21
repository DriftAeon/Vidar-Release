// Astra review bridge (frontend half): the armed-tab state, arm/disarm, and the serialised
// review-dispatch handler. sessions.ts binds its tab map and write seam in (no import of ../sessions).
import { invoke } from "../../ipc";
import { listen } from "../../ipc";
import { askGate, cancelAsk } from "../askgate";
import { depsReport } from "../../deps/state";
import { rel } from "../../paths";
import { sandboxBlocker } from "./astra-sandbox";
import type { TerminalSession } from "./types";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let writeToSession: (id: string, data: string) => Promise<boolean> = async () => false;

/** sessions.ts, at load: the tab map and writeToSession this bridge reads through. */
export function bindAstraBridge(deps: { sessions: ReadonlyMap<string, TerminalSession>; writeToSession: (id: string, data: string) => Promise<boolean> }) {
  sessions = deps.sessions;
  writeToSession = deps.writeToSession;
}

/* ---- Astra review bridge (frontend half; Rust half in src-tauri/src/review.rs) ----
   One tab may be ARMED as astra. Arming is consent: a launcher role or an
   explicit tab-menu pick, never a name match. Only a Vidar-spawned Codex tab
   whose launch args carry `-a never` qualifies — with approvals off no prompt
   can exist, so nothing we type can approve a pending command.
   Typing is text, ≥1 s pause, then CR as a separate write: Codex reads a fast
   burst as a paste and an Enter inside it as a newline. */

export interface Dispatch {
  id: string;
  tab: string;
  text: string;
  requester: string;
}

/** What `review-dispatch` delivers: the request plus the card's clock (src-tauri review.rs). */
export interface DispatchEvent extends Dispatch {
  claimedAtMs: number;
  expiresAtMs: number;
}

export let armedId: string | null = null;
let dispatchChain: Promise<void> = Promise.resolve();
// Set by hand from the Codex paste heuristic. Measured:
// request → Codex turn start 1.8 s of a 382 s round trip, so not worth tuning.
const SUBMIT_PAUSE_MS = 1200;

function hasNeverFlag(args?: string[]): boolean {
  // The flag must sit on the codex invocation itself, not anywhere in the
  // joined args (a quoted "-a never" inside other text would otherwise pass).
  const cmd = (args ?? []).find((a) => /^\s*codex(\s|$)/.test(a)) ?? "";
  return /(^|\s)(-a|--ask-for-approval)\s+never(\s|$)/.test(cmd);
}

/** The two folders an Astra tab may sit in (paths contract ids display, astraReports); null while the Vidar root is unknown. */
function astraCwds(): string[] | null {
  const root = depsReport()?.root;
  if (!root) return null;
  const base = root.replace(/[\\/]+$/, "");
  return ["display", "astraReports"].map((id) => `${base}\\${rel(id).replaceAll("/", "\\")}`);
}

/** Why this tab can't be armed, or null when it can. */
export function armBlocker(id: string): string | null {
  const s = sessions.get(id);
  if (!s?.alive) return "tab is not alive";
  if (s.agent !== "codex") return "only Codex tabs can be Astra";
  if (!hasNeverFlag(s.launchArgs)) return "relaunch Codex with -a never (Astra launcher)";
  return sandboxBlocker({ launchArgs: s.launchArgs, shell: s.shell, cwd: s.cwd, allowedCwds: astraCwds() });
}

export function armAstra(id: string): boolean {
  if (armBlocker(id)) return false;
  if (armedId && armedId !== id) disarmAstra();
  armedId = id;
  sessions.get(id)?.button.classList.add("armed");
  return true;
}

export function disarmAstra() {
  if (armedId) sessions.get(armedId)?.button.classList.remove("armed");
  armedId = null;
}

export function isArmed(id: string): boolean {
  return armedId === id;
}

/** spawnAstra opens a reviewer only when none is armed yet (one Astra at a time). */
export function hasArmedAstra(): boolean {
  return armedId !== null;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function handleDispatch(d: DispatchEvent) {
  const refuse = (reason: string) => invoke("review_result", { id: d.id, ok: false, tab: null, reason });
  if (d.tab !== "astra") return refuse(`unknown role "${d.tab}"`);
  if (!armedId) return refuse("no armed astra tab");
  const id = armedId;
  // Re-validate right before touching the pty: the arm is a claim, these are facts.
  const blocker = armBlocker(id);
  if (blocker) {
    disarmAstra();
    return refuse(`astra tab refused: ${blocker}`);
  }
  // A leading slash is a Codex command, not a prompt; a brief never starts with one.
  if (/^\s*\//.test(d.text)) return refuse("text starts with a slash command");
  const codexUp = () => invoke("pty_has_descendant", { id, exe: "codex.exe" }).catch(() => false);
  if (!(await codexUp())) return refuse("astra tab isn't running codex");
  // The user approves the exact bytes typed; the requester is only what the file claims.
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const card = askGate({
    permission: true,
    details: [
      ["Asked By", `${d.requester} (Unverified)`],
      ["Tab", sessions.get(id)?.container.dataset.title ?? id],
      ["Text", d.text],
    ],
    question: "",
    claimedAtMs: d.claimedAtMs,
    expiresAtMs: d.expiresAtMs,
    id: d.id,
    tab: id,
  }, "review-dispatch");
  expiry = setTimeout(() => { cancelAsk("review-dispatch", "expired"); }, Math.max(0, d.expiresAtMs - Date.now()));
  const { approved, shown, comment, reason: why } = await card;
  clearTimeout(expiry);
  // Not shown (deduped, or stale before it rendered) is not a denial: the requester must see the difference.
  if (!shown) return refuse(`err ${why ?? "self-answered"}`);
  if (why === "expired") return refuse("expired");
  if (!approved) return refuse(`denied ${comment}`);
  // The card can sit for minutes: the arm and the process are facts to re-read, not carry over.
  if (armedId !== id) return refuse("astra tab went away before approval");
  const late = armBlocker(id);
  if (late) {
    disarmAstra();
    return refuse(`astra tab refused: ${late}`);
  }
  if (!(await codexUp())) return refuse("astra tab isn't running codex");
  if (!(await writeToSession(id, d.text))) return refuse("write to astra tab failed");
  await sleep(SUBMIT_PAUSE_MS);
  // Re-check the PROCESS, not just the tab: Codex can exit during the pause
  // while its shell lives on, and a CR then submits the text to PowerShell
  // Text without CR is harmless in a shell composer.
  if (!sessions.get(id)?.alive || armedId !== id) return refuse("astra tab went away before submit");
  if (!(await codexUp())) {
    disarmAstra();
    return refuse("codex exited during the pause; text left unsubmitted, tab disarmed");
  }
  // The verdict lands BEFORE the CR: Astra's turn can end (and the notify hook read tabCwd from
  // dispatch-result.json) within seconds of the submit. A failed CR overwrites it with ok:false.
  await invoke("review_result", { id: d.id, ok: true, tab: id, reason: null, tabCwd: sessions.get(id)?.cwd ?? null });
  if (!(await writeToSession(id, "\r"))) return refuse("submit to astra tab failed");
}

/** initSessions: register the review-dispatch listener, then let Rust's poller start. */
export async function initAstraBridge() {
  // Review bridge: Rust hands each dispatch over exactly once; serialise them
  // here so two never interleave their text/pause/Enter on the same tab.
  await listen<DispatchEvent>("review-dispatch", (e) => {
    dispatchChain = dispatchChain
      .then(async () => { await handleDispatch(e.payload); })
      .catch((err) => {
        // best-effort: the requester must see *some* outcome
        void invoke("review_result", { id: e.payload.id, ok: false, tab: null, reason: `dispatch threw: ${String(err)}` }).catch(() => {});
      });
  });
  await invoke("review_ready"); // only now does the poller start claiming files
}
