// Changes tab DOM (changes.css): the branch head with rename and the Sync split, the held error or
// commit strip, the Staged and Changes groups with the Revert All confirm in place, the empty
// states, and the commit bar. State and IPC live in panels/changes.ts; this file only draws and
// reports clicks. The list and head are redrawn only when their content changes, so a 5 s poll
// never steals focus from a row button or the rename field.
import { iconImg } from "../icon-img";
import { lucide, type LucideName } from "../icons";
import { clearEmptyState, fillEmptyState, goButton } from "../panels/empty-state";
import type { ChangesStatus } from "../ipc";
import { fileType, focusAfter, headFocusClass, truncatePath, type FocusMark, type HeadMark, type Groups, type Row } from "./model";
import type { SyncMode } from "./actions";

export type RepoStatus = Extract<ChangesStatus, { repo: true }>;
export type Busy = null | "commit" | "commit-sync" | "sync" | "act" | "rename";

export interface ViewState {
  mode: "loading" | "no-folder" | "no-repo" | "repo";
  cwd: string;
  status: RepoStatus | null;
  groups: Groups;
  revertable: string[];
  busy: Busy;
  error: string | null;
  done: { sha: string; warning: string | null } | null;
  confirm: boolean;
  renaming: boolean;
  /** Shown as the alert line under the Generate Git Prompt button in the no-repo state. */
  note: string | null;
}

export interface Handlers {
  stage(paths: string[]): void;
  unstage(paths: string[]): void;
  revertAsk(): void;
  revertConfirm(): void;
  revertCancel(): void;
  sync(mode: SyncMode): void;
  commit(sync: boolean): void;
  renameStart(): void;
  renameCommit(name: string): void;
  renameCancel(): void;
  dismiss(): void;
  gitPrompt(): void;
}

export interface View {
  root: HTMLElement;
  message: HTMLInputElement;
  render(s: ViewState): void;
  closeMenu(): void;
}

/** Folder part budget in characters; CSS ellipsis covers a pane narrower than this. */
const PATH_BUDGET = 64;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function iconBtn(icon: LucideName, label: string, cls = "cx-ico"): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(lucide(icon));
  return b;
}

function textBtn(label: string, cls: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.textContent = label;
  return b;
}

function syncTip(st: RepoStatus): string {
  if (!st.upstream) return "No upstream branch is set; set one in a terminal.";
  return `Sync with ${st.upstream}: pull, then push. ${st.ahead ?? 0} ahead, ${st.behind ?? 0} behind.`;
}

