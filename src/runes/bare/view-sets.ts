// DOM pieces of a vault rune card and its Modify switch.
import { iconImg } from "../../icon-img";
import type { RuneItem } from "../types";
import { BARE_SCOPE, cardDetails, runeName, type CardCtx } from "../cards";
import { el } from "./agent-view";
import type { ViewLib } from "./view-types";
import { loadedLine } from "../ledger";
import { nextRuneState, runeState, stateDisabled, stateLabel, stateTooltip, type RuneState } from "./rune-state";
import { driftOf } from "./cake";

type Brick = ViewLib["bricks"][number];

/** Pure card state used by the cost bar. */
export const brickOn = (_lib: ViewLib, b: Brick): boolean => runeState(b) === "on";

/** The round switch chip every rune card carries in Modify. */
export function runeSwitch(state: RuneState, locked: boolean, title: string, flip: () => void): HTMLButtonElement {
  const sw = el("button", "runes-chip runes-bare-switch");
  sw.type = "button";
  sw.disabled = locked;
  sw.setAttribute("aria-label", stateLabel(state));
  sw.title = title;
  sw.appendChild(iconImg(state === "on" ? "check-circle" : state === "shadow" ? "inspect" : "dismiss-circle"));
  sw.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); flip(); });
  return sw;
}

export function runeControls(b: Brick, state: RuneState, locked: boolean, extra: string, flip: (state: RuneState) => void): HTMLElement[] {
  const sw = runeSwitch(state, stateDisabled(b, locked), stateTooltip(state, b.required, extra), () => flip(nextRuneState(state, b.addable)));
  if (!b.required) return [sw];
  const chip = el("span", "runes-chip", "Required");
  chip.title = stateTooltip(state, true);
  chip.prepend(iconImg("lock"));
  return [chip, sw];
}

const TIP_EDITED = "The library copy of this rune changed after the vault locked; this session keeps the text it loaded.";
const TIP_LOCK = "Locks this tab's vault now; the first message locks it too.";

/** The Lock button in the Runes head: `Lock` while the session's vault is open, `Locked` (disabled) once it locks. */
export function lockButton(): HTMLButtonElement {
  const b = el("button", "ws-btn runes-lock");
  b.type = "button";
  b.hidden = true;
  return b;
}

/** Repaints the Lock button; hidden when the tab has no vault record. */
export function paintLock(b: HTMLButtonElement, locked: boolean | null, busy: boolean): void {
  b.hidden = locked === null;
  b.disabled = busy || locked === true;
  b.setAttribute("aria-pressed", String(locked === true));
  b.replaceChildren(iconImg("lock"), el("span", "", locked ? "Locked" : "Lock"));
  b.title = locked ? "" : TIP_LOCK;
}

/** One rune as the ordinary card; `tail` carries the switch in Modify. A vault rune edited in its library after
 *  lock carries the Edited After This Session marker. */
export function runeCard(lib: ViewLib, b: Brick, o: { dim: boolean; tail: HTMLElement[]; card: CardCtx; read?: boolean }): HTMLDetailsElement {
  if (driftOf(b)) { const m = el("span", "runes-chip also", "Edited After This Session"); m.title = TIP_EDITED; o = { ...o, tail: [m, ...o.tail] }; }
  const rune = { id: b.id, kind: b.kind, scope: [], activate: b.activate, description: b.description, path: b.path, body: b.body,
    origin: b.origin, closesWhen: b.closesWhen, why: b.why, example: b.example };
  const globs = b.activate === "paths" ? b.paths ?? [] : [];
  const card = cardDetails(rune, {
    // the name is the slug's Title Case form; a sentence description or heading goes to the tooltip (user, 2026-10-22)
    name: runeName({ id: b.id, path: b.path } as RuneItem),
    dim: o.dim,
    title: [b.id, ...new Set([b.description, b.section.join(" / ")].filter(Boolean)), ...(o.read ? [loadedLine({ reason: "recall" })] : [])].join("\n"),
    scopes: [{ icon: BARE_SCOPE.icons[lib.scope], title: `Scope: ${BARE_SCOPE.names[lib.scope]}` }],
    tail: o.tail,
    barScope: BARE_SCOPE.names[lib.scope],
    glob: globs.length ? { text: globs[0], title: globs.join("\n") } : undefined,
  }, o.card);
  if (b.activate === "recall" || b.activate === "paths") card.classList.add(`act-${b.activate}`);
  if (o.read) card.classList.add("is-read");
  card.dataset.id = b.id;
  return card;
}
