// One offline preview renderer for HTML/SVG that Vidar didn't write — bridge
// display files today, workbench content later. Two layers, each measured on
// its own by tools/drive/preview-harness.mjs:
//
//   1. RECONSTRUCTION is the structure boundary. DOMParser → inert source doc;
//      an iterative walk builds a NEW tree in a second inert document from an
//      allowlist of elements/attributes; the engine serialises it. Original
//      nodes are never adopted, original markup never inserted, nothing
//      unfiltered ever touches the active document. CSS goes through the
//      browser's own parser and every rule is rebuilt from filtered parts — a
//      small subset (no custom properties, no var(), no nesting): reconstruction
//      reduces the CSS surface, it is NOT a resource-denial guarantee.
//   2. CSP + the unchanged sandbox IS the resource-denial boundary: an owned
//      srcdoc document whose first head child is a CSP meta denying every load
//      except data: images, mounted in <iframe sandbox="">.
//
// Guarantee, stated: no content-initiated network, navigation or script.

export interface Reconstructed {
  /** filtered <style> rule text, one string per head <style>, "</" never present */
  styles: string[];
  /** serialised body innerHTML from the inert output document */
  body: string;
  /** class/lang/dir carried from the source html/body onto the owned wrappers */
  bodyAttrs: Record<string, string>;
  dropped: Record<string, number>;
  fellBack: false | { reason: string };
}

export interface PreviewResult {
  el: HTMLElement;
  dropped: Record<string, number>;
  fellBack: false | { reason: string };
}

const CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const INPUT_CAP = 2 * 1024 * 1024;
const OUTPUT_CAP = 4 * 1024 * 1024;
const NODE_CAP = 50_000;
const DEPTH_CAP = 256;
const RULE_CAP = 5_000;
const CSS_DEPTH_CAP = 8;

const XHTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

const HTML_KEEP = new Set([
  "div", "p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "pre", "code", "blockquote",
  "em", "strong", "b", "i", "u", "s", "small", "sub", "sup", "br", "hr", "img", "figure",
  "figcaption", "section", "article", "header", "footer", "main", "nav", "aside", "details",
  "summary", "mark", "abbr", "kbd", "samp", "var", "time",
]);
const SVG_KEEP = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
  "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "symbol",
  "use", "title", "desc",
]);

