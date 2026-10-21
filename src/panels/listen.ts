/* Listen: wake word -> VAD -> whisper -> the focused tab (submitted when
   wakeword.autoSubmit is on; see deliver()). Bottom-bar button left
   of Speak (index.html, #mic-group), modelled on speak.ts's power-switch shape but driven by
   Rust's own state machine (listen.rs) instead of a request/response round trip:

     off          -> left click: listen_start(cfg, prompt); Rust resolves the wake and stt slots.
     listening    -> right click: listen_stop. A wake word has not fired yet.
     heard        -> the wake word fired; VAD is waiting for speech to actually start
                     (Rust reverts to "listening" on its own after heardTimeoutMs).
     recording    -> speech is being captured.
     transcribing -> whisper is running.
     delivering   -> a transcript landed and is being written to the focused tab.
     busy         -> a wake word arrived while the previous utterance was still being
                     handled; Rust does not buffer it, the UI just flashes.

   Rust owns the state machine and emits `listen-state {state, error?}`; this module
   only repaints. `listen-transcript {text}` is this module's cue to deliver: write the
   (prefixed) text to the focused tab, then ack with listen_delivered() in every case so
   Rust can leave "delivering" — a no-focused-tab miss is not a delivery failure Rust needs
   to retry, it is a tooltip for the user to read and re-utter.

   Mounted by the capability registry (capabilities/mounts/listen.ts, gated on the voice
   dependency); everything here is undone when `signal` aborts. */
import { invoke, listen as ipcListen } from "../ipc";
import { lucide } from "../icons";
import { iconImg } from "../icon-img";
import { clearOpenMessage, getActiveSessionId, isPageTab, writeToSession } from "./sessions";
import { markVoice } from "../voice-mark";
import { playChime, primeChime } from "../chime";
import { openVoiceMap } from "./voice-map";
import { addSettingRow } from "../shortcuts";
import type { VoiceCfg } from "../voice";

/** Provided as "listen" (mounts/listen.ts): what the voice map reads and its Listen Off calls. */
export interface ListenApi {
  state(): ListenState;
  /** The user's stop: listen_stop and `enabled: false` saved. */
  off(): void;
  wakeword: WakewordCfg;
  /** The live whisper config (dictation's, when it is on). */
  readonly voice: VoiceCfg | undefined;
}

export interface WakewordCfg {
  enabled: boolean;
  device: string;
  model: string;
  threshold: number;
  endSilenceMs: number;
  maxUtteranceMs: number;
  heardTimeoutMs: number;
  vadStart: number;
  vadStop: number;
  prerollMs: number;
  autoSubmit: boolean;
}

// "starting" is UI-only: painted on the click, before listen_start resolves (sidecar spawn
// plus model load is a second or two). Rust never emits it.
type ListenState = "off" | "starting" | "listening" | "heard" | "recording" | "transcribing" | "delivering" | "busy";
type State = ListenState;

const TITLES: Record<State, string> = {
  off: "Listen Off",
  starting: "Starting the Wake-Word Sidecar…",
  listening: "Listening for the Wake Word",
  heard: "Wake Word Heard…",
  recording: "Recording…",
  transcribing: "Transcribing…",
  delivering: "Delivering to the Focused Tab…",
  busy: "Busy — Finishing the Last Utterance",
};

interface ListenStatePayload {
  state: State;
  error?: string;
}
interface ListenTranscriptPayload {
  text: string;
}

