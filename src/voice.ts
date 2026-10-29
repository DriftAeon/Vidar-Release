// Voice input state machine: global hotkey → record → transcribe → type into the
// focused pane, unsent unless the Auto-Send switch is on. Rust (voice.rs) owns the mic and
// the whisper process; this module owns WHEN (hold vs toggle) and WHERE: the pane that
// was active at hotkey PRESS. Captured then, not looked up after transcription — whisper
// takes seconds and a tab switch in between must not redirect the words. Window blur
// never changes activeId, so "last selected before Vidar lost focus" is that pane too.
//
// All invokes go through one promise chain: a Released that lands before voice_start has
// resolved still stops *after* it, instead of racing it.
//
// Settings live in the Shortcuts modal: the chord as an `external` shortcut row (we
// persist it and re-register live), mode and microphone as select rows. Only those
// keys are written to vidar.json; the transcriber block stays config-file-only — the model
// picker drives the `{model}` substitution inside it, never the args themselves.

//
// This is the `dictation` capability's body (capabilities/mounts/
// dictation.ts): a hostless service loaded lazily, so the entry chunk holds none of it. initVoice
// returns a Dispose that undoes everything it set up; ending the chord and a live recording is
// capabilities/stops/dictation.ts, which runs on a switch-off and at a launch that leaves it off.

import { invoke } from "./ipc";
import { listen } from "./ipc";
import { clearOpenMessage, getActiveSessionId, sessionContainer, writeToSession } from "./panels/sessions";
import { addSettingRow, addShortcut, isShortcutsModalOpen } from "./shortcuts";
import { markVoice } from "./voice-mark";

interface TranscriberCfg {
  command: string;
  args: string[];
}
export interface VoiceCfg {
  hotkey: string;
  mode: string; // "hold" | "toggle"
  device: string;
  // whisper's initial prompt: biases spelling/casing toward these words (mic, Claude, git)
  prompt: string;
  // bare whisper model name ("small.en"); Rust resolves it to vendor\whisper\ggml-<name>.bin
  model: string;
  transcriber: TranscriberCfg;
}

type Phase = "idle" | "recording" | "transcribing";

const DEFAULT_HOTKEY = "Ctrl+Shift+G";
// Hold releases shorter than this are an accidental tap: stop and discard without paying
// for a model load.
const MIN_HOLD_MS = 250;

let cfg: VoiceCfg;
let phase: Phase = "idle";
let startOk = false;
let pressedAt = 0;
let target: string | null = null; // destination pane, fixed at press
let chain: Promise<void> = Promise.resolve();
let pill: HTMLElement;
let pillHome: HTMLElement; // #bottombar — where the pill lives when it is not over a pane
let pillAnchor: ChildNode | null; // the sibling it goes back in front of
let paneObserver: MutationObserver | undefined;
let remountQueued = false;
let hideTimer: number | undefined;

let live: AbortSignal = AbortSignal.abort(); // the current mount's signal; aborted while unmounted

/** Ends a recording without transcribing and resumes listen (voice.rs returns before reading
 *  the transcriber on a discard). Rejects with "not recording" when there is none. Same literal
 *  as capabilities/stops/dictation.ts, which must not import this UI module. */
const DISCARD = { prompt: "", discard: true };

export function initVoice(voice: VoiceCfg, signal: AbortSignal): () => void {
  cfg = voice;
  live = signal;
  pill = document.getElementById("voice-pill")!;
  pillHome = pill.parentElement!;
  pillAnchor = pill.nextSibling;
  const removers = registerSettings();
  // Warm the slot hash cache off the UI thread, so the first press doesn't pay the model hash.
  void invoke("voice_slots_status").catch(() => {});
  let unlisten: (() => void) | null = null;
  void (async () => {
    // A hold a reload orphaned keeps the slot Some, so voice_start would no-op on the next press
    // and listen would stay paused: end it first ("not recording" is the normal answer).
    try {
      await invoke("voice_stop", DISCARD);
    } catch {
      // not recording
    }
    if (signal.aborted) return;
    const un = await listen<string>("voice-hotkey", (e) => {
      if (!signal.aborted) onHotkey(e.payload === "pressed");
    });
    if (signal.aborted) {
      un();
      return;
    }
    unlisten = un;
    if (!cfg.hotkey.trim()) return;
    try {
      await invoke("voice_register", { chord: toGlobalChord(cfg.hotkey) });
    } catch (e) {
      if (!signal.aborted) show(String(e), "error", 10000);
      return;
    }
    // The stop's voice_register("") may have run before this register landed: unbind again.
    if (signal.aborted) void invoke("voice_register", { chord: "" }).catch(() => {});
  })().catch((e: unknown) => console.error("dictation start:", e));
  return () => {
    unlisten?.();
    unlisten = null;
    for (const remove of removers) remove();
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = undefined;
    unwatchPanes();
    pill.className = "hidden";
    if (pill.parentElement !== pillHome || pill.nextSibling !== pillAnchor) pillHome.insertBefore(pill, pillAnchor);
    phase = "idle";
    startOk = false;
    target = null;
  };
}

