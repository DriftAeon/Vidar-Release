import { fitWords, splitWords } from "./words.js";

export const MAX_LENGTH = 60;

/** A URL slug for `title`: lowercase, ASCII, `-` between words, cut on a word boundary at MAX_LENGTH. */
export function slugify(title, max = MAX_LENGTH) {
  return fitWords(splitWords(String(title)), max).join("-");
}
