// src\onboarding\shell.ts — the full-window onboarding overlay: a stage with the step title on
// its seam label, and the footer bar (Back, step dots, Skip, Next or Finish; mock S1). It covers
// #main and the right side; #leftbar stays drawn with New Session and Relay dimmed and inert.
// Steps come from the registry in steps.ts; each step change writes `onboarding.progress`.
// Mouse first: nothing takes default focus, and a step change moves focus to the step container.

import { getPref, setPref } from "../prefs";
import type { OnboardingProgress, OnboardingStep } from "./progress";
import { footerState, runesShown, stepView, type FooterState, type StepCtx } from "./steps";

export interface OnboardingOpts {
  /** Whether the release lists the Runes step (a set may list none); a function is read live at every
   *  step change. The shell also drops the step while the user has Runes hidden (`modules.hidden`). */
  runesListed: boolean | (() => boolean);
  /** Whether the Dependencies step counts as shown; true when it is the start step. */
  depsShown?: boolean;
  /** Runs after the overlay closes, Finish included. */
  onClose?: () => void;
}

interface Live {
  root: HTMLElement;
  body: HTMLElement;
  label: HTMLElement;
  stage: HTMLElement;
  back: HTMLButtonElement;
  skip: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  dots: HTMLElement;
  opts: OnboardingOpts;
  depsShown: boolean;
  step: OnboardingStep;
  progress: OnboardingProgress;
  footer: FooterState;
  nextEnabled: boolean;
  /** A step's own Back (setBack); replaces the step-to-step Back while set. */
  backFn: (() => void) | null;
  /** Re-renders the footer when a module is shown or hidden (the Runes step may drop in or out). */
  onModules: () => void;
  disposeStep: (() => void) | null;
  inerted: Array<{ el: HTMLElement; was: boolean }>;
}

let live: Live | null = null;

const LEFTBAR_BLOCKED = ["new-session", "relay-btn"];

export function onboardingOpen(): boolean {
  return live !== null;
}

function button(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  return b;
}

function save(l: Live, finished: boolean): void {
  l.progress = { ...l.progress, step: l.step, finished };
  setPref("onboarding.progress", l.progress);
}

/** Read at call time, never frozen at open: the Modules step can hide Runes after the overlay opened. */
function runesNow(opts: OnboardingOpts): boolean {
  const listed = typeof opts.runesListed === "function" ? opts.runesListed() : opts.runesListed;
  return runesShown(listed, getPref("modules.hidden") ?? []);
}

function renderFooter(l: Live): void {
  l.footer = footerState(l.step, {
    runesListed: runesNow(l.opts),
    depsShown: l.depsShown,
    registered: (s) => stepView(s) !== undefined,
  });
  const f = l.footer;
  l.back.hidden = f.back === null && l.backFn === null;
  l.skip.hidden = !f.skip;
  l.nextBtn.textContent = f.nextLabel;
  l.nextBtn.disabled = !l.nextEnabled;
  l.dots.replaceChildren(
    ...f.dots.map((_, n) => {
      const d = document.createElement("i");
      if (n < f.current) d.className = "done";
      else if (n === f.current) d.className = "on";
      return d;
    }),
  );
}

function setSeam(l: Live, percent: number | null): void {
  l.stage.style.setProperty("--ob-seam", percent === null ? "50%" : `${percent}%`);
}

function enter(l: Live, step: OnboardingStep): void {
  l.disposeStep?.();
  l.disposeStep = null;
  l.step = step;
  if (step === "deps") l.depsShown = true;
  l.nextEnabled = true;
  l.backFn = null;
  save(l, false);
  const view = stepView(step);
  l.label.textContent = view?.title ?? "";
  l.body.replaceChildren();
  setSeam(l, null);
  renderFooter(l);
  if (view) {
    const ctx: StepCtx = {
      progress: l.progress,
      setNextEnabled: (on) => {
        if (live !== l || l.step !== step) return;
        l.nextEnabled = on;
        l.nextBtn.disabled = !on;
      },
      next: () => advance(l, step),
      setSeam: (p) => { if (live === l && l.step === step) setSeam(l, p); },
      setProgress: (patch) => {
        if (live !== l || l.step !== step) return;
        l.progress = { ...l.progress, ...patch };
        setPref("onboarding.progress", l.progress);
      },
      setBack: (fn) => {
        if (live !== l || l.step !== step) return;
        l.backFn = fn;
        renderFooter(l);
      },
    };
    l.disposeStep = view.mount(l.body, ctx);
  }
  l.body.focus({ preventScroll: true });
}

