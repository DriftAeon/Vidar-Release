/* Listen stop: runs at launch when listen ends up off, and on a live
   switch-off (mounts/listen.ts re-exports it). Only listen_stop: the wake-word sidecar and the
   capture stream end. Never save_wakeword, so `enabled` survives and listen comes back as the
   user left it when the capability is on again. Listen mounted again by the time this runs (a
   Recheck found voice after a launch-time stop was queued): leave it up. The microtask wait is
   because on a live switch-off the registry calls stop() before it withdraws `provided`. No UI here. */
import { invoke } from "../../ipc";
import { use } from "../registry";

export async function stop(): Promise<void> {
  await Promise.resolve();
  if (use("listen") !== null) return;
  try {
    await invoke("listen_stop");
  } catch (e) {
    console.error("listen stop:", e);
  }
}
