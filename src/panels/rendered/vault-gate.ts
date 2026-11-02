// A Rendered Bare tab that waits for its Rune Vault: the launcher opens the tab at once and the pick (Runes
// panel, chat card) releases its first spawn. Pure: no DOM, no IPC. `pick` takes any vault id, so a draft vault
// from a later Modify-before-start path fits without a change here.

export interface VaultGate {
  /** True until a pick or a cancel releases the gate. */
  readonly pending: boolean;
  /** Resolves once the gate is released (a pick, or the tab closing). Resolved at once when not pending. */
  wait(): Promise<void>;
  /** Releases the gate with `vault`; a no-op after the first release. Returns whether this call released it. */
  pick(vault: string): boolean;
  /** Releases the gate without a vault (the tab closed): waiters resume and find the body disposed. */
  cancel(): void;
  /** The vault the pick named, null while pending or after a cancel. */
  picked(): string | null;
}

export function createVaultGate(): VaultGate {
  let pending = true;
  let chosen: string | null = null;
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  return {
    get pending() { return pending; },
    wait: () => (pending ? released : Promise.resolve()),
    pick(vault) {
      if (!pending) return false;
      pending = false;
      chosen = vault;
      release();
      return true;
    },
    cancel() {
      if (!pending) return;
      pending = false;
      release();
    },
    picked: () => chosen,
  };
}