function advance(l: Live, from: OnboardingStep): void {
  if (live !== l || l.step !== from) return;
  if (l.footer.next) enter(l, l.footer.next);
  else finish(l);
}

function finish(l: Live): void {
  save(l, true);
  setPref("onboarding.dependenciesSeen", true);
  closeOnboarding();
}

function blockLeftbar(l: Live): void {
  for (const id of LEFTBAR_BLOCKED) {
    const el = document.getElementById(id);
    if (!el) continue;
    l.inerted.push({ el, was: el.hasAttribute("inert") });
    el.setAttribute("inert", "");
    el.classList.add("ob-inert");
  }
}

/** Opens the overlay at `start` (or the first registered step after it) and writes the progress record. */
export function openOnboarding(start: OnboardingStep, opts: OnboardingOpts): void {
  if (live) return;
  const host = document.getElementById("app");
  if (!host) return;
  const root = document.createElement("section");
  root.className = "onboarding-shell";
  root.setAttribute("aria-label", "Onboarding");
  const stage = document.createElement("div");
  stage.className = "ob-stage";
  const label = document.createElement("div");
  label.className = "ob-label";
  const body = document.createElement("div");
  body.className = "ob-body";
  body.tabIndex = -1;
  stage.append(body, label);

  const bar = document.createElement("div");
  bar.className = "ob-bar";
  const left = document.createElement("div");
  left.className = "ob-bar-l";
  const right = document.createElement("div");
  right.className = "ob-bar-r";
  const back = button("Back", "ws-btn ob-btn");
  const skip = button("Skip", "ws-btn ob-btn");
  const nextBtn = button("Next", "ws-btn ws-add ob-btn");
  const dots = document.createElement("div");
  dots.className = "ob-dots";
  left.append(back);
  right.append(skip, nextBtn);
  bar.append(left, dots, right);
  root.append(stage, bar);

  const saved = getPref("onboarding.progress");
  const l: Live = {
    root, body, label, stage, back, skip, nextBtn, dots, opts,
    depsShown: opts.depsShown ?? start === "deps",
    step: start,
    progress: { step: start, finished: false, ...(saved?.workspace ? { workspace: saved.workspace } : {}) },
    footer: { back: null, skip: false, next: null, nextLabel: "Finish", dots: [], current: 0 },
    nextEnabled: true,
    backFn: null,
    onModules: () => { if (live === l) renderFooter(l); },
    disposeStep: null,
    inerted: [],
  };
  back.addEventListener("click", () => {
    if (l.backFn) l.backFn();
    else if (l.footer.back) enter(l, l.footer.back);
  });
  skip.addEventListener("click", () => advance(l, l.step));
  nextBtn.addEventListener("click", () => advance(l, l.step));

  live = l;
  document.addEventListener("vidar-modules-change", l.onModules);
  blockLeftbar(l);
  host.appendChild(root);
  // A start step nobody registered yet falls through to the next one that is.
  const first = stepView(start) ? start : footerState(start, {
    runesListed: runesNow(opts),
    depsShown: l.depsShown,
    registered: (s) => stepView(s) !== undefined,
  }).next;
  if (first) enter(l, first);
  else closeOnboarding();
}

/** Removes the overlay and restores the left bar. No progress write: Finish does that. */
export function closeOnboarding(): void {
  const l = live;
  if (!l) return;
  live = null;
  document.removeEventListener("vidar-modules-change", l.onModules);
  l.disposeStep?.();
  l.root.remove();
  for (const { el, was } of l.inerted) {
    if (!was) el.removeAttribute("inert");
    el.classList.remove("ob-inert");
  }
  l.opts.onClose?.();
}

/** Hides the overlay without losing state (a tab the overlay caused is open). */
export function stepAside(): void {
  if (live) live.root.hidden = true;
}

/** Shows the overlay again after `stepAside`, focus on the step container. */
export function stepBack(): void {
  if (!live) return;
  live.root.hidden = false;
  live.body.focus({ preventScroll: true });
}
