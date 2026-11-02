// src\control\launch-vault.ts — which Rune Vault an agent's `ctl.spawn` loads. Pure: drive.ts gathers
// the inputs (the roster row, the user's Last Vault, the vault list) and calls this.
//
// `asked` is the request's `vault`: a vault id or "last" (the user's Last Vault for that agent). Unset means
// Last Used too; with no Last Vault there is nothing to load and the spawn is refused. A set `vault` on a row
// without a launch profile (not Bare) is refused: that launch would drop it quietly. Unset there is ignored.

export interface LaunchVaultInput {
  /** The user's Last Vault for this agent (roster `defaultVault`); undefined when there is none yet. */
  last: string | undefined;
  asked: string | undefined;
  /** Ids from `rune_vault_list`; null when the list could not be read (the membership check is skipped). */
  listed: readonly string[] | null;
  /** The resolved row carries a launch profile (a Bare row). */
  bare: boolean;
}

export type LaunchVaultResult = { vault: string | undefined } | { refuse: string };

const NO_LAST_VAULT_REFUSAL = "no Last Vault for this agent yet; pass vault <id> or pick one in a Rendered tab first";

export function resolveLaunchVault(i: LaunchVaultInput): LaunchVaultResult {
  if (!i.bare) {
    return i.asked === undefined ? { vault: undefined } : { refuse: "vault needs a Bare row" };
  }
  const known = (id: string): boolean => i.listed === null || i.listed.includes(id);
  const id = i.asked === undefined || i.asked === "last" ? i.last : i.asked;
  if (id === undefined || id === "") return { refuse: NO_LAST_VAULT_REFUSAL };
  if (!known(id)) return { refuse: `unknown vault "${id}"` };
  return { vault: id };
}
