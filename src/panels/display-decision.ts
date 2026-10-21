// Display decision sidecar IO, no DOM: `<file>.decision.json` beside a display file, bound to the
// sha256 of the bytes that were on screen. Split from display-gate.ts so Relay can read and write
// verdicts without importing the Display strip.

import { invoke } from "../ipc";

export interface Decision {
  file: string;
  sha256: string;
  /** dismiss = cleared from Relay unruled: neither an approval nor a denial */
  verdict: "approve" | "deny" | "dismiss";
  comment: string;
  atMs: number;
  request: string | null;
}
export interface DecisionView {
  decision: Decision;
  /** the decision's sha256 matches the file as it is now */
  current: boolean;
}

/* The gate is for files something is waiting on. A body that wants a verdict writes
   `<slug>-<8 hex>.<ext>` (docs\reference\workbench-display-gate.md) and Rust reads the id back the same way
   (request_id_of, bridge.rs). A name without one is a file put up to look at, and the
   verdict buttons under it were noise. A file that already HAS a
   decision keeps the gate either way, so an old verdict stays visible and revisable. */
const REQUEST_ID = /-[0-9a-f]{8}$/;

export function hasRequestId(path: string): boolean {
  const name = path.split("\\").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return REQUEST_ID.test(dot > 0 ? name.slice(0, dot) : name);
}

/** null = no sidecar; throws on a sidecar that will not parse. */
export function readDisplayDecision(path: string): Promise<DecisionView | null> {
  return invoke("read_display_decision", { path });
}

export async function saveDisplayDecision(path: string, sha256: string, verdict: Decision["verdict"], comment: string): Promise<void> {
  await invoke("save_display_decision", { path, sha256, verdict, comment });
}
