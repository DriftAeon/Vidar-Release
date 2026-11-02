// How a rune reached a session, as the Bare vault view's tooltip words it.

export interface LoadReason { reason: "always" | "path" | "recall"; trigger?: string }

export function loadedLine(load: LoadReason): string {
  if (load.reason === "always") return "Loaded: Always";
  if (load.reason === "recall") return "Loaded: Recall";
  return load.trigger ? `Loaded: Path (${load.trigger})` : "Loaded: Path";
}
