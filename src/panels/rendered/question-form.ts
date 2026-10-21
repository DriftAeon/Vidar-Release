// AskUserQuestion form of a Rendered question card: every question stacked, options as
// radio rows (checkbox rows when multi-select), an "Other" field per question. Split from cards.ts.

import { DRIVE_CLASS } from "../rendered-drive";
import { askLabel } from "./ask-answers";
import { btn, el } from "./dom";

/** an option's label for every reader (toggle, drive click, snapshot): the description
 *  shares the button's text, so `textContent` alone is "Labeldescription", and the shown label drops a "(Recommended)" suffix that dataset.label keeps */
const optionLabel = (b: HTMLElement): string => b.dataset.label ?? b.textContent ?? "";

type QState = { q: string; multi: boolean; picked: Set<string>; other: HTMLInputElement; otherRow: HTMLElement };

/** Other counts only while its row is on and the text is non-empty (a listed pick in single-select turns the row off, keeping the text) */
const otherOn = (st: QState): boolean => st.otherRow.classList.contains("on") && st.other.value.trim() !== "";

/** mirrors `picked` onto the listed option rows (the Other row is not one) */
function syncPicks(optsRow: HTMLElement, st: QState): void {
  for (const c of optsRow.children) {
    if (c === st.otherRow) continue;
    const on = st.picked.has(optionLabel(c as HTMLElement));
    c.classList.toggle("on", on);
    c.setAttribute("aria-checked", String(on));
  }
}

/** builds the form into `card`; returns a collector for {questions, answers}.
 *  `onChange` fires on every pick or keystroke with "is every question answered" —
 *  the Answer button stays disabled until it is true. */
export function questionForm(card: HTMLElement, input: unknown, onChange: (answered: boolean) => void): { collect: () => unknown; answered: () => boolean } {
  const i = (input && typeof input === "object" ? input : {}) as { questions?: unknown };
  const qs = Array.isArray(i.questions) ? i.questions : [];
  const state: QState[] = [];
  // every question, not any: a partial send still reaches the model as "did not answer"
  // for the ones left blank
  const answered = () => state.every((st) => st.picked.size > 0 || otherOn(st));
  // secret answers are wiped once the card settles (any outcome), so a folded card holds no value
  const secrets: HTMLInputElement[] = [];
  const root = card.parentElement ?? card;
  const watch = new MutationObserver(() => {
    if (!root.classList.contains(DRIVE_CLASS.settled)) return;
    for (const s of secrets) s.value = "";
    watch.disconnect();
  });
  for (const raw of qs) {
    const q = (raw && typeof raw === "object" ? raw : {}) as { id?: string; question?: string; header?: string; options?: unknown; multiSelect?: boolean; isOther?: boolean; isSecret?: boolean };
    const box = el("div", DRIVE_CLASS.question);
    // the model's `header` chip is not shown: the question text stands alone
    const top = el("div", "q-text", q.question ?? "");
    // Codex answers are keyed by stable question ID; Claude's questions use their text.
    const st: QState = { q: q.id ?? q.question ?? "", multi: q.multiSelect === true, picked: new Set<string>(), other: el("input", "q-other"), otherRow: el("div") };
    const optsRow = el("div", "q-options");
    optsRow.setAttribute("role", st.multi ? "group" : "radiogroup");
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const oo = (o && typeof o === "object" ? o : {}) as { label?: string; description?: string };
      const label = oo.label ?? "";
      const b = btn("", DRIVE_CLASS.option, () => {
        if (st.multi) { if (st.picked.has(label)) st.picked.delete(label); else st.picked.add(label); }
        else { st.picked.clear(); st.picked.add(label); st.otherRow.classList.remove("on"); } // text stays, the row is off
        syncPicks(optsRow, st);
        onChange(answered());
      });
      b.dataset.label = label;
      b.setAttribute("role", st.multi ? "checkbox" : "radio");
      b.setAttribute("aria-checked", "false");
      // "(Recommended)" is shown as a star before the label; dataset.label and the answer keep the original string
      b.append(askLabel(label));
      if (oo.description) b.append(el("span", "q-desc", oo.description));
      optsRow.appendChild(b);
    }
    // "Other" is the last option row: same marker as the listed options, a 24px text box in column 2.
    // It is not a `.q-opt`, so the drive and snapshot readers never count it as a listed option.
    const otherRow = el("div", st.multi ? "q-other-row multi" : "q-other-row");
    st.otherRow = otherRow;
    const freeText = !Array.isArray(q.options) || q.options.length === 0;
    const secret = q.isSecret === true;
    st.other.type = secret ? "password" : "text";
    // a secret free-text question's field is its only input, not an "Other" choice
    if (!(secret && freeText)) st.other.placeholder = "Other";
    if (secret) secrets.push(st.other);
    // Other is on while its box has text or focus: focusing it (or clicking its marker) selects it like a
    // listed pick, typing in it is the answer; leaving it empty turns it back off
    const otherSync = () => {
      const on = st.other.value.trim() !== "" || st.other.ownerDocument.activeElement === st.other;
      otherRow.classList.toggle("on", on);
      if (on && !st.multi) { st.picked.clear(); syncPicks(optsRow, st); }
      onChange(answered());
    };
    st.other.addEventListener("input", otherSync);
    st.other.addEventListener("focus", otherSync);
    st.other.addEventListener("blur", () => {
      if (st.other.value.trim() !== "") return;
      otherRow.classList.remove("on");
      onChange(answered());
    });
    otherRow.addEventListener("click", (e) => { if (e.target !== st.other) st.other.focus(); });
    otherRow.append(st.other);
    // Codex questions carry an `id` and opt in to Other (`isOther`, default false); Claude's have
    // neither field and always get the Other row
    const codex = typeof q.id === "string";
    if (!codex || q.isOther === true || freeText) optsRow.appendChild(otherRow);
    box.append(top, optsRow);
    card.appendChild(box);
    state.push(st);
  }
  if (secrets.length) watch.observe(root, { attributes: true, attributeFilter: ["class"] });
  return {
    answered,
    collect: () => {
      const answers: Record<string, string> = {};
      for (const st of state) {
        const other = otherOn(st) ? st.other.value.trim() : "";
        answers[st.q] = st.multi ? [...st.picked, ...(other ? [other] : [])].join(", ") : other || [...st.picked].join(", ");
      }
      return { questions: qs, answers };
    },
  };
}
