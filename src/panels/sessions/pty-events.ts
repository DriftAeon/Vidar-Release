// One listener per PTY event routes every terminal attachment by tab id and generation.
import { listen } from "../../ipc";
import { armedId, disarmAstra } from "./astra-bridge";
import { b64ToBytes, flowResumed, flushOutput, queueOutput } from "./output";
import { matchesPtyGeneration } from "./pty-generation";
import { feedRaw } from "./tab-state-feeds";
import type { TerminalSession } from "./types";

export async function initPtyEvents(
  sessions: ReadonlyMap<string, TerminalSession>,
  onExit: (session: TerminalSession) => void,
): Promise<void> {
  await listen<{ id: string; gen: number; data: string }>("pty-output", (e) => {
    const s = sessions.get(e.payload.id);
    if (!matchesPtyGeneration(s, e.payload.gen)) return;
    queueOutput(e.payload.id, b64ToBytes(e.payload.data));
  });
  await listen<string>("pty-flow-resumed", (e) => flowResumed(e.payload));
  await listen<{ id: string; gen: number }>("pty-exit", (e) => {
    const s = sessions.get(e.payload.id);
    if (!matchesPtyGeneration(s, e.payload.gen)) return;
    flushOutput(e.payload.id); // the exit banner follows the final output
    s.alive = false;
    feedRaw(s.id, s.agent, false);
    onExit(s);
    s.button.classList.add("dead");
    s.term.write("\r\n\x1b[90m[process exited — close with ×]\x1b[0m\r\n");
    if (armedId === s.id) disarmAstra();
  });
}
