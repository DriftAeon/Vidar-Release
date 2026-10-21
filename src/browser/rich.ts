// DOM helpers for rich renderers. Elements come from a tag allowlist and carry text, never markup; a link
// is an inert element with a click handler (never an `href`), and only http/https reaches the handler.

const TAGS = new Set([
  "div", "span", "p", "pre", "code", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "br", "table", "thead", "tbody", "tr", "th", "td", "strong", "em", "s", "u", "mark",
  "details", "summary", "figure", "figcaption",
]);

export function el(tag: string, cls: string): HTMLElement {
  if (!TAGS.has(tag)) throw new Error(`rich: tag "${tag}" is not allowed`);
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

const MAX_URL = 2048;

/** Drops format controls (\p{Cf}: bidi overrides, zero-width marks), which can disguise a host in a label. */
export function stripFormat(text: string): string {
  return text.replace(/\p{Cf}/gu, "");
}

/** The normalised http/https URL, or null for anything else (javascript:, data:, relative, control or format
 *  chars: a url that changes when \p{Cf} is stripped is refused). */
export function safeUrl(url: string): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL) return null;
  if (stripFormat(url) !== url) return null;
  if (/[\p{Cc}\s]/u.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** A link-looking element; its label loses format controls and its title is the normalised href. With an
 *  unsafe URL it is plain text with no handler and no title. */
export function inertLink(text: string, url: string, openUrl: (url: string) => void): HTMLElement {
  const node = el("span", "rich-link");
  node.textContent = stripFormat(text);
  const safe = safeUrl(url);
  if (safe === null) return node;
  node.title = safe;
  node.setAttribute("role", "link");
  node.tabIndex = 0;
  node.addEventListener("click", (ev) => {
    ev.preventDefault();
    openUrl(safe);
  });
  node.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    openUrl(safe);
  });
  return node;
}
