// Pending asks as Relay items (kind "ask"): the agent posted named options and ended its turn.
// Send Answer is the only path that delivers text into the asker's tab: claim -> re-read (the sha
// must still match what the form painted) -> sendPromptTo -> settle. Nothing is persisted but the ask.

import { invoke, listen } from "../ipc";
import { setItems, type RelayAsk, type RelayItem, type RelayVerdict } from "./store";

const SOURCE = "asks";
let latest = 0;
/** ids with a send in flight in this window (Rust's claim covers the other windows) */
const busy = new Set<string>();

export type AskTabState = "ready" | "not-ready" | "no-tab" | "ended";

/** The delivered text, built from the re-read entry; never carries the question. */
export function answerText(ask: Pick<RelayAsk, "id">, choice: string | null | undefined, comment: string): string {
  return `Answer to pending question ${ask.id.slice(0, 8)}: choice=${JSON.stringify(choice ?? null)} comment=${JSON.stringify(comment || null)}`;
}

const readAll = async (): Promise<RelayAsk[]> => (await invoke("list_pending_asks"))?.items ?? [];
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Loaded on first use: the session layer reaches back into the workbench, so a static import
// would close a cycle (tests/import-cycles.test.mjs) through panels/relay.
const sessionsMod = () => import("../panels/sessions");
const registryMod = () => import("../control/registry");

/** The asker's tab as the user would see it right now: title and whether a prompt can land. */
export async function askTabState(session: string): Promise<{ state: AskTabState; title: string; tab: string | null }> {
  const { findTabByFalconSessionHosted, renderedBody, sessionTitle } = await sessionsMod();
  const tab = await findTabByFalconSessionHosted(session);
  const body = tab ? renderedBody(tab) : null;
  if (!tab || !body) return { state: "no-tab", title: "", tab: null };
  const title = sessionTitle(tab) ?? "";
  if (!body.alive()) return { state: "ended", title, tab };
  return { state: body.promptReady() ? "ready" : "not-ready", title, tab };
}

/** Send Answer: claim, re-read, deliver, settle. A failure before delivery releases the claim and rethrows; a settle failure after delivery keeps it. */
export async function sendAnswer(painted: RelayAsk, choice: string | null, comment: string): Promise<void> {
  if (busy.has(painted.id)) throw new Error("Already Sending");
  busy.add(painted.id);
  try {
    await invoke("claim_pending_ask", { id: painted.id, sha256: painted.sha256 });
    let delivered = false;
    try {
      const cur = (await readAll()).find((a) => a.id === painted.id);
      if (!cur || cur.sha256 !== painted.sha256) throw new Error("Question Changed; Select the Row Again");
      if (choice !== null && !cur.choices.includes(choice)) throw new Error("Choice Is Not Offered");
      if (choice === null && !comment && cur.choices.length > 0) throw new Error("Pick a Choice");
      const { tab } = await askTabState(cur.session);
      if (!tab) throw new Error("Tab Not Open");
      await (await registryMod()).sendPromptTo(tab, answerText(cur, choice, comment));
      delivered = true;
      await invoke("settle_pending_ask", { id: painted.id, sha256: painted.sha256 });
    } catch (e) {
      // Delivered but not settled: keep the claim so a second click cannot send the answer twice.
      if (delivered) throw new Error("Sent; Could Not Clear the Ask");
      await invoke("release_pending_ask", { id: painted.id }).catch(() => {});
      throw e;
    }
  } finally {
    busy.delete(painted.id);
    void refresh().catch(() => {});
  }
}

/** Dismiss: settles without sending; needs no claim. */
async function dismissAsk(painted: RelayAsk): Promise<void> {
  try {
    await invoke("settle_pending_ask", { id: painted.id, sha256: painted.sha256 });
  } finally {
    void refresh().catch(() => {});
  }
}

function itemFor(a: RelayAsk): RelayItem {
  return {
    id: a.id,
    kind: "ask",
    source: SOURCE,
    title: a.question.replace(/\s+/g, " ").trim(),
    sinceMs: a.askedAtMs,
    view: { type: "ask", ask: a },
    async resolve(v: RelayVerdict) {
      if (v.verdict === "deny" || v.verdict === "dismiss") await dismissAsk(a);
      else await sendAnswer(a, v.choice ?? null, v.comment);
    },
  };
}

export async function refresh(): Promise<void> {
  const gen = ++latest;
  const asks = await readAll();
  if (gen !== latest) return;
  setItems(SOURCE, asks.map(itemFor));
}

export { msgOf as askErrorText };

export function startAskSource(): void {
  void listen("pending-ask-update", () => { void refresh().catch(() => {}); });
  void refresh().catch(() => {});
}
