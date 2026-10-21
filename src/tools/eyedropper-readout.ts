// Pixel values drive picking; computed CSS remains supplementary shell information.
export type RGB = [number, number, number];
export type CssReadout = { bg: RGB | null; fg: RGB | null };

export function hex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function parseColor(s: string): RGB | null {
  const h = s.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (h) {
    const digits = h[1].length === 3 ? [...h[1]].map((v) => v + v).join("") : h[1];
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as RGB;
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i);
  if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null;
  return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
}

export function isCssSurface(el: Element | null): boolean {
  return !!el && !el.closest("iframe, canvas, img, video, svg, .xterm, .display-render");
}

export function chooseReadout(pixel: RGB | null, css: CssReadout | null) {
  return { picked: pixel, pixel, bg: css?.bg ?? null, fg: css?.fg ?? null };
}

export function cssReadout(el: Element | null): CssReadout | null {
  if (!isCssSurface(el)) return null;
  let bg: RGB | null = null;
  for (let cur = el; cur && !bg; cur = cur.parentElement) {
    bg = parseColor(getComputedStyle(cur).backgroundColor);
  }
  return { bg, fg: parseColor(getComputedStyle(el!).color) };
}

const BARE_COLOUR = /^(#[\da-f]{3}|#[\da-f]{6}|rgba?\([^()]*\))$/i;

// Built once per arm: hex value → first custom property whose whole value is a bare hex or
// rgb()/rgba() colour (a var(), color-mix() or shorthand is skipped). Paint only looks values up.
export function tokenMap(style: CSSStyleDeclaration): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (!name.startsWith("--")) continue;
    const raw = style.getPropertyValue(name).trim();
    if (!BARE_COLOUR.test(raw)) continue;
    const value = parseColor(raw);
    if (value && !map.has(hex(value))) map.set(hex(value), name);
  }
  return map;
}

// A value match is a useful token hint, not proof that the declaration used that token.
export function matchingToken(rgb: RGB, tokens: ReadonlyMap<string, string>): string | null {
  return tokens.get(hex(rgb)) ?? null;
}
