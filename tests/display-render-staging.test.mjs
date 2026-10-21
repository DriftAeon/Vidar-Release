// display-render.ts contract (Relay and Document paint display files through it): an HTML frame
// loads behind the render on screen and replaces it only on load (no white flash between files).
// Carried over from the retired Display tab's mount test (2026-10-16).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    // renderPreview: an iframe for "frame…" content (the staged path), a div otherwise
    "panels/preview": `export function renderPreview(kind, content) {
        const el = document.createElement(content.startsWith("frame") ? "iframe" : "div");
        el.className = "display-render"; el.dataset.content = content;
        // jsdom fires an about:blank load on append; the test fires the real one
        const add = el.addEventListener.bind(el);
        el.addEventListener = (t, fn, o) => t === "load" ? (el.fireLoad = fn) : add(t, fn, o);
        return { el, dropped: {}, fellBack: null };
      }`,
  },
});
// show() branches on these; the shared helper does not install them
Object.assign(globalThis, { HTMLImageElement: dom.window.HTMLImageElement, HTMLIFrameElement: dom.window.HTMLIFrameElement });

let content = (path) => `div:${path}`;
dom.ipc.answers.read_display_file = ({ path }) => ({ kind: "html", content: content(path), sha256: "x" });
const { createDisplayRenderer } = await import("../src/panels/display-render.ts");
const box = document.createElement("div");
document.body.append(box);
const renderer = createDisplayRenderer(box);
const settle = async () => { for (let i = 0; i < 4; i++) await dom.flush(); };

test("display render: an HTML frame stays hidden behind the render on screen until it loads", async () => {
  await renderer.show({ path: "D:\\b.html", kind: "html", mtime_ms: 300 });
  const old = box.firstElementChild;
  assert.ok(old, "the first render painted");
  content = (path) => `frame:${path}`;
  const painting = renderer.show({ path: "D:\\c.html", kind: "html", mtime_ms: 400 });
  await settle();
  const staged = box.querySelector("iframe.display-staging");
  assert.ok(staged, "the new frame was not staged");
  assert.equal(old.isConnected, true, "the old render left before the frame loaded");

  staged.fireLoad();
  await painting;
  assert.deepEqual([...box.children], [staged], "the swap left the old render or dropped the frame");
  assert.equal(staged.classList.contains("display-staging"), false);
});
