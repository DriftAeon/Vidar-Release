// The seam between a notice card's Ask Agent to Fix button and the launcher that opens the fix tab.
// The launcher registers an opener at startup (main.ts, launcher/fix-tab.ts); the panel never imports
// the launcher. Same shape as the setter seam in launcher/roster.ts.

/** What the fix tab needs to word its prompt. */
export interface FixRequest {
  /** "Codex" or "Claude": the tab that showed the warning */
  agentLabel: string;
  /** the warned tab's launch folder, where the fix tab opens */
  folder: string;
  /** the warning text as the card showed it */
  warning: string;
}

export interface FixOpener {
  /** True while the launcher has a row that can host the fix tab. */
  available: () => boolean;
  /** Resolves once the fix tab exists; rejects with the reason it could not open. */
  open: (req: FixRequest) => Promise<void>;
}

/** The disabled tooltip of the button when no launcher row can open the fix tab. */
export const FIX_UNAVAILABLE = "Claude isn't in the launcher";

let opener: FixOpener | null = null;

export function setFixOpener(next: FixOpener | null): void {
  opener = next;
}

export function fixAvailable(): boolean {
  return !!opener && opener.available();
}

export function requestFix(req: FixRequest): Promise<void> {
  if (!opener || !opener.available()) return Promise.reject(new Error(FIX_UNAVAILABLE));
  return opener.open(req);
}
