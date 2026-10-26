// close-spawned and check-clean: compare the live window with the run ledger.
import { clearLedger, spawnedHosted, leftoverLocal, leftoverSessions } from "../drive-ledger.mjs";

// close-spawned: the tab X path (`.session-close` → closeSession → closeHostedTab → falcon_kill),
// not a direct falcon_kill invoke, which needs the tab's view generation and silently no-ops on a
// wrong one. Waits up to 8 s for the tabs to leave state.
// Unresolved hosted tabs (no Falcon session, not seen at snapshot) are reported, never closed.
export async function closeSpawned({ ledger, ledgerAt, evalJs, STATE_JS }) {
  const { spawned: ids, unresolved } = spawnedHosted(ledger, await evalJs(STATE_JS));
  if (ids.length === 0) return { since: ledgerAt(), closed: [], missing: [], remaining: [], unresolved };
  return { since: ledgerAt(), unresolved, ...await evalJs(`(async (ids) => {
    const closed = [], missing = [];
    for (const id of ids) {
      const x = document.querySelector('.session-btn[data-id="' + CSS.escape(id) + '"] .session-close');
      if (x) { x.click(); closed.push(id); } else missing.push(id);
    }
    const live = async () => new Set((await window.__vidarDrive.state()).tabs.map((t) => t.id));
    for (const t0 = Date.now(); Date.now() - t0 < 8000; await new Promise((r) => setTimeout(r, 250))) {
      const now = await live();
      if (ids.every((id) => !now.has(id))) break;
    }
    const now = await live();
    return { closed, missing, remaining: ids.filter((id) => now.has(id)) };
  })(${JSON.stringify(ids)})`) };
}

export async function checkClean({ ledger, ledgerAt, evalJs, PROBE_JS, lap, LEDGER, LEDGER_REL }) {
  const probe = await evalJs(PROBE_JS);
  lap("check-clean");
  const { spawned: left, unresolved } = spawnedHosted(ledger, probe.state);
  const loc = leftoverLocal(ledger, probe);
  const ses = leftoverSessions(ledger, probe);
  const lines = [];
  if (left.length > 0) lines.push(`not clean: ${left.length} hosted tab(s) opened since ${ledgerAt()} remain: ${left.join(", ")}; run close-spawned`);
  if (unresolved.length > 0) lines.push(`not clean: ${unresolved.length} hosted tab(s) with no Falcon session, not seen at ${ledgerAt()}: ${unresolved.join(", ")}; close them by hand`);
  for (const id of loc.spawned) lines.push(`not clean: local tab ${id} opened since ${ledgerAt()}; close tab ${id} with its X`);
  for (const id of loc.unresolved) lines.push(`not clean: local tab ${id} cannot be told from the snapshot's: page reloaded since the snapshot; close or keep these, then rerun check-clean after deleting ${LEDGER_REL}`);
  for (const s of ses.spawned) lines.push(s.kind === "shell"
    ? `not clean: Falcon session ${s.session} opened since ${ledgerAt()} is held by the Falcon shell; end it with Close Session in the Falcon shell`
    : `not clean: Falcon session ${s.session} opened since ${ledgerAt()} is parked; close its row in the launcher's Falcon row`);
  for (const u of ses.unresolved) lines.push(`not clean: ${u}; rerun check-clean with Falcon up, or delete ${LEDGER_REL} to end the run by hand`);
  if (lines.length > 0) {
    for (const l of lines) console.error(l);
    process.exit(4);
  }
  clearLedger(LEDGER);
  return `clean: no tab or Falcon session opened since ${ledgerAt()} remains; ledger cleared`;
}
