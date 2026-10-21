// Settle, timeout and drop decisions for launcher adopts (hosted.ts wires them). Pure and
// import-light so plain node can test it with mock timers; hosted.ts itself imports the DOM.
const ADOPT_TIMEOUT_MS = 10_000;

export interface AdoptResult {
  ok: boolean;
  reason: string;
  timedOut: boolean;
}

/** `refused`: the host said no and (with dropOnFail) the tab was dropped. `timeout`: nothing
 *  settled; the tab stays because a late adopt would still take a lease. */
export class AdoptError extends Error {
  readonly kind: "refused" | "timeout";
  readonly reason: string;
  readonly dropped: boolean;
  constructor(message: string, kind: "refused" | "timeout", reason: string, dropped: boolean) {
    super(message);
    this.kind = kind;
    this.reason = reason;
    this.dropped = dropped;
  }
}

/** Start the bounded wait: `onAdopted` goes to `createSession`, `result` settles on the first
 *  of it or the timeout (it never rejects). */
export function startAdopt(timeoutMs = ADOPT_TIMEOUT_MS) {
  let resolve!: (r: AdoptResult) => void;
  const result = new Promise<AdoptResult>((r) => { resolve = r; });
  const timer = setTimeout(() => resolve({ ok: false, reason: "", timedOut: true }), timeoutMs);
  return {
    result,
    onAdopted: (ok: boolean, reason?: string) => {
      clearTimeout(timer);
      resolve({ ok, reason: reason ?? "", timedOut: false });
    },
  };
}

/** Await the settle and return the tab, or throw `AdoptError`. A refused adopt drops the tab
 *  once, only when `dropOnFail`; the timeout never drops. `drop` must not kill the session. */
export async function finishAdopt(
  tab: string,
  result: Promise<AdoptResult>,
  opts: { dropOnFail?: boolean; drop: (tab: string) => void; log?: (reason: string) => void },
): Promise<string> {
  const r = await result;
  if (r.ok) return tab;
  if (r.timedOut) throw new AdoptError("adopt timed out waiting for the host to grant the lease", "timeout", "", false);
  if (opts.dropOnFail) {
    opts.log?.(r.reason);
    opts.drop(tab);
  }
  throw new AdoptError("adopt failed: the host did not grant the lease", "refused", r.reason, !!opts.dropOnFail);
}

/** After a launcher adopt dropped its tab: raise the Falcon shell only when the refusal names
 *  another controller, or the re-listed session reads as shell-held. Never on a timeout. */
export function shouldShowShellAfterDrop(err: unknown, relistedHeldElsewhere: boolean): boolean {
  if (!(err instanceof AdoptError) || err.kind !== "refused" || !err.dropped) return false;
  return err.reason.includes("already controlled by") || relistedHeldElsewhere;
}
