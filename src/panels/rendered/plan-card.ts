// Plan checklist card of a Rendered body (Codex turn/plan/updated; 2026-10-11): a framed
// card with the plan icon, "Plan" and a progress ring whose tooltip is "<done> of <total>", the
// explanation indented under the title, then one 24px row per step with its status icon (green check
// dot, spinning accent arc, empty ring). Colours come from rendered-plan.css classes, never attributes.

import type { PlanStatus, PlanView } from "../../agents/protocol";
import { el } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";
/** circumference of the r=6 progress ring */
const RING = 2 * Math.PI * 6;
const STATUS_LABEL: Record<PlanStatus, string> = { completed: "Completed", inProgress: "In Progress", pending: "Pending" };
const STATUS_CLASS: Record<PlanStatus, string> = { completed: "done", inProgress: "run", pending: "todo" };

type Attrs = Record<string, string | number>;

function svg(cls: string, viewBox: string, label: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("class", cls);
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("role", "img");
  const t = document.createElementNS(SVG_NS, "title");
  t.textContent = label;
  s.append(t);
  return s;
}

function shape(tag: string, attrs: Attrs, cls?: string): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute("class", cls);
  return e;
}

/** lucide list-checks */
function planIcon(): SVGSVGElement {
  const s = svg("icn plan-icon", "0 0 24 24", "Plan");
  for (const d of ["m3 17 2 2 4-4", "m3 7 2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8"]) s.append(shape("path", { d }));
  return s;
}

function statusIcon(status: PlanStatus): SVGSVGElement {
  const s = svg(`icn plan-status ${STATUS_CLASS[status]}`, "0 0 16 16", STATUS_LABEL[status]);
  if (status === "completed") {
    s.append(shape("circle", { cx: 8, cy: 8, r: 7 }, "plan-dot"), shape("path", { d: "M4.8 8.2 7 10.3l4.2-4.6" }, "plan-tick"));
  } else if (status === "inProgress") {
    s.append(shape("circle", { cx: 8, cy: 8, r: 6 }, "plan-track"), shape("path", { d: "M8 2a6 6 0 0 1 6 6" }, "plan-arc"));
  } else {
    s.append(shape("circle", { cx: 8, cy: 8, r: 6 }, "plan-ring-empty"));
  }
  return s;
}

function progressRing(done: number, total: number): SVGSVGElement {
  const s = svg("plan-progress", "0 0 16 16", `${done} of ${total}`);
  const filled = total > 0 ? (done / total) * RING : 0;
  s.append(
    shape("circle", { cx: 8, cy: 8, r: 6 }, "plan-progress-track"),
    shape("circle", { cx: 8, cy: 8, r: 6, "stroke-dasharray": `${filled.toFixed(2)} ${RING.toFixed(2)}`, transform: "rotate(-90 8 8)" }, "plan-progress-fill"),
  );
  return s;
}

export function planCard(plan: PlanView): HTMLElement {
  const card = el("div", "plan-card");
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const head = el("div", "plan-head");
  head.append(planIcon(), el("span", "plan-title", "Plan"), progressRing(done, plan.steps.length));
  card.append(head);
  if (plan.explanation) card.append(el("div", "plan-exp", plan.explanation));
  const steps = el("div", "plan-steps");
  for (const s of plan.steps) {
    const row = el("div", `plan-step ${STATUS_CLASS[s.status]}`);
    row.append(statusIcon(s.status), el("span", "plan-step-text", s.text));
    steps.append(row);
  }
  card.append(steps);
  return card;
}
