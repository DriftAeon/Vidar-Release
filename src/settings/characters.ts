// Settings › Characters:
// one expandable row per pack with its status, the Changed/Missing alert with Pin New File
// and Browse, editable answers-to chips, the Material Style dropdown with its fallback note,
// Open Folder, Remove, Add Character, clash flags, and the Default Character dropdown. The
// model path is never typed here: Add, Browse and Pin New File run the picker/hash in Rust.
// Lighting and clip speed are hand-edited in character.json for now.
import { invoke } from "../ipc";
import type { CharacterEntry, CharacterList, Claim, ClaimKind, MaterialPreference } from "../character/catalog";
import {
  addCharacter, characterList, onCharactersChanged, onStyleNotes, refreshCharacters, removeCharacter,
  repinCharacter, setDefaultCharacter, styleNote, updateCharacter,
} from "../character/packs";
import { claimsOf, findClashes, normaliseKey, type Clash } from "../character/resolve";
import { REVERT_EVENT } from "./modal";
import { addSettingRow, registerCategory } from "./registry";
import { iconImg } from "../icon-img";
import { el } from "../panels/rendered/dom";

const CHARACTERS_CATEGORY = "characters";

const expanded = new Set<string>();
// The one live editor (the modal rebuilds controls on every open); list and note changes
// repaint only this one.
let repaint: (() => void) | null = null;
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  onCharactersChanged(() => repaint?.());
  onStyleNotes(() => repaint?.());
}

