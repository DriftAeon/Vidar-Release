/* Speak: bottom-bar button left of the close lock. A power
   switch first, a read button second, so nothing loads just because Vidar
   opened:

     off      → click: arm — start the warm Kokoro process, warm the rewrite
                slot's model (local-voice\speak.py --arm). Muted glyph, faded.
     armed    → click: read the focused tab's latest Claude reply aloud —
                speak.py pulls it from the session transcript, the rewrite slot
                rewrites it for the ear, Kokoro speaks it, first sentence first.
                Right-click: off (the Kokoro process exits; a server model stays
                LM Studio's business and unloads on its own TTL).
     speaking → click: stop.

   On start the button asks speak.py --status, so a sidecar left warm by an
   earlier Vidar or the CLI shows as armed rather than off. Early testing, so
   failure is graceful and quiet: the error lands in the tooltip and the
   console. The button does not know the tab's transcript; it hands over the
   tab's start cwd and the script finds the newest transcript under that
   project. After a read the tooltip holds the spoken text, so what the rewrite made
   of the reply can be read as well as heard. */
import { invoke } from "../ipc";
import { iconImg } from "../icon-img";
import { getActiveSessionAgent, getActiveSessionCwd, getActiveSessionId, sessionLaunchInfo } from "./sessions";
import type { SpeakTarget } from "./reply-events";
import { openVoiceMap } from "./voice-map";

export type SpeakResult = {
  ok: boolean;
  error?: string;
  spoken?: string;
  source?: string;
  budget?: number;
  words_in?: number;
  words_out?: number;
  rewrite_seconds?: number;
  synth_seconds?: number;
  audio_seconds?: number;
  first_audio_seconds?: number;
  sidecar_wait_seconds?: number;
};
/** The rewrite adapter's `warm` keys are merged in (rewrite_openai.py WARM_KEYS). */
export type ArmResult = { ok: boolean; error?: string; sidecar_wait_seconds?: number; lmstudio_start_seconds?: number; model_load_seconds?: number; model?: string };
/** `owner`: the sidecar's spawner tag (null from a pre-tag build); `owned`: Vidar spawned it.
 *  `rewrite`: the rewrite adapter's `status` (rewrite_openai.py STATUS_KEYS) or its error. */
export type SpeakStatusResult = {
  ok: boolean; sidecar?: boolean; owner?: string | null; owned?: boolean; rewrite?: { model?: string; error?: string };
};

export type SpeakState = "off" | "arming" | "armed" | "speaking";
type State = SpeakState;

const TITLES: Record<State, string> = {
  off: "Speak Off",
  arming: "Loading Voice…",
  armed: "Speak Reply",
  speaking: "Stop Speaking",
};

/** What auto-speak (panels/autospeak.ts) needs without duplicating the arm/read logic. */
export interface SpeakApi {
  /** Read the given tab's latest reply aloud: arms first if off, interrupts
   *  and re-reads if already speaking, ignored while arming (rare — a reply
   *  landing in the ~5s the sidecar takes to warm up is not queued). `cwd` is
   *  the cwd of the tab that fired the reply, captured at dispatch time
   *  — not re-read from the focused tab, which may have
   *  changed by the time this runs. */
  autoSpeak(target: SpeakTarget): void;
  /** Current button state for the voice map; `error` is the failure title while the
   *  button shows its error styling, else null. */
  state(): { state: SpeakState; error: string | null };
  /** The user's kill (the voice map's Speak Off): ends any sidecar, Vidar's or the CLI's. */
  off(): void;
}

