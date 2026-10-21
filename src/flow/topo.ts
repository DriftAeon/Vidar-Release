// Generic Kahn topological sort over node ids and directed edges. Leaf module — no imports at
// all, so it stays importable under `node --test`'s extensionless resolution (leaf-module
// rule). v1's engine only ever feeds it a `validate.ts`-approved straight chain, but the
// algorithm itself doesn't assume that shape — growth-shaped for v2 branching/fan-out.

export interface TopoEdge {
  from: string;
  to: string;
}

/** Returns `ids` in a valid topological order (stable: among ties, `ids`' own order), or `null`
 *  if the edges describe a cycle. An edge naming an id not in `ids` is ignored rather than
 *  thrown on — callers that need that checked do it themselves (`validate.ts`'s topology check
 *  runs before RUN is ever reachable). */
export function topoSort(ids: string[], edges: TopoEdge[]): string[] | null {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (!adj.has(e.from) || !inDegree.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const id of ids) if (inDegree.get(id) === 0) queue.push(id);

  const order: string[] = [];
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  return order.length === ids.length ? order : null;
}
