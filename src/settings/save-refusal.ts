// The refusal shown when a save is blocked because vidar.json reported an error on read.
// Saving would overwrite the user's bad-but-intended entries, so the refusal stays; only the
// wording differs: a partial load (config.rs typed_lenient) lists what was ignored or skipped, a
// hard failure (`vidar.json parse error`) means nothing loaded.

// Wire contract with src-tauri/src/config.rs PARTIAL_KEYS_PREFIX / PARTIAL_ENTRIES_PREFIX (a Rust
// test pins the full prefixes). Change either side only together with the other.
const PARTIAL_MARKS = ["defaults used for them: ", "skipped entries: "];

export function saveRefusal(error: string): string {
  const hits = PARTIAL_MARKS.map((m) => ({ m, at: error.indexOf(m) })).filter((h) => h.at >= 0);
  if (hits.length === 0) return `vidar.json Did Not Load: ${error}`;
  const first = hits.reduce((a, b) => (b.at < a.at ? b : a));
  const rest = error.slice(first.at + first.m.length);
  return `vidar.json Has Errors: ${rest} — Fix The File To Save`;
}
