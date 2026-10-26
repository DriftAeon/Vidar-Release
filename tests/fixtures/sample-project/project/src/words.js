// Text helpers shared by the slug function.

/** Lowercase ASCII words in `text`; accents are dropped and punctuation splits words. */
export function splitWords(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The longest run of `words` that fits `max` characters once joined with `-`. */
export function fitWords(words, max) {
  const out = [];
  let used = 0;
  for (const w of words) {
    const next = used + w.length + (out.length ? 1 : 0);
    if (next > max) break;
    out.push(w);
    used = next;
  }
  return out;
}
