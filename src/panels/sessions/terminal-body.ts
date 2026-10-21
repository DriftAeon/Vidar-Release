// Terminal body: the xterm over a pty — attach (keys, paste, zoom, links, spawn), detach, the
// fit-then-resize sync and the theme refresh. sessions.ts binds its tab map and seeds Rider links.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "../../ipc";
import { xtermTheme } from "../../theme";
import type { TerminalSession } from "./types";
import { rescueBottombar } from "./bottombar-dock";
import { armedId, disarmAstra } from "./astra-bridge";
import { currentFont, showSessionsToast, zoomBy, zoomReset } from "./zoom";
import { openSearch } from "./search-overlay";
import { noteTyped } from "./message-open";
import { dropOutput } from "./output";
import { registerFileLinks } from "./file-links";
import { ptySpawnPayload } from "./pty-spawn";
import { createPtyResize } from "./pty-resize";
import { noteRawCodexSpawn } from "./lookup";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
const clipboardWarnings = new WeakSet<TerminalSession>();
let riderEnabled = false;
/** Last attachment tag handed to spawn_pty. Events match on (id, tag), so one counter serves every
 *  tab; boot-unique tab ids make its reset on a webview reload harmless. */
let ptyGenSeq = 0;

/** Sessions whose spawn_pty is in flight: writes wait in `buf` (the pty does not exist yet, so a
 *  write would fail "no such pty" and drop bytes). The entry counts only for the attachment (`term`)
 *  that made it; detach deletes it. */
const spawnQueue = new Map<TerminalSession, { term: Terminal; buf: string[] }>();

function writePty(s: TerminalSession, data: string): Promise<unknown> {
  const q = spawnQueue.get(s);
  if (q) {
    q.buf.push(data);
    return Promise.resolve();
  }
  return invoke("write_pty", { id: s.id, data });
}

/** sessions.ts, at load: the tab map the paste guard and ResizeObserver read. */
export function bindTerminalBody(deps: { sessions: ReadonlyMap<string, TerminalSession> }) {
  sessions = deps.sessions;
}

/** initSessions: whether file:line links open in Rider (vidar.json riderEnabled). */
export function initTerminalBody(rider: boolean) {
  riderEnabled = rider;
}

/* ---- terminal body ---- */

