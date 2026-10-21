// In-DOM prompt for the Document view (discard / new document). Like session
// rename, keep input in the DOM: native dialogs are unreliable here.

export function documentDialog(
  root: HTMLElement, scrollEl: HTMLElement, message: string, action: string, inputName = false,
): Promise<string | null> {
  if (root.querySelector("#doc-dialog")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const form = document.createElement("form");
    form.id = "doc-dialog";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-label", message);
    form.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px;flex-wrap:wrap;";
    const label = document.createElement("label");
    label.textContent = message;
    const input = document.createElement("input");
    input.spellcheck = false;
    input.setAttribute("aria-label", "Document name");
    if (inputName) label.appendChild(input);
    const accept = document.createElement("button");
    accept.type = "submit";
    accept.textContent = action;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    form.append(label, accept, cancel);
    let finished = false;
    const done = (commit: boolean, restoreFocus = true) => {
      if (finished) return;
      const value = inputName ? input.value.trim() : "discard";
      if (commit && !value) { input.focus(); return; }
      finished = true;
      form.remove();
      if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
      resolve(commit ? value : null);
    };
    form.addEventListener("submit", (event) => { event.preventDefault(); done(true); });
    cancel.addEventListener("click", () => done(false));
    form.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); done(false); }
    });
    form.addEventListener("focusout", (event) => {
      if (!form.contains(event.relatedTarget as Node | null)) done(false, false);
    });
    root.insertBefore(form, scrollEl);
    (inputName ? input : cancel).focus();
    if (inputName) input.select();
  });
}