function button(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ws-btn ${cls}`.trim();
  b.textContent = label;
  return b;
}

function mb(bytes: number | undefined): string {
  return bytes === undefined ? "?" : `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function nameOf(entry: CharacterEntry): string {
  return entry.pack?.name ?? entry.folder;
}

function claimLabel(claim: Claim): string {
  return claim.kind === "model" ? claim.key : `${claim.kind}: ${claim.key}`;
}

function statusText(entry: CharacterEntry): string {
  switch (entry.status) {
    case "ok": return `${mb(entry.currentBytes ?? entry.pack?.model.bytes)} · Pinned`;
    case "changed": return "Changed Since Pinned";
    case "missing": return "Missing";
    case "invalid": return "Invalid";
  }
}

/** The kind dropdown's labels; chips keep the key as stored (normalised lowercase). */
const KIND_LABEL: Record<ClaimKind, string> = { model: "Model", role: "Role", agent: "Agent" };

function editor(setError: (msg: string) => void): HTMLElement {
  const root = el("div", "ch-list");
  const run = (work: Promise<unknown>) => {
    void work.then(() => setError(""), (e) => setError(`Not Saved: ${String(e)}`));
  };

  const alert = (title: string, body: string, actions: HTMLElement[] = []) => {
    const box = el("div", "ch-alert");
    box.append(el("div", "ch-alert-title", title), el("div", "ch-alert-body", body));
    if (actions.length) {
      const row = el("div", "ch-actions");
      row.append(...actions);
      box.appendChild(row);
    }
    return box;
  };

  const detailRow = (label: string, ...children: HTMLElement[]) => {
    const row = el("div", "ch-det-row");
    row.append(el("span", "ch-det-k", label), ...children);
    return row;
  };

  const chips = (entry: CharacterEntry, clashes: Clash[], editable: boolean) => {
    const box = el("span", "ch-chips");
    const claims = claimsOf(entry);
    claims.forEach((claim, i) => {
      const chip = el("span", "ch-chip", claimLabel(claim));
      const lost = clashes.find((c) => c.kind === claim.kind && c.key === normaliseKey(claim.key) && entry.id !== null && c.losers.includes(entry.id));
      if (lost) {
        chip.classList.add("ch-chip-clash");
        chip.title = `Claimed first by ${lost.winner}; this pack never gets it`;
      }
      if (editable) {
        const x = button("", "ch-chip-x");
        x.appendChild(iconImg("close"));
        x.title = "Remove";
        x.setAttribute("aria-label", `Remove ${claimLabel(claim)}`);
        x.addEventListener("click", () => run(updateCharacter(entry.target, { answersTo: claims.filter((_, j) => j !== i) })));
        chip.appendChild(x);
      }
      box.appendChild(chip);
    });
    if (editable) box.appendChild(addClaim(entry, claims));
    return box;
  };

  const addClaim = (entry: CharacterEntry, claims: Claim[]) => {
    const wrap = el("span", "ch-add-claim");
    const open = button("Add", "ch-chip-add");
    open.addEventListener("click", () => {
      const kind = el("select", "sc-select ch-kind");
      for (const k of ["model", "role", "agent"] as ClaimKind[]) kind.add(new Option(KIND_LABEL[k], k));
      const key = el("input", "sc-input ch-key");
      key.spellcheck = false;
      key.placeholder = "Key";
      key.setAttribute("aria-label", "Answers To Key");
      const commit = () => {
        const k = normaliseKey(key.value);
        if (!k) return;
        const next: Claim = { kind: kind.value as ClaimKind, key: k };
        if (claims.some((c) => c.kind === next.kind && normaliseKey(c.key) === k)) { repaint?.(); return; }
        run(updateCharacter(entry.target, { answersTo: [...claims, next] }));
      };
      const ok = button("Add");
      ok.addEventListener("click", commit);
      key.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") repaint?.();
        e.stopPropagation(); // typing is not a shortcut
      });
      wrap.replaceChildren(kind, key, ok);
      key.focus();
    });
    wrap.appendChild(open);
    return wrap;
  };

  const detail = (entry: CharacterEntry, clashes: Clash[]) => {
    const det = el("div", "ch-det");
    const pack = entry.pack;
    const pinNew = () => { const b = button("Pin New File"); b.addEventListener("click", () => run(repinCharacter(entry.target, false))); return b; };
    const browse = () => { const b = button("Browse"); b.title = "Choose The Model File"; b.addEventListener("click", () => run(repinCharacter(entry.target, true))); return b; };
    if (entry.status === "changed" && pack) {
      det.appendChild(alert("Model File Changed Since It Was Pinned",
        `Pinned ${mb(pack.model.bytes)}; the file is now ${mb(entry.currentBytes)}. ${pack.name} shows the placeholder until you pin the new file.`,
        [pinNew(), browse()]));
    } else if (entry.status === "missing" && pack) {
      det.appendChild(alert("Model File Missing",
        `${entry.reason ?? pack.model.path}. ${pack.name} shows the placeholder until you browse to the file.`,
        [browse()]));
    } else if (entry.status === "invalid") {
      det.appendChild(alert("Pack Invalid",
        `${entry.reason ?? "character.json could not be read"}. Fix character.json in the pack folder, then reopen Settings.`));
    }
    if (pack) {
      const path = el("span", "ws-path", pack.model.path);
      path.title = pack.model.path;
      det.appendChild(detailRow("Model", browse(), path));
      det.appendChild(detailRow("Answers To", chips(entry, clashes, true)));
      const material = el("select", "sc-select ch-material");
      material.setAttribute("aria-label", "Material Style");
      for (const [value, label] of [["auto", "Auto"], ["cel", "Cel"], ["standard", "Standard"]]) material.add(new Option(label, value));
      material.value = pack.material;
      material.addEventListener("change", () => run(updateCharacter(entry.target, { material: material.value as MaterialPreference })));
      const note = styleNote(pack.id);
      det.appendChild(detailRow("Material Style", material, ...(note ? [el("span", "ch-note", note)] : [])));
    }
    const folder = el("span", "ws-path", `characters\\${entry.folder}\\`);
    folder.title = entry.dir;
    const openFolder = button("", "icon-btn");
    openFolder.setAttribute("aria-label", "Open Folder");
    openFolder.title = "Open Folder";
    openFolder.appendChild(iconImg("folder"));
    openFolder.addEventListener("click", () => run(invoke("open_folder", { path: entry.dir })));
    const remove = button("Remove", "ws-remove");
    remove.title = "Moves The Pack To characters\\_removed";
    remove.addEventListener("click", () => { expanded.delete(entry.folder); run(removeCharacter(entry.target)); });
    det.appendChild(detailRow("Pack", folder, openFolder, remove));
    return det;
  };

  const row = (entry: CharacterEntry, clashes: Clash[]) => {
    const head = el("div", "ch-row");
    const open = expanded.has(entry.folder);
    head.classList.toggle("open", open);
    const caret = button(open ? "⌄" : "›", "ch-caret");
    caret.setAttribute("aria-expanded", String(open));
    caret.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${nameOf(entry)}`);
    caret.addEventListener("click", () => {
      if (expanded.has(entry.folder)) expanded.delete(entry.folder); else expanded.add(entry.folder);
      repaint?.();
    });
    head.appendChild(caret);

    if (entry.pack) {
      const name = el("input", "sc-input ch-name");
      name.spellcheck = false;
      name.value = entry.pack.name;
      name.setAttribute("aria-label", "Character Name");
      const revert = () => { name.value = entry.pack!.name; };
      name.addEventListener("change", () => {
        const next = name.value.trim();
        if (!next || next === entry.pack!.name) return revert();
        run(updateCharacter(entry.target, { name: next }));
      });
      name.addEventListener(REVERT_EVENT, revert);
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") name.blur();
        if (e.key === "Escape") revert();
        e.stopPropagation();
      });
      head.appendChild(name);
    } else {
      head.appendChild(el("span", "ch-name ch-name-static", entry.folder));
    }

    const summary = el("span", "ch-chips");
    const claims = claimsOf(entry);
    claims.slice(0, 2).forEach((c) => summary.appendChild(el("span", "ch-chip", claimLabel(c))));
    if (claims.length > 2) summary.appendChild(el("span", "ch-chip ch-chip-more", `+${claims.length - 2}`));
    head.appendChild(summary);

    const pin = el("span", "ch-pin", statusText(entry));
    pin.classList.toggle("bad", entry.status !== "ok");
    if (entry.reason && entry.status !== "ok") pin.title = entry.reason;
    head.appendChild(pin);
    return open ? [head, detail(entry, clashes)] : [head];
  };

  const render = (list: CharacterList | null) => {
    if (!root.isConnected && root.childElementCount) { if (repaint === paint) repaint = null; return; }
    root.replaceChildren();
    const packs = list?.packs ?? [];
    const clashes = list ? findClashes(list) : [];
    const names = new Map(packs.flatMap((p) => (p.id ? [[p.id, nameOf(p)] as const] : [])));
    for (const clash of clashes) {
      const losers = clash.losers.map((id) => names.get(id) ?? id);
      const winner = names.get(clash.winner) ?? clash.winner;
      root.appendChild(alert(`Claimed Twice: ${clash.kind === "model" ? clash.key : `${clash.kind}: ${clash.key}`}`,
        `${[winner, ...losers].join(" and ")} all answer to it; ${winner} is listed first and wins. Remove it from the others.`));
    }
    for (const entry of packs) root.append(...row(entry, clashes));
    const add = button("Add Character", "ws-add");
    add.addEventListener("click", () => run(addCharacter().then((id) => { if (id) expanded.add(id); })));
    root.appendChild(add);
  };
  const paint = () => render(characterList());
  repaint = paint;
  subscribe();
  paint();
  // Opening the page re-reads from Rust (rehashing every model), so a hand-edited or repaired
  // character.json shows without a restart; the revision bumps only if the list changed.
  void refreshCharacters(true).catch((e) => setError(`Characters Not Loaded: ${String(e)}`));
  return root;
}

function defaultPicker(setError: (msg: string) => void): HTMLElement {
  const select = el("select", "sc-select ch-default");
  select.setAttribute("aria-label", "Default Character");
  const fill = () => {
    const list = characterList();
    select.replaceChildren(new Option("None", ""));
    for (const entry of list?.packs ?? []) if (entry.pack) select.add(new Option(entry.pack.name, entry.pack.id));
    select.value = list?.default ?? "";
  };
  select.addEventListener("change", () => {
    void setDefaultCharacter(select.value || null).then(() => setError(""), (e) => setError(`Not Saved: ${String(e)}`));
  });
  fill();
  const stop = onCharactersChanged(() => { if (select.isConnected) fill(); else stop(); });
  return select;
}

let registered = false;

/** Adds the Characters page once, after Workspaces and above Keybinds. */
export function registerCharacterRows(): void {
  if (registered) return;
  registered = true;
  registerCategory(CHARACTERS_CATEGORY, "Characters", "keybinds", "module");
  addSettingRow({
    name: "Characters",
    tip: "Each character is a pack folder in characters\\ in the Vidar folder. Add Character picks a GLB and pins its size and hash.",
    category: CHARACTERS_CATEGORY,
    wide: true,
    keywords: () => (characterList()?.packs ?? []).map((p) => `${nameOf(p)} ${claimsOf(p).map((c) => c.key).join(" ")}`).join(" "),
    control: editor,
  });
  addSettingRow({
    name: "Default Character",
    tip: "For any tab nothing else matches. None shows the empty stage.",
    category: CHARACTERS_CATEGORY,
    control: defaultPicker,
  });
}
