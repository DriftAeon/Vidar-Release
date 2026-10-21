/** A small insertion-ordered cache: setting a key makes it the newest; past `max` entries the oldest is dropped. */
export function boundedCache<V>(max: number) {
  const map = new Map<string, V>();
  return {
    get: (key: string): V | undefined => map.get(key),
    set(key: string, value: V) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
    get size() { return map.size; },
  };
}