export async function attachTerminalBody(s: TerminalSession, launch: { shell?: string; args?: string[] }) {
  const { id, container, button, cwd } = s;
  // DOM renderer on purpose: WebGL addon has reported corruption under
  // constant full-screen TUI redraw.
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: currentFont,
    scrollback: 10000,
    theme: { ...xtermTheme() },
    // Off (1 = no adjustment). It existed to rescue the STOCK ANSI palette from
    // dark-on-dark; now that theme.ts authors all 16 colours deliberately, the
    // auto-lightening would override those choices instead of backstopping them.
    minimumContrastRatio: 1,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  // Custom handler replaces the default window.open entirely; Rust command
  // enforces the http/https allowlist.
  term.loadAddon(
    new WebLinksAddon((ev, uri) => {
      if (ev.button === 0) invoke("open_url", { url: uri });
    }),
  );
  term.unicode.activeVersion = "11";
  if (riderEnabled) registerFileLinks(term);

  // Single handler: attachCustomKeyEventHandler REPLACES, never stacks.
  // ctrlPasteGesture owns exactly one Ctrl+V keydown until its keyup, focusout or
  // the browser paste it may still raise; the clipboard read's lifetime is NOT part
  // of it (a pending read must not swallow an unrelated paste).
  // pasteChain keeps two quick Ctrl+Vs delivering in press order.
  let ctrlPasteGesture = false;
  let pasteChain: Promise<void> = Promise.resolve();
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === "keyup" && (ev.key.toLowerCase() === "v" || ev.key === "Control")) {
      // Keep ownership through the browser's default action for this event.
      window.setTimeout(() => { ctrlPasteGesture = false; }, 0);
    }
    if (ev.type !== "keydown") return true;
    // Terminals collapse Shift+Enter into plain Enter; Claude Code expects \x1b\r.
    if (ev.key === "Enter" && ev.shiftKey) {
      void writePty(s, "\x1b\r");
      return false;
    }
    if (ev.ctrlKey && !ev.altKey) {
      if (!ev.shiftKey && !ev.metaKey && ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        ctrlPasteGesture = true;
        // Read first (in parallel with any earlier read), deliver in order.
        const read = navigator.clipboard.readText().catch((error: unknown) => {
          if (!clipboardWarnings.has(s)) {
            clipboardWarnings.add(s);
            console.warn("Clipboard text read failed; forwarding Ctrl+V for image paste", error);
          }
          return "";
        });
        pasteChain = pasteChain.then(async () => {
          try {
            const text = await read;
            // Focus can move or this body can be replaced while permission is pending.
            if (sessions.get(id) !== s || s.term !== term || !s.alive) return;
            if (text) term.paste(text);
            else await writePty(s, "\x16");
          } catch (error) { console.warn("Terminal paste failed", error); }
        });
        return false;
      }
      // preventDefault is load-bearing on F (WebView2 find bar); harmless and
      // future-proof on the zoom keys (accelerators are platform-disabled).
      if (ev.key === "f" || ev.key === "F") {
        ev.preventDefault();
        openSearch();
        return false;
      }
      if (ev.key === "=" || ev.key === "+") {
        ev.preventDefault();
        zoomBy(1);
        return false;
      }
      if (ev.key === "-") {
        ev.preventDefault();
        zoomBy(-1);
        return false;
      }
      if (ev.key === "0") {
        ev.preventDefault();
        zoomReset();
        return false;
      }
    }
    return true;
  });
  term.attachCustomWheelEventHandler((ev) => {
    if (ev.ctrlKey) {
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1 : -1);
      return false;
    }
    return true;
  });
  term.onData((data) => {
    noteTyped(id, data);
    void writePty(s, data);
  });

  const ro = new ResizeObserver((entries) => {
    // Hidden containers report 0×0 — fitting then would corrupt the pty size.
    for (const en of entries) if (en.contentRect.width === 0 || en.contentRect.height === 0) return;
    const s = sessions.get(id);
    if (!s?.term || !s.fit) return;
    // Fit now (cheap, keeps the xterm grid live); the pty hears the size once the drag settles.
    s.fit.fit();
    if (s.term.cols !== s.ptyCols || s.term.rows !== s.ptyRows) ptyResize.later(id);
  });

  // Tagged before the spawn so its earliest events (ConPTY's ESC[6n) match without the reply.
  const ptyGen = ++ptyGenSeq;
  s.term = term;
  s.ptyGen = ptyGen;
  s.fit = fit;
  s.search = search;
  s.ro = ro;
  s.body = "terminal";
  s.launchArgs = launch.args;
  // its own rollouts are the ones written from now on (codex-thread.ts pickRawThreads)
  if (s.agent === "codex") noteRawCodexSpawn(id);
  button.dataset.body = "terminal";
  term.open(container);
  // Capture before xterm's textarea listener; one Ctrl+V must have one owner.
  // The terminal element is removed on disposal, taking these listeners with it.
  term.element!.addEventListener("paste", (event) => {
    if (!ctrlPasteGesture) return; // context-menu / Ctrl+Shift+V paste: not ours, let it through
    ctrlPasteGesture = false; // one gesture, one paste
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  term.element!.addEventListener("focusout", () => { ctrlPasteGesture = false; });
  fit.fit();
  s.ptyCols = term.cols; // spawn_pty below is the first "resize"
  s.ptyRows = term.rows;
  // Rules ride the one spawn: fresh, adopt and switch-to-Raw all land here. Prepare-time warnings
  // are shown once per tab, so a later switch does not repeat them. A profiled tab (bare) carries
  // its profile on every spawn and no shell, args or rules (pty-spawn.ts).
  const spawn = ptySpawnPayload({
    id,
    cols: term.cols,
    rows: term.rows,
    cwd,
    tabName: s.button.title || null, // VIDAR_TAB_NAME, beside VIDAR_TAB
    ptyGen,
    shell: launch.shell,
    args: launch.args,
    rules: s.rules,
    profile: s.profile,
    rowKey: s.rowKey,
    agent: s.button.dataset.art ?? s.agent, // roster id: a gateway tab reads its module id, not its "claude" kind
  });
  const notes = [...(s.rules?.warnings ?? []), ...(spawn.warning ? [spawn.warning] : [])];
  if (s.rules) s.rules = { ...s.rules, warnings: [] };
  for (const w of notes) term.write(`\r\n\x1b[33m[${w}]\x1b[0m\r\n`);
  if (notes.length) showSessionsToast(notes.join(" "), 6000);
  const queued = { term, buf: [] as string[] };
  spawnQueue.set(s, queued);
  try {
    await invoke("spawn_pty", spawn.payload);
    // Detach deletes the entry, and a newer attachment owns its own: only this one's counts.
    const mine = spawnQueue.get(s) === queued;
    if (mine) spawnQueue.delete(s);
    const tabGone = sessions.get(id) !== s;
    if (!mine || s.term !== term || tabGone) {
      // The pty this spawn made belongs to no live attachment: close it. A newer attachment on
      // this session has its own spawn (kill would take that one; kill::admit refuses its spawn).
      if (!s.term || tabGone) void invoke("kill_pty", { id, close: tabGone }).catch(console.warn);
      else console.warn(`Terminal ${id}: spawn landed after its body was replaced`);
      return;
    }
  } catch (err) {
    if (spawnQueue.get(s) === queued) spawnQueue.delete(s);
    // A replaced body's failed spawn is not this attachment's to report or disarm.
    if (s.term !== term) {
      console.warn(`Terminal ${id}: spawn failed after its body was replaced`, err);
      return;
    }
    // An armed tab whose shell never started must not stay a dispatch target.
    if (armedId === id) disarmAstra();
    // A refused profiled spawn (bare) says why in the tab itself, not only in the toast.
    if (s.profile && s.term === term) {
      const msg = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, " ");
      term.write(`\r\n\x1b[31m[${msg}]\x1b[0m\r\n`);
    }
    throw err;
  }
  for (const data of queued.buf) void invoke("write_pty", { id, data });
  // Resizes during the spawn were fit-only; send the grid the pty is now missing.
  if (container.clientWidth > 0 && container.clientHeight > 0) syncPty(s);
  ro.observe(container);
  term.focus();
}