/* ---- state machine ---- */

function enqueue(step: () => Promise<void>) {
  chain = chain.then(step, step);
}

function onHotkey(pressed: boolean) {
  // The settings modal's recorder is armed: a press of the current chord is the user
  // re-recording it, not a request to record audio.
  if (isShortcutsModalOpen()) return;
  const toggle = cfg.mode === "toggle";
  switch (phase) {
    case "transcribing":
      if (pressed) flash();
      return;
    case "idle":
      if (!pressed) return;
      target = getActiveSessionId();
      if (!target) {
        show("No Session to Type Into", "error", 4000);
        return;
      }
      phase = "recording";
      pressedAt = performance.now();
      show("Recording ●", "rec");
      enqueue(start);
      return;
    case "recording":
      // toggle ignores Released; hold ignores a second Pressed (can't happen with
      // MOD_NOREPEAT, but the state machine shouldn't rely on that)
      if (toggle ? !pressed : pressed) return;
      phase = "transcribing";
      enqueue(() => stop(!toggle && performance.now() - pressedAt < MIN_HOLD_MS));
  }
}

async function start() {
  const sig = live;
  if (sig.aborted) {
    // switched off between the press and this queued step: never open the mic
    phase = "idle";
    return;
  }
  try {
    await invoke("voice_start", { device: cfg.device });
    if (sig.aborted) {
      // Switched off while voice_start was in flight: its stop may have run first, and no
      // release will arrive now. End the take so the mic closes and listen resumes.
      void invoke("voice_stop", DISCARD).catch(() => {});
      return;
    }
    startOk = true;
  } catch (e) {
    startOk = false;
    if (sig.aborted) return; // the dispose already reset phase and hid the pill
    phase = "idle";
    show(String(e), "error", 10000);
  }
}

async function stop(discard: boolean) {
  if (!startOk) {
    phase = "idle"; // start failed after onHotkey already moved us on
    return;
  }
  startOk = false;
  if (discard) hide();
  else show("Transcribing…", "busy");
  const sig = live;
  try {
    const text = await invoke("voice_stop", { prompt: cfg.prompt, discard });
    if (discard || sig.aborted) return; // switched off mid-transcription: no pill, no write
    if (!text) show("Nothing Detected", "warn", 2500);
    else if (await writeToSession(target!, markVoice(target!, text))) {
      hide();
      // Auto-Send (bottom-bar switch beside the mic) submits what was just typed, as listen.ts deliver() does.
      const send = (await invoke("read_switch", { name: "auto-send" }).catch(() => false)) === true;
      if (send && !sig.aborted) {
        await new Promise((r) => setTimeout(r, 150));
        if (!sig.aborted) {
          await writeToSession(target!, "\r");
          clearOpenMessage(target!);
        }
      }
    }
    // target closed or died while transcribing: say so, never redirect to another pane
    else show("Target session closed — transcript dropped", "error", 5000);
  } catch (e) {
    if (!sig.aborted) show(String(e), "error", 10000);
  } finally {
    // Off→on while this transcription ran: the dispose already reset phase, and the new mount
    // may be recording. Resetting here would leave its mic open with the machine idle.
    if (!sig.aborted) phase = "idle";
  }
}

/* ---- settings (Shortcuts modal) ---- */

// The in-app recorder says "Meta"; global-hotkey's parser wants "Super".
function toGlobalChord(chord: string): string {
  return chord.replace(/\bMeta\b/g, "Super");
}

async function save(): Promise<string | null> {
  try {
    await invoke("save_voice", { hotkey: cfg.hotkey, mode: cfg.mode, device: cfg.device, prompt: cfg.prompt, model: cfg.model });
    return null;
  } catch (e) {
    return String(e);
  }
}

// Re-registers live, then persists. A chord the plugin refuses (parse error, taken by
// another app) leaves the previous one registered and reports why.
async function applyHotkey(chord: string): Promise<string | null> {
  // A Settings modal opened before dictation went off still shows this row: bind nothing.
  if (live.aborted) return OFF;
  const sig = live;
  const prev = cfg.hotkey;
  try {
    await invoke("voice_register", { chord: toGlobalChord(chord) });
  } catch (e) {
    try {
      await invoke("voice_register", { chord: toGlobalChord(prev) });
    } catch {
      // previous chord gone too — the error below is what the user needs to see
    }
    return String(e);
  }
  if (sig.aborted) {
    // switched off while the register was in flight: the stop's unbind may have run first
    void invoke("voice_register", { chord: "" }).catch(() => {});
    return OFF;
  }
  cfg.hotkey = chord;
  return save();
}