/** `voice` is read per start, so a whisper-model edit in dictation's settings reaches listen. */
export function initListen(
  btn: HTMLButtonElement, wakeword: WakewordCfg, voice: () => VoiceCfg | undefined, signal: AbortSignal,
  onState?: (state: ListenState) => void,
): ListenApi {
  const cfg = wakeword;
  let state: State = "off";
  // Sticks in the tooltip when a transcript has nowhere to go (no focused tab);
  // replaced the moment the next utterance lands.
  let pending: string | null = null;
  const glyph = { off: lucide("mic-off"), on: iconImg("mic") };
  btn.append(glyph.off);

  const paint = (next: State, err?: string) => {
    if (signal.aborted) return; // a late event must not repaint a disposed (or remounted) button
    state = next;
    const want = next === "off" ? glyph.off : glyph.on;
    if (btn.firstChild !== want) btn.replaceChildren(want);
    btn.dataset.state = next;
    onState?.(next);
    const base = TITLES[next];
    btn.title = err ? `${base}\n\n${err}` : pending ? `${base}\n\nNo Focused Tab · "${pending}"` : base;
  };
  paint("off");

  invoke("listen_status")
    .then((s) => { if (s && s !== "off") paint(s as State); })
    .catch((e) => console.warn("listen status:", e));

  // Persist on/off: the user's last choice comes back on the next launch via
  // cfg.enabled (the mount passes the loaded config; `start(false)` below). Whole-struct save.
  const remember = (enabled: boolean) => {
    if (cfg.enabled === enabled) return;
    cfg.enabled = enabled;
    void invoke("save_wakeword", { cfg }).catch((e) => console.warn("save wakeword:", e));
  };

  const start = async (fromClick: boolean): Promise<boolean> => {
    const v = voice();
    if (!v) return false;
    // Priming an AudioContext needs a real user gesture; a config-driven auto-start
    // (cfg.enabled on load) has none, so the first pointerdown anywhere primes it instead.
    if (fromClick) primeChime();
    else document.addEventListener("pointerdown", () => primeChime(), { once: true, signal });
    paint("starting");
    try {
      await invoke("listen_start", { cfg, prompt: v.prompt });
      // Switched off while listen_start was in flight: the stop's listen_stop already moved the
      // slot off Starting and Rust tears this session down (listen.rs start_session). No second
      // listen_stop: after a quick remount it would kill the new mount's session.
      if (signal.aborted) return false;
      // Rust emits "listening" once the sidecar is up and the stream is open; paint
      // eagerly in case that event landed before we got here.
      if (state === "starting") paint("listening");
      remember(true);
      return true;
    } catch (e) {
      paint("off", String(e));
      console.error("listen start:", e);
      return false;
    }
  };

  const stop = async () => {
    try {
      await invoke("listen_stop");
      paint("off");
    } catch (e) {
      paint("off", String(e));
      console.error("listen stop:", e);
    }
    remember(false);
  };

  const labels = new Map<string, string>(); // manifest id -> label, filled by the picker below
  const label = (id: string) => labels.get(id) ?? id;
  const removeRow = addSettingRow({
    name: "Wake Word",
    description: "Restarts Listen with an installed model from the wake slot's manifest.", // note-ok: user, 2026-10-01 (consequence: a change restarts Listen)
    category: "audio",
    control: () => {
      const sel = document.createElement("select");
      sel.className = "sc-select";
      sel.disabled = true;
      // The wake slot's manifest models[] (voice_slots_status) is the one list; only installed
      // files are offered, so a dropped-in ONNX never becomes a one-click pick.
      void invoke("voice_slots_status")
        .then((rows) => {
          const models = rows.find((r) => r.slot === "wake")?.models ?? [];
          for (const m of models) labels.set(m.id, m.label ?? m.id);
          const installed = models.filter((m) => m.installed);
          for (const m of installed) sel.append(new Option(label(m.id), m.id));
          if (cfg.model && !installed.some((m) => m.id === cfg.model)) {
            sel.append(new Option(`${label(cfg.model)} (Not Installed)`, cfg.model));
          }
          sel.value = cfg.model;
          sel.disabled = false;
        })
        .catch((e) => {
          sel.append(new Option(`Models Unavailable: ${String(e)}`, "__err"));
          sel.value = "__err";
        });
      sel.addEventListener("change", () => {
        // An open Settings modal keeps the rendered row after abort; the capability is off then.
        if (signal.aborted || sel.value === "__err" || sel.value === cfg.model) return;
        const next = sel.value;
        const previous = cfg.model;
        const wasRunning = state !== "off";
        sel.disabled = true;
        void (async () => {
          try {
            if (wasRunning) {
              await invoke("listen_stop");
              paint("off");
            }
            cfg.model = next;
            await invoke("save_wakeword", { cfg });
            if (wasRunning && !(await start(false))) throw new Error(`${label(next)} Failed to Start`);
          } catch (e) {
            cfg.model = previous;
            sel.value = previous;
            await invoke("save_wakeword", { cfg }).catch((saveErr) => console.error("restore wakeword:", saveErr));
            if (wasRunning && state === "off") await start(false);
            console.error("change wakeword:", e);
          } finally {
            sel.disabled = false;
          }
        })();
      });
      return sel;
    },
  });
  signal.addEventListener("abort", removeRow, { once: true });

  btn.addEventListener("click", () => {
    if (state === "off") void start(true);
    // Any other state: the sidecar is running; a left click while listening does
    // nothing (stopping is a deliberate right-click, same shape as Speak's off arrow).
  }, { signal });
  // RMB opens the voice-map popup; "Listen Off" lives in there as a red
  // button, which calls the provided off() below.
  btn.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openVoiceMap(btn);
  }, { signal });

  /** Subscribes until `signal` aborts, including when it aborts before listen() resolves. */
  const subscribe = <T>(event: string, fn: (payload: T) => void) => {
    void ipcListen<T>(event, (e) => { if (!signal.aborted) fn(e.payload); }).then((un) => {
      if (signal.aborted) un();
      else signal.addEventListener("abort", un, { once: true });
    }).catch((e) => console.error(`listen: subscribe ${event}:`, e));
  };

  subscribe<ListenStatePayload>("listen-state", ({ state: next, error }) => {
    if (next === "heard") playChime("wake");
    else if (next === "busy") playChime("busy");
    paint(next, error);
  });

  subscribe<ListenTranscriptPayload>("listen-transcript", ({ text }) => void deliver(text));

  // Target: the focused tab, like push-to-talk. With wakeword.autoSubmit on
  // (the Rust default) it is submitted there, in any tab kind; off, it
  // lands unsent. With no live focused tab, hold the text in the tooltip. A focused page tab
  // (Dependencies) has nothing to type into, so it counts as no focused tab.
  async function deliver(text: string) {
    const focused = getActiveSessionId();
    const id = focused && !isPageTab(focused) ? focused : null;
    if (!id) {
      pending = text;
      paint(state);
      await invoke("listen_delivered").catch((e) => console.error("listen delivered:", e));
      return;
    }
    const ok = await writeToSession(id, markVoice(id, text));
    if (ok && cfg.autoSubmit) {
      // Same tab as the text, even if focus moved meanwhile. A programmatic "\r" never reaches
      // onData, so the open message is cleared here and the next utterance is marked again.
      await new Promise((r) => setTimeout(r, 150));
      await writeToSession(id, "\r");
      clearOpenMessage(id);
    }
    if (ok) {
      pending = null;
      playChime("delivered");
    } else {
      pending = text; // the tab died or rejected the write mid-flight
    }
    paint(state);
    await invoke("listen_delivered").catch((e) => console.error("listen delivered:", e));
  }

  if (cfg.enabled) void start(false);

  return {
    state: () => state,
    off: () => void stop(),
    wakeword: cfg,
    get voice() { return voice(); },
  };
}
