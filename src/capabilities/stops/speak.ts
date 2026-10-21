/* Speak stop: runs at launch when speak ends up off, and on a live
   switch-off (mounts/speak.ts re-exports it). Calls speak_off, which runs the tts slot's own
   `stop` with {owner} = "vidar" (speak.rs `OWNER`); the stock Kokoro
   adapter ends its warm process only while it is still tagged "vidar", and the process
   re-checks the tag on /quit, so one a terminal started or claimed survives. The owner check
   lives in the adapter, so there is no status round trip first.
   A report that says the voice venv is missing: no spawn. No report yet (detection past its
   deadline or failed): try anyway; a failure (no tts pick yet, say) stays a console line.
   No UI here. */
import { depsReport } from "../../deps/state";
import { invoke } from "../../ipc";

export async function stop(): Promise<void> {
  const report = depsReport();
  if (report && report.deps.find((d) => d.id === "voice")?.found !== true) return;
  try {
    await invoke("speak_off");
  } catch (e) {
    console.error("speak stop:", e);
  }
}
