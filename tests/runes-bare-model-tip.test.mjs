// The Generate Runes from Local Model select and the Generate tooltip name the same model, before and after a pick.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { mountBareView } = await import("../src/runes/bare/view.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

const MODELS = [
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

function harness() {
  const SET = { library: "installed", set: "installed" };
  const vault = { id: "daily", name: "Daily", hash: "abc", lockedUtc: null,
    runesets: [{ source: SET, file: "installed.md", copiedUtc: "", sourceHash: "" }], runes: [], pins: {} };
  const view = { vault, runes: [], warnings: [], drift: [] };
  const vaultIo = {
    session: async () => ({ vault: { id: "daily", hash: "abc" } }),
    read: async () => structuredClone(view),
    lock: async () => vault,
  };
  const files = [{ path: "C:/proj/CLAUDE.md", shown: "CLAUDE.md", kind: "rules", scope: "project", ticked: true, pickable: true }];
  const io = {
    localSources: async () => ({ files, memoryDir: null, guardsKey: false }),
    moduleBundles: async () => ({ bundles: {}, warnings: [] }),
    generate: async () => { throw Error("unused"); },
    generateCancel: async () => null,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", vault: vaultIo,
    gen: () => ({ models: MODELS }), start: "files" }, io);
  return { host, dispose() { handle.dispose(); host.remove(); } };
}

const picked = (host) => {
  const sel = host.querySelector('select[aria-label="Model"]');
  return MODELS.find((m) => m.value === sel.value)?.label ?? sel.value;
};
const generate = (host) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Generate");

test("Generate's tooltip names the model the Model select shows, default and after a pick", async () => {
  const h = harness();
  try {
    await settle();
    assert.ok(generate(h.host), "Generate is offered");
    assert.equal(picked(h.host), "Sonnet 5");
    assert.equal(generate(h.host).title, "Sends the ticked rules to Sonnet 5.");
    const sel = h.host.querySelector('select[aria-label="Model"]');
    sel.focus();
    sel.value = "claude-opus-5-5";
    sel.dispatchEvent(new window.Event("change"));
    await settle();
    assert.equal(picked(h.host), "Opus 5.5");
    assert.equal(generate(h.host).title, "Sends the ticked rules to Opus 5.5.");
    const now = h.host.querySelector('select[aria-label="Model"]');
    assert.notEqual(now, sel, "the pick repaints the select");
    assert.equal(document.activeElement, now, "focus follows to the repainted select, so the next key reaches it");
  } finally { h.dispose(); }
});
