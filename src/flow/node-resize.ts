// Node resize → repaint. One shared ResizeObserver over every node element; a height
// change (field wrap, badge, collapse) schedules a frame so edges re-read offsetTop/
// offsetHeight instead of detaching. Must not touch selection, edges or node data.

import { scheduleFrame } from "./viewport";

let ro: ResizeObserver | null = null;

function observer(): ResizeObserver {
  if (!ro) ro = new ResizeObserver(() => scheduleFrame());
  return ro;
}

export function observeNode(el: HTMLElement) {
  observer().observe(el);
}

export function unobserveNode(el: HTMLElement) {
  ro?.unobserve(el);
}

export function unobserveAllNodes() {
  ro?.disconnect();
  ro = null;
}
