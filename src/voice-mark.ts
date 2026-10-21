// The `[Voice]` marker for dictated text (kept out of voice.ts so
// listen.ts can mark a wake-word transcript without pulling the dictation service into the entry
// chunk). Uses only session helpers.
import { hasOpenMessage, markMessageOpen, renderedBody, sessionKind } from "./panels/sessions";

// A model that knows a line was dictated can read through the garble; without
// the marker it treats "sauce-tori-sauce-openup.is" as the user's own spelling
// Only for a terminal tab running an agent:
//   - a shell tab gets a broken command line, which is the whole reason this is
//     conditional;
//   - a rendered body splices text in at the caret (rendered.ts), so it is
//     marked only into an empty composer; that also makes it once per message;
//   - `agent` is fixed at tab creation, so a Claude tab whose REPL the user
//     exited still gets the marker at a bare prompt. Accepted: the alternative
//     is probing the pty on every transcript.
//
// Once per MESSAGE, not per take: dictating one message in three presses put
// three markers in one line. `hasOpenMessage` is driven by the
// tab's own keystrokes and stays true until the user submits or abandons, so a
// continuation is silent and a genuinely new message is marked again.
const MARK = "[Voice] ";

export function markVoice(target: string, text: string): string {
  const k = sessionKind(target);
  if (k?.body === "rendered") return renderedBody(target)?.draft().trim() === "" ? MARK + text : text;
  const spoken = k?.body === "terminal" && (k.agent === "claude" || k.agent === "codex" || k.agent === "gemini" || k.agent === "pi");
  if (!spoken) return text;
  const first = !hasOpenMessage(target);
  markMessageOpen(target);
  return first ? MARK + text : text;
}
