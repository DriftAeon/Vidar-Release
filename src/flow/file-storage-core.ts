// Flow's storage leaf: a synchronous
// `StorageLike` over the files in `state\flow\` (src-tauri/src/flow_store.rs). `init()` fills an
// in-memory Map once; reads are served from it, writes update it at once and reach the files
// through a serialized pump. Leaf module — only `import type` crosses in, so `node --test` loads it
// standalone; file-storage.ts wires it to `flow_store_open`/`flow_store_write`.
//
// Loss guards:
// - Before `init()` resolves every accessor throws: a read would see "absent" and seed over data.
// - Read-only (another Vidar holds the writer lock, or the open failed) is fixed for the page's
//   life: `setItem`/`removeItem` throw, nothing is sent.
// - `setItem` refuses a bad key or an oversize value synchronously, so one bad write can never
//   wedge the pump; the store-core leaves turn that throw into their save-failed result.
// - One batch per microtask burst; the next waits for the previous to settle. A failed batch puts
//   its keys back first, in their order, ahead of keys dirtied later (a backup key is never
//   overtaken by the overwrite it protects). It is resent on the next write or flush; no timer.
// - `flush()` sends at once, carrying every in-flight key too, so the Rust side can drop the
//   older batch if it lands later (sequence numbers).
// - Sequence numbers start from the `seq` the open returned and every write carries the open's
//   `page` id: Rust judges staleness per page, so an old page's pagehide batch landing after this
//   page's open can never make this page's batches look stale.

import type { StorageLike } from "../prefs-core";

export const MAX_VALUE_BYTES = 16 * 1024 * 1024;

const KEY_RE = /^vidar\.flow\.[A-Za-z0-9._-]{1,120}$/;

/** The file-name rule, same as flow_store.rs `valid_key`. */
export function isFlowKey(key: string): boolean {
  return KEY_RE.test(key) && !key.includes("..") && !key.endsWith(".");
}

/** `locked`: another Vidar holds the writer lock. `lockfailed`: the lock file could not be opened
 *  for any other reason. Both leave the page read-only. */
export type FlowStorageErrorKind = "save" | "unreadable" | "locked" | "lockfailed";

export interface FileStorageBackend {
  open(): Promise<unknown>;
  write(page: number, seq: number, entries: [string, string | null][]): Promise<unknown>;
}

interface Batch {
  seq: number;
  keys: string[];
  done: Promise<boolean>;
}

const encoder = new TextEncoder();

interface OpenReply {
  writable: boolean;
  entries: Record<string, unknown>;
  page: number;
  seq: number;
  lockError?: string | null;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function isOpenReply(v: unknown): v is OpenReply {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.writable === "boolean" && typeof r.entries === "object" && r.entries !== null && !Array.isArray(r.entries)
    && isCount(r.page) && isCount(r.seq)
    && (r.lockError === undefined || r.lockError === null || typeof r.lockError === "string");
}

/** A Rust-side validation refusal (`rejected <key>: ...`): that key is dropped, not retried. */
function rejectedKey(err: unknown): string | null {
  // Tauri rejects with the bare string; an Error carries it as its message.
  const m = /^rejected (\S+):/.exec(err instanceof Error ? err.message : String(err));
  return m ? m[1] : null;
}

export class FileStorage implements StorageLike {
  private map = new Map<string, string>();
  /** Insertion-ordered: the send order of a batch. */
  private dirty = new Set<string>();
  private ready = false;
  private writableFlag = false;
  private initP: Promise<void> | null = null;
  private seq = 0;
  private page = 0;
  private inflight: Batch[] = [];
  private scheduled = false;
  private errorCb: ((kind: FlowStorageErrorKind, keys: string[], err: unknown) => void) | null = null;
  private initFailure: { kind: FlowStorageErrorKind; err: unknown } | null = null;
  private readonly backend: FileStorageBackend;

  // No parameter properties: node --test strips types, it does not transform them.
  constructor(backend: FileStorageBackend) {
    this.backend = backend;
  }

  get writable(): boolean {
    return this.writableFlag;
  }

  /** Once per page: a second call returns the first call's promise. Never rejects. */
  init(): Promise<void> {
    if (!this.initP) this.initP = this.load();
    return this.initP;
  }

  private async load(): Promise<void> {
    try {
      const reply = await this.backend.open();
      if (!isOpenReply(reply)) throw new Error("flow_store_open returned no object");
      const entries = new Map<string, string>();
      for (const [k, v] of Object.entries(reply.entries)) {
        if (typeof v !== "string") throw new Error(`flow_store_open: ${k} is not a string`);
        entries.set(k, v);
      }
      this.map = entries;
      this.page = reply.page;
      this.seq = reply.seq;
      this.writableFlag = reply.writable;
      if (!reply.writable) {
        if (reply.lockError) this.reportInit("lockfailed", new Error(reply.lockError));
        else this.reportInit("locked", new Error("another Vidar holds state\\flow\\writer.lock"));
      }
    } catch (e) {
      this.map.clear();
      this.writableFlag = false;
      this.reportInit("unreadable", e);
    }
    this.ready = true;
  }

