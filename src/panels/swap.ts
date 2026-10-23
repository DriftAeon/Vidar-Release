/* Swap button (bottom bar, in #lock-group right off the close lock toggle, same divider cell): the Vidar half of /swap
   in one press. Rust (src-tauri/src/swap_button.rs) runs tools\release\pending.ps1 and starts
   tools\release\swap-button.ps1 detached; that worker builds what is pending, runs
   swap-release.ps1 and reports through runtime\bridge\swap-button.json, which this panel polls
   while Vidar is still up. Falcon is never part of it.
   - Accent while a build or swap is pending: checked once at mount and on window focus, at most
     every 30 s, and on every press.
   - Pressing shows no text: while a swap is checking, building or swapping, the icon is replaced
     by a red ring spinner and the phase is the tooltip only ("Building Vidar").
   - A failure keeps the button's tooltip and the #swap-status strip (shown for failures only:
     the button has no other visible error signal); the next press clears it.
   - Close lock on (the sibling #close-lock host carries "locked"): disabled, the tooltip says why.
   - RMB opens a one-row menu: "Swap Confirmation Panel" (pref `swap.confirm`, default off). On,
     a click first asks "Would you like to rebuild Vidar now?" (Yes / No) above the bar; off, a
     click swaps at once. Raw (PTY) tabs get no extra confirm: they die with the window, the user
     chose to trust the press (2026-10-07). */
import { invoke } from "../ipc";
import { iconImg } from "../icon-img";
import { getPref, setPref } from "../prefs";
import { openPopover } from "../modules/popover";
import { placeAbove } from "../modules/place-menu";
import type { SwapPending, SwapState } from "../ipc-settings";

const FOCUS_THROTTLE_MS = 30_000;
const POLL_MS = 1_000;
const NOTE_MS = 6_000;
/** The worker writes its first state within a second or two; past this it never started. */
const START_GRACE_MS = 20_000;
/** A failed state found at mount is shown only while the state file is this fresh. */
const RECENT_FAIL_MS = 10 * 60_000;

/** Prefix of the Rust error when tools\release is not in this install (swap_button.rs). */
const UNAVAILABLE = "Swap Unavailable";
const TITLE = "Swap Vidar";
const LOCKED_TITLE = "Close lock is on. Unlock it to swap.";
type Phase = "checking" | "building" | "swapping";
const PHASE_TITLE: Record<Phase, string> = {
  checking: "Checking Vidar",
  building: "Building Vidar",
  swapping: "Swapping Vidar",
};
const asPhase = (p: string | null | undefined): Phase => (p === "building" || p === "swapping" ? p : "checking");

