// UI-state leaf:
// the typed key registry, a synchronous in-memory cache over `vidar-state.json`, a debounced
// write-back, and the one-shot import of the pre-file browser-storage keys. Leaf module — nothing
// but `import type` crosses in, so `node --test` loads it standalone; prefs.ts wires it to
// `read_state`/`patch_state` and the page. Flow's graphs and runs are not here: they live in
// their own files under state\flow\ (flow/file-storage.ts).
//
// The Rust side (src-tauri/src/settings/state.rs) merges shallowly: every patch entry replaces one
// top-level key whole, and a null entry deletes it. So a key's value is always written whole, never
// as a partial object. A merged object whose compact serialization is longer than MAX_STATE_BYTES
// is refused there; `set` checks the same bound first so an oversize write fails at the caller
// instead of on a later flush.

/** Subset of the DOM `Storage` interface a storage leaf can be handed — a Map-backed stub in
 *  tests, flow/file-storage-core.ts's FileStorage in the app. Hoisted here from flow/store-core.ts and
 *  flow/runs-core.ts, which re-export it. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** What the one-shot import reads from: the page's old browser storage. */
export type LegacySource = Pick<Storage, "getItem" | "removeItem" | "key" | "length">;

import type { OnboardingProgress } from "./onboarding/progress";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The registry: every typed pref, one dotted namespace. `theme` stays a bare top-level key —
 *  main.rs reads exactly that key for the pre-paint injection. */
export interface PrefKeys {
  "theme": string;
  "rightbar.width": number;
  "split.width": number;
  /** Zoom as an offset from vidar.json's fontSize; absent = 0. */
  "sessions.zoomOffset": number;
  /** The retired absolute font size, kept only until sessions/zoom.ts converts it to an offset. */
  "sessions.legacyFont": number;
  "document.last": string;
  "document.groups": Record<string, true>;
  "order.loadout": string[];
  "order.rack": string[];
  /** Toolbar tool IDs, left to right; absent = built-in order. */
  "order.tools": string[];
  /** Module IDs hidden in Vidar; absent = all shown. Core IDs are rejected by the resolver. */
  "modules.hidden": string[];
  /** Slack ts (`secs.micros`) of the newest message the Slack tab showed; rows newer than it carry the New dot. */
  "slack.seen": string;
  /** Launcher root rows, top-down, by roster-shown.ts rowId (settings/launcher-order.ts); absent = default. */
  "order.launcher": string[];
  /** The plain (non-Bare) Claude and Codex launcher rows are shown; absent = off (settings/agents.ts, launcher/roster.ts). */
  "launcher.plainRows": boolean;
  /** Document Open menu folder buttons, top-down, by folder key ("Run · <slug>" folders merge into "Runs"; a saved "Run" still counts); document-open-menu.ts. */
  "order.documentFolders": string[];
  /** Workbench header tabs, left to right, by data-tab id; workbench.ts. */
  "order.workbenchTabs": string[];
  /** Swap button asks "rebuild now?" before a swap; set from its RMB menu (panels/swap.ts). Absent = off. */
  "swap.confirm": boolean;
  "character.animationDropdown": "on" | "off";
  /** Which backend the Changes tab shows; absent = git (changes/view.ts switch). */
  "changes.backend": "git" | "p4";
  /** Set once the launch-time Dependencies page has been shown (settings/dependencies.ts). */
  "onboarding.dependenciesSeen": boolean;
  /** Legacy: read once for compat, nothing writes it since the Your Rules page was retired (onboarding/start.ts decides launch). */
  "onboarding.rulesSeen": boolean;
  /** Onboarding resume point and step 2 workspace; `finished` once the series ends (onboarding/progress.ts). */
  "onboarding.progress": OnboardingProgress;
  /** Raw catalog group of the folder last picked in the Document Open menu (document-open-menu.ts). */
  "document.folder": string;
  /** Dismissed background-agent task ids per Claude session id, bounded (panels/rendered/agents-dismissed.ts). */
  "rendered.dismissedAgents": Record<string, { t: number; ids: string[] }>;
  /** Last model list a Claude Rendered tab received (events.ts), shown in Settings › Agents › Model. */
  "claudeModels": { value: string; label: string; resolved?: string }[];
  /** Last full model/list catalog a Codex Rendered tab received (events.ts), shown in Settings › Agents › Codex Rendered. */
  "codexModels": { value: string; label: string; effortLevels: string[] }[];
  /** Open Codex Rendered tabs in strip order, rebuilt on every change (panels/sessions/codex-save.ts)
   *  and reopened at boot (launcher/codex-restore.ts). `threadId` is null until the tab has run a prompt. */
  "rendered.codexTabs": CodexTabRecord[];
  /** Persisted positions for hosted sessions and in-process Codex tabs in the strip. */
  "rendered.tabOrder": string[];
  /** A renamed hosted Claude tab's title per Falcon session id; dropped when the host stops listing the session (launcher/hosted-names.ts). */
  "rendered.hostedNames": Record<string, string>;
  /** Shared browser filters: source -> facet id -> chosen values; sanitised by the shell (browser/filter.ts cleanFilters), not here. */
  "browser.filters": Record<string, Record<string, string[]>>;
  /** Dismissed Unreal diagnostics per project root, cleared when the build or live-coding time changes (unreal/model.ts). */
  "unreal.dismissed": Record<string, { build: number | null; live: number | null; keys: string[] }>;
}
export interface CodexTabRecord {
  /** Stable identity for the tab, including a new thread with no turns. */
  tabKey?: string;
  threadId: string | null;
  cwd: string;
  title: string;
  art: string;
  model: string | null;
  mode: "default" | "acceptEdits" | "plan";
  /** Rules file path the tab was launched with, if any. */
  rules: string | null;
  active: boolean;
  /** Bare launch profile of a profiled tab; restore respawns it in that Bare home. */
  profile?: string;
  /** The launching Bare row's key; with `profile` it must still resolve to a row at restore. */
  rowKey?: string;
  /** Explicit set override the tab launched with; absent = the row's own. */
  sets?: { library?: string; set: string }[];
  /** The Rune Vault a profiled tab loaded; restore resumes the thread on it, wins over `sets`. */
  vault?: string;
}
export type PrefKey = keyof PrefKeys;

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === "string";
const isStrArray = (v: unknown) => Array.isArray(v) && v.every(isStr);
/** EFFORT_LEVELS (agents/protocol.ts), copied because this leaf takes only `import type`; a test pins them equal. */
export const EFFORT_NAMES: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const isTrueMap = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => x === true);

