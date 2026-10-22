// Relay action row: a one-line comment that grows, the state line, then Approve / Deny / Dismiss
// (Dismiss clears the item unruled) and the file actions (Copy Path, Open in Browser, Open Folder),
// inline or in deps.actionsHost.
// One instance per surface (each card, the Open Large bar); the host keeps the class `relay-strip`,
// which decision-pair.css scopes the Approve/Deny look on.
// A verdict binds to ONE renderer snapshot taken before any await: the bytes the user saw.

import { copyPathButton, isBrowserPath, openFolderButton, openInBrowserButton, OPEN_IN_BROWSER } from "../panels/file-actions";
import type { Painted } from "../panels/display-render";
import { viewPath, type RelayItem, type RelayVerdict } from "./store";
import type { RelayViewState } from "./view";

export interface RelayStripDeps {
  selected(): RelayItem | null;
  current(): Painted | null;
  view(): RelayViewState;
  /** where the file-action buttons go (a card's head cluster); omitted, they sit inline after Dismiss */
  actionsHost?: HTMLElement;
}

export interface RelayStrip {
  /** repaints from the selection and the view state; cheap, called on every store or view change */
  paint(): void;
  /** a message on the state line for the selected item (an ask's send failure or a copy result) */
  note(msg: string): void;
  /** stops repainting on another surface's verdict; the host is the caller's to remove */
  dispose(): void;
}

/** item ids with a verdict in flight on any surface: a card Approve and a Large Deny never both save */
const inFlight = new Set<string>();
/** every live strip's paint, so a verdict starting or ending on one surface locks or frees the others */
const live = new Set<() => void>();

function paintAll(): void {
  for (const p of [...live]) p();
}

export function createRelayStrip(host: HTMLElement, deps: RelayStripDeps): RelayStrip {
  host.classList.add("relay-strip");
  host.innerHTML = `
    <textarea class="relay-comment" rows="1" placeholder="Comment" maxlength="4000"></textarea>
    <span class="relay-state dim"></span>
    <button type="button" class="relay-approve">Approve</button>
    <button type="button" class="relay-deny">Deny</button>
    <button type="button" class="relay-dismiss">Dismiss</button>`;
  const approveBtn = host.querySelector<HTMLButtonElement>(".relay-approve")!;
  const denyBtn = host.querySelector<HTMLButtonElement>(".relay-deny")!;
  const dismissBtn = host.querySelector<HTMLButtonElement>(".relay-dismiss")!;
  const commentEl = host.querySelector<HTMLTextAreaElement>(".relay-comment")!;
  const stateEl = host.querySelector<HTMLElement>(".relay-state")!;
  /** a failed resolve or a file action's feedback; belongs to `msgFor` and clears when the selection moves */
  let message = "";
  let msgFor: string | null = null;
  /** the item the strip last painted for; a change clears the comment and the message */
  let paintedFor: string | null = null;

  const here = () => viewPath(deps.selected());
  let browserBtn: HTMLButtonElement;
  /** the inline file actions; disabled with no selection, hidden for an ask */
  const actionBtns = [
    copyPathButton({ path: here, note, className: "relay-act" }),
    (browserBtn = openInBrowserButton({ path: here, note, className: "relay-act" })),
    openFolderButton({ path: here, note, className: "relay-act" }),
  ];
  (deps.actionsHost ?? host).append(...actionBtns);

  approveBtn.addEventListener("click", () => void decide("approve"));
  denyBtn.addEventListener("click", () => void decide("deny"));
  dismissBtn.addEventListener("click", () => void decide("dismiss"));
  // one line that grows with the comment; Enter submits nothing (the buttons decide)
  commentEl.addEventListener("input", () => {
    commentEl.rows = Math.min(6, Math.max(1, commentEl.value.split("\n").length));
  });

  function note(msg: string) {
    message = msg;
    msgFor = deps.selected()?.id ?? null;
    paint();
  }

  async function decide(verdict: RelayVerdict["verdict"]) {
    const item = deps.selected();
    // an ask answers from its own form, never through this display-only guard
    if (item && item.kind !== "display") return;
    const painted = deps.current(); // the one snapshot: nothing below re-reads the renderer
    if (!item || !painted || inFlight.has(item.id)) return;
    if (painted.path !== viewPath(item)) {
      note("Shown File Is Not This Row's; Select the Row Again");
      return;
    }
    const binding = { path: painted.path, sha256: painted.sha256 };
    const comment = commentEl.value;
    inFlight.add(item.id);
    message = "";
    paintAll();
    try {
      await item.resolve({ verdict, comment, binding });
      if (paintedFor === item.id) { // moved on already: the box holds another item's comment
        commentEl.value = "";
        commentEl.rows = 1;
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
      msgFor = item.id;
    } finally {
      inFlight.delete(item.id);
      paintAll();
    }
  }

  function paint(): void {
    const item = deps.selected();
    const id = item?.id ?? null;
    if (id !== paintedFor) {
      // a comment typed for one item never rides along to the next
      paintedFor = id;
      commentEl.value = "";
      commentEl.rows = 1;
      if (msgFor !== id) message = "";
    }
    const v = deps.view();
    const sha = deps.current()?.sha256;
    const locked = !item || v.painting || inFlight.has(item.id) || !sha;
    approveBtn.disabled = locked;
    denyBtn.disabled = locked;
    dismissBtn.disabled = locked;
    stateEl.textContent = (msgFor === id && message) || v.error || item?.error || "";
    stateEl.title = stateEl.textContent;
    const isAsk = !!item && item.kind !== "display";
    for (const e of [approveBtn, denyBtn, dismissBtn, commentEl, ...actionBtns]) e.classList.toggle("hidden", isAsk);
    const path = item ? viewPath(item) : "";
    for (const b of actionBtns) b.disabled = !item;
    // only .html/.htm opens in the browser; anything else is disabled and says why
    const html = isBrowserPath(path);
    browserBtn.disabled = !html;
    browserBtn.title = html || !path ? OPEN_IN_BROWSER : "HTML and Images Only";
  }

  // leaving Relay (a workbench tab switch hides the view) or hiding the Open Large bar drops the message;
  // no workbench event reaches the strip, so its own visibility is the signal
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((entries) => {
      if (entries.some((e) => !e.isIntersecting) && message) {
        message = "";
        paint();
      }
    });
    io.observe(host);
  }

  live.add(paint);
  paint();
  return { paint, note, dispose: () => { live.delete(paint); io?.disconnect(); } };
}
