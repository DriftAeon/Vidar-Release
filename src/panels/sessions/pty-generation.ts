// Admission for PTY exit/output events shared by the two session listeners.
import type { Terminal } from "@xterm/xterm";
import type { TerminalSession } from "./types";

type Admissible = Pick<TerminalSession, "body" | "term" | "ptyGen">;

/** True when the event's `gen` is this terminal attachment's own tag (set before spawn_pty). */
export function matchesPtyGeneration<S extends Admissible>(
  session: S | undefined,
  gen: number,
): session is S & { term: Terminal; ptyGen: number } {
  return !!session?.term && session.body === "terminal"
    && session.ptyGen !== undefined && session.ptyGen === gen;
}
