// Message-open tracking for voice: whether a tab has an unsent message being composed, so one
// dictated message takes one marker. Terminal onData feeds noteTyped; voice reads and sets it.

/* ---- message-open tracking (voice) ----
   Whether a tab has an unsent message being composed. Voice uses it to mark a
   MESSAGE as dictated rather than each burst of speech: dictating in three
   presses is one message and takes one marker.

   The signal is exact rather than a timer, because a timer gets both directions
   wrong — a long thinking pause double-marks, and a genuinely new message
   dictated soon after the last one silently loses its marker, which is the
   failure the marker exists to prevent. `term.onData` is the single funnel for
   every byte the user types into a terminal tab, so "open until the next ender"
   is the truth, not an estimate. */
const messageOpen = new Set<string>();

/** onData: any ender closes the composing message. `\r`/`\n` submit it, `\x03`
 *  and `\x1b` abandon it. The sessions panel's own programmatic `"\x1b\r"` writes go
 *  through `write_pty` directly and never reach onData, so they cannot reset it. */
export function noteTyped(id: string, data: string) {
  if (/[\r\n\x03\x1b]/.test(data)) messageOpen.delete(id);
}

/** Voice: true when this tab already has an unsent message in progress. */
export function hasOpenMessage(id: string): boolean {
  return messageOpen.has(id);
}

/** Voice: a transcript was just written into this tab, so a message is now open. */
export function markMessageOpen(id: string) {
  messageOpen.add(id);
}

/** Wakeword: a programmatic submit ("\r" via write_pty) never reaches onData, so
 *  noteTyped never sees it and the message would stay "open" forever. Called right
 *  after that submit so the NEXT utterance gets `markVoice`'s "[Voice] " prefix too,
 *  not just the first one of the session. */
export function clearOpenMessage(id: string) {
  messageOpen.delete(id);
}
