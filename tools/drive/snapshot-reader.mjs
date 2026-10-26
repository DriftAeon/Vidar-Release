// This file is also evaluated verbatim in the page after stripping `export`.
// Keep it dependency-free: the exported helpers take only numbers and colours.
export function zeroSize(rect) { return rect.w < 1 || rect.h < 1; }
export function offViewport(rect, viewport) {
  return rect.w <= 0 || rect.h <= 0 || rect.x + rect.w <= 0 || rect.y + rect.h <= 0 || rect.x >= viewport.w || rect.y >= viewport.h;
}
export function clippedText(scrollWidth, clientWidth, overflow) {
  return scrollWidth > clientWidth + 1 && overflow !== "visible";
}
export function occluded(hitIsSelfOrDescendant) { return !hitIsSelfOrDescendant; }
export function overlap(a, b) {
  const area = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return Math.min(a.w * a.h, b.w * b.h) > 0 && area > 0.2 * Math.min(a.w * a.h, b.w * b.h);
}
export function colour(color) {
  if (!color) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(color.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])] : null;
}
export function fgEqualsBg(fg, bg) {
  const a = colour(fg), b = colour(bg);
  return !!a && !!b && a[3] === 1 && b[3] === 1 && a.slice(0, 3).every((v, i) => v === b[i]);
}
export function lowContrast(fg, bg) {
  const a = colour(fg), b = colour(bg);
  if (!a || !b || a[3] !== 1 || b[3] !== 1) return false;
  const lum = (c) => c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) < 3;
}
export function brokenImage(complete, naturalWidth) { return complete && naturalWidth === 0; }

const ELEMENTS = 'button,a[href],input,select,textarea,summary,[role="button"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="checkbox"],[role="switch"],[role="option"],[role="link"],[role="combobox"],[role="slider"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
const LANDMARKS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tablist"],[role="toolbar"],dialog';