const OFF = "Dictation Is Off";

/** For the select/input rows: true (and says so) when a stale modal row fires while off. */
function offGuard(): boolean {
  if (!live.aborted) return false;
  show(OFF, "warn", 4000);
  return true;
}

/** Returns the removers, so a dispose takes the rows and the shortcut back out. */
function registerSettings(): (() => void)[] {
  return [registerModelRow(), registerPromptRow(), addShortcut({
    id: "voice-ptt",
    name: "Voice Input",
    tip: "Works while another app is focused; sends when Auto-Send is on.",
    defaultKeys: DEFAULT_HOTKEY,
    initial: cfg.hotkey,
    run: () => {},
    external: applyHotkey,
    category: "keybinds",
  }), addSettingRow({
    name: "Voice Bind Style",
    tip: "Hold to talk, or toggle on and off.",
    category: "keybinds",
    control: () => {
      const sel = select([["hold", "Hold"], ["toggle", "Toggle"]], cfg.mode);
      sel.addEventListener("change", () => {
        if (offGuard()) return;
        cfg.mode = sel.value;
        void save().then((err) => err && show(err, "error", 8000));
      });
      return sel;
    },
  }), addSettingRow({
    name: "Microphone",
    tip: "Windows default follows the system setting.",
    category: "audio",
    control: () => {
      const sel = select([["", "Windows Default"]], "");
      sel.disabled = true;
      void invoke("voice_devices")
        .then((names) => {
          for (const n of names) sel.append(new Option(n, n));
          // stored value is a substring filter; pick the first option it would match
          const hit = cfg.device
            ? Array.from(sel.options).find((o) => o.value && o.value.toLowerCase().includes(cfg.device.toLowerCase()))
            : undefined;
          if (cfg.device && !hit) sel.append(new Option(`${cfg.device} (Not Present)`, cfg.device));
          sel.value = hit ? hit.value : cfg.device;
          sel.disabled = false;
        })
        .catch((e) => {
          sel.append(new Option(`Devices Unavailable:${String(e)}`, "__err"));
          sel.value = "__err";
        });
      sel.addEventListener("change", () => {
        if (sel.value === "__err" || offGuard()) return;
        cfg.device = sel.value;
        void save().then((err) => err && show(err, "error", 8000));
      });
      return sel;
    },
  })];
}

// The stt slot's manifest models[] (voice_slots_status) is the one list, as for the wake
// picker; only installed files are offered. A model the config names but disk doesn't have
// still shows, marked, rather than silently snapping the selection to something else.
function registerModelRow(): () => void {
  return addSettingRow({
    name: "Speech Model",
    // the timings and how to add a model live in docs\reference\voice-input.md, not in the tooltip
    tip: "Bigger is more accurate and slower.",
    category: "audio",
    control: () => {
      const sel = select(cfg.model ? [[cfg.model, cfg.model]] : [], cfg.model);
      sel.disabled = true;
      void invoke("voice_slots_status")
        .then((rows) => {
          const models = rows.find((r) => r.slot === "stt")?.models ?? [];
          const label = (id: string) => models.find((m) => m.id === id)?.label ?? id;
          const installed = models.filter((m) => m.installed);
          sel.replaceChildren();
          for (const m of installed) sel.append(new Option(label(m.id), m.id));
          if (cfg.model && !installed.some((m) => m.id === cfg.model)) {
            sel.append(new Option(`${label(cfg.model)} (Not Installed)`, cfg.model));
          }
          if (!sel.options.length) {
            const none = new Option("None Installed", "");
            none.disabled = true;
            sel.append(none);
            sel.selectedIndex = 0;
            return; // nothing to pick: the select stays disabled
          }
          if (cfg.model) sel.value = cfg.model;
          else sel.selectedIndex = 0; // unset: show the first installed model, saved only on a change
          sel.disabled = false;
        })
        .catch((e) => {
          sel.replaceChildren(new Option(`Models Unavailable: ${String(e)}`, "__err"));
          sel.value = "__err";
        });
      sel.addEventListener("change", () => {
        if (sel.value === "__err" || offGuard()) return;
        cfg.model = sel.value;
        void save().then((err) => err && show(err, "error", 8000));
      });
      return sel;
    },
  });
}