export function initSwap(btn: HTMLButtonElement, signal: AbortSignal) {
  const status = document.getElementById("swap-status")!;
  const icon = iconImg("swap");
  const spinner = Object.assign(document.createElement("span"), { className: "swap-spin" });
  spinner.setAttribute("aria-hidden", "true");
  btn.replaceChildren(icon);
  btn.setAttribute("aria-label", TITLE);

  let locked = false;
  /** Non-null while a swap is in progress: the spinner shows and the tooltip names the phase. */
  let phase: Phase | null = null;
  /** Tooltip after a press (a failure, "Nothing Pending"); cleared by the next press or its ttl. */
  let note = "";
  let lastCheck = 0;
  let checking: Promise<SwapPending | null> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const paint = () => {
    btn.disabled = locked;
    btn.title = locked ? LOCKED_TITLE : phase ? PHASE_TITLE[phase] : note || TITLE;
    btn.classList.toggle("busy", phase !== null);
    btn.setAttribute("aria-busy", String(phase !== null));
    const want = phase ? spinner : icon;
    if (btn.firstChild !== want) btn.replaceChildren(want);
  };

  const setPhase = (p: Phase | null) => {
    phase = p;
    paint();
  };

  /** Tooltip note; `error` also shows it in #swap-status. `ttl` clears it, none keeps it until the next press. */
  const say = (text: string, error = false, ttl?: number) => {
    clearTimeout(noteTimer);
    note = text;
    status.textContent = error ? text : "";
    status.title = error ? text : "";
    status.classList.toggle("error", error);
    status.classList.toggle("hidden", !error || !text);
    paint();
    if (ttl) noteTimer = setTimeout(() => say(""), ttl);
  };

  const setPending = (p: SwapPending | null) => {
    if (p) btn.classList.toggle("pending", p.build || p.swap);
  };

  /** pending.ps1 through Rust; one run at a time, the throttle only applies to focus checks. */
  const checkPending = (force: boolean): Promise<SwapPending | null> => {
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < FOCUS_THROTTLE_MS) return Promise.resolve(null);
    lastCheck = Date.now();
    checking = invoke("swap_pending")
      .then((p) => (p && typeof p.build === "boolean" ? p : null)) // the browser mock answers undefined
      .then((p) => { setPending(p); return p; })
      .catch((e) => {
        // A shipped install has no tools\release: the button has nothing to run, so it goes away.
        if (String(e).startsWith(UNAVAILABLE)) btn.classList.add("hidden");
        throw e;
      })
      .finally(() => { checking = null; });
    return checking;
  };

  const stopPoll = () => {
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  /** `pid`: the worker this press started; null adopts whichever worker is running (mount). */
  const follow = (pid: number | null) => {
    const since = Date.now();
    const tick = async () => {
      const s: SwapState | null = await invoke("swap_state").catch(() => null);
      if (!s) return;
      const ours = pid === null || s.pid === pid;
      if (ours && s.running) {
        setPhase(asPhase(s.phase));
        return;
      }
      if (!ours && Date.now() - since < START_GRACE_MS) return; // not written yet
      stopPoll();
      phase = null;
      if (!ours) say("Swap Stopped: See swap-button.log", true); // copy-ok: file name
      else if (s.phase === "failed") say(s.error || "Swap Failed", true);
      else if (s.phase === "nothing") {
        btn.classList.remove("pending");
        say("Nothing Pending", false, NOTE_MS);
      } else if (s.phase === "done") say("Swapped", false, NOTE_MS);
      else say("Swap Stopped: See swap-button.log", true); // copy-ok: file name
    };
    stopPoll();
    pollTimer = setInterval(() => void tick(), POLL_MS);
    void tick();
  };

  const start = async () => {
    setPhase("checking");
    try {
      follow(await invoke("swap_start"));
    } catch (e) {
      phase = null;
      say(String(e), true);
    }
  };

  /** The swap itself: pending check, then the worker. Confirmation (if on) happened before. */
  const run = async () => {
    if (phase || locked) return;
    say("");
    setPhase("checking");
    let p: SwapPending | null = null;
    let failure = "";
    try {
      p = await checkPending(true);
    } catch (e) {
      failure = String(e);
    }
    phase = null;
    if (!p) return say(failure || "Pending Check Failed", true);
    if (!p.build && !p.swap) return say("Nothing Pending", false, NOTE_MS);
    if (locked) return say("");
    return start();
  };

  /* ---- popups: the RMB menu and the confirm, fixed on body so the bar never clips them ---- */
  let popup: HTMLElement | null = null;
  let stopPopup: ((refocus?: boolean) => void) | null = null;
  const closePopup = (refocus = false) => stopPopup?.(refocus);
  /** Above the bottom bar (gap from the bar's top edge, not the button's), right edge on the button's. */
  const openPopup = (el: HTMLElement, focus: HTMLElement) => {
    closePopup();
    popup = el;
    btn.setAttribute("aria-expanded", "true");
    const bar = btn.closest<HTMLElement>("#bottombar") ?? btn;
    stopPopup = openPopover({
      el,
      anchor: btn,
      place: placeAbove(btn.getBoundingClientRect(), bar.getBoundingClientRect(), "end"),
      keys: "document",
      restoreFocus: () => { if (!btn.disabled) btn.focus(); },
      onClose: () => {
        if (popup !== el) return; // replaced: the new popup owns the state
        popup = null; stopPopup = null;
        btn.setAttribute("aria-expanded", "false");
      },
    });
    focus.focus();
  };

  const openMenu = () => {
    const menu = Object.assign(document.createElement("div"), { id: "swap-menu" });
    menu.setAttribute("role", "menu");
    const row = Object.assign(document.createElement("button"), { type: "button" });
    row.setAttribute("role", "menuitemcheckbox");
    const label = Object.assign(document.createElement("span"), { textContent: "Swap Confirmation Panel" });
    const track = Object.assign(document.createElement("span"), { className: "switch" });
    track.append(Object.assign(document.createElement("span"), { className: "knob" }));
    row.append(label, track);
    const paintRow = () => {
      const on = getPref("swap.confirm") === true;
      row.classList.toggle("on", on);
      row.setAttribute("aria-checked", String(on));
    };
    row.addEventListener("click", () => {
      setPref("swap.confirm", getPref("swap.confirm") === true ? undefined : true);
      paintRow();
    });
    paintRow();
    menu.append(row);
    openPopup(menu, row);
  };

  const openConfirm = () => {
    const box = Object.assign(document.createElement("div"), { id: "swap-confirm" });
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", TITLE);
    const head = Object.assign(document.createElement("div"), { className: "swap-confirm-head" });
    const tile = Object.assign(document.createElement("span"), { className: "title-tile" }); // title-bar.css
    tile.append(iconImg("swap"));
    head.append(tile, Object.assign(document.createElement("strong"), { textContent: TITLE }));
    const body = Object.assign(document.createElement("div"), { className: "swap-confirm-body" });
    const text = Object.assign(document.createElement("p"), { textContent: "Would you like to rebuild Vidar now?" });
    const actions = Object.assign(document.createElement("div"), { className: "swap-confirm-actions" });
    const yes = Object.assign(document.createElement("button"), { type: "button", className: "swap-yes", textContent: "Yes" });
    const no = Object.assign(document.createElement("button"), { type: "button", className: "swap-no", textContent: "No" });
    yes.addEventListener("click", () => { closePopup(true); void run(); });
    no.addEventListener("click", () => closePopup(true));
    actions.append(yes, no);
    body.append(text, actions);
    box.append(head, body);
    openPopup(box, yes);
  };

  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", () => {
    if (phase || locked) return;
    if (popup?.id === "swap-confirm") return closePopup(true); // a second click on the button dismisses it
    if (getPref("swap.confirm") === true) return openConfirm();
    closePopup();
    void run();
  }, { signal });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (popup?.id === "swap-menu") return closePopup(true);
    openMenu();
  }, { signal });
  window.addEventListener("focus", () => void checkPending(false).catch(() => null), { signal });

  // The close lock's own panel owns the switch; its host's "locked" class is the painted state.
  const lockHost = document.getElementById("close-lock");
  const readLock = () => {
    locked = !!lockHost?.classList.contains("locked");
    if (locked && popup?.id === "swap-confirm") closePopup();
    paint();
  };
  const observer = new MutationObserver(readLock);
  if (lockHost) observer.observe(lockHost, { attributes: true, attributeFilter: ["class"] });
  readLock();

  signal.addEventListener("abort", () => {
    observer.disconnect();
    stopPoll();
    clearTimeout(noteTimer);
    closePopup();
  });

  // A worker still running (this window was reloaded mid-build) is followed, not restarted.
  void invoke("swap_state")
    .then((s) => {
      if (s?.running) {
        setPhase(asPhase(s.phase));
        follow(null);
      } else if (s?.phase === "failed" && !s.dryRun && s.atMs && Date.now() - s.atMs < RECENT_FAIL_MS) {
        say(s.error?.split(/\r?\n/)[0] || "Swap Failed", true);
      }
    })
    .catch(() => {});
  void checkPending(true).catch(() => null);
}