export function pageSnapshot(port, delta = true) {
  const doc = document;
  const win = globalThis;
  const previousState = win.__vidarExplorer;
  const origin = performance.timeOrigin;
  const fresh = !previousState || previousState.timeOrigin !== origin;
  const state = fresh
    ? { next: 1, refOf: new WeakMap(), byRef: new Map(), baseline: null, timeOrigin: origin }
    : previousState;
  win.__vidarExplorer = state;
  const viewport = { w: win.innerWidth, h: win.innerHeight };
  const candidates = [...doc.querySelectorAll(`${ELEMENTS},${LANDMARKS}`)];
  const interactive = new Set(doc.querySelectorAll(ELEMENTS));
  const visible = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (p.hasAttribute("inert") || p.getAttribute("aria-hidden") === "true") return false;
      const css = win.getComputedStyle(p);
      if (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse") return false;
    }
    return true;
  };
  const scrollReachable = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const css = win.getComputedStyle(p);
      if (/auto|scroll|overlay/.test(css.overflowY) && p.scrollHeight > p.clientHeight) return true;
      if (/auto|scroll|overlay/.test(css.overflowX) && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  // Centre outside an ancestor's client box: "reach" when every such ancestor can scroll it in, "clip" when one cannot.
  const foldState = (el, cx, cy) => {
    const canScroll = (v, scrollSize, clientSize) => /auto|scroll|overlay/.test(v) && scrollSize > clientSize;
    let state = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const css = win.getComputedStyle(p);
      if (!/auto|scroll|overlay|hidden|clip/.test(`${css.overflowX} ${css.overflowY}`)) continue;
      const b = p.getBoundingClientRect();
      const w = p.clientWidth > 0 ? p.clientWidth : b.width;
      const h = p.clientHeight > 0 ? p.clientHeight : b.height;
      const outY = cy < b.y || cy > b.y + h;
      const outX = cx < b.x || cx > b.x + w;
      if (!outX && !outY) continue;
      const ok = (!outY || canScroll(css.overflowY, p.scrollHeight, p.clientHeight))
        && (!outX || canScroll(css.overflowX, p.scrollWidth, p.clientWidth));
      if (!ok) return "clip";
      state = "reach";
    }
    return state;
  };
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const inputRole = { button: "button", submit: "button", reset: "button", checkbox: "checkbox", radio: "radio", range: "slider" }[el.type] ?? "textbox";
    return el.getAttribute("role") || ({ a: "link", button: "button", input: inputRole, select: el.multiple ? "listbox" : "combobox", textarea: "textbox", summary: "button", dialog: "dialog" }[tag] ?? tag);
  };
  const nameOf = (el) => {
    const label = el.getAttribute("aria-label");
    const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => doc.getElementById(id)?.textContent ?? "").join(" ");
    return (label || labelled || (el.innerText ?? el.textContent) || el.value || el.getAttribute("title") || el.textContent || "")
      .replace(/\s+/g, " ").trim().slice(0, 60);
  };
  const scrollParent = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const css = win.getComputedStyle(p);
      if (/auto|scroll|overlay/.test(`${css.overflowY} ${css.overflowX}`)) return p;
    }
    return null;
  };
  // elementFromPoint skips pointer-events:none, so a fade with it never shows up as the hit: no such relation.
  const coverOf = (el, hit) => {
    const r = hit.getBoundingClientRect();
    const positioned = /sticky|fixed|absolute/.test(win.getComputedStyle(hit).position);
    const container = scrollParent(el);
    const sameScroll = scrollParent(hit) === container && (!container || container.contains(hit));
    return {
      tag: hit.tagName.toLowerCase(), role: roleOf(hit), name: nameOf(hit),
      cls: String(hit.getAttribute("class") ?? "").trim().slice(0, 60),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      relation: positioned && sameScroll ? "ancestor-sibling" : "other",
    };
  };
  const nodes = [];
  const counts = new Map();
  for (const el of candidates) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el);
    const name = nameOf(el);
    const key = `${role}\u0000${name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    let ref = state.refOf.get(el);
    if (!ref) { ref = `e${state.next++}`; state.refOf.set(el, ref); state.byRef.set(ref, new WeakRef(el)); }
    const r = el.getBoundingClientRect();
    const bbox = { x: r.x, y: r.y, w: r.width, h: r.height };
    const css = win.getComputedStyle(el);
    let bg = null;
    for (let p = el; p; p = p.parentElement) {
      const c = win.getComputedStyle(p).backgroundColor;
      if (colour(c)?.[3] === 1) { bg = c; break; }
    }
    const flags = [];
    let cover = null;
    if (zeroSize(bbox)) flags.push("zero-size");
    const off = offViewport(bbox, viewport);
    // A sized element below a scroll container's fold is reachable by scrolling, not a defect.
    if (off && !(!zeroSize(bbox) && scrollReachable(el))) flags.push("off-viewport");
    if (clippedText(el.scrollWidth, el.clientWidth, css.overflowX || css.overflow)) flags.push("clipped-text");
    if (!zeroSize(bbox) && !offViewport(bbox, viewport)) {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      // Below a scroll fold the hit falls through to whatever sits behind the container: reachable, not covered.
      const hit = foldState(el, cx, cy) === "reach" ? null : doc.elementFromPoint?.(cx, cy);
      if (hit &&occluded(hit === el || el.contains(hit))) { flags.push("occluded"); cover = coverOf(el, hit); }
    }
    if (interactive.has(el) && [...el.parentElement?.children ?? []].some((sib) => sib !== el && interactive.has(sib)
      && visible(sib) && overlap(bbox, (() => { const s = sib.getBoundingClientRect(); return { x: s.x, y: s.y, w: s.width, h: s.height }; })()))) flags.push("overlap");
    if (bg && lowContrast(css.color, bg)) flags.push("low-contrast");
    if (bg && fgEqualsBg(css.color, bg)) flags.push("fg-equals-bg");
    if ((tag === "img" && brokenImage(el.complete, el.naturalWidth))
      || [...el.querySelectorAll("img")].some((img) => brokenImage(img.complete, img.naturalWidth))) flags.push("broken-image");
    const tip = (el.getAttribute("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const node = {
      ref, role, name,
      ...(tip && tip !== name ? { tip } : {}),
      state: { enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
        focused: doc.activeElement === el,
        ...(el.hasAttribute("aria-checked") ? { checked: el.getAttribute("aria-checked") === "true" } : {}),
        ...(el.hasAttribute("aria-expanded") ? { expanded: el.getAttribute("aria-expanded") === "true" } : {}),
        ...(el.hasAttribute("aria-selected") ? { selected: el.getAttribute("aria-selected") === "true" } : {}) },
      locator: { role, name, nth }, flags, bbox,
      ...(cover ? { cover } : {}),
    };
    nodes.push(node);
  }
  const now = new Map(nodes.map((node) => [node.ref, JSON.stringify(node)]));
  const before = state.baseline;
  const removed = before ? [...before.keys()].filter((ref) => !now.has(ref)) : [];
  const changed = nodes.filter((node) => before?.get(node.ref) !== now.get(node.ref));
  const fraction = before ? (changed.length + removed.length) / Math.max(1, before.size, now.size) : 1;
  const full = fresh || !before || !delta || fraction > 0.4;
  const reason = full ? fresh ? (previousState ? "reload" : "start") : !delta ? "asked" : !before ? "start" : "large" : undefined;
  state.baseline = now;
  return { v: 1, port, timeOrigin: origin, full, ...(reason ? { reason } : {}), nodes: full ? nodes : changed,
    ...(!full ? { removed } : {}) };
}
