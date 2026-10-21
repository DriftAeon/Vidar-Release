// Sticky pair (2026-10-09): the last Dual-View pair is remembered, so stepping out to another
// tab and clicking either member brings the pair back. It ends on Single-View or when a member closes.

let pair: [string, string] | null = null;

export function rememberPair(a: string, b: string): void {
  pair = [a, b];
}

/** Single-View, or a closing tab (`id`): forget the pair (only if `id` is in it, when given). */
export function forgetPair(id?: string): void {
  if (id === undefined || pair?.includes(id)) pair = null;
}

/** The other member of the pair, when `id` is in it and `exists(mate)` still holds. */
export function pairMate(id: string, exists: (k: string) => boolean): string | undefined {
  const mate = pair?.[0] === id ? pair[1] : pair?.[1] === id ? pair[0] : undefined;
  return mate !== undefined && exists(mate) ? mate : undefined;
}
