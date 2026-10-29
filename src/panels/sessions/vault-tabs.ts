// A tab's Rune Vault, looked up the way a respawn would (Falcon session, then thread id, then tab), and the
// respawn of the other Rendered tabs on a vault after an unlocked edit.
import { invoke, type VaultSession } from "../../ipc";
import * as lookup from "./lookup"; // namespace: a test stub of lookup need not list every export

/** `rune_vault_session` for `tab` with the identity a re-adopted tab carries: its Falcon session and thread id.
 *  The backend matches the Falcon session first, so an adopted tab finds the record its launch wrote. */
export function tabVaultSession(tab: string): Promise<VaultSession | null> {
  return invoke("rune_vault_session", { tab, ...tabIdentity(tab) });
}

/** The Falcon session and thread id tab `tab` runs now (null when unknown). A re-adopted tab has a new tab id
 *  while its session records keep the old one, so a record lookup or move must carry these, not the tab id alone. */
export function tabIdentity(tab: string): { falconSession: string | null; threadId: string | null } {
  const t = (lookup.driveSnapshot?.().tabs ?? []).find((x) => x.id === tab);
  return { falconSession: t?.falconSession ?? null, threadId: t?.sessionId ?? null };
}

export interface VaultTabsDeps {
  tabs(): { id: string; falconSession: string | null; sessionId: string | null }[];
  /** null for a tab with no Rendered body */
  body(id: string): { isBusy(): boolean; respawnFresh(): Promise<void> } | null;
  recorded(tab: string, falconSession: string | null, threadId: string | null): Promise<string | null>;
  locked(vault: string): Promise<boolean>;
}

const defaults: VaultTabsDeps = {
  tabs: () => lookup.driveSnapshot?.().tabs ?? [],
  body: (id) => lookup.renderedBody(id),
  recorded: (tab, falcon, thread) => lookup.recordedVault(tab, falcon, thread),
  locked: async (id) => !!(await invoke("rune_vault_read", { id })).vault.lockedUtc,
};

/** Respawns every Rendered tab except `except` whose recorded vault is `vault`, fresh, so it loads the edit.
 *  A busy tab (mid-turn or hydrating) is skipped, and the lock is re-read before each tab: a first message on
 *  another tab may have locked the vault since the edit. A Raw tab has no respawn route. Returns the tab ids
 *  respawned; one tab's failure never stops the rest. */
export async function respawnVaultTabs(vault: string, except: string, deps: VaultTabsDeps = defaults): Promise<string[]> {
  const done: string[] = [];
  for (const t of deps.tabs()) {
    if (t.id === except) continue;
    try {
      const body = deps.body(t.id);
      if (!body || body.isBusy()) continue;
      if ((await deps.recorded(t.id, t.falconSession, t.sessionId)) !== vault) continue;
      if (await deps.locked(vault) || body.isBusy()) continue;
      await body.respawnFresh();
      done.push(t.id);
    } catch { /* skip this tab */ }
  }
  return done;
}
