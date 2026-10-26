// DOM reader for the Bare Runes view and the launcher set pick: one self-contained function, no imports and no
// outer references, so Layer B can eval its source in the real app (strip the leading `export default `, then
// call it on `document`). Plain data out, in document order:
//   sections [{ name, count, section, kind, tip }]  every `.runes-set-head`; `section` = the card it sits in
//   sets     [{ library, head, section, tip, runes }]  `.runes-set[data-library]`; runes = [{ id, name, on, locked, tip }]
//   servers  [{ name, label, tip, group, section, ticked }]  MCP server rows, in a View group or in Local Files
//   buttons  [{ text, disabled, title }]  every button with text (Create Runes, Generate, Import Raw ...)
//   picks    [{ label, ticked }]  set-pick tray rows (`.sp-row`)
export default function readRunes(root) {
  const top = root.documentElement ?? root;
  const text = (e) => (e ? e.textContent.trim() : "");
  const all = (sel, from) => [...(from ?? top).querySelectorAll(sel)];
  const headOf = (card) => {
    const h = card && [...card.children].find((c) => c.classList.contains("runes-set-head"));
    return h ? text(h.querySelector(".runes-sn")) : "";
  };
  const sectionOf = (el) => {
    let p = el.parentElement;
    while (p) {
      if (p.tagName === "DETAILS" && p.classList.contains("runes-card")) return headOf(p);
      p = p.parentElement;
    }
    return null;
  };
  const sections = all(".runes-set-head").map((h) => ({
    name: text(h.querySelector(".runes-sn")),
    count: text(h.querySelector(".runes-sc")),
    section: sectionOf(h.parentElement),
    kind: h.parentElement.dataset.kind ?? null,
    tip: h.title,
  }));
  const sets = all(".runes-set[data-library]").map((card) => ({
    library: card.dataset.library,
    head: headOf(card),
    section: sectionOf(card),
    tip: card.querySelector(":scope > .runes-set-head")?.title ?? "",
    runes: all("details.runes-rn", card).map((r) => {
      const sw = r.querySelector(".runes-bare-switch");
      return {
        id: r.dataset.id ?? "",
        name: text(r.querySelector(".runes-rname")),
        on: sw ? sw.getAttribute("aria-pressed") === "true" : !r.classList.contains("is-dim"),
        locked: sw ? sw.disabled : false,
        tip: sw ? sw.title : "",
      };
    }),
  }));
  const servers = all('.rp-source[data-kind="mcp"], [data-kind="mcp"] .rp-source').filter((r, i, a) => a.indexOf(r) === i).map((r) => {
    const group = r.closest('.runes-set[data-kind="mcp"]');
    return {
      name: text(r.querySelector(".rp-name")),
      label: text(r.querySelector(".rp-path")),
      tip: r.title,
      group: headOf(group),
      section: group ? sectionOf(group) : null,
      ticked: r.getAttribute("aria-pressed") === "true",
    };
  });
  const buttons = all("button").filter((b) => text(b)).map((b) => ({ text: text(b), disabled: b.disabled, title: b.title }));
  const picks = all(".sp-row").map((b) => ({ label: text(b), ticked: b.getAttribute("aria-checked") === "true" }));
  return { sections, sets, servers, buttons, picks };
}
