// drag <from|x,y> <to|x,y>: press at <from>'s centre or the x,y point, a stepped move, release at <to>'s centre or the x,y point (sandbox only).
// Targets resolve like `press` (ref or selector; x,y for canvas nodes and ports that have no ref); the same no-press list and hit-test refusals apply to both ends.
// A plain source gets real CDP mouse input. A source that is draggable="true" (or --synth) gets a page-side synthetic
// sequence instead, because CDP mouse events do not start an HTML5 drag: pointerdown, mousedown, stepped pointermove and
// mousemove, then dragstart, drag, dragenter, dragover, drop, dragend, pointerup, mouseup (PointerEvent, pointerId 1).
// The result carries the source element's rect before and after.
import { Refusal, gateRealInput, resolveJs, describeAtJs, matchNoPress, drainExternal } from "../drive-input.mjs";

export const DRAG_STEPS = 6;
const POINT = /^(-?\d+),(-?\d+)$/;

async function resolveEnd(ctx, target) {
  const p = POINT.exec(target);
  const r = await ctx.evalJs(p ? describeAtJs(Number(p[1]), Number(p[2])) : resolveJs(target));
  if (r?.stale) throw new Refusal(`stale ref: ${target} (take a fresh snapshot)`);
  if (!r?.found) throw new Error(`drag: no match for ${target}`);
  for (const d of [r, r.hit.got]) {
    const id = d && matchNoPress(d);
    if (id) throw new Refusal(`refused: ${id} is on the no-press list (${r.role} "${r.name}")`);
  }
  return r;
}

/** Page-side: the source's rect and draggable flag, or null when it is gone. */
const rectJs = (target) => `(() => {
  const t = ${JSON.stringify(target)}; const pt = /^(-?\\d+),(-?\\d+)$/.exec(t);
  const el = pt ? document.elementFromPoint(Number(pt[1]), Number(pt[2])) : /^e\\d+$/.test(t) ? globalThis.__vidarExplorer?.byRef?.get(t)?.deref() ?? null : document.querySelector(t);
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), draggable: !!el.closest('[draggable="true"]') };
})()`;

/** Page-side synthetic drag; returns the event types dispatched, in order. */
export const synthDragJs = (target, a, b, steps) => `(() => {
  const t = ${JSON.stringify(target)}, a = ${JSON.stringify(a)}, b = ${JSON.stringify(b)}, steps = ${Number(steps)};
  const pt = /^(-?\\d+),(-?\\d+)$/.exec(t);
  const src = pt ? document.elementFromPoint(Number(pt[1]), Number(pt[2])) : /^e\\d+$/.test(t) ? globalThis.__vidarExplorer?.byRef?.get(t)?.deref() ?? null : document.querySelector(t);
  if (!src) return { error: "source gone" };
  const log = [];
  const at = (p) => document.elementFromPoint(p.x, p.y) ?? src;
  const base = (p) => ({ bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, view: window });
  const ptr = (type, el, p, down) => { el.dispatchEvent(new PointerEvent(type, { ...base(p), pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: down ? 1 : 0 })); log.push(type); };
  const mouse = (type, el, p, down) => { el.dispatchEvent(new MouseEvent(type, { ...base(p), buttons: down ? 1 : 0 })); log.push(type); };
  let dt = null; try { dt = new DataTransfer(); } catch {}
  const drag = (type, el, p) => { const ev = typeof DragEvent === "function" ? new DragEvent(type, { ...base(p), dataTransfer: dt }) : new MouseEvent(type, base(p)); el.dispatchEvent(ev); log.push(type); };
  const sd = at(a);
  ptr("pointerdown", sd, a, true); mouse("mousedown", sd, a, true);
  for (let i = 1; i <= steps; i++) {
    const p = { x: Math.round(a.x + ((b.x - a.x) * i) / steps), y: Math.round(a.y + ((b.y - a.y) * i) / steps) };
    const el = at(p);
    ptr("pointermove", el, p, true); mouse("mousemove", el, p, true);
  }
  const dst = at(b);
  if (src.closest('[draggable="true"]')) {
    drag("dragstart", src, a); drag("drag", src, b); drag("dragenter", dst, b); drag("dragover", dst, b); drag("drop", dst, b); drag("dragend", src, b);
  }
  ptr("pointerup", dst, b, false); mouse("mouseup", dst, b, false);
  return { events: log };
})()`;

export async function drag(ctx) {
  if (!ctx.a1 || !ctx.a2) throw new Error("usage: drag <from|x,y> <to|x,y>");
  await gateRealInput(ctx);
  const from = await resolveEnd(ctx, ctx.a1);
  const to = await resolveEnd(ctx, ctx.a2);
  const hit = (r) => ({ ok: r.hit.ok, at: r.hit.at, got: r.hit.got ? { role: r.hit.got.role, name: r.hit.got.name } : null });
  const out = { from: hit(from), to: hit(to), dragged: false };
  if (!from.hit.ok || !to.hit.ok) return out; // a covered end would press or drop on whatever sits there
  const before = await ctx.evalJs(rectJs(ctx.a1));
  const a = from.at, b = to.at;
  const synth = ctx.flags?.synth === true || before?.draggable === true;
  if (synth) {
    const r = await ctx.evalJs(synthDragJs(ctx.a1, a, b, DRAG_STEPS));
    if (r?.error) throw new Error(`drag: ${r.error}`);
    out.mode = "synthetic";
    out.events = r.events;
  } else {
    await ctx.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
    await ctx.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / DRAG_STEPS), y = Math.round(a.y + ((b.y - a.y) * i) / DRAG_STEPS);
      await ctx.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    await ctx.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
    out.mode = "cdp";
  }
  out.dragged = true;
  const after = await ctx.evalJs(rectJs(ctx.a1));
  out.source = { before: before && { x: before.x, y: before.y, w: before.w, h: before.h }, after: after && { x: after.x, y: after.y, w: after.w, h: after.h } };
  const external = await drainExternal(ctx);
  return external.length ? { ...out, external } : out;
}
