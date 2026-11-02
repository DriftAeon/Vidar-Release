// Guards for untyped JSON (SDK records, wire payloads, stored envelopes). A leaf: node --test loads it directly.

export type Json = Record<string, unknown>;

/** The value as a plain object (arrays excluded), else null. */
export function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

/** The value if it is a string, else `fallback`. */
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** A non-null object, arrays included. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** UTF-8 size of the value's JSON text. */
export function jsonBytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}
