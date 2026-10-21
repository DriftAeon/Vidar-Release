// A node's full, uncapped final output for the inspector card. The run record keeps only a
// 2000-char `summary` (engine.ts); flow_output.rs writes the whole text per (run, node) and
// `flow_output_read` returns it. This module decides which file belongs to a card and keeps a
// slow read for an old card from overwriting the current one. The read itself is injected, so
// it has no Tauri dependency and tests drive it directly.

import type { FlowRun } from "./run";

/** The node whose output file a card shows, at the attempt that produced it. */
export interface OutputTarget {
  runId: string;
  nodeId: string;
  attempt: number;
}

/** `null` when there is no finished output to read. An Output node never runs; its text is its
 *  source agent's, found from the edge into it in the executed run's own graph snapshot, not the
 *  live graph, which may have been rewired since the run. Only an "ok" source has a final text
 *  (the same rule as the run record's `summary`). */
export function outputReadTarget(run: FlowRun, nodeId: string): OutputTarget | null {
  const snap = run.graphSnapshot;
  let sourceId = nodeId;
  if (snap?.nodes?.find((n) => n.id === nodeId)?.kind === "output") {
    const edge = snap.edges?.find((e) => e.to.node === nodeId);
    if (!edge) return null;
    sourceId = edge.from.node;
  }
  const st = run.nodes[sourceId];
  if (!st || st.status !== "ok" || st.attempts < 1) return null;
  return { runId: run.id, nodeId: sourceId, attempt: st.attempts };
}

/** Resolves the file's text, `null`/`undefined` when there is none. May reject (command absent
 *  in an older backend, bad id); a rejection counts as "no full text". */
export type OutputReadFn = (runId: string, nodeId: string) => Promise<string | null | undefined>;

export interface OutputReader {
  /** Full text already read for this target, if any. */
  cached(t: OutputTarget): string | undefined;
  /** Makes `t` the current target and reads it. Resolves the text only if `t` is still the
   *  current target when the read lands; a stale, empty or failed read resolves `undefined`. */
  load(t: OutputTarget): Promise<string | undefined>;
  /** Clears the current target, so a read still in flight fills nothing. */
  release(): void;
  /** Reads `t` for a user action without changing the current target. */
  fetch(t: OutputTarget): Promise<string | undefined>;
}

/** Full outputs can be large; a handful covers flipping between the cards of one run. */
const CACHE_MAX = 8;

const keyOf = (t: OutputTarget): string => `${t.runId}:${t.nodeId}:${t.attempt}`;

export function createOutputReader(read: OutputReadFn): OutputReader {
  const texts = new Map<string, string>();
  let current: string | null = null;

  async function readInto(t: OutputTarget): Promise<string | undefined> {
    const key = keyOf(t);
    const hit = texts.get(key);
    if (hit !== undefined) return hit;
    let text: string | null | undefined;
    try {
      text = await read(t.runId, t.nodeId);
    } catch {
      text = null;
    }
    if (typeof text !== "string" || text === "") return undefined;
    texts.delete(key);
    texts.set(key, text);
    while (texts.size > CACHE_MAX) texts.delete(texts.keys().next().value as string);
    return text;
  }

  return {
    cached: (t) => texts.get(keyOf(t)),
    async load(t) {
      const key = keyOf(t);
      current = key;
      const text = await readInto(t);
      return current === key ? text : undefined;
    },
    release() {
      current = null;
    },
    fetch: readInto,
  };
}