/** Guarded get: a hand-edited file holding the wrong type reads as absent, not as a crash. */
export const GUARDS: { [K in PrefKey]: (v: unknown) => boolean } = {
  "theme": isStr,
  "rightbar.width": isNum,
  "split.width": isNum,
  "sessions.zoomOffset": isNum,
  "sessions.legacyFont": isNum,
  "document.last": isStr,
  "document.groups": isTrueMap,
  "order.loadout": isStrArray,
  "order.rack": isStrArray,
  "order.tools": isStrArray,
  "modules.hidden": isStrArray,
  "slack.seen": (v) => typeof v === "string" && /^\d{1,12}\.\d{1,9}$/.test(v),
  "order.launcher": isStrArray,
  "launcher.plainRows": (v) => typeof v === "boolean",
  "order.documentFolders": isStrArray,
  "order.workbenchTabs": isStrArray,
  "swap.confirm": (v) => typeof v === "boolean",
  "character.animationDropdown": (v) => v === "on" || v === "off",
  "changes.backend": (v) => v === "git" || v === "p4",
  "onboarding.dependenciesSeen": (v) => typeof v === "boolean",
  "onboarding.rulesSeen": (v) => typeof v === "boolean",
  "onboarding.progress": (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const x = v as { step?: unknown; finished?: unknown; workspace?: unknown };
    return (
      typeof x.step === "string" &&
      /^(deps|primary|workspace|theme|modules|runes)$/.test(x.step) && // OnboardingStep ids; a quoted bare runes literal trips the paths-contract scan
      typeof x.finished === "boolean" &&
      (x.workspace === undefined || typeof x.workspace === "string")
    );
  },
  "document.folder": isStr,
  "rendered.dismissedAgents": (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.values(v).every((e) => {
      const x = e as { t?: unknown; ids?: unknown } | null;
      return !!x && isNum(x.t) && isStrArray(x.ids); // same shape as agents-dismissed.ts isDismissedMap
    }),
  "claudeModels": (v) =>
    Array.isArray(v) && v.every((m) => {
      const x = m as { value?: unknown; label?: unknown; resolved?: unknown } | null;
      return !!x && isStr(x.value) && isStr(x.label) && (x.resolved === undefined || isStr(x.resolved));
    }),
  "codexModels": (v) =>
    Array.isArray(v) && v.every((m) => {
      const x = m as { value?: unknown; label?: unknown; effortLevels?: unknown } | null;
      return !!x && isStr(x.value) && isStr(x.label) && Array.isArray(x.effortLevels)
        && x.effortLevels.every((l) => EFFORT_NAMES.includes(l as string));
    }),
  "rendered.hostedNames": (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isStr),
  "rendered.tabOrder": isStrArray,
  // Shape only (object -> object -> string[]); bounds are cleanFilters' job.
  "browser.filters": (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.values(v).every((s) =>
      typeof s === "object" && s !== null && !Array.isArray(s) && Object.values(s).every(isStrArray)),
  "unreal.dismissed": (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.values(v).every((e) => {
      const x = e as { build?: unknown; live?: unknown; keys?: unknown } | null;
      return !!x && (x.build === null || isNum(x.build)) && (x.live === null || isNum(x.live)) && isStrArray(x.keys);
    }),
  "rendered.codexTabs": (v) =>
    Array.isArray(v) && v.every((t) => {
      const x = t as Record<string, unknown> | null;
      const strOrNull = (y: unknown) => y === null || isStr(y);
      return !!x && typeof x === "object" && (x.tabKey === undefined || isStr(x.tabKey))
        && (x.profile === undefined || isStr(x.profile)) && (x.rowKey === undefined || isStr(x.rowKey))
        && (x.sets === undefined || (Array.isArray(x.sets) && x.sets.every((r) => !!r && isStr((r as Record<string, unknown>).set) && ((r as Record<string, unknown>).library === undefined || isStr((r as Record<string, unknown>).library)))))
        && (x.vault === undefined || isStr(x.vault))
        && strOrNull(x.threadId) && isStr(x.cwd) && isStr(x.title) && isStr(x.art)
        && strOrNull(x.model) && strOrNull(x.rules) && typeof x.active === "boolean"
        && (x.mode === "default" || x.mode === "acceptEdits" || x.mode === "plan");
    }),
};

const num = (raw: string): Json | undefined => {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : undefined;
};
const str = (raw: string): Json | undefined => raw;
const json = (raw: string): Json | undefined => {
  try { return JSON.parse(raw) as Json; } catch { return undefined; }
};

/** Old browser-storage key -> pref key and value parser. Both historical naming schemes. Only
 *  these keys are imported and removed; every other key (Flow's `vidar.flow.graphs.v1`,
 *  `vidar.flow.runs.v1`, their backups, ...) is left alone. */
const LEGACY_KEYS: Record<string, { key: PrefKey; parse: (raw: string) => Json | undefined }> = {
  "vidar-theme": { key: "theme", parse: str },
  "vidar-rightbar": { key: "rightbar.width", parse: num },
  "vidar-split": { key: "split.width", parse: num },
  "vidar-font": { key: "sessions.legacyFont", parse: num },
  "vidar-zoom-offset": { key: "sessions.zoomOffset", parse: num },
  "vidar.document.last": { key: "document.last", parse: str },
  "vidar.document.groups": { key: "document.groups", parse: json },
  "vidar.order.loadout": { key: "order.loadout", parse: json },
  "vidar.order.rack": { key: "order.rack", parse: json },
  "vidar.character.animationDropdown": { key: "character.animationDropdown", parse: str },
};

/** Module ids renamed in place, old -> new (the Benchmark tab became Lab). A saved
 *  list naming an old id reads as the new one, so a hidden tab stays hidden and keeps its order slot;
 *  modules/names.ts applies the same map to vidar.json `moduleNames`. */
export const RENAMED_MODULE_IDS: Readonly<Record<string, string>> = { benchmark: "lab" };
/** The saved lists that hold module ids: bare (`order.workbenchTabs`) or prefixed (`bench:<id>`). */
const MODULE_ID_LISTS: readonly PrefKey[] = ["modules.hidden", "order.workbenchTabs"];

/** `list` with every renamed id (bare, or after one `<prefix>:`) replaced in place, or null when
 *  nothing in it was renamed. A list already holding the new id keeps its first occurrence. */
export function renameModuleIds(list: readonly string[]): string[] | null {
  const mapped = list.map((entry) => {
    const colon = entry.indexOf(":");
    const prefix = colon < 0 ? "" : entry.slice(0, colon + 1);
    const id = entry.slice(prefix.length);
    return Object.hasOwn(RENAMED_MODULE_IDS, id) ? prefix + RENAMED_MODULE_IDS[id] : entry;
  });
  if (mapped.every((v, i) => v === list[i])) return null;
  return mapped.filter((v, i) => mapped.indexOf(v) === i);
}

/** Same bound as state.rs `MAX_STATE_FILE_BYTES`: a compact serialization longer than this is
 *  refused, exactly this long is accepted. */
export const MAX_STATE_BYTES = 1024 * 1024;
const DEBOUNCE_MS = 300;

export interface PrefsBackend {
  read(): Promise<unknown>;
  /** Whole values per top-level key; null deletes the key. */
  patch(entries: Record<string, Json>): Promise<unknown>;
}

/** A confirmed write result. An accepted edit stays pending until this result settles. */
export type PrefSaveOutcome =
  | { status: "saved"; accepted: true }
  | { status: "failed"; accepted: boolean }
  | { status: "session-only"; accepted: true };

export interface PrefsOptions {
  debounceMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?: (msg: string) => void;
}

const encoder = new TextEncoder();

function isRecord(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Collects what the import would take: entries for keys the file does not already hold (the
 *  file wins), and every recognised source key, imported or not, for removal afterwards. */
export function collectLegacy(
  legacy: LegacySource,
  existing: Record<string, Json>,
): { entries: Record<string, Json>; sourceKeys: string[] } {
  const entries: Record<string, Json> = {};
  const sourceKeys: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < legacy.length; i++) {
    const k = legacy.key(i);
    if (k !== null) names.push(k);
  }
  for (const name of names) {
    const raw = legacy.getItem(name);
    if (raw === null) continue;
    if (!Object.hasOwn(LEGACY_KEYS, name)) continue; // not ours: left in place
    const typed = LEGACY_KEYS[name];
    const target = typed.key;
    let value = typed.parse(raw);
    if (value !== undefined && !GUARDS[typed.key](value)) value = undefined;
    sourceKeys.push(name);
    if (value !== undefined && !(target in existing) && !(target in entries)) entries[target] = value;
  }
  return { entries, sourceKeys };
}

export class PrefsStore {
  private cache: Record<string, Json> = {};
  private dirty = new Set<string>();
  private timer: unknown = null;
  private ready = false;
  /** False when the file could not be read: state.rs would refuse every patch, so the cache
   *  runs session-only instead of failing on each flush. */
  private writable = true;
  private warnedEarly = false;
  /** Keys whose last write failed and was already logged: the log is once per key. */
  private failedKeys = new Set<string>();
  private errorCb: ((keys: string[], err: unknown) => void) | null = null;
  /** Set when init could not read the file; replayed to a later `onError` subscriber. */
  private initFailure: { err: unknown } | null = null;
  /** Tail of the backend-patch queue: each flush's patch starts only after the previous one
   *  settled, so writes reach state.rs in submission order. Never rejects. */
  private inFlight: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly timers: NonNullable<PrefsOptions["timers"]>;
  private readonly log: (msg: string) => void;
  private readonly backend: PrefsBackend;

  // No parameter properties: node --test strips types, it does not transform them.
  constructor(backend: PrefsBackend, opts: PrefsOptions = {}) {
    this.backend = backend;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.timers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as number) };
    this.log = opts.log ?? ((msg) => console.error(msg));
  }

  /** Registers the one subscriber for persistence failures. A refused `patch_state` flush calls
   *  it with that flush's keys (the log line itself is once per key); an unreadable or
   *  non-object state file calls it once with no keys, replayed on registration if init already
   *  failed. Nothing is retried. */
  onError(cb: ((keys: string[], err: unknown) => void) | null): void {
    this.errorCb = cb;
    if (cb && this.initFailure) {
      try { cb([], this.initFailure.err); } catch { /* a subscriber's throw stays out */ }
    }
  }

  /** Reads the file once, then imports and removes the old browser-storage keys. The imported
   *  values join the cache only after the import patch lands, and the removal waits for it too,
   *  so a failed or oversize import loses nothing, leaves the old copies for a later boot, and
   *  never counts against the size cap of later writes. */
  async init(legacy?: LegacySource): Promise<void> {
    try {
      const root = await this.backend.read();
      if (isRecord(root)) {
        this.cache = { ...root };
        this.renameModuleIdsInCache();
      } else {
        // state.rs refuses every patch against a non-object root, same as an unreadable file.
        this.writable = false;
        this.log("prefs: vidar-state.json root is not an object, UI state is session-only");
        this.reportInitFailure(new Error("vidar-state.json root is not an object"));
      }
    } catch (e) {
      this.writable = false;
      this.log(`prefs: vidar-state.json unreadable, UI state is session-only: ${e}`);
      this.reportInitFailure(e);
    }
    this.ready = true;
    if (!legacy) return;
    // Old browser storage can throw on any access (length/key/getItem/removeItem, e.g. storage
    // disabled or corrupt): that must never abort boot. A failed enumeration skips the import
    // and keeps every old copy for a later boot; the hydrated file cache stands.
    let collected: ReturnType<typeof collectLegacy>;
    try {
      collected = collectLegacy(legacy, this.cache);
    } catch (e) {
      this.log(`prefs: old UI state could not be read, import skipped, kept the old copies: ${e}`);
      return;
    }
    const { entries, sourceKeys } = collected;
    if (sourceKeys.length === 0) return;
    if (!this.fitsAll(entries)) {
      this.log(`prefs: import of old UI state skipped, vidar-state.json would exceed ${MAX_STATE_BYTES} bytes; kept the old copies`);
      return;
    }
    if (!this.writable) {
      // Session-only: serve the old values, keep the old copies (nothing durable took them).
      this.mergeImported(entries);
      return;
    }
    try {
      if (Object.keys(entries).length) {
        // Through the same `inFlight` chain as flush(), so submission order holds for the
        // import too; the chain itself swallows the outcome, this await sees it.
        const sent = this.inFlight.then(() => this.backend.patch(entries));
        this.inFlight = sent.then(() => {}, () => {});
        await sent;
      }
    } catch (e) {
      this.log(`prefs: import of old UI state failed, kept the old copies: ${e}`);
      return;
    }
    this.mergeImported(entries);
    // The file holds the values now; a removal that throws only leaves an old copy behind,
    // which the next boot re-collects and drops (the file wins).
    for (const k of sourceKeys) {
      try {
        legacy.removeItem(k);
      } catch (e) {
        this.log(`prefs: old UI state key "${k}" could not be removed: ${e}`);
      }
    }
  }

  /** Renamed module ids read as their new id from load on; the rewritten list is marked dirty, so
   *  it lands on disk with the next flush (no write of its own at boot). */
  private renameModuleIdsInCache(): void {
    for (const key of MODULE_ID_LISTS) {
      const v = this.cache[key];
      if (!isStrArray(v)) continue;
      const next = renameModuleIds(v as string[]);
      if (!next) continue;
      this.cache[key] = next;
      this.dirty.add(key);
    }
  }

  /** The file could not be read: every pref this session is session-only. Kept so a subscriber
   *  registered after init still hears it (`onError` replays it with no keys). */
  private reportInitFailure(err: unknown): void {
    this.initFailure = { err };
    try { this.errorCb?.([], err); } catch { /* a subscriber's throw stays out of init */ }
  }

  /** A key set while the import patch was in flight wins over the imported value. */
  private mergeImported(entries: Record<string, Json>): void {
    for (const [k, v] of Object.entries(entries)) if (!(k in this.cache)) this.cache[k] = v;
  }

  private fitsAll(entries: Record<string, Json>): boolean {
    return encoder.encode(JSON.stringify({ ...this.cache, ...entries })).length <= MAX_STATE_BYTES;
  }

  private raw(key: string): Json | undefined {
    if (!this.ready && !this.warnedEarly) {
      this.warnedEarly = true;
      this.log(`prefs: "${key}" read before initPrefs() finished`);
    }
    return this.cache[key];
  }

  get<K extends PrefKey>(key: K): PrefKeys[K] | undefined {
    const v = this.raw(key);
    return v !== undefined && GUARDS[key](v) ? (v as PrefKeys[K]) : undefined;
  }

  /** `undefined` deletes the key. False (and logged) when the file would reach the size cap. */
  set<K extends PrefKey>(key: K, value: PrefKeys[K] | undefined): boolean {
    return this.put(key, value as Json | undefined);
  }

  /** Accept into the cache now, then report this exact serialized patch's result. Unlike set(),
   *  callers must await the outcome before displaying Saved. The existing error subscriber is
   *  still notified independently on a refused patch. */
  saveConfirmed<K extends PrefKey>(key: K, value: PrefKeys[K] | undefined): Promise<PrefSaveOutcome> {
    if (!this.ready) return Promise.resolve({ status: "failed", accepted: false });
    if (!this.put(key, value as Json | undefined, true)) {
      return Promise.resolve({ status: "failed", accepted: false });
    }
    if (!this.writable) return Promise.resolve({ status: "session-only", accepted: true });
    return this.flushOutcome().then((status) => ({ status, accepted: true }));
  }

  private fits(key: string, value: Json): boolean {
    return this.fitsAll({ [key]: value });
  }

  private put(key: string, value: Json | undefined, force = false): boolean {
    if (value === undefined || value === null) {
      if (!(key in this.cache) && !force) return true;
      delete this.cache[key];
    } else {
      if (!this.fits(key, value)) {
        this.log(`prefs: "${key}" not saved, vidar-state.json would reach ${MAX_STATE_BYTES} bytes`);
        return false;
      }
      this.cache[key] = value;
    }
    if (!this.writable) return true;
    this.dirty.add(key);
    if (this.timer === null) this.timer = this.timers.set(() => { void this.flush(); }, this.debounceMs);
    return true;
  }

  /** Writes every pending key now (whole values, null for deleted). One attempt: a refused
   *  patch is logged (once per key until that key writes again) and reported to `onError`,
   *  then dropped, never retried in a loop. Patches are serialized through `inFlight`: this
   *  flush's patch is sent only after every earlier one settled (state.rs's lock orders merges,
   *  not submissions), and the returned promise settles once all of them have — with nothing
   *  pending it still waits for already-issued work. */
  flush(): Promise<void> {
    return this.flushOutcome().then(() => {});
  }

  private flushOutcome(): Promise<"saved" | "failed"> {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    if (this.dirty.size === 0) return this.inFlight.then(() => "saved");
    const entries: Record<string, Json> = {};
    for (const k of this.dirty) entries[k] = k in this.cache ? this.cache[k] : null;
    this.dirty.clear();
    const keys = Object.keys(entries);
    const outcome: Promise<"saved" | "failed"> = this.inFlight.then(() => this.backend.patch(entries)).then(
      () => { for (const k of keys) this.failedKeys.delete(k); return "saved"; },
      (e) => {
        const fresh = keys.filter((k) => !this.failedKeys.has(k));
        for (const k of fresh) this.failedKeys.add(k);
        // A throwing logger must not reject the chain and poison every later flush.
        try {
          if (fresh.length) this.log(`prefs: write of ${fresh.join(", ")} failed: ${e}`);
        } catch { /* logger failure stays out of the chain */ }
        try { this.errorCb?.(keys, e); } catch { /* a subscriber's throw stays out of the flush */ }
        return "failed";
      },
    );
    this.inFlight = outcome.then(() => {});
    return outcome;
  }
}