export function buildView(h: Handlers): View {
  const root = el("div", "changes-pane");
  root.id = "changes-view";
  root.style.display = "none";
  const head = el("div", "cx-head");
  const strip = el("div", "cx-strip");
  const list = el("div", "cx-list");
  const empty = el("div", "cx-empty");
  const bar = el("div", "cx-commit");
  const message = el("input", "cx-message");
  message.type = "text";
  message.placeholder = "Message";
  message.setAttribute("aria-label", "Commit Message");
  message.spellcheck = false;
  const commitBtn = textBtn("Commit", "cx-commit-btn cx-primary");
  const commitSyncBtn = textBtn("Commit and Sync", "cx-commit-btn");
  const btns = el("div", "cx-commit-bar wb-actions");
  btns.append(commitBtn, commitSyncBtn);
  bar.append(message, btns);
  root.append(head, strip, list, empty, bar);

  // where focus returns after the next unlocked render: a list click's mark, or a bar element
  let mark: FocusMark | HTMLElement | null = null;
  let last: ViewState | null = null;
  message.addEventListener("input", syncBar);
  message.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !commitBtn.disabled) { e.preventDefault(); mark = message; h.commit(false); }
  });
  commitBtn.addEventListener("click", () => { mark = commitBtn; h.commit(false); });
  commitSyncBtn.addEventListener("click", () => { mark = commitSyncBtn; h.commit(true); });

  // the list's buttons, held so a lock change disables them in place instead of rebuilding the list
  let rowBtns: HTMLButtonElement[] = [];
  let revertBtn: HTMLButtonElement | null = null;
  let confirmBtns: { no: HTMLButtonElement; yes: HTMLButtonElement } | null = null;
  let boxes: HTMLElement[] = [];

  // the header control a Sync or Rename action came from; restored once the lock lifts
  let headMark: HeadMark | null = null;
  let renameDraft: string | null = null;
  let menu: HTMLElement | null = null;
  let menuOff: (() => void) | null = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
    menuOff?.();
    menuOff = null;
    head.querySelector(".cx-split-more")?.removeAttribute("aria-expanded");
  }
  function openMenu(anchor: HTMLElement) {
    closeMenu();
    const m = el("div", "cx-menu");
    m.setAttribute("role", "menu");
    const items: Array<[SyncMode, string]> = [["sync", "Sync"], ["pull", "Pull"], ["push", "Push"]];
    for (const [mode, label] of items) {
      const it = textBtn(label, "cx-menu-item");
      it.setAttribute("role", "menuitem");
      it.addEventListener("click", () => { closeMenu(); headMark = "more"; h.sync(mode); });
      m.append(it);
    }
    document.body.append(m);
    // fixed on body, 4px under the head row, right edge on the split's right edge
    const bar = head.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    m.style.top = `${bar.bottom + 4}px`;
    m.style.left = `${Math.max(4, a.right - m.offsetWidth)}px`;
    anchor.setAttribute("aria-expanded", "true");
    menu = m;
    const onDown = (e: PointerEvent) => {
      if (!m.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeMenu(); anchor.focus(); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    menuOff = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    (m.firstElementChild as HTMLElement | null)?.focus();
  }

  function drawHead(s: ViewState) {
    head.replaceChildren();
    const st = s.status!;
    const locked = s.busy !== null;
    const branch = el("span", "cx-branch");
    branch.append(iconImg("folder"));
    if (s.renaming && !st.detached) {
      const wrap = el("span", "cx-rename-wrap wb-actions");
      const input = el("input", "cx-rename-input");
      input.type = "text";
      input.value = renameDraft ?? st.branch ?? "";
      input.addEventListener("input", () => { renameDraft = input.value; });
      input.placeholder = "Branch";
      input.setAttribute("aria-label", "Branch Name");
      input.spellcheck = false;
      input.disabled = locked;
      const ok = iconBtn("check", "Rename");
      ok.disabled = locked;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); headMark = "rename"; h.renameCommit(input.value); }
        else if (e.key === "Escape") { e.preventDefault(); h.renameCancel(); }
      });
      ok.addEventListener("click", () => { headMark = "rename"; h.renameCommit(input.value); });
      wrap.append(input, ok);
      branch.append(wrap);
      head.append(branch);
      queueMicrotask(() => { if (!locked) { input.focus(); input.select(); } });
    } else {
      const name = el("span", "cx-branch-name");
      name.textContent = st.detached ? "Detached" : st.branch ?? "";
      name.title = st.detached ? "HEAD is detached; no branch to rename or sync." : st.branch ?? "";
      branch.append(name);
      head.append(branch);
      if (!st.detached) {
        const pen = iconBtn("pencil", "Rename Branch", "cx-ico cx-rename");
        pen.disabled = locked;
        pen.addEventListener("click", () => h.renameStart());
        head.append(pen);
      }
    }
    const grow = el("span", "cx-grow");
    const split = el("span", "cx-split wb-actions");
    const syncing = s.busy === "sync";
    const main = iconBtn(syncing ? "loader-circle" : "arrow-up-down", "Sync", "cx-ico cx-split-main");
    main.title = syncTip(st);
    main.setAttribute("aria-busy", String(syncing));
    main.disabled = locked || st.detached;
    main.addEventListener("click", () => { headMark = "sync"; h.sync("sync"); });
    const more = iconBtn("chevron-down", "Sync Options", "cx-ico cx-split-more");
    more.setAttribute("aria-haspopup", "menu");
    more.disabled = locked || st.detached;
    more.addEventListener("click", () => (menu ? closeMenu() : openMenu(more)));
    split.append(main, more);
    head.append(grow, split);
  }

  function drawRow(r: Row, groups: Groups, locked: boolean): HTMLElement {
    const f = r.file;
    const row = el("div", `cx-row${r.kind === "deleted" ? " cx-del" : ""}`);
    row.title = f.origPath ? `${f.origPath} → ${f.path}` : f.path;
    const letter = el("span", `cx-st cx-st-${r.kind}`);
    letter.textContent = r.letter;
    const ft = fileType(f.path);
    const glyph = lucide(ft.icon, `icn cx-ft cx-ft-${ft.tint}`);
    const { name, dir } = truncatePath(f.path, PATH_BUDGET);
    const path = el("span", "cx-path");
    const fname = el("span", "cx-fname");
    fname.textContent = name;
    const fdir = el("span", "cx-dir");
    fdir.textContent = dir;
    path.append(fname, fdir);
    const acts = el("span", "cx-racts");
    const staged = r.group === "staged";
    const b = iconBtn(staged ? "minus" : "plus", staged ? "Unstage" : "Stage", "cx-ra");
    b.disabled = locked;
    rowBtns.push(b);
    b.addEventListener("click", () => {
      mark = { group: r.group, path: f.path, index: Math.max(0, groups[r.group].indexOf(r)) };
      if (staged) h.unstage(pathsOf(r)); else h.stage(pathsOf(r));
    });
    acts.append(b);
    row.append(letter, glyph, path, acts);
    if (r.adds !== null && r.dels !== null) {
      const nums = el("span", "cx-nums");
      const a = el("span", "cx-add");
      a.textContent = `+${r.adds}`;
      const d = el("span", "cx-del-n");
      d.textContent = `−${r.dels}`;
      nums.append(a, d);
      row.append(nums);
    }
    return row;
  }

  function drawGroup(s: ViewState, group: "staged" | "changes"): HTMLElement {
    const rows = s.groups[group];
    const locked = s.busy !== null;
    const sec = el("div", "cx-group");
    sec.dataset.group = group;
    const top = el("div", "cx-sec");
    const label = el("span", "cx-sec-label");
    label.textContent = group === "staged" ? "Staged" : "Changes";
    const count = el("span", "cx-sec-count");
    count.textContent = String(rows.length);
    const acts = el("span", "cx-sec-acts wb-actions");
    if (group === "staged") {
      const all = iconBtn("minus", "Unstage All");
      all.disabled = locked;
      rowBtns.push(all);
      all.addEventListener("click", () => { mark = { group, path: null, index: 0 }; h.unstage(uniq(rows)); });
      acts.append(all);
    } else {
      const rev = iconBtn("undo-2", "Revert All");
      rev.disabled = locked || s.revertable.length === 0;
      revertBtn = rev;
      if (s.confirm) rev.setAttribute("aria-pressed", "true");
      rev.addEventListener("click", () => (s.confirm ? h.revertCancel() : h.revertAsk()));
      const all = iconBtn("plus", "Stage All");
      all.disabled = locked;
      rowBtns.push(all);
      all.addEventListener("click", () => { mark = { group, path: null, index: 0 }; h.stage(uniq(rows)); });
      acts.append(rev, all);
    }
    top.append(label, count, acts);
    sec.append(top);
    if (group === "changes" && s.confirm) sec.append(drawConfirm(s));
    const box = el("div", `cx-rows${locked ? " cx-dim" : ""}`);
    for (const r of rows) box.append(drawRow(r, s.groups, locked));
    boxes.push(box);
    sec.append(box);
    return sec;
  }

  function drawConfirm(s: ViewState): HTMLElement {
    const n = s.revertable.length;
    const card = el("div", "cx-confirm");
    const title = el("div", "cx-confirm-bar");
    title.textContent = "Revert All Changes";
    const body = el("div", "cx-confirm-body");
    const text = el("span", "cx-confirm-text");
    text.textContent = `Discard changes in ${n} ${n === 1 ? "file" : "files"}? This cannot be undone. Untracked files are kept.`;
    const pair = el("div", "cx-confirm-pair");
    const no = textBtn("Cancel", "cx-no");
    const yes = textBtn("Revert All", "cx-yes");
    no.disabled = s.busy !== null;
    yes.disabled = s.busy !== null || n === 0;
    confirmBtns = { no, yes };
    no.addEventListener("click", () => h.revertCancel());
    yes.addEventListener("click", () => { mark = { group: "changes", path: null, index: 0 }; h.revertConfirm(); });
    pair.append(no, yes);
    body.append(text, pair);
    card.append(title, body);
    queueMicrotask(() => { if (!no.disabled && !card.contains(document.activeElement)) no.focus(); });
    return card;
  }

  function drawEmpty(icon: LucideName, title: string, sub: string | null) {
    clearEmptyState(empty);
    empty.replaceChildren();
    empty.append(lucide(icon, "icn cx-empty-icon"));
    const t = el("span", "cx-empty-title");
    t.textContent = title;
    empty.append(t);
    if (sub) {
      const p = el("span", "cx-empty-path");
      p.textContent = sub;
      empty.append(p);
    }
  }

  function drawNoRepo(cwd: string, note: string | null) {
    fillEmptyState(empty, {
      icon: lucide("folder-x", "icn"),
      title: "Not a Git Repository",
      path: cwd,
      actions: [goButton("Generate Git Prompt", () => h.gitPrompt())],
      alert: note,
    });
  }

  let stripKey = "";
  function drawStrip(s: ViewState) {
    const lines: Array<["err" | "ok" | "warn", string]> = [];
    if (s.error) lines.push(["err", s.error]);
    if (s.done) {
      lines.push(["ok", `Committed ${s.done.sha}`]);
      if (s.done.warning) lines.push(["warn", s.done.warning]);
    }
    const key = JSON.stringify(lines);
    if (key === stripKey) return;
    stripKey = key;
    strip.replaceChildren();
    for (const [kind, text] of lines) {
      const line = el("div", `cx-note cx-note-${kind}`);
      line.setAttribute("role", kind === "ok" ? "status" : "alert");
      line.append(lucide(kind === "ok" ? "circle-check" : "circle-alert"));
      const msg = el("span", "cx-note-msg");
      msg.textContent = text;
      const x = iconBtn("x", "Dismiss");
      x.addEventListener("click", () => h.dismiss());
      const wrap = el("span", "wb-actions");
      wrap.append(x);
      line.append(msg, wrap);
      strip.append(line);
    }
    strip.hidden = lines.length === 0;
  }

  /** Commit buttons and message field from the last rendered state; the message input calls it per keystroke. */
  function syncBar() {
    const s = last;
    if (!s) return;
    const locked = s.busy !== null;
    const ready = s.groups.staged.length > 0 && message.value.trim() !== "" && !locked;
    message.disabled = locked;
    commitBtn.disabled = !ready;
    commitSyncBtn.disabled = !ready || !!s.status?.detached;
  }

  /** Lock changes touch the drawn list in place; a rebuild would drop focus from the button pressed. */
  function applyLock(s: ViewState) {
    const locked = s.busy !== null;
    for (const b of rowBtns) b.disabled = locked;
    if (revertBtn) revertBtn.disabled = locked || s.revertable.length === 0;
    if (confirmBtns) {
      confirmBtns.no.disabled = locked;
      confirmBtns.yes.disabled = locked || s.revertable.length === 0;
    }
    for (const b of boxes) b.classList.toggle("cx-dim", locked);
  }

  /** After a click, the redrawn list (or the unlocked bar) has lost the focused button: put focus
   *  where the click was. Focus already somewhere real cancels the mark. */
  function restoreFocus(s: ViewState, locked: boolean) {
    if (!mark || locked) return;
    const a = document.activeElement;
    const m = mark;
    mark = null;
    if (a && a !== document.body && a.isConnected) return;
    let target: Element | null | undefined = null;
    if (m instanceof HTMLElement) {
      target = m;
    } else {
      const at = focusAfter(m, s.groups);
      const sec = at ? list.querySelector(`[data-group="${at.group}"]`) : null;
      if (at && sec) {
        target = "head" in at
          ? sec.querySelector(".cx-sec-acts button:last-of-type")
          : sec.querySelectorAll(".cx-rows .cx-ra")[at.index];
      }
    }
    if (target instanceof HTMLButtonElement || target instanceof HTMLInputElement) {
      if (!target.disabled) target.focus();
    }
  }

  /** After a Sync or Rename the header was redrawn under the pressed button (native disabled drops
   *  focus): once unlocked, focus returns to the same header control unless focus went elsewhere. */
  function restoreHeadFocus(s: ViewState, locked: boolean) {
    if (!headMark || locked) return;
    const m = headMark;
    headMark = null;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const cls = headFocusClass(m, !!s.status?.detached);
    const t = cls ? head.querySelector(`.${cls}`) : null;
    if (t instanceof HTMLButtonElement && !t.disabled) t.focus();
  }

  let headKey = "";
  let listKey = "";
  let listRefs: unknown[] = [];
  function render(s: ViewState) {
    const repo = s.mode === "repo" && s.status !== null;
    const st = s.status;
    const locked = s.busy !== null;
    last = s;
    root.classList.toggle("cx-busy", locked);
    if (!s.renaming) renameDraft = null;
    // head: redrawn when its inputs move; under an open rename field only the lock redraws it, and the
    // typed name survives that (renameDraft)
    const hk = !repo ? ""
      : s.renaming ? JSON.stringify([st!.root, s.busy, "renaming"])
      : JSON.stringify([st!.root, st!.branch, st!.detached, st!.upstream, st!.ahead, st!.behind, s.busy]);
    if (hk !== headKey) { headKey = hk; closeMenu(); if (repo) drawHead(s); else head.replaceChildren(); }
    head.hidden = !repo;
    drawStrip(s);
    const total = s.groups.staged.length + s.groups.changes.length;
    // the key (root, files, confirm, revertable; not busy) is built only when one of those references moved
    const refs = repo ? [st!.root, st!.files, s.confirm, s.revertable] : [];
    if (refs.length !== listRefs.length || refs.some((v, i) => v !== listRefs[i])) {
      listRefs = refs;
      const lk = repo ? JSON.stringify(refs) : "";
      if (lk !== listKey) {
        listKey = lk;
        list.replaceChildren();
        rowBtns = [];
        revertBtn = null;
        confirmBtns = null;
        boxes = [];
        if (repo) {
          if (s.groups.staged.length) list.append(drawGroup(s, "staged"));
          if (s.groups.changes.length) list.append(drawGroup(s, "changes"));
        }
      }
    }
    applyLock(s);
    list.hidden = !repo || total === 0;
    if (s.mode === "no-folder") drawEmpty("folder", "No Folder", null);
    else if (s.mode === "no-repo") drawNoRepo(s.cwd, s.note);
    else if (repo && total === 0) drawEmpty("check", "No Changes", null);
    empty.hidden = !(s.mode === "no-folder" || s.mode === "no-repo" || (repo && total === 0));
    bar.hidden = !repo;
    syncBar();
    const committing = s.busy === "commit" || s.busy === "commit-sync";
    const spinOn = s.busy === "commit" ? commitBtn : s.busy === "commit-sync" ? commitSyncBtn : null;
    for (const b of [commitBtn, commitSyncBtn]) {
      const label = b === commitBtn ? "Commit" : "Commit and Sync";
      if (b === spinOn) {
        b.replaceChildren(lucide("loader-circle", "icn cx-spin"), document.createTextNode("Committing"));
        b.setAttribute("aria-busy", "true");
      } else if (b.getAttribute("aria-busy") === "true" || b.textContent !== label) {
        b.textContent = label;
        b.removeAttribute("aria-busy");
      }
    }
    root.classList.toggle("cx-committing", committing);
    restoreFocus(s, locked);
    restoreHeadFocus(s, locked);
  }

  return { root, message, render, closeMenu };
}

/** A staged rename is two index entries: unstaging only the destination would leave the source's
 *  deletion staged, so the source path rides along. */
function pathsOf(r: Row): string[] {
  return r.group === "staged" && r.file.origPath ? [r.file.path, r.file.origPath] : [r.file.path];
}

function uniq(rows: Row[]): string[] {
  return [...new Set(rows.flatMap(pathsOf))];
}
