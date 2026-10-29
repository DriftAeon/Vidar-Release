// src\onboarding\step-primary.ts — onboarding step 1, Primary Agent (mock primary-agent-variants C,
// The Seam, with B's door tints and scrim). Claude and Codex face each other across a seam. A side
// whose agent is not installed is drawn disabled; a side the release set does not list is not drawn.
// A click opens that agent's setup view (path, login, version where known) and "Use X" writes
// `primaryAgent` the way Settings does (patch_settings), then moves on. Login is never a gate.
import { AGENTS } from "../agents/descriptor";
import { AGENT_IDS } from "../agents/id";
import { effectivePrimary, primaryAsked, primaryChoices, type PrimaryAgent } from "../agents/primary";
import { loadConfig, onSettingsChanged } from "../config";
import { CATALOG, depsReport, onDepsChange } from "../deps/state";
import { invoke } from "../ipc";
import { markFor } from "../launcher/menu-rows";
import { moduleListed, onModulesChange } from "../modules/registry";
import { knownUpdates, onKnownUpdates } from "../startup-updates/known";
import { registerStep, type StepCtx } from "./steps";

const LABEL = Object.fromEntries(AGENT_IDS.map((id) => [id, AGENTS[id].name])) as Record<PrimaryAgent, string>;

const LEAN = 54; // hover leans the seam to 54 / 46 toward the hovered side
const STEP = 70; // after a click the chosen side holds 70 / 30

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function tile(id: PrimaryAgent, cls: string): HTMLImageElement {
  const img = el("img", cls);
  img.alt = "";
  const mark = markFor(LABEL[id]);
  if (mark) img.src = mark.icon;
  return img;
}

function row(dot: "ok" | "warn", text: string, mono: boolean): HTMLElement {
  const r = el("div", "ob-setup-row");
  r.append(el("span", `ob-dot ${dot}`), el("span", mono ? "ob-setup-text ob-mono" : "ob-setup-text", text));
  return r;
}

/** The setup card: dep name (and version when the update check knows it), path, Claude's login state. */
function setupCard(id: PrimaryAgent): HTMLElement {
  const card = el("div", "ob-setup");
  const entry = CATALOG.deps.find((d) => d.id === id);
  const status = depsReport()?.deps.find((d) => d.id === id);
  const head = el("div", "ob-setup-row");
  head.append(el("span", "ob-dot ok"), el("span", "ob-setup-text", entry?.label ?? LABEL[id]));
  const version = knownUpdates().updates.find((u) => u.id === id)?.installed;
  if (version) head.append(el("span", "ob-setup-val ob-mono", version));
  card.append(head);
  if (status?.location) card.append(row("ok", status.location, true));
  if (entry?.authCheck === "claude" && status) {
    card.append(status.warning ? row("warn", "Not Logged In", false) : row("ok", "Logged In", false));
  }
  return card;
}

registerStep({
  id: "primary",
  title: "Primary Agent",
  hideTitle: true, // the label crossed the seam and added nothing
  mount(body: HTMLElement, ctx: StepCtx) {
    const root = el("div", "ob-primary");
    body.appendChild(root);
    let picked: PrimaryAgent | null = primaryAsked() ? effectivePrimary() : null;
    let view: PrimaryAgent | null = null; // the side whose setup view is open
    let saving = false;
    let error = "";
    let disposed = false;

    const listed = (): PrimaryAgent[] => AGENT_IDS.filter((id) => moduleListed(id));

    function seam(p: number | null): void {
      ctx.setSeam(p);
      root.style.setProperty("--ob-seam", `${p ?? 50}%`);
    }

    function use(id: PrimaryAgent): void {
      if (saving) return;
      saving = true;
      error = "";
      paint();
      invoke("patch_settings", { key: "primaryAgent", value: id }).then(
        () => {
          if (disposed) return;
          saving = false;
          picked = id;
          ctx.setNextEnabled(true);
          ctx.next();
        },
        (e: unknown) => {
          console.error(`primaryAgent not saved: ${String(e)}`);
          if (disposed) return;
          saving = false;
          error = `Not Saved: ${String(e)}`;
          paint();
        },
      );
    }

    function side(id: PrimaryAgent, sides: PrimaryAgent[], installed: boolean): HTMLElement {
      const b = el("button", `ob-half ${id}${picked === id ? " picked" : ""}`);
      b.type = "button";
      b.disabled = !installed;
      b.append(tile(id, "ob-tile"), el("span", "ob-name", LABEL[id]));
      if (!installed) b.append(el("span", "ob-absent", "Not Installed"));
      else {
        b.addEventListener("click", () => { view = id; error = ""; paint(); });
        if (sides.length > 1) {
          const lean = id === sides[0] ? LEAN : 100 - LEAN;
          b.addEventListener("pointerenter", () => seam(lean));
          b.addEventListener("pointerleave", () => seam(null));
        }
      }
      return b;
    }

    function paint(): void {
      if (disposed) return;
      const choices = primaryChoices();
      const sides = listed();
      if (view && !choices.includes(view)) view = null;
      root.replaceChildren();
      root.dataset.sides = String(sides.length);
      ctx.setNextEnabled(picked !== null && choices.includes(picked));
      ctx.setBack(view ? () => { view = null; error = ""; paint(); } : null);
      if (!view) {
        seam(null);
        for (const id of sides) root.append(side(id, sides, choices.includes(id)));
        if (sides.length > 1) root.append(el("div", "ob-seam-line"));
        return;
      }
      const main = view;
      const first = sides[0] === main;
      seam(sides.length > 1 ? (first ? STEP : 100 - STEP) : null);
      const mainCol = el("div", `ob-half ${main} main`);
      const head = el("div", "ob-row-head");
      head.append(tile(main, "ob-tile"), el("span", "ob-name", LABEL[main]));
      const use$ = el("button", "ws-btn ws-add ob-btn ob-big", `Use ${LABEL[main]}`);
      use$.type = "button";
      use$.disabled = saving;
      use$.addEventListener("click", () => use(main));
      mainCol.append(head, setupCard(main), use$);
      if (error) mainCol.append(el("div", "ob-error", error));
      const cols: HTMLElement[] = [mainCol];
      for (const id of sides) {
        if (id === main) continue;
        // the narrow side: the other way back to the split, or a dimmed Not Installed mark
        const other = el("button", `ob-half ${id} other`);
        other.type = "button";
        other.append(tile(id, "ob-tile"), el("span", "ob-name", LABEL[id]));
        if (choices.includes(id)) other.addEventListener("click", () => { view = null; error = ""; paint(); });
        else {
          other.disabled = true;
          other.append(el("span", "ob-absent", "Not Installed"));
        }
        cols.push(other);
      }
      // keep Claude left, Codex right, whichever side holds the setup view
      root.append(...(first ? cols : [...cols].reverse()), el("div", "ob-seam-line"));
    }

    paint();
    const offs = [
      onDepsChange(paint),
      onModulesChange(paint),
      onKnownUpdates(paint),
      onSettingsChanged(({ keys }) => {
        if (!keys.includes("primaryAgent")) return;
        void loadConfig().then(() => {
          picked = primaryAsked() ? effectivePrimary() : null;
          paint();
        });
      }),
    ];
    return () => {
      disposed = true;
      for (const off of offs) off();
    };
  },
});