export function initSpeak(btn: HTMLButtonElement, signal?: AbortSignal): SpeakApi {
  let state: State = "off";
  let error: string | null = null;
  const glyph = { off: iconImg("speaker-off"), on: iconImg("speaker-on") };
  btn.append(glyph.off);

  // After dispose (signal aborted) a late IPC result must not repaint #speak-btn: the button is
  // shared with any remounted instance, whose state it would desync.
  const dead = () => signal?.aborted === true;

  const paint = (next: State, title = TITLES[next], err = false) => {
    if (dead()) return;
    state = next;
    error = err ? title : null;
    const off = next === "off";
    const want = off ? glyph.off : glyph.on;
    if (btn.firstChild !== want) btn.replaceChildren(want);
    btn.classList.toggle("off", off);
    btn.classList.toggle("busy", next === "arming" || next === "speaking");
    btn.classList.toggle("err", err);
    btn.title = title;
  };
  paint("off");

  // A sidecar already warm (earlier Vidar, or tools\voice\speak.ps1) means armed.
  invoke("speak_status")
    .then((s) => { if (!dead() && s?.sidecar) paint("armed"); })
    .catch((e) => console.warn("speak status:", e));

  const arm = async () => {
    paint("arming");
    try {
      const r = await invoke("speak_arm");
      if (dead()) return;
      if (r && r.ok) {
        paint("armed", `${TITLES.armed}\n\nkokoro ${r.sidecar_wait_seconds ?? "-"} s · lmstudio ${r.lmstudio_start_seconds ?? "-"} s · model ${r.model_load_seconds ?? "-"} s (${r.model ?? "?"})`);
      } else {
        paint("off", `Speak failed to load: ${r?.error ?? "no result"}`, true);
      }
    } catch (e) {
      paint("off", `Speak failed to load: ${String(e)}`, true);
      console.error("speak arm:", e);
    }
  };

  // Set by autoSpeak() when it interrupts a running read: speak_stop kills the
  // child but read()'s own invoke("speak_last") is still the one in flight, so
  // the retrigger waits for it to settle (the backend allows one child at a
  // time) before starting the reply that superseded it.
  let retrigger = false;

  const activeTarget = (): SpeakTarget => {
    const tab = getActiveSessionId();
    return { cwd: getActiveSessionCwd(), agent: getActiveSessionAgent(), tab, profile: (tab && sessionLaunchInfo(tab)?.profile) || null };
  };

  const read = async (target: SpeakTarget) => {
    paint("speaking");
    try {
      const r = await invoke("speak_last", target);
      if (dead()) return;
      if (r && r.ok) {
        const t = `${r.words_in ?? "-"}→${r.words_out ?? "-"} words (budget ${r.budget ?? "-"}) · Rewrite ${r.rewrite_seconds ?? "-"} s · first audio ${r.first_audio_seconds ?? "-"} s · audio ${r.audio_seconds ?? "-"} s · ${r.source ?? ""}`;
        paint("armed", `${TITLES.armed}\n\n${t}\n\n${r.spoken ?? ""}`);
      } else {
        paint("armed", `Speak failed: ${r?.error ?? "no result"}`, true);
      }
    } catch (e) {
      paint("armed", `Speak failed: ${String(e)}`, true);
      console.error("speak:", e);
    } finally {
      if (retrigger) {
        retrigger = false;
        if (!dead()) void read(target);
      }
    }
  };

  const off = async () => {
    try {
      // Owner-scoped (plan §1): a Kokoro a terminal started or claimed, or one from before the
      // owner tag, stays up, and the button says so instead of painting Off over it.
      const r = await invoke("speak_off");
      if (dead()) return;
      if (r?.sidecar && !r.stopped) {
        const who = r.owner ? `Owner ${r.owner}` : "No Owner Tag";
        paint("armed", `Kokoro Kept Running: ${who}, Not Vidar`, true);
      } else {
        paint("off");
      }
    } catch (e) {
      paint("armed", `Speak off failed: ${String(e)}`, true);
      console.error("speak off:", e);
    }
  };

  btn.addEventListener("click", () => {
    if (state === "off") void arm();
    else if (state === "armed") void read(activeTarget());
    else if (state === "speaking") {
      // Clear a pending retrigger too: the stop click must cancel any
      // re-read still queued from an interrupted autoSpeak, not just the
      // audio in flight.
      retrigger = false;
      invoke("speak_stop").catch((e) => console.error("speak stop:", e));
    }
    // arming: ignore the click; it resolves on its own.
  }, { signal });
  // RMB opens the voice-map popup; "Speak Off" lives in there as a red
  // button, which calls the returned off().
  btn.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openVoiceMap(btn);
  }, { signal });

  const autoSpeak = (target: SpeakTarget) => {
    if (state === "off") {
      void (async () => {
        await arm();
        if (!dead() && (state as State) === "armed") void read(target);
      })();
    } else if (state === "speaking") {
      retrigger = true;
      invoke("speak_stop").catch((e) => console.error("speak stop:", e));
    } else if (state === "armed") {
      void read(target);
    }
    // arming: a reply landing mid-arm is dropped rather than queued (rare, ~5s window).
  };

  return { autoSpeak, state: () => ({ state, error }), off: () => void off() };
}
