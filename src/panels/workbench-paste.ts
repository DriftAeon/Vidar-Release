// Pure scope check for the workbench-wide paste listener (workbench.ts's
// onPaste, attached to the workbench root). Kept separate from workbench.ts
// — which pulls in ipc/DOM/sessions/document/display/flow — so this is
// testable via `node --test` with no relative imports to resolve, the same
// leaf-module pattern as workbench-restore.ts.
//
// Duck-typed rather than `instanceof Element`, so a plain object with a
// `closest` method exercises the same logic in a test with no DOM present.

/** The minimal shape this needs from an event target. */
interface ClosestTarget {
  closest(selector: string): unknown;
}

function hasClosest(target: unknown): target is ClosestTarget {
  return !!target && typeof (target as ClosestTarget).closest === "function";
}

/** True when the Tray should handle a paste event; false when it should let
 *  an editable field (Document's editor, Display's comment box, Flow's
 *  inspector fields) keep it. The listener sits on the workbench root, so
 *  every descendant's paste bubbles through here first — a non-editable
 *  target (or one with no `closest`, e.g. a non-Element EventTarget) is the
 *  Tray's to take. */
export function trayTakesPaste(target: EventTarget | null): boolean {
  if (!hasClosest(target)) return true;
  return !target.closest("input, textarea, [contenteditable]");
}
