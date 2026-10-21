// Inspector wiring for a node's full output: the one reader over `flow_output_read`, the card's
// second paint, and the click-time read for Open in Document. Which file to read and the
// stale-result guard live in output-read.ts.

import { invoke } from "../ipc";
import { getRun } from "./runs-store";
import { createOutputReader, outputReadTarget, type OutputTarget } from "./output-read";

const reader = createOutputReader((runId, nodeId) => invoke("flow_output_read", { runId, nodeId }));

/** The file a card shows and, once read, its full text. Both absent when there is none to read. */
export function fullOutputFor(runId: string, nodeId: string): { target?: OutputTarget; full?: string } {
  const run = getRun(runId);
  const target = run ? outputReadTarget(run, nodeId) : null;
  return target ? { target, full: reader.cached(target) } : {};
}

/** Second paint: swaps the summary in `box` for the full text when it arrives, if the card still
 *  shows the same (run, node, attempt). */
export function fillFullOutput(target: OutputTarget, box: HTMLElement, onText?: (text: string) => void): void {
  void reader.load(target).then((full) => {
    if (full === undefined || !box.isConnected) return;
    box.textContent = full;
    onText?.(full);
  });
}

/** The card is being replaced: a read still in flight for it fills nothing. */
export function releaseFullOutput(): void {
  reader.release();
}

/** Reads `target` for a user action (Open in Document) without changing the card's target. */
export function fetchFullOutput(target: OutputTarget): Promise<string | undefined> {
  return reader.fetch(target);
}
