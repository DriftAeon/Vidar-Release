// Settings › Agents › Guards: how many guard hooks a Bare Claude tab keeps (vidar.json `bareGuards`)
// and a Bare Codex tab keeps (`bareCodexGuards`). Read-only; a fresh install has none, which
// launches quietly (the tab shows no warning).

/** "None" for an empty or absent list, else "1 Guard" / "2 Guards". */
export function guardsValue(count: number): string {
  if (count <= 0) return "None";
  return `${count} ${count === 1 ? "Guard" : "Guards"}`;
}

/** The row's value: dim when none, the plain colour once guards are listed. `read` resolves the
 *  count; a failed read leaves the value blank rather than claiming "None". */
export function guardsControl(doc: Document, read: () => Promise<number>): HTMLElement {
  const host = doc.createElement("span");
  host.className = "ag-readonly";
  void read().then((n) => {
    if (n <= 0) {
      host.textContent = guardsValue(0);
      return;
    }
    const b = doc.createElement("b");
    b.textContent = guardsValue(n);
    host.replaceChildren(b);
  }).catch(() => {});
  return host;
}