export function detachTerminalBody(s: TerminalSession) {
  s.ptyGen = undefined;
  spawnQueue.delete(s);
  ptyResize.cancel(s.id);
  s.ro?.disconnect();
  s.ro = undefined;
  dropOutput(s.id);
  s.term?.dispose(); // also disposes loaded addons
  s.term = undefined;
  s.fit = undefined;
  s.search = undefined;
  rescueBottombar(s.container); // a docked bottom bar must not be cleared with the body
  s.container.textContent = "";
}

// Fit, then tell the pty only if the grid actually changed. ConPTY treats an
// identical resize as a real one and the TUI repaints in full — with the sync
// fit in layout() followed by the ResizeObserver's a frame later, that was a
// visible double redraw every time the workbench opened. Also what keeps a
// divider drag from flooding the pty: many fits, few real column changes.
export function syncPty(s: TerminalSession) {
  if (!s.term || !s.fit) return;
  s.fit.fit();
  ptyResize.now(s.id);
}

// Fire-time send for both paths: reads the current grid, never fits. Nothing to tell a pty that is
// still spawning (the landing syncs) or a body that is gone; a drag back to the old grid sends nothing.
function sendPtySize(id: string) {
  const s = sessions.get(id);
  if (!s?.term || spawnQueue.has(s)) return;
  if (s.term.cols === s.ptyCols && s.term.rows === s.ptyRows) return;
  s.ptyCols = s.term.cols;
  s.ptyRows = s.term.rows;
  invoke("resize_pty", { id, cols: s.term.cols, rows: s.term.rows });
}
const ptyResize = createPtyResize(sendPtySize);

export function setTerminalTheme() {
  // New object each time — xterm compares by reference (mutation is ignored).
  for (const s of sessions.values()) {
    if (s.term) s.term.options.theme = { ...xtermTheme() };
  }
}
