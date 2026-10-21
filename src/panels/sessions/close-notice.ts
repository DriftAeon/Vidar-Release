// One aggregated notice for tabs that left the bar before their backend confirmed it had stopped.
// Not showSessionsToast: zoom and laneToast overwrite that one message, and a failure must outlive them.
// The controller is pure (io injected) so aggregation, auto-hide and the pagehide gate are testable.

interface CloseFailure {
  label: string;
  error: string;
}

export interface CloseNoticeIo {
  show(failures: readonly CloseFailure[]): void;
  hide(): void;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

const CLOSE_NOTICE_MS = 10_000;

export function closeNoticeTitle(count: number): string {
  return count === 1 ? "1 Session May Still Be Running" : `${count} Sessions May Still Be Running`;
}

export function createCloseNotices(io: CloseNoticeIo, ms = CLOSE_NOTICE_MS) {
  let failures: CloseFailure[] = [];
  let timer: unknown;
  let suppressed = false;
  const dismiss = () => {
    failures = [];
    if (timer !== undefined) io.cancel(timer);
    timer = undefined;
    io.hide();
  };
  return {
    /** New failures append to the open notice and restart its auto-hide. */
    report(label: string, error: string) {
      if (suppressed) return;
      failures.push({ label, error });
      io.show(failures.slice());
      if (timer !== undefined) io.cancel(timer);
      timer = io.schedule(dismiss, ms);
    },
    dismiss,
    /** pagehide is the only JS quit signal; the window is going, so nothing new is shown. */
    suppress() {
      suppressed = true;
    },
    count: () => failures.length,
  };
}

/* ---- DOM binding ---- */

let root: HTMLButtonElement | null = null;

const domIo: CloseNoticeIo = {
  show(failures) {
    if (!root) {
      // A tab-shaped row: the button is the row, as in the tab list (leftbar.css shares its look).
      root = document.createElement("button");
      root.type = "button";
      root.id = "close-notice";
      root.className = "bar-btn";
      root.setAttribute("aria-live", "polite");
      root.addEventListener("click", () => notices.dismiss());
    }
    // In the left bar right after New Session, ending the tab list. Both are static index.html
    // nodes, so tab renders (which only touch #session-strip's children) never drop it; re-attach if moved.
    const anchor = document.getElementById("new-session");
    if (anchor?.parentElement) {
      if (root.previousSibling !== anchor) anchor.after(root);
    } else if (!root.isConnected) {
      document.body.appendChild(root);
    }
    root.title = "Stopping failed, so the session may still be running. Check the launcher's Falcon row.";
    const face = document.createElement("span");
    face.className = "tab-face";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = closeNoticeTitle(failures.length);
    const sub = document.createElement("span");
    sub.className = "tab-sub";
    const names = document.createElement("span");
    names.className = "tab-model";
    names.textContent = failures.map((f) => f.label).join(", ");
    names.title = failures.map((f) => `${f.label}: ${f.error}`).join("\n");
    sub.appendChild(names);
    const close = document.createElement("span");
    close.className = "session-close";
    close.title = "Dismiss";
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      notices.dismiss();
    });
    root.replaceChildren(face, title, sub, close);
    root.hidden = false;
  },
  hide() {
    if (root) root.hidden = true;
  },
  schedule: (fn, ms) => window.setTimeout(fn, ms),
  cancel: (h) => window.clearTimeout(h as number),
};

const notices = createCloseNotices(domIo);
if (typeof window !== "undefined") window.addEventListener("pagehide", () => notices.suppress(), { once: true });

/** A tab already removed from the bar whose backend may not have stopped. */
export function reportCloseFailure(label: string, error: string) {
  notices.report(label, error);
}
