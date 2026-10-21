// src\launcher\recent-cache.ts — Resume lists cached for one launcher opening. Hovering back
// onto Resume (or between the Claude and Codex rows) within an opening reuses the last list
// instead of refetching; closeLauncher resets it. Imports nothing from the launcher.
interface Entry<T> {
  hit: T | undefined;
  promise: Promise<T>;
}
const entries = new Map<string, Entry<unknown>>();

/** `hit` is set once the fetch for `key` has settled ok; `promise` is the (shared) fetch. A rejected fetch is forgotten. */
export function cachedList<T>(key: string, fetch: () => Promise<T>): { hit: T | undefined; promise: Promise<T> } {
  const found = entries.get(key) as Entry<T> | undefined;
  if (found) return found;
  const entry: Entry<T> = { hit: undefined, promise: undefined as unknown as Promise<T> };
  entry.promise = fetch().then(
    (v) => {
      entry.hit = v;
      return v;
    },
    (e) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw e;
    },
  );
  entries.set(key, entry);
  return entry;
}

export function resetRecentCache(): void {
  entries.clear();
}
