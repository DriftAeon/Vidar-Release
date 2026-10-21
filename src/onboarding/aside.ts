// src\onboarding\aside.ts — the overlay steps aside while a tab it caused is open (Setup Via Agent,
// Voice Slots, Open Dependencies) and returns when that tab closes. A page tab closes through its
// mount's dispose (sessions.ts closeSession); an agent tab closes through the tab-state store's
// removal notice (removeSessionView -> dropTabState -> drop). Both are hooks those tabs already fire.
import { subscribe } from "../panels/sessions/tab-state-store";
import { onboardingOpen, stepAside, stepBack } from "./shell";

let asided = false;

function release(): void {
  if (!asided) return;
  asided = false;
  stepBack();
}

/** Wraps a page tab's mount so its close (the dispose) brings the overlay back. */
export function backOnPageClose(mount: (host: HTMLElement) => () => void): (host: HTMLElement) => () => void {
  return (host) => {
    const dispose = mount(host);
    return () => {
      dispose();
      release();
    };
  };
}

/** Hides the overlay while a page tab is open; a no-op with no overlay. */
export function asideForPage(): void {
  if (!onboardingOpen()) return;
  asided = true;
  stepAside();
}

/** Hides the overlay while the agent tab `id` is open; returns when its tab state is dropped. */
export function asideForTab(id: string): void {
  if (!onboardingOpen()) return;
  asided = true;
  stepAside();
  const off = subscribe((tab, state) => {
    if (tab !== id || state !== null) return;
    off();
    release();
  });
}
