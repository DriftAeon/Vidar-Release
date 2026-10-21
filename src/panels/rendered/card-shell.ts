// Structure of a Rendered card: a root plus only the parts the caller asks for, each carrying
// the shared `card-*` class next to whatever legacy class the caller passes. A `details` root
// is its own body (so `:scope >` selectors in groups.ts / agents-block.ts keep working) and
// its head is the `summary`; nothing is added to it unless asked, because an extra child
// would make a thoughts-only group read as non-empty.

import { btn, el } from "./dom";
import { markSlot, type Mark } from "./marks";

type CardPart = "head" | "title" | "mark" | "body" | "actions" | "dismiss";

export interface CardShellOpts {
  root: "div" | "details";
  /** classes on the root, after `card` */
  classes?: string;
  /** parts to create; absent parts are null in the result */
  parts?: readonly CardPart[];
  /** title text (needs the `title` part) */
  title?: string;
  /** initial mark glyph (needs the `mark` part) */
  mark?: Mark;
  /** legacy class per part, kept next to the `card-*` one */
  partClasses?: Partial<Record<CardPart, string>>;
  /** dismiss handler (needs the `dismiss` part); inside a summary it cannot toggle the details */
  dismiss?: () => void;
}

export interface CardShell {
  root: HTMLElement;
  head: HTMLElement | null;
  title: HTMLElement | null;
  mark: HTMLElement | null;
  body: HTMLElement | null;
  actions: HTMLElement | null;
  dismiss: HTMLButtonElement | null;
}

const cls = (part: CardPart, legacy?: string) => (legacy ? `card-${part} ${legacy}` : `card-${part}`);

export function cardShell(o: CardShellOpts): CardShell {
  const want = new Set(o.parts ?? []);
  const pc = o.partClasses ?? {};
  const root = el(o.root, o.classes ? `${o.classes} card` : "card");
  const isDetails = o.root === "details";
  const head = want.has("head") ? el(isDetails ? "summary" : "div", cls("head", pc.head)) : null;
  const title = want.has("title") ? el("span", cls("title", pc.title), o.title ?? "") : null;
  const mark = want.has("mark") ? markSlot(o.mark ?? "idle") : null;
  const body = want.has("body") ? (isDetails ? root : el("div", cls("body", pc.body))) : null;
  const actions = want.has("actions") ? el("div", cls("actions", pc.actions)) : null;
  let dismiss: HTMLButtonElement | null = null;
  if (want.has("dismiss")) {
    const onDismiss = o.dismiss ?? (() => {});
    dismiss = btn("✕", cls("dismiss", pc.dismiss), () => onDismiss());
    dismiss.title = "Dismiss";
    // a button inside a summary would otherwise also toggle the details
    if (isDetails) dismiss.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  }
  const holder = head ?? root;
  for (const n of [mark, title, dismiss]) if (n) holder.appendChild(n);
  if (head) root.appendChild(head);
  if (body && body !== root) root.appendChild(body);
  if (actions) root.appendChild(actions);
  return { root, head, title, mark, body, actions, dismiss };
}
