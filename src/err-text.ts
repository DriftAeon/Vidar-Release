/** A caught value as the text to show: an Error's message, a thrown object's string `message` (the Runes
 * Flow view's own copy read it before it moved here), else the value stringified. A rejected invoke carries
 * the backend's String error, shown exactly as it came. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = e && typeof e === "object" ? (e as { message?: unknown }).message : undefined;
  return typeof m === "string" ? m : String(e);
}