function registerPromptRow(): () => void {
  return addSettingRow({
    name: "Vocabulary Prompt",
    // a long list starts leaking into the output — said once in docs\reference\voice-input.md
    tip: "Words whisper should prefer: Claude, git, mic.",
    category: "audio",
    control: () => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "sc-input";
      input.value = cfg.prompt;
      input.spellcheck = false;
      input.addEventListener("change", () => {
        if (offGuard()) return;
        cfg.prompt = input.value.trim();
        void save().then((err) => err && show(err, "error", 8000));
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        e.stopPropagation(); // the modal's document-level recorder must not see typing
      });
      return input;
    },
  });
}

function select(options: [string, string][], value: string): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "sc-select";
  for (const [v, label] of options) sel.append(new Option(label, v));
  sel.value = value;
  return sel;
}

/* ---- indicator ---- */

function show(text: string, kind: "rec" | "busy" | "warn" | "error", ms?: number) {
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = undefined;
  pill.textContent = text;
  pill.title = kind === "error" ? text : ""; // long errors ellipsize; hover for the whole thing
  pill.className = kind; // wipes .overlay, so remount() must come after
  remount();
  if (ms) hideTimer = window.setTimeout(hide, ms);
}

function hide() {
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = undefined;
  pill.className = "hidden";
  remount();
}

/* ---- the pill follows the words, not the focus ----
   Recording feedback belongs where the transcript is going to land, so the pill is
   reparented into the target pane: the composer's input row for a rendered body, the
   container itself for a terminal one — a direct child of .term-container and so
   outside .xterm-viewport, which would scroll out from under an overlay. It returns
   to its bottom-bar home whenever there is no target, the pane is hidden or gone, or
   the message is an error (errors are long and want selecting, which a
   pointer-events:none chip cannot give). Voice is serialised, so one pill is enough. */

/** the pane element `id`'s words land in, or null if it is closed or off-screen */
function paneHost(id: string | null): HTMLElement | null {
  if (!id) return null;
  // sessions/lookup.ts owns the lookup now — exact id, no parsing. This used to dig the
  // counter out of `s<n>-<boot>` and query the container's data attribute, which
  // worked only because ids are boot-unique.
  const container = sessionContainer(id);
  if (!container || container.offsetParent === null) return null; // closed, or on a hidden view
  return container.querySelector<HTMLElement>(".rendered-input-row") ?? container;
}

function mount(host: HTMLElement | null) {
  const dest = host ?? pillHome;
  if (pill.parentElement !== dest) {
    if (dest === pillHome) pillHome.insertBefore(pill, pillAnchor);
    else dest.appendChild(pill);
  }
  pill.classList.toggle("overlay", dest !== pillHome);
}

/** True while the message on screen belongs to a pane — i.e. a voice operation is
 *  running and it is not an error. It stays true when the pill is sitting in its
 *  bottom-bar fallback because the target is hidden: the pane can come back. */
function paneBound(): boolean {
  return !pill.classList.contains("hidden") && !pill.classList.contains("error");
}

/** re-resolve the host for whatever message is on screen right now */
function remount() {
  const bound = paneBound();
  mount(bound ? paneHost(target) : null);
  // Observing is tied to the operation, NOT to where the pill currently sits:
  // hiding the target sends the pill home, and stopping there would leave
  // nothing to notice the target coming back — switch away and back mid-record and the
  // pill would stay in the bottom bar for the rest of the take.
  if (bound) watchPanes();
  else unwatchPanes();
}

/** While a voice operation is pane-bound, a tab switch, a dual-view change and the
 *  target closing or reappearing all reach it as layout mutations under #main
 *  (sessions.ts hides a pane with an inline `display`). Re-resolving on those keeps
 *  the pill wherever the words are actually going. */
function queueRemount() {
  if (remountQueued) return;
  remountQueued = true;
  requestAnimationFrame(() => { remountQueued = false; remount(); });
}
/** Watches the target container and each ancestor up to #main, no subtree: what decides
 *  `paneHost` is the container, its `offsetParent` chain and its input row. Re-armed on
 *  every remount so a reparented container is picked up. */
function watchPanes() {
  paneObserver ??= new MutationObserver(queueRemount);
  paneObserver.disconnect();
  const main = document.getElementById("main")!;
  const init: MutationObserverInit = { childList: true, attributes: true, attributeFilter: ["style", "class"] };
  let el: HTMLElement | null = target ? sessionContainer(target) : null;
  if (el && !main.contains(el)) el = null;
  for (; el && el !== main; el = el.parentElement) paneObserver.observe(el, init);
  paneObserver.observe(main, init);
}
function unwatchPanes() {
  paneObserver?.disconnect();
  paneObserver = undefined;
}

function flash() {
  pill.classList.remove("flash");
  void pill.offsetWidth; // restart the animation
  pill.classList.add("flash");
}
