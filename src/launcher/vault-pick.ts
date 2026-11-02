// The pick that releases a waiting Rendered Bare tab (panels/rendered/vault-gate.ts): the tab's launch vault
// becomes `vault`, the pick is remembered as the agent's Last Vault, and the held first spawn starts. Any vault
// id is accepted (New Rune Vault makes a named vault first, which passes through); validating it is the caller's job.
import { getFocusedSession, pendingVaultTab } from "../panels/sessions/lookup";
import { rememberVault } from "./roster";
import { startVault } from "./start-vault";

/** Picks `vault` for pending tab `tab`. False when the tab is not waiting (closed, already picked). */
export async function pickTabVault(tab: string, vault: string): Promise<boolean> {
  const first = pendingVaultTab(tab);
  if (!first?.pendingVault) return false;
  // Last Vault keeps the picked id; the tab loads its own copy (a named vault passes through)
  rememberVault(first.agent, vault);
  const loads = await startVault(first.agent, vault);
  const s = pendingVaultTab(tab); // the tab may have closed or been picked while the copy was made
  if (!s?.pendingVault) return false;
  s.vault = loads;
  const picked = s.pendingVault.pick(loads);
  // the Runes panel leaves its Pick state on the next focus refresh (the gate is released, so the tab reads as started)
  if (picked) document.dispatchEvent(new CustomEvent("vidar-focus", { detail: getFocusedSession() }));
  return picked;
}
