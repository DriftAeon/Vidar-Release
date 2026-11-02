// The scrim over a Rendered tab that waits for its Rune Vault (vault-gate.ts): the transcript and composer sit under
// the Relay ask overlay's scrim and 1.5px blur, with one right-aligned line pointing to the Runes panel. No buttons:
// the pick happens only in the panel. Everything under the scrim is inert (no typing, no Tab focus) and the scrim
// lifts when the gate is released (a pick, or the tab closing).
import type { VaultGate } from "./vault-gate";

/** The note's emphasised words (bold, amber) and the whole line they sit in. */
const VAULT_SCRIM_KEY = "Rune Vault";
export const VAULT_SCRIM_NOTE = `Pick a ${VAULT_SCRIM_KEY} in the Runes Panel →`;

/** Mounts the scrim on `root` while `gate` is pending; a no-op for a tab without a pending gate. */
export function mountVaultScrim(root: HTMLElement, gate: VaultGate | null | undefined): void {
  if (!gate?.pending) return;
  const under = [...root.children] as HTMLElement[];
  const scrim = document.createElement("div");
  scrim.className = "vault-scrim";
  const note = document.createElement("span");
  note.className = "vault-scrim-note";
  const [before, after] = VAULT_SCRIM_NOTE.split(VAULT_SCRIM_KEY);
  const key = document.createElement("strong");
  key.className = "vault-scrim-key";
  key.textContent = VAULT_SCRIM_KEY;
  note.append(before, key, after);
  scrim.append(note);
  for (const el of under) el.inert = true;
  root.append(scrim);
  void gate.wait().then(() => {
    scrim.remove();
    for (const el of under) el.inert = false;
  });
}
