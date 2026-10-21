// User module names: vidar.json `moduleNames` ({ "<module id>": "<name>" }), the one TS owner.
// Read: setModuleNames() cleans the raw value (a bad entry is dropped with one console.warn, `relay`
// is ignored because Relay keeps its name, unknown ids are kept so a later release that lists the
// module picks the name up); moduleName() resolves a label. The store follows `settings-changed`
// (key moduleNames) and `reload_config` itself; main.ts only seeds it from the first config read.
// Write: renameModule() validates with the same rules as Rust (tests/fixtures/module-names.json),
// chains saves through one promise, and per save re-reads vidar.json and merges its single edit into
// the on-disk map, so a hand edit and a second quick rename both survive. While a save is pending
// the store ignores moduleNames echoes; `confirmed` is the last map known to be on disk, and a
// failed save resets the live cache to it (plus any saves still queued).

import contract from "../../contracts/modules.json" with { type: "json" };
import { invalidateConfig, loadConfig, onConfigReloaded, onSettingsChanged } from "../config";
import { invoke } from "../ipc";
import { RENAMED_MODULE_IDS } from "../prefs-core";

const KEY = "moduleNames";
/** Relay keeps its built-in name (Rust refuses the key too). */
const FIXED_ID = "relay";
/** Longest name in code points (contracts/modules.json limits.nameChars). */
export const NAME_CHARS: number = contract.limits.nameChars;
const ID_PATTERN = new RegExp(contract.idPattern);
const BAD_CHAR = /[\p{Cc}\p{Cf}]/u;
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

export type RenameOutcome = "saved" | "refused" | "failed";

/** A key the store may hold: the contract id grammar, never `relay`. */
export function moduleIdOk(id: string): boolean {
  return id !== FIXED_ID && ID_PATTERN.test(id);
}

/** Trims Unicode White_Space at both ends (what a typed name is saved as). */
export function trimModuleName(s: string): string {
  return s.replace(EDGE_SPACE, "");
}

/** The stored-name rule set: a string, no surrounding White_Space, 1..=NAME_CHARS code points,
 *  no Cc or Cf character. */
export function moduleNameOk(s: unknown): s is string {
  if (typeof s !== "string" || trimModuleName(s) !== s) return false;
  const n = [...s].length;
  return n >= 1 && n <= NAME_CHARS && !BAD_CHAR.test(s);
}

type Names = Map<string, string>;

function clean(raw: unknown, warn: boolean): Names {
  const out: Names = new Map();
  if (raw === undefined || raw === null) return out;
  const bad: string[] = [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    bad.push("(not an object)");
  } else {
    for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
      if (id === FIXED_ID) continue;
      if (moduleIdOk(id) && moduleNameOk(name)) out.set(id, name);
      else bad.push(id);
    }
  }
  if (warn && bad.length) console.warn(`vidar.json moduleNames: ignored ${bad.join(", ")}`);
  // A renamed module keeps its user name under the new id (the new id's own entry wins). The old
  // key leaves the file with the next save, which writes this cleaned map back.
  for (const [old, now] of Object.entries(RENAMED_MODULE_IDS)) {
    const name = out.get(old);
    if (name === undefined) continue;
    out.delete(old);
    if (!out.has(now)) out.set(now, name);
  }
  return out;
}

const same = (a: Names, b: Names): boolean =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** null = remove the entry (back to the built-in name). */
type Edit = { id: string; name: string | null };

let confirmed: Names = new Map();
let live: Names = new Map();
const queued: Edit[] = [];
/** Bumped by every save start; a re-read started under an older value is dropped. */
let generation = 0;
let chain: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function overlay(base: Names, edits: readonly Edit[]): Names {
  const out = new Map(base);
  for (const e of edits) {
    if (e.name === null) out.delete(e.id);
    else out.set(e.id, e.name);
  }
  return out;
}

function setLive(next: Names): void {
  if (same(next, live)) return;
  live = next;
  for (const cb of listeners) cb();
}

function adopt(raw: unknown): void {
  confirmed = clean(raw, true);
  setLive(overlay(confirmed, queued));
}

let following = false;
function follow(): void {
  if (following) return;
  following = true;
  // An echo of our own pending write (or a read that a save overtook) would replace the
  // optimistic cache with the pre-save file; the save adopts what it wrote instead.
  const reread = (raw?: () => Promise<unknown>) => {
    if (queued.length) return;
    const gen = generation;
    void (raw ?? (() => loadConfig().then(({ config }) => config.moduleNames)))().then((value) => {
      if (gen === generation && !queued.length) adopt(value);
    });
  };
  onSettingsChanged(({ keys }) => { if (keys.includes(KEY)) reread(); });
  onConfigReloaded((res) => reread(() => Promise.resolve(res.config.moduleNames)));
}

/** Seeds the store from a config read (main.ts) and starts following later changes. */
export function setModuleNames(raw: unknown): void {
  follow();
  if (queued.length) return;
  adopt(raw);
}

/** The user's name for module `id`, else `builtin`. Relay always answers `builtin`. */
export function moduleName(id: string, builtin: string): string {
  return (id !== FIXED_ID && live.get(id)) || builtin;
}

/** Runs `cb` after any change to the resolved names. Returns the unsubscribe. */
export function onModuleNamesChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Saves `name` for module `id`. Trimmed first; empty or equal to `builtin` removes the entry.
 *  "refused": the rules turned it down before any write (nothing changed). "failed": the read or
 *  patch_settings failed, and the cache is back on the confirmed map. The cache updates before the
 *  write, so a second rename made while this one is pending keeps both. */
export function renameModule(id: string, name: string, builtin: string): Promise<RenameOutcome> {
  follow();
  const value = trimModuleName(name);
  const remove = value === "" || value === builtin;
  if (!moduleIdOk(id) || (!remove && !moduleNameOk(value))) return Promise.resolve("refused");
  const edit: Edit = { id, name: remove ? null : value };
  generation++;
  queued.push(edit);
  setLive(overlay(confirmed, queued));
  const run = chain.then(() => save(edit));
  chain = run;
  return run;
}

async function save(edit: Edit): Promise<RenameOutcome> {
  let outcome: RenameOutcome = "failed";
  try {
    invalidateConfig();
    const { config, error } = await loadConfig();
    // A file Rust could not parse reads as {}: merging into that would wipe the saved names.
    if (error === null) {
      const next = overlay(clean(config.moduleNames, false), [edit]);
      await invoke("patch_settings", { key: KEY, value: Object.fromEntries(next) });
      confirmed = next;
      outcome = "saved";
    }
  } catch (e) {
    console.warn(`moduleNames save failed: ${e}`);
  }
  queued.splice(queued.indexOf(edit), 1);
  setLive(overlay(confirmed, queued));
  return outcome;
}