  private reportInit(kind: FlowStorageErrorKind, err: unknown): void {
    this.initFailure = { kind, err };
    this.emit(kind, [], err);
  }

  private emit(kind: FlowStorageErrorKind, keys: string[], err: unknown): void {
    try { this.errorCb?.(kind, keys, err); } catch { /* a subscriber's throw stays out */ }
  }

  /** One subscriber. An init failure (read-only or unreadable) is replayed on registration. */
  onError(cb: ((kind: FlowStorageErrorKind, keys: string[], err: unknown) => void) | null): void {
    this.errorCb = cb;
    if (cb && this.initFailure) this.emit(this.initFailure.kind, [], this.initFailure.err);
  }

  private assertReady(key: string): void {
    if (!this.ready) throw new Error(`Flow storage read of "${key}" before init`);
  }

  private assertWritable(key: string): void {
    this.assertReady(key);
    if (!this.writableFlag) throw new Error(`Flow storage is read-only, "${key}" not saved`);
  }

  getItem(key: string): string | null {
    this.assertReady(key);
    return this.map.get(key) ?? null;
  }

  /** Store-owned transaction rollback. Call only after the failed flush settles. */
  captureKey(key: string): { value: string | null; dirty: boolean } {
    this.assertReady(key);
    return { value: this.map.get(key) ?? null, dirty: this.dirty.has(key) };
  }

  restoreKey(key: string, previous: { value: string | null; dirty: boolean }): void {
    this.assertReady(key);
    if (previous.value === null) this.map.delete(key);
    else this.map.set(key, previous.value);
    if (previous.dirty) this.dirty.add(key);
    else this.dirty.delete(key);
  }

  /** Every key held, for the legacy import's duplicate check. */
  keys(): string[] {
    this.assertReady("keys");
    return [...this.map.keys()];
  }

  setItem(key: string, value: string): void {
    this.assertWritable(key);
    if (!isFlowKey(key)) throw new Error(`Flow storage key "${key}" is not a valid file key`);
    const v = String(value);
    if (encoder.encode(v).length > MAX_VALUE_BYTES) throw new Error(`Flow storage value for "${key}" is over 16 MiB`);
    this.map.set(key, v);
    this.markDirty(key);
  }

  removeItem(key: string): void {
    this.assertWritable(key);
    if (!isFlowKey(key)) throw new Error(`Flow storage key "${key}" is not a valid file key`);
    this.map.delete(key);
    this.markDirty(key);
  }

  private markDirty(key: string): void {
    // A re-set key keeps its first position: the batch order is first-dirtied order.
    this.dirty.add(key);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.inflight.length === 0) this.send([]);
      });
    }
  }

  /** Sends `carry` (in-flight keys, flush only) followed by every dirty key, current values. */
  private send(carry: string[]): Batch | null {
    const keys = [...new Set([...carry, ...this.dirty])];
    if (keys.length === 0) return null;
    this.dirty.clear();
    const seq = ++this.seq;
    const page = this.page;
    const entries: [string, string | null][] = keys.map((k) => [k, this.map.get(k) ?? null]);
    const batch: Batch = { seq, keys, done: Promise.resolve(false) };
    batch.done = Promise.resolve()
      .then(() => this.backend.write(page, seq, entries))
      .then(
        () => {
          this.settle(batch);
          // Keys dirtied while this batch was out go next.
          if (this.inflight.length === 0 && this.dirty.size > 0) this.send([]);
          return true;
        },
        (err) => {
          this.settle(batch);
          this.requeue(batch, err);
          this.emit("save", batch.keys, err);
          return false;
        },
      );
    this.inflight.push(batch);
    return batch;
  }

  private settle(batch: Batch): void {
    this.inflight = this.inflight.filter((b) => b !== batch);
  }

  /** A failed batch's keys go back ahead of anything dirtied since, in their original order;
   *  a key a newer in-flight batch already carries is left to that batch, and a key the Rust side
   *  rejected by name is dropped. No resend here: the next write or flush sends it. */
  private requeue(batch: Batch, err: unknown): void {
    const rejected = rejectedKey(err);
    const covered = new Set(this.inflight.filter((b) => b.seq > batch.seq).flatMap((b) => b.keys));
    const back = batch.keys.filter((k) => k !== rejected && !covered.has(k));
    const later = [...this.dirty].filter((k) => !back.includes(k));
    this.dirty = new Set([...back, ...later]);
  }

  /** Sends everything pending now, without waiting on an in-flight batch. True once every key
   *  written so far has landed; false in read-only mode or on a failed write. */
  async flush(): Promise<boolean> {
    if (!this.ready || !this.writableFlag) return false;
    if (this.dirty.size === 0) {
      const results = await Promise.all(this.inflight.map((b) => b.done));
      return results.every(Boolean) && this.dirty.size === 0;
    }
    const carry = this.inflight.flatMap((b) => b.keys);
    const batch = this.send(carry);
    if (!batch) return true;
    return (await batch.done) && this.dirty.size === 0;
  }
}