const GLOBAL_ATTRS = new Set(["class", "id", "title", "lang", "dir"]);
const HTML_ATTRS: Record<string, Set<string>> = {
  img: new Set(["alt", "width", "height", "src"]),
  td: new Set(["colspan", "rowspan", "scope"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  details: new Set(["open"]),
  time: new Set(["datetime"]),
};
const SVG_GEOM = new Set([
  "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points",
  "viewBox", "preserveAspectRatio", "transform", "offset", "stop-opacity", "gradientUnits",
  "gradientTransform", "spreadMethod", "patternUnits", "patternTransform", "clipPathUnits",
  "maskUnits", "maskContentUnits", "dx", "dy",
]);
const SVG_PRESENT = new Set([
  "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "fill-opacity", "fill-rule", "opacity", "font-size", "font-family",
  "font-weight", "text-anchor", "dominant-baseline", "letter-spacing", "visibility", "display",
]);
/** these take a paint/reference value and go through the recogniser */
const SVG_PAINT = new Set([
  "fill", "stroke", "stop-color", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "filter",
]);

const DATA_IMG = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const FRAG_ID = /^#[A-Za-z0-9_-]+$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.]+%?(?:deg)?(?:\s*[,\s/]\s*[\d.]+%?){2,3}\s*\)$/i;
const FRAG_URL = /^url\(\s*(?:"#[A-Za-z0-9_-]+"|'#[A-Za-z0-9_-]+'|#[A-Za-z0-9_-]+)\s*\)$/;
/** any CSS value function that can name a resource */
const RESOURCE_FUNC = /(?:^|[^a-z-])(?:url|image-set|image|element|src|paint)\s*\(/i;
/** a local fragment reference — the one url() form a value may keep */
const FRAG_URL_G = /url\(\s*(?:"#[A-Za-z0-9_-]+"|'#[A-Za-z0-9_-]+'|#[A-Za-z0-9_-]+)\s*\)/gi;
/** true if the value names any resource other than url("#fragment") */
export function hasExternalRef(val: string): boolean {
  return RESOURCE_FUNC.test(val.replace(FRAG_URL_G, ""));
}

// CSS Color 4 named colours — the recogniser uses this list, not "any word"
const NAMED_COLORS = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
  "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue " +
  "darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
  "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink " +
  "deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold " +
  "goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush " +
  "lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey " +
  "lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
  "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
  "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
  "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
  "palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
  "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
  "springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));

/** Restrictive recogniser for paint/reference values: a colour, a keyword, or a
 *  local fragment reference. Rejects some valid CSS — that costs styling, not safety. */
function paintOk(v: string): boolean {
  const s = v.trim();
  const lower = s.toLowerCase();
  if (lower === "none" || lower === "currentcolor" || lower === "transparent" || lower === "inherit") return true;
  if (NAMED_COLORS.has(lower)) return true;
  if (HEX.test(s) || COLOR_FUNC.test(s) || FRAG_URL.test(s)) return true;
  return false;
}

/* ---- CSS: through the browser's parser, every rule rebuilt from filtered parts ---- */

interface CssBudget { rules: number; dropped: Record<string, number> }

function bump(d: Record<string, number>, k: string) {
  d[k] = (d[k] ?? 0) + 1;
}

/** A declaration survives only if it is not a custom property, uses no var(),
 *  and its serialised value names no resource except url("#fragment"). */
export function filterDecls(style: CSSStyleDeclaration, dropped: Record<string, number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (!prop || prop.startsWith("--") || prop === "behavior") { bump(dropped, "css-decl"); continue; }
    const val = style.getPropertyValue(prop);
    if (/var\s*\(/i.test(val) || /expression\s*\(/i.test(val)) { bump(dropped, "css-decl"); continue; }
    if (hasExternalRef(val)) { bump(dropped, "css-decl"); continue; }
    // "</" inside a value would end the owned <style> element on re-parse
    if (/<\//.test(val) || /<\//.test(prop)) { bump(dropped, "css-decl"); continue; }
    const prio = style.getPropertyPriority(prop);
    out.push(`${prop}: ${val}${prio ? " !" + prio : ""}`);
  }
  return out;
}

function rebuildRules(list: CSSRuleList, depth: number, b: CssBudget): string[] {
  const out: string[] = [];
  if (depth > CSS_DEPTH_CAP) { bump(b.dropped, "css-depth"); return out; }
  for (let i = 0; i < list.length; i++) {
    if (++b.rules > RULE_CAP) { bump(b.dropped, "css-rule-cap"); break; }
    const r = list[i];
    if (r instanceof CSSStyleRule) {
      // nested child rules (CSS nesting) are dropped, never re-emitted via cssText
      const nested = (r as unknown as { cssRules?: CSSRuleList }).cssRules;
      if (nested && nested.length) bump(b.dropped, "css-nested");
      const sel = r.selectorText;
      if (/<\//.test(sel)) { bump(b.dropped, "css-rule"); continue; }
      const decls = filterDecls(r.style, b.dropped);
      if (decls.length) out.push(`${sel} { ${decls.join("; ")} }`);
    } else if (r instanceof CSSMediaRule) {
      const inner = rebuildRules(r.cssRules, depth + 1, b);
      if (inner.length && !/<\//.test(r.conditionText)) out.push(`@media ${r.conditionText} { ${inner.join(" ")} }`);
    } else if (r instanceof CSSSupportsRule) {
      const inner = rebuildRules(r.cssRules, depth + 1, b);
      if (inner.length && !/<\//.test(r.conditionText)) out.push(`@supports ${r.conditionText} { ${inner.join(" ")} }`);
    } else if (r instanceof CSSKeyframesRule) {
      const frames: string[] = [];
      for (let k = 0; k < r.cssRules.length; k++) {
        const kf = r.cssRules[k];
        if (!(kf instanceof CSSKeyframeRule)) continue;
        const decls = filterDecls(kf.style, b.dropped);
        if (decls.length && !/<\//.test(kf.keyText)) frames.push(`${kf.keyText} { ${decls.join("; ")} }`);
      }
      if (frames.length && /^[A-Za-z0-9_-]+$/.test(r.name)) out.push(`@keyframes ${r.name} { ${frames.join(" ")} }`);
    } else {
      bump(b.dropped, "css-rule"); // @import @font-face @namespace @layer @property @container @page …
    }
  }
  return out;
}

/** Filters one stylesheet's text into rule strings. Exported for the harness's structural check. */
function filterCss(text: string, dropped: Record<string, number>, budget?: CssBudget): string[] {
  const b = budget ?? { rules: 0, dropped };
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(text); // grammar-aware; @import is ignored here by spec
  } catch {
    bump(dropped, "css-parse");
    return [];
  }
  return rebuildRules(sheet.cssRules, 0, b);
}

/* ---- reconstruction ---- */

function keepAttr(ns: string | null, tag: string, attrNs: string | null, name: string, value: string): string | false {
  if (name.startsWith("on")) return false;
  if (attrNs === XLINK && name !== "href") return false;
  if (ns === SVG) {
    if (name === "href" && tag === "use") return FRAG_ID.test(value.trim()) ? value.trim() : false;
    if (SVG_PAINT.has(name)) return paintOk(value) ? value.trim() : false;
    if (GLOBAL_ATTRS.has(name) || SVG_GEOM.has(name) || SVG_PRESENT.has(name) || name === "stop-color") {
      return /<\//.test(value) ? false : value;
    }
    return false;
  }
  if (GLOBAL_ATTRS.has(name)) return value;
  const per = HTML_ATTRS[tag];
  if (!per || !per.has(name)) return false;
  if (tag === "img" && name === "src") return DATA_IMG.test(value.trim()) ? value.trim() : false;
  return value;
}

interface Frame { src: Node; dst: Node; depth: number }

export function reconstruct(content: string): Reconstructed {
  const dropped: Record<string, number> = {};
  const fail = (reason: string): Reconstructed => ({ styles: [], body: "", bodyAttrs: {}, dropped, fellBack: { reason } });
  if (content.length > INPUT_CAP) return fail("input over 2 MiB");

  const src = new DOMParser().parseFromString(content, "text/html"); // inert: no browsing context
  const out = document.implementation.createHTMLDocument(""); // inert: no browsing context

  // head <style>s only; body-local <style> is dropped (counted) by the walk
  const cssBudget: CssBudget = { rules: 0, dropped };
  const styles: string[] = [];
  src.head.querySelectorAll("style").forEach((s) => {
    const rules = filterCss(s.textContent ?? "", dropped, cssBudget);
    if (rules.length) styles.push(rules.join("\n"));
  });

  const bodyAttrs: Record<string, string> = {};
  for (const el of [src.documentElement, src.body]) {
    for (const a of ["class", "lang", "dir"]) {
      const v = el.getAttribute(a);
      if (v && !/<\//.test(v)) bodyAttrs[a] = bodyAttrs[a] ? `${bodyAttrs[a]} ${v}` : v;
    }
  }

  let nodes = 0;
  const stack: Frame[] = [{ src: src.body, dst: out.body, depth: 0 }];
  while (stack.length) {
    const { src: s, dst: d, depth } = stack.pop()!;
    if (depth > DEPTH_CAP) return fail("nesting over 256 deep");
    // children are appended to `d` here, in document order; the stack only defers each child's
    // own subtree, so its pop order doesn't matter (walking kids in reverse mirrored every page)
    const kids = Array.from(s.childNodes);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (++nodes > NODE_CAP) return fail("over 50 000 nodes");
      if (k.nodeType === Node.TEXT_NODE) {
        d.appendChild(out.createTextNode(k.textContent ?? ""));
        continue;
      }
      if (k.nodeType !== Node.ELEMENT_NODE) continue; // comments, PIs: dropped silently
      const el = k as Element;
      const ns = el.namespaceURI;
      const tag = el.localName;
      let outTag = tag;
      let keep = false;
      if (ns === SVG) {
        if (tag === "a") { outTag = "g"; keep = true; } // inert: text kept, href as title
        else keep = SVG_KEEP.has(tag);
      } else if (ns === XHTML) {
        if (tag === "a") { outTag = "span"; keep = true; }
        else keep = HTML_KEEP.has(tag);
      }
      if (!keep) {
        bump(dropped, tag);
        d.appendChild(out.createTextNode(`[dropped: ${tag}]`));
        continue;
      }
      const n = out.createElementNS(ns === SVG ? SVG : XHTML, outTag);
      for (const a of Array.from(el.attributes)) {
        const v = keepAttr(ns, tag, a.namespaceURI, a.localName, a.value);
        if (v !== false) n.setAttribute(a.localName, v);
      }
      if (tag === "a") {
        const href = el.getAttribute("href");
        if (href && !/<\//.test(href)) n.setAttribute("title", href);
        bump(dropped, "a→inert");
      }
      // style attribute: read from the inert source element's CSSOM, write filtered
      if (el.hasAttribute("style")) {
        const decls = filterDecls((el as HTMLElement | SVGElement).style, dropped);
        for (const decl of decls) {
          const idx = decl.indexOf(":");
          const prop = decl.slice(0, idx).trim();
          let val = decl.slice(idx + 1).trim();
          let prio = "";
          if (val.endsWith("!important")) { val = val.slice(0, -10).trim(); prio = "important"; }
          (n as HTMLElement).style.setProperty(prop, val, prio);
        }
      }
      d.appendChild(n);
      stack.push({ src: el, dst: n, depth: depth + 1 });
    }
  }

  const body = out.body.innerHTML; // engine serialisation
  if (body.length + styles.reduce((a, s) => a + s.length, 0) > OUTPUT_CAP) return fail("output over 4 MiB");
  for (const s of styles) if (/<\//.test(s)) return fail("style text would close the element");
  return { styles, body, bodyAttrs, dropped, fellBack: false };
}

/* ---- the owned document ---- */

// The frame can't see the app's CSS variables, so the theme's --bg/--fg are resolved here and
// baked in: an unstyled document, or one that paints only <body>, sits on the theme instead of a
// white rim. Padding is on body only, so a document's own body background reaches the frame edge.
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([0-9., ]+\))$/i;
function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return COLOR_RE.test(v) ? v : fallback;
}
// Scrollbars: the frame's document is its own scroller and the app's `*::-webkit-scrollbar` rules
// (styles.css, "Themed scrollbars") don't cross the frame, so it drew WebView2's white default bar.
// Same look, tokens resolved: --border thumb, --fg-dim on hover, --radius-4, transparent track.
const LEN_RE = /^\d+(\.\d+)?px$/;
function scrollbarCss(): string {
  const root = getComputedStyle(document.documentElement);
  const scheme = root.colorScheme === "light" ? "light" : "dark";
  const thumb = themeColor("--border", "#2b2b33"), hover = themeColor("--fg-dim", "#83818b");
  const r = root.getPropertyValue("--radius-4").trim();
  const radius = LEN_RE.test(r) ? r : "4px";
  return `:root{color-scheme:${scheme}}::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:${thumb};border-radius:${radius}}::-webkit-scrollbar-thumb:hover{background:${hover}}`;
}
function baseCss(): string {
  const bg = themeColor("--bg", "#fff"), fg = themeColor("--fg", "#111");
  return `${scrollbarCss()}html{background:${bg};color:${fg}}html,body{margin:0}body{padding:8px;font-family:system-ui,Segoe UI,sans-serif;font-size:14px;line-height:1.45}img,svg{max-width:100%}pre{overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px}`;
}

/** Builds the srcdoc string. `withCsp: false` exists ONLY for the harness's
 *  control/recon-only configurations; the renderer always passes true. */
export function buildDocument(parts: { styles: string[]; body: string; bodyAttrs?: Record<string, string> }, withCsp: boolean): string {
  const doc = document.implementation.createHTMLDocument("");
  const head = doc.head;
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  if (withCsp) {
    const meta = doc.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", CSP);
    head.prepend(meta); // FIRST: createHTMLDocument already inserted a title
  }
  head.appendChild(charset);
  const base = doc.createElement("style");
  base.textContent = baseCss();
  head.appendChild(base);
  for (const s of parts.styles) {
    const st = doc.createElement("style");
    st.textContent = s;
    head.appendChild(st);
  }
  for (const [k, v] of Object.entries(parts.bodyAttrs ?? {})) doc.body.setAttribute(k, v);
  doc.body.innerHTML = parts.body; // engine-serialised output of the inert walk, into another inert doc
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

/** Mounts a srcdoc document in a sandboxed frame. The renderer keeps
 *  sandbox=""; the harness may pass extra flags for its positive controls only. */
export function mountFrame(srcdoc: string, sandbox = ""): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "display-render";
  frame.setAttribute("sandbox", sandbox);
  frame.srcdoc = srcdoc;
  return frame;
}

export function renderPreview(kind: "html" | "svg", content: string): PreviewResult {
  if (kind === "svg") {
    // image-rendered SVG: no script, no external resources — unchanged from before
    const img = document.createElement("img");
    img.className = "display-render";
    // encodeURIComponent, not btoa — btoa throws on non-Latin-1 content
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(content);
    return { el: img, dropped: {}, fellBack: false };
  }
  const r = reconstruct(content);
  if (r.fellBack) {
    const pre = document.createElement("pre");
    pre.className = "display-source";
    pre.textContent = content;
    return { el: pre, dropped: r.dropped, fellBack: r.fellBack };
  }
  return { el: mountFrame(buildDocument(r, true)), dropped: r.dropped, fellBack: false };
}

/* ---- structural check (harness) ----
   Inspects resource-bearing attributes and re-parsed CSS values of a
   reconstructed document — not its text, which legitimately contains URLs in
   prose, code and inert link titles. Returns violations. */
const RESOURCE_ATTRS = ["src", "href", "srcset", "poster", "data", "action", "formaction", "ping"];

export function structuralCheck(srcdoc: string): string[] {
  const bad: string[] = [];
  const doc = new DOMParser().parseFromString(srcdoc, "text/html");
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of RESOURCE_ATTRS) {
      const v = el.getAttribute(a) ?? el.getAttributeNS(XLINK, a);
      if (v === null) continue;
      if (a === "src" && DATA_IMG.test(v.trim())) continue;
      if (a === "href" && FRAG_ID.test(v.trim())) continue;
      bad.push(`${el.localName}[${a}]=${v.slice(0, 60)}`);
    }
    for (const a of Array.from(el.attributes)) {
      if (a.localName.startsWith("on")) bad.push(`${el.localName}[${a.localName}]`);
      if (SVG_PAINT.has(a.localName) && !paintOk(a.value)) bad.push(`${el.localName}[${a.localName}]=${a.value.slice(0, 60)}`);
    }
    const st = el.getAttribute("style");
    if (st && (hasExternalRef(st) || /var\s*\(/i.test(st))) bad.push(`${el.localName}[style]=${st.slice(0, 60)}`);
  });
  doc.querySelectorAll("style").forEach((s, i) => {
    const sheet = new CSSStyleSheet();
    try { sheet.replaceSync(s.textContent ?? ""); } catch { bad.push(`style#${i} unparsable`); return; }
    const walk = (list: CSSRuleList) => {
      for (let j = 0; j < list.length; j++) {
        const r = list[j];
        if (r instanceof CSSImportRule || r instanceof CSSFontFaceRule) bad.push(`style#${i} ${r.cssText.slice(0, 60)}`);
        const style = (r as CSSStyleRule).style;
        if (style) {
          for (let k = 0; k < style.length; k++) {
            const v = style.getPropertyValue(style[k]);
            if (style[k].startsWith("--") || /var\s*\(/i.test(v) || hasExternalRef(v)) {
              bad.push(`style#${i} ${style[k]}: ${v.slice(0, 60)}`);
            }
          }
        }
        const inner = (r as CSSGroupingRule).cssRules;
        if (inner) walk(inner);
      }
    };
    walk(sheet.cssRules);
  });
  return bad;
}
