// Pure validation for a stored camera view — no three import, so this is testable
// without a WebGL context (tests/*.test.mjs).

export interface View {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** `raw` is whatever `vidar.json`'s `characterViews[id]` holds — untrusted JSON. */
export function validateView(raw: unknown): View | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!isVec3(v.position) || !isVec3(v.target)) return null;
  if (typeof v.zoom !== "number" || !Number.isFinite(v.zoom) || v.zoom <= 0) return null;
  return { position: v.position, target: v.target, zoom: v.zoom };
}
