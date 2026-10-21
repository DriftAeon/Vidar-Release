// Codex's thread history omits plan notifications. Vidar keeps bounded snapshots in
// runtime/vidar-state.json via the existing state backend, under one isolated key.
export const CODEX_PLANS_KEY = "rendered.codexPlans";
export const PLAN_LIMITS = { threads: 32, turns: 64, bytes: 128 * 1024, planBytes: 16 * 1024,
  ageMs: 30 * 24 * 60 * 60 * 1000 };

type Json = Record<string, unknown>;
export interface PlanSnapshot {
  threadId: string;
  turnId: string;
  explanation: string;
  plan: { step: string; status: "pending" | "inProgress" | "completed" }[];
  updatedAt: number;
}
export interface PlanBackend {
  read(): Promise<unknown>;
  patch(entries: Record<string, unknown>): Promise<unknown>;
}
const obj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

function snapshot(threadId: unknown, p: unknown, updatedAt: unknown): PlanSnapshot | null {
  if (!id(threadId) || !obj(p) || !id(p.turnId) || !Array.isArray(p.plan) || p.plan.length > 128
    || typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0
    || (p.explanation !== undefined && p.explanation !== null && typeof p.explanation !== "string")) return null;
  const plan: PlanSnapshot["plan"] = [];
  for (const raw of p.plan) {
    if (!obj(raw) || typeof raw.step !== "string"
      || !["pending", "inProgress", "completed"].includes(String(raw.status))) return null;
    plan.push({ step: raw.step, status: raw.status as PlanSnapshot["plan"][number]["status"] });
  }
  const row: PlanSnapshot = { threadId, turnId: p.turnId, explanation: p.explanation as string ?? "", plan, updatedAt };
  return bytes(row) <= PLAN_LIMITS.planBytes ? row : null;
}

export class CodexPlanStore {
  private rows: PlanSnapshot[] = [];
  private opening: Promise<void> | null = null;
  private writable = false;
  private writing: Promise<void> | null = null;
  private pending: { version: number; entries: PlanSnapshot[] } | null = null;
  private backend: PlanBackend;
  private now: () => number;
  private report: (error: unknown) => void;

  constructor(backend: PlanBackend, now = Date.now, report = (e: unknown) => console.error("codex plans:", e)) {
    this.backend = backend;
    this.now = now;
    this.report = report;
  }

  init(): Promise<void> {
    this.opening ??= this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    let dropped = false;
    try {
      const root = await this.backend.read();
      if (!obj(root)) throw new Error("State root is not an object");
      const saved = root[CODEX_PLANS_KEY];
      if (saved !== undefined) {
        if (!obj(saved) || saved.version !== 1 || !Array.isArray(saved.entries)
          || bytes(saved) > 1024 * 1024) throw new Error("Invalid plan store");
        const seen = new Set<string>();
        const loaded: PlanSnapshot[] = [];
        for (const raw of saved.entries) {
          const row = obj(raw) ? snapshot(raw.threadId, raw, raw.updatedAt) : null;
          const key = row ? JSON.stringify([row.threadId, row.turnId]) : "";
          // drop bad or duplicate rows, keep the good ones
          if (!row || seen.has(key)) { dropped = true; continue; }
          seen.add(key);
          loaded.push(row);
        }
        this.rows = loaded;
      }
      this.writable = true;
      const before = JSON.stringify(this.rows);
      this.prune();
      if (dropped || before !== JSON.stringify(this.rows)) await this.write();
    } catch (e) {
      // Preserve corrupt/unreadable state; the live mapper still draws plans.
      this.report(e);
    }
  }

  private prune(): void {
    const cutoff = this.now() - PLAN_LIMITS.ageMs;
    const threads = new Map<string, number>();
    // Most recently updated snapshots win; stable sorting breaks timestamp ties by arrival.
    this.rows.sort((a, b) => b.updatedAt - a.updatedAt);
    this.rows = this.rows.filter((row) => {
      if (row.updatedAt < cutoff) return false;
      if (!threads.has(row.threadId) && threads.size >= PLAN_LIMITS.threads) return false;
      const count = threads.get(row.threadId) ?? 0;
      if (count >= PLAN_LIMITS.turns) return false;
      threads.set(row.threadId, count + 1);
      return true;
    });
    while (bytes({ version: 1, entries: this.rows }) > PLAN_LIMITS.bytes) this.rows.pop();
  }

  private write(): Promise<void> {
    if (!this.writable) return Promise.resolve();
    this.pending = { version: 1, entries: structuredClone(this.rows) };
    // One write and one latest pending snapshot, even during rapid plan updates.
    this.writing ??= Promise.resolve().then(async () => {
      while (this.pending) {
        const saved = this.pending;
        this.pending = null;
        try { await this.backend.patch({ [CODEX_PLANS_KEY]: saved }); }
        catch (e) { this.report(e); }
      }
    }).finally(() => {
      this.writing = null;
      if (this.pending) return this.write();
    });
    return this.writing;
  }

  async remember(threadId: string, p: unknown): Promise<void> {
    await this.init();
    const row = snapshot(threadId, p, this.now());
    if (!row) return;
    this.rows = this.rows.filter((r) => r.threadId !== row.threadId || r.turnId !== row.turnId);
    this.rows.unshift(row);
    this.prune();
    await this.write();
  }

  get(threadId: string, turnId: string): PlanSnapshot | null {
    const row = this.rows.find((r) => r.threadId === threadId && r.turnId === turnId
      && r.updatedAt >= this.now() - PLAN_LIMITS.ageMs);
    return row ? structuredClone(row) : null;
  }

  /**
   * Complete, untruncated history only: remove plans for rolled-back/deleted turns.
   * NOT called from the Codex adapter: it assumes history turn.id equals the live turnId, which is
   * unverified. If app-server re-ids turns on resume, this would delete every snapshot for the thread.
   */
  async reconcile(threadId: string, turnIds: ReadonlySet<string>): Promise<void> {
    await this.init();
    const count = this.rows.length;
    this.rows = this.rows.filter((r) => r.threadId !== threadId || turnIds.has(r.turnId));
    if (this.rows.length !== count) await this.write();
  }

  /** Archive/delete lifecycle hook. Closing a view keeps plans for later Resume. */
  async forget(threadId: string): Promise<void> {
    await this.reconcile(threadId, new Set());
  }
}

// Lazy IPC import keeps the store independently testable under node's type stripping.
export const codexPlans = new CodexPlanStore({
  read: async () => (await import("../ipc")).invoke("read_state"),
  patch: async (entries) => (await import("../ipc")).invoke("patch_state", { entries }),
});
export const initCodexPlans = (): Promise<void> => codexPlans.init();
