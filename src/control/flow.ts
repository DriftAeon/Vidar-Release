// Flow card and observe listeners, kept out of listen.ts's general verb handler.
import { listen as ipcListen } from "../ipc";
import { openApproval } from "../asks/approvals";
import { APPROVAL_TITLES } from "../asks/approval";
import { prepareControlFlow, approveControlFlow, saveControlFlow } from "../flow/control-start";
import { flowCardRows, flowCardMatrix, flowCardDecision } from "./flow-card";
import { getRun, subscribeRuns } from "../flow/runs-store";
import { flowStatusLine, waitForFlow } from "../flow/control-observe";
import { orderedNodes } from "../flow/control-core";
import { initFlowStorage } from "../flow/file-storage";
import { initRunsStore } from "../flow/runs-store";
import { heldRunIds, resolveRunModes } from "../flow/engine";
import { driveSnapshot, requesterTabId } from "./registry";
import type { Requester } from "./requester";

type Card = { id: string; cardId: string; details: unknown; requester: Requester; claimedAtMs: number; expiresAtMs: number };
type Observe = { id: string; runId: string; root: string; timeoutMs: number; requester: Requester };
type Reply = (id: string, ok: boolean, line: string) => void;
type CardReply = (id: string, cardId: string, ok: boolean, line: string, verdict?: string) => void;

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

export function handleFlowCard(card: Card, hooks: {
  cardResult: CardReply; label: (r: Requester) => string; problem: (r: Requester) => string | null;
}): void {
  const { id, cardId, requester, expiresAtMs } = card;
  const result = (ok: boolean, line: string, verdict?: string) => hooks.cardResult(id, cardId, ok, line, verdict);
  void (async () => {
    try {
      const snapshot = await prepareControlFlow(card.details);
      const modes = await resolveRunModes(snapshot);
      if (hooks.problem(requester)) { result(false, "err requester gone"); return; }
      if (Date.now() >= expiresAtMs) { result(false, "err expired"); return; }
      const label = hooks.label(requester);
      const rows = flowCardRows(snapshot, label, orderedNodes, modes);
      const matrix = flowCardMatrix(snapshot, label, orderedNodes, modes);
      // One record; Relay (or Drive) answers it and the registry settles it once, so approve starts the flow once.
      const refused = openApproval({
        id: cardId, origin: "ctl-flow", title: APPROVAL_TITLES["ctl-flow"],
        asker: { tab: requesterTabId(requester), label, verified: true },
        rows, matrix, askedAtMs: card.claimedAtMs, expiresAtMs, comment: true, drawInAskerTab: true,
      }, (outcome) => {
        void (async () => {
          try {
            if (!("comment" in outcome)) { // cancelled or expired
              if (outcome.verdict === "expired") result(false, "err expired");
              return;
            }
            const decision = await flowCardDecision(snapshot.id,
              { approved: outcome.verdict === "approve", shown: true, comment: outcome.comment },
              false, Date.now() >= expiresAtMs, !!hooks.problem(requester), () => approveControlFlow(snapshot, modes));
            if (decision) result(decision.ok, decision.line, decision.verdict);
          } catch (error) { result(false, `err ${reason(error)}`); }
        })();
      });
      if (refused) result(false, `err ${refused}`, "failed");
    } catch (error) { result(false, `err ${reason(error)}`); }
  })();
}

export function listenFlowObserve(reply: Reply, problem: (r: Requester) => string | null): void {
  const aborts = new Map<string, AbortController>();
  ipcListen<{ id: string }>("ctl-wait-cancel", (event) => {
    aborts.get(event.payload.id)?.abort();
    aborts.delete(event.payload.id);
  });
  const status = async (payload: Observe, wait: boolean) => {
    const { id, requester, runId, root } = payload;
    const bad = problem(requester);
    if (bad) { reply(id, false, `err ${bad}`); return; }
    await initFlowStorage();
    await initRunsStore(heldRunIds());
    if (!wait) {
      const run = getRun(runId);
      reply(id, !!run, run ? flowStatusLine(run, root, orderedNodes) : "err no run");
      return;
    }
    const abort = new AbortController();
    aborts.set(id, abort);
    const tab = requesterTabId(requester);
    const gone = setInterval(() => {
      if (tab && !driveSnapshot().tabs.some((item) => item.id === tab)) abort.abort();
    }, 1000);
    try {
      const run = await waitForFlow(runId, payload.timeoutMs, getRun, subscribeRuns, abort.signal);
      if (run === "gone") reply(id, false, "err requester gone");
      else if (run === "timeout") reply(id, false, "err timeout");
      else if (run === "missing") reply(id, false, "err no run");
      else reply(id, true, flowStatusLine(run, root, orderedNodes));
    } finally { clearInterval(gone); aborts.delete(id); }
  };
  ipcListen<{ id: string; graph: unknown; cwd: string; requester: Requester }>("ctl-flow-save", (event) => {
    const { id, graph, cwd, requester } = event.payload;
    const bad = problem(requester);
    if (bad) { reply(id, false, `err ${bad}`); return; }
    void saveControlFlow({ action: "save", graph, cwd })
      .then((line) => reply(id, true, line))
      .catch((error) => reply(id, false, `err ${reason(error)}`));
  });
  ipcListen<Observe>("ctl-flow-status", (event) => { void status(event.payload, false).catch((error) => reply(event.payload.id, false, `err ${reason(error)}`)); });
  ipcListen<Observe>("ctl-flow-wait", (event) => { void status(event.payload, true).catch((error) => reply(event.payload.id, false, `err ${reason(error)}`)); });
}
