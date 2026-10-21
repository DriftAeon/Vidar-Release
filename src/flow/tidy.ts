// Tidy: the toolbar button that lays the active graph out top-to-bottom (layout.ts's pure
// autoLayout, fed real card sizes measured from the DOM at press time), animates the cards there
// over ~200ms and saves through the normal graph-save path. Manual only: nothing else calls it.

import { iconImg } from "../icon-img";
import { S, NODE_W } from "./state";
import { scheduleFrame } from "./viewport";
import { scheduleGraphSave } from "./store";
import { autoLayout } from "./layout";

const DURATION_MS = 200;
let anim = 0;

function place(id: string, x: number, y: number) {
  const n = S.nodes.find((nn) => nn.id === id);
  const el = S.nodeEls.get(id);
  if (!n || !el) return;
  n.x = x;
  n.y = y;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

/** Lays the graph out and animates to it. The spine stays where the graph already is: its
 *  centre is the current bounding box's centre (snapped so card lefts land on the grid) and row
 *  0 starts at the current top. */
function tidyGraph(): void {
  if (!S.nodes.length || S.dragging) return;
  cancelAnimationFrame(anim);
  const sizes = S.nodes.map((n) => {
    const el = S.nodeEls.get(n.id);
    return { id: n.id, w: el?.offsetWidth || NODE_W, h: el?.offsetHeight || 0 };
  });
  const grid = S.GRID;
  const minX = Math.min(...S.nodes.map((n) => n.x));
  const maxR = Math.max(...S.nodes.map((n, i) => n.x + sizes[i].w));
  const minY = Math.min(...S.nodes.map((n) => n.y));
  const axisX = Math.round(((minX + maxR) / 2 - NODE_W / 2) / grid) * grid + NODE_W / 2;
  const top = Math.round(minY / grid) * grid;
  const target = autoLayout(sizes, S.edges.map((e) => ({ from: e.from.node, to: e.to.node })), { axisX, top, grid });

  const from = new Map(S.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const els = new Map(S.nodeEls);
  const t0 = performance.now();
  const step = (now: number) => {
    // A graph load/switch/reset or a node drag mid-animation wins: stop without touching
    // the (possibly same-id) nodes now on the canvas.
    if (S.dragging || [...els].some(([id, el]) => S.nodeEls.get(id) !== el)) return;
    const t = Math.min(1, (now - t0) / DURATION_MS);
    const k = 1 - Math.pow(1 - t, 3); // ease-out cubic
    for (const [id, a] of from) {
      const b = target[id];
      if (!b) continue;
      if (t < 1) place(id, Math.round(a.x + (b.x - a.x) * k), Math.round(a.y + (b.y - a.y) * k));
      else place(id, b.x, b.y);
    }
    scheduleFrame();
    if (t < 1) anim = requestAnimationFrame(step);
    else scheduleGraphSave();
  };
  anim = requestAnimationFrame(step);
}

/** Toolbar button; shares `.flow-run-cancel`'s look via its sibling selector list (styles.css). */
export function buildTidyButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "flow-tidy-btn icon-btn";
  btn.setAttribute("aria-label", "Tidy");
  btn.appendChild(iconImg("menu"));
  btn.title = "Tidy: arrange the cards top to bottom along their connections.";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    tidyGraph();
  });
  return btn;
}
