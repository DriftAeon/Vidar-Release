// Plain jsdom page for tests that import src/ modules directly (no resolve hooks: see dom-mount.mjs for those).
// installDom(names) installs window, document and each named window global on globalThis and returns the window.
import { JSDOM } from "jsdom";

export const BLANK_PAGE = "<!doctype html><html><body></body></html>";

export function installDom(names = [], html = BLANK_PAGE) {
  const { window } = new JSDOM(html);
  Object.assign(globalThis, { window, document: window.document });
  for (const name of names) globalThis[name] = window[name];
  return window;
}
