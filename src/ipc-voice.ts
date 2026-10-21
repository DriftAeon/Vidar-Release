/* The voice, speak and listen slice of the typed command map (ipc.ts `Commands` extends it).
   Types only: ipc.ts stays the one file that imports @tauri-apps/api, and the host tags for
   these names stay in ipc-hosts.ts's COMMAND_HOSTS, which tests/ipc-commands.test.mjs checks against
   src-tauri/src/main.rs. Split out of ipc.ts for the module-size line. */
import type { Cmd } from "./ipc";
import type { WakewordCfg } from "./panels/listen";
import type { SpeakResult, ArmResult, SpeakStatusResult } from "./panels/speak";

/** contracts/voice-slots.json slot ids. */
export type VoiceSlot = "stt" | "wake" | "rewrite" | "tts";

/** Where a pick came from: `voiceSlots.<slot>` naming the stock pack, another pack, or a legacy
 *  vidar.json key (`voice`, `voice.transcriber`, `wakeword.model`). */
export type VoiceSlotSource =
  | { kind: "stock" }
  | { kind: "pack"; pack: string }
  | { kind: "legacy"; key: string };

/** One row of `voice_slots_status` (src-tauri/src/voice_slots/mod.rs `SlotStatus`). A row with
 *  `slot: null` is a pack or manifest that failed to parse; it is never skipped. */
export interface VoiceSlotStatus {
  slot: VoiceSlot | null;
  required: boolean;
  state: "filled" | "missing" | "empty" | "broken";
  reason: string | null;
  adapter: string | null;
  label: string | null;
  model: string | null;
  bytes: number | null;
  licence: string | null;
  source: VoiceSlotSource | null;
  /** Filled rows only: `never` is a PATH command, the inline custom transcriber, or an adapter
   *  with nothing pinnable. */
  pinned: "yes" | "not-yet" | "never" | null;
  recommended: string | null;
  recommendedModel: string | null;
  fill: string | null;
  file: string | null;
  /** The adapter's `models[]` (the stock recommendation's when no adapter resolves). */
  models: VoiceSlotModel[];
  /** The pick's effort, rewrite adapters that list `efforts` only. */
  effort: string | null;
  /** Every adapter the scan found for this slot (the picker's choices). */
  adapters: VoiceSlotAdapter[];
}

export interface VoiceSlotAdapter {
  id: string;
  label: string;
  /** The pick's `model` is any id, filled verbatim (an LM Studio or Claude model id). */
  modelIds: boolean;
  efforts: string[];
  /** A picker hint, never validation. */
  suggestedModels: { id: string; label: string | null }[];
}

/** vidar.json `voiceSlots.rewrite`; `effort` only when the adapter lists `efforts`. */
export interface VoiceSlotPick { adapter: string; model?: string; effort?: string }

interface VoiceSlotModel {
  id: string;
  label: string | null;
  /** The model file is on disk. */
  installed: boolean;
  recommended: boolean;
}

export interface VoiceCommands {
  // voice (push-to-talk)
  voice_devices: Cmd<undefined, string[]>;
  voice_register: Cmd<{ chord: string }, void>;
  voice_start: Cmd<{ device: string }, void>;
  /** Transcribes through the `stt` slot, which Rust resolves from vidar.json. */
  voice_stop: Cmd<{ prompt: string; discard: boolean }, string>;
  // speak: speak.py's last JSON line, passed through as serde_json::Value
  speak_last: Cmd<{ cwd?: string | null; agent?: string | null; tab?: string | null; profile?: string | null }, SpeakResult>;
  speak_stop: Cmd<undefined, boolean>;
  speak_arm: Cmd<undefined, ArmResult>;
  speak_status: Cmd<undefined, SpeakStatusResult>;
  /** The tts slot's `stop` with {owner} = "vidar", for every caller (launch stop, live
   *  switch-off, the Speak Off button): Kokoro quits only while tagged "vidar". `sidecar` true
   *  with `stopped` false means someone else holds it (`owner` "cli": a terminal; null: from
   *  before the owner tag). `others`: the other stock engines' sidecars the same stop reached. */
  speak_off: Cmd<undefined, { ok: boolean; error?: string; sidecar?: boolean; stopped?: boolean; owner?: string | null;
    others?: { port: number; sidecar: boolean; stopped: boolean; owner: string | null }[] }>;
  // listen (wake word)
  /** `cfg` carries the tuning; its `model` is ignored: the `wake` and `stt` slots resolve in Rust. */
  listen_start: Cmd<{ cfg: WakewordCfg; prompt: string }, void>;
  stt_warm_status: Cmd<undefined, { state: "off" | "loading" | "ready" | "dead"; pid: number | null; adapter: string | null; lastPath: "warm" | "cold" | null; lastMs: number | null }>;
  listen_stop: Cmd<undefined, void>;
  listen_status: Cmd<undefined, string>;
  listen_delivered: Cmd<undefined, void>;
  // voice slots (voice_slots/mod.rs): four slot rows, then one row per broken pack or manifest
  voice_slots_status: Cmd<undefined, VoiceSlotStatus[]>;
  /** One slot's row alone (`status_one`): evaluates only that slot, so no other slot's model is hashed. */
  voice_slots_status_one: Cmd<{ slot: VoiceSlot }, VoiceSlotStatus>;
  /** Trust Current: re-pins every file the slot's adapter uses as it is now. */
  voice_slots_trust: Cmd<{ slot: VoiceSlot }, void>;
  /** Writes the rewrite slot's pick (null clears it) and returns the slot's fresh row; other slots refuse. */
  voice_slots_pick: Cmd<{ slot: VoiceSlot; pick: VoiceSlotPick | null }, VoiceSlotStatus>;
}
