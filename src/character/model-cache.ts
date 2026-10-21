// Per-session cache of the CPU-side results that cost the most on a character switch: the
// decoded eye-bake PNGs and the dilated atlas pixels. Both depend only on the GLB's bytes, so
// the key is a SHA-256 of those bytes plus the character revision (a Settings › Characters
// change bumps it and drops every older entry). Pure data, no three.js: nothing here owns a GPU
// object, so the renderer's own dispose stays the only teardown.

export interface CachedPixels { width: number; height: number; data: Uint8ClampedArray }
export interface ModelEntry {
  revision: number;
  /** Dilated atlas pixels by glTF texture index. */
  padded: Map<number, CachedPixels>;
  /** Manually decoded PNG pixels by glTF bufferView index. */
  decoded: Map<number, CachedPixels>;
}

export const MODEL_CACHE_LIMIT = 4;

const entries = new Map<string, ModelEntry>(); // insertion order = recency
const owners = new WeakMap<object, string>();

export async function modelDigest(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Associates a parsed model (the glTF parser) with its cache key. A null digest leaves it uncached. */
export function tagModel(owner: object, digest: string | null, revision: number): void {
  if (!digest) return;
  for (const [key, entry] of entries) if (entry.revision !== revision) entries.delete(key);
  owners.set(owner, `${revision}:${digest}`);
  const key = `${revision}:${digest}`;
  const existing = entries.get(key);
  if (existing) { entries.delete(key); entries.set(key, existing); return; }
  entries.set(key, { revision, padded: new Map(), decoded: new Map() });
  while (entries.size > MODEL_CACHE_LIMIT) entries.delete(entries.keys().next().value as string);
}

/** The entry for a tagged model, or undefined when untagged or already evicted. */
export function entryFor(owner: object): ModelEntry | undefined {
  const key = owners.get(owner);
  return key === undefined ? undefined : entries.get(key);
}

export function clearModelCache(): void {
  entries.clear();
}

export function modelCacheSize(): number {
  return entries.size;
}
