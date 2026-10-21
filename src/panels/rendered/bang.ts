// Bang mode of a Rendered composer: a `!` line typed with the keyboard runs in Git Bash
// (`bang_run`, src-tauri/src/bang.rs) and is drawn as an ordinary Bash pill. The run is held and
// goes to the model in front of the next non-slash message, in the CLI's own tag shape.
// Only a keyboard Enter runs anything: a `!` line that arrives through body.write() (bus write,
// voice, drive send, Astra) stays unsent in the composer, so another source cannot run a shell here.

import { invoke } from "../../ipc";
import type { RenderedState } from "./state";

export interface BangRun { command: string; stdout: string; stderr: string }

const BLOCK = /^<bash-input>([\s\S]*?)<\/bash-input>\n<bash-stdout>([\s\S]*?)<\/bash-stdout><bash-stderr>([\s\S]*?)<\/bash-stderr>\n\n/;
/** The S5 marker a failed or timed-out run leaves at the end of its held stderr. */
const FAILED = /\[(?:exit code -?\d+|timed out)\]$/;

// `</bash-` inside a field would close its tag early (here and in the CLI's own strip): one more
// backslash after the `<` of every `<\…\/bash-`, so the escaped text never holds a bare `</bash-`.
const escape = (s: string) => s.replace(/<(\\*)\/bash-/g, "<$1\\/bash-");
const unescape = (s: string) => s.replace(/<(\\*)\\\/bash-/g, "<$1/bash-");

/** held runs + the user's text → the content the model receives */
export function composeBash(runs: readonly BangRun[], text: string): string {
  return runs.map((r) => `<bash-input>${escape(r.command)}</bash-input>\n<bash-stdout>${escape(r.stdout)}</bash-stdout><bash-stderr>${escape(r.stderr)}</bash-stderr>\n\n`).join("") + text;
}

/** Inverse of composeBash: the leading bash blocks and the user's own text. */
export function splitBashContext(content: string): { runs: BangRun[]; text: string } {
  const runs: BangRun[] = [];
  let rest = content;
  for (let m = BLOCK.exec(rest); m; m = BLOCK.exec(rest)) {
    runs.push({ command: unescape(m[1]), stdout: unescape(m[2]), stderr: unescape(m[3]) });
    rest = rest.slice(m[0].length);
  }
  return { runs, text: rest };
}

export interface BangDeps {
  /** the agent profile's `localCommands` */
  enabled: boolean;
  /** the host's `bangMode` feature, resolved by rendered.ts (the lockstep test keeps host checks there) */
  hostOk: boolean;
  sealGroup: (keepOpen?: boolean) => void;
  toolStart: (id: string, name: string, input: unknown, truncated: number | undefined, parent: string | null) => void;
  toolDone: (id: string, content: string, isError: boolean, structured: unknown, truncated: number | undefined, parent: string | null) => void;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
}

export interface Bang {
  /** null: not a bang line, carry on; true: a run started (the composer clears); false: refused, the text stays */
  handle(text: string, fromKey: boolean): boolean | null;
  /** The runs that ride with this outgoing text (none for a `/…` send) and the wire content; clears them. */
  take(text: string): { runs: BangRun[]; wire: string };
  /** Put runs back in front (a failed send, a retracted prompt). */
  hold(runs: readonly BangRun[]): void;
  /** /clear: the held runs go, and a run still in flight is ignored when it lands. */
  drop(): void;
  /** The transcript was reset (hydration start, /clear, resume): a run still in flight is ignored when it lands. */
  invalidate(): void;
  /** A body.write() landed: a `!` line it leaves in the composer gets the hold notice once. */
  written(value: string): void;
  /** A prompt-queued record's content: the user's text, with its runs drawn as pills unless this
   *  body composed it live (those were drawn when they ran). Hydration redraws them all. */
  fromRecord(content: string, hydrating: boolean): { runs: BangRun[]; text: string };
}

export function createBang(S: Pick<RenderedState, "pillCwd">, deps: BangDeps): Bang {
  const { enabled, hostOk, sealGroup, toolStart, toolDone, noticeBlock } = deps;
  let held: BangRun[] = [];
  let running = false;
  let n = 0;
  let gen = 0;
  let noted = false;
  const mine = new Set<string>(); // wire strings this body composed
  const output = (r: { stdout: string; stderr: string }) => (r.stdout && r.stderr ? `${r.stdout}\n${r.stderr}` : r.stdout || r.stderr);

  function draw(command: string): string {
    const id = `bang-${++n}`;
    sealGroup();
    toolStart(id, "Bash", { command }, undefined, null);
    sealGroup(true); // model tools arriving while this runs open their own group; keepOpen: the output stays
    return id;
  }
  function redraw(runs: readonly BangRun[]): void {
    for (const r of runs) toolDone(draw(r.command), output(r), FAILED.test(r.stderr), undefined, undefined, null);
  }
  function run(command: string): void {
    running = true;
    const mark = gen;
    const id = draw(command);
    // MSYS reads a leading `@word` argument as a response file
    void invoke("bang_run", { cwd: S.pillCwd, command: command.startsWith("@") ? ` ${command}` : command }).then((res) => {
      if (mark !== gen) return;
      const bad = res.timedOut || (res.code !== null && res.code !== 0);
      const extra = res.timedOut ? "[timed out]" : bad ? `[exit code ${res.code}]` : "";
      const stderr = extra ? (res.stderr ? `${res.stderr}\n${extra}` : extra) : res.stderr;
      toolDone(id, output({ stdout: res.stdout, stderr }), bad, undefined, undefined, null);
      held.push({ command, stdout: res.stdout, stderr });
      noticeBlock("Output goes with your next message.", "info");
    }, (error) => {
      if (mark !== gen) return;
      toolDone(id, String(error instanceof Error ? error.message : error), true, undefined, undefined, null);
    }).finally(() => { running = false; });
  }

  return {
    handle(text, fromKey) {
      if (!text.startsWith("!") || !enabled) return null;
      const command = text.slice(1).trim();
      if (!command) return null;
      if (!hostOk) { noticeBlock("A ! line runs only in a Vidar tab.", "info"); return false; }
      if (!fromKey) { noted = true; noticeBlock("A ! line from another source waits here. Press Enter to run it.", "info"); return false; }
      if (running) { noticeBlock("A ! command is already running.", "info"); return false; }
      noted = false;
      run(command);
      return true;
    },
    take(text) {
      if (!held.length || text.trimStart().startsWith("/")) return { runs: [], wire: text };
      const runs = held;
      held = [];
      const wire = composeBash(runs, text);
      mine.add(wire);
      return { runs, wire };
    },
    hold(runs) { held = [...runs, ...held]; },
    drop() { held = []; gen++; },
    invalidate() { gen++; },
    written(value) {
      const line = enabled && hostOk && value.trim().startsWith("!") && value.trim().length > 1;
      if (line && !noted) noticeBlock("A ! line from another source waits here. Press Enter to run it.", "info");
      noted = line;
    },
    fromRecord(content, hydrating) {
      const split = splitBashContext(content);
      if (split.runs.length && (hydrating || !mine.delete(content))) redraw(split.runs);
      return split;
    },
  };
}
