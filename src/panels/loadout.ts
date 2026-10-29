// Loadout: "what this tab starts with" — a second rack module directly under
// MCP servers (rack module conventions:
// observation only, textContent only, fetch on mount/expand, no
// polling), keyed to the active tab. Re-fetches on `vidar-focus`
// (sessions.ts:dispatchFocus) whenever the focused session's id changes.
//
// Computed from the agent's load rules, not observed — Vidar never opens
// the session's own process. The header note says so; anything inferred
// rather than verified is called out in the row it affects.

import { invoke, type CodexLoadout } from "../ipc";
import { iconImg } from "../icon-img";
import { DASH, prettyModel } from "../format";
import { tabIdentity } from "./sessions/vault-tabs";
import { launchPresentation } from "./loadout-launch";
import { onPress } from "./press";
import { detailRow, text } from "./rack-row";
import { applyOrder, enableReorder } from "./reorder";

const ORDER_KEY = "order.loadout";
import { buildInstructionsViz } from "./loadout-viz";
import { codexRows } from "./loadout-codex";
import { buildRow, detailRowNode, groupedLines, groupHead, infoLine, pathNode, rowToggles, scopeValue, shortenPath } from "./loadout-rows";
import type { FocusedSession, SessionAgent } from "./sessions";
import { skillLabel } from "./skill-label";
import { boundedCache } from "./loadout-cache";
import { isGateway } from "../launcher/agent-kind";
import { moduleOn, onModulesChange } from "../modules/registry";
import type { AgentId } from "../agents/id";

export interface KbFile {
  path: string;
  kb: number;
  // true for a rules file that only loads when a matching file is touched
  // (loadout.rs: frontmatter `paths:` key) — false for anything that loads
  // unconditionally at session start
  onTouch: boolean;
}
interface SkillEntry {
  name: string;
  description: string;
}
interface AgentEntry {
  name: string;
  model: string;
}
interface SettingsHooks {
  path: string;
  events: [string, string[]][];
}
interface SettingsPermissions {
  path: string;
  allow: number;
  ask?: string[];
  deny: string[];
}
export interface Loadout {
  instructions: KbFile[];
  memoryPath: string;
  memoryEntries: number;
  handoffPath: string;
  handoffNewest: string | null;
  skills: SkillEntry[];
  agents: AgentEntry[];
  hooks: SettingsHooks[];
  permissions: SettingsPermissions[];
  notes: string[];
}

type LoadedLoadout =
  | { kind: "claude"; data: Loadout }
  | { kind: "codex"; data: CodexLoadout };

// launchArgs is the -Command string handed to PowerShell (src/launcher/roster.ts BUILTIN_AGENTS),
// so flags show up quoted either '…' or bare, forward- or back-slash paths alike.
// Every extractor below is deliberately permissive about the quoting, and the
// Launch row prints what it found so a miss reads as an empty value, not a lie.
function extractFlag(joined: string, flag: string): string[] {
  const re = new RegExp(`--${flag}\\s+(?:'([^']*)'|"([^"]*)"|(\\S+))`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

interface ParsedLaunch {
  model: string | null;
  settingsPaths: string[];
  pluginDir: string | null;
  roleFile: string | null;
  rolePromptInline: string | null;
  baseUrl: string | null;
}

function parseLaunch(launchArgs: string[] | undefined): ParsedLaunch {
  const joined = (launchArgs ?? []).join(" ");
  const baseUrlMatch = /ANTHROPIC_BASE_URL=['"]?([^'";\s]+)/.exec(joined);
  return {
    model: extractFlag(joined, "model")[0] ?? null,
    settingsPaths: extractFlag(joined, "settings"),
    pluginDir: extractFlag(joined, "plugin-dir")[0] ?? null,
    roleFile: extractFlag(joined, "append-system-prompt-file")[0] ?? null,
    rolePromptInline: extractFlag(joined, "append-system-prompt")[0] ?? null,
    baseUrl: baseUrlMatch?.[1] ?? null,
  };
}

// One reader per agent, keyed by AgentId: a third agent fails tsc here until its reader is written
// (no fallback to Claude's). `skips` names the tabs of that agent the reader cannot see.
interface Reader {
  skips: (s: FocusedSession) => boolean;
  read: (t: FocusedSession) => Promise<LoadedLoadout>;
}
const READERS: Record<AgentId, Reader> = {
  claude: {
    // a gateway tab runs `claude --settings <fence> --plugin-dir ...`, which read_loadout cannot see
    skips: (s) => isGateway(s.art),
    read: async (t) => {
      const parsed = parseLaunch(t.launchArgs);
      // the three defaults: home settings.json is prepended by Rust (it has no
      // TS-visible home-dir lookup); the project pair sits under cwd
      const settingsPaths = [
        `${t.cwd}\\.claude\\settings.json`,
        `${t.cwd}\\.claude\\settings.local.json`,
        ...parsed.settingsPaths,
      ];
      const data = await invoke("read_loadout", {
        cwd: t.cwd,
        settingsPaths,
        pluginDir: parsed.pluginDir,
        profile: t.profile ?? null,
        // a Bare tab reads the combination home its own session runs on
        tab: t.profile ? t.id : null,
        row: t.profile ? t.rowKey ?? null : null,
      });
      return { kind: "claude", data };
    },
  },
  codex: {
    skips: () => false,
    read: async (t) => ({
      kind: "codex",
      data: await invoke("read_codex_loadout", { tab: t.id, falconSession: tabIdentity(t.id).falconSession, profile: t.profile ?? null, row: t.rowKey ?? null, cwd: t.cwd }),
    }),
  },
};
/** The agent whose reader serves this focus, else null (no focus, another agent, module off, a skipped tab). */
const readerId = (s: FocusedSession | null): AgentId | null =>
  s && Object.hasOwn(READERS, s.agent) && moduleOn(s.agent) && !READERS[s.agent as AgentId].skips(s) ? (s.agent as AgentId) : null;

export function initLoadout(root: HTMLElement, signal?: AbortSignal) {
  const box = document.createElement("div");
  box.className = "module module-box";
  // no visible head (2026-10-05); the box keeps its accessible name
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Loadout");
  box.innerHTML = `<button type="button" class="rack-name loadout-gear" aria-expanded="false"><span class="rack-label">Gear</span></button><div class="loadout-wrap"><div class="loadout-inner"><div class="rack-list"></div></div></div>`;
  const list = box.querySelector<HTMLElement>(".rack-list")!;
  const gear = box.querySelector<HTMLButtonElement>(".loadout-gear")!;
  gear.prepend(iconImg("toolbox")); // left of the label (2026-10-10)
  const paintOpen = (open: boolean) => {
    box.dataset.open = String(open);
    gear.setAttribute("aria-expanded", String(open));
  };
  // every launch starts collapsed; open is not persisted (2026-10-10)
  paintOpen(false);
  onPress(gear, () => paintOpen(box.dataset.open !== "true"));
  enableReorder(list, ORDER_KEY);
  root.appendChild(box);

  let focused: FocusedSession | null = null;
  // what load() reads from the session: a change in any of them refetches, the rest only redraws
  let lastLoadKey: string | null = null;
  const loadKey = (s: FocusedSession | null) => (s ? JSON.stringify([s.id, s.agent, s.cwd, s.profile ?? null, s.rowKey ?? null, s.launchArgs ?? null]) : null);
  let loadGen = 0;
  // cached so a same-id vidar-focus (title/model changed, id didn't) redraws
  // without a spurious "Querying…" flash or a wasted re-fetch
  let lastLoadout: LoadedLoadout | null = null;
  let lastError: string | null = null;
  // last reply per loadKey: a tab switch draws it at once and refetches behind it
  const loadoutCache = boundedCache<LoadedLoadout>(16);
  // rows for a focus about to load: its cached reply, else whatever same-kind rows are already drawn
  // (so the box never drops to "Querying…" between tabs), else null
  const rowsWhileLoading = (key: string, kind: AgentId): LoadedLoadout | null => {
    const cached = loadoutCache.get(key);
    if (cached?.kind === kind) return cached;
    return drawn?.loadout?.kind === kind ? drawn.loadout : null;
  };
  // a reply identical to what is on screen needs no redraw
  const sameLoadout = (a: LoadedLoadout | null, b: LoadedLoadout) => !!a && a.kind === b.kind && JSON.stringify(a.data) === JSON.stringify(b.data);
  let claudeAvailable = moduleOn("claude");
  let codexAvailable = moduleOn("codex");

  // every row hidden (all sections empty): leave the list empty, so modules.css hides the whole Gear box
  const paintRows = (rows: HTMLElement[]) => {
    list.replaceChildren(...(rows.every((r) => r.hidden) ? [] : rows));
    applyOrder(list, ORDER_KEY);
  };

  const render = (loaded: LoadedLoadout | null, error: string | null) => {
    if (!focused) {
      list.replaceChildren();
      return;
    }

    const agent: SessionAgent = focused.agent;
    const isClaude = agent === "claude" && moduleOn("claude");
    const isCodex = agent === "codex" && moduleOn("codex");
    const parsed = parseLaunch(focused.launchArgs);
    const rows: HTMLElement[] = [];

    // 1. Launch — always shown, every agent, never waits on the Rust call; no
    // headline value (the model is in the detail, and the tab header already shows it)
    // Only what differs from a default launch; a plain tab has no Launch row.
    const launchSet = !!parsed.baseUrl ||
      (isClaude && (parsed.settingsPaths.length > 0 || !!parsed.pluginDir || !!parsed.roleFile || !!parsed.rolePromptInline));
    if (launchSet) rows.push(
      buildRow("Launch", scopeValue(""), () => {
        const d: HTMLElement[] = [];
        if (parsed.baseUrl) d.push(launchPresentation([["Endpoint", parsed.baseUrl]]));
        if (isClaude) {
          if (parsed.settingsPaths.length) {
            d.push(detailRow("Settings", parsed.settingsPaths.map((p) => shortenPath(p, focused!.cwd)).join(", ")));
          }
          if (parsed.pluginDir) d.push(detailRow("Plugins", shortenPath(parsed.pluginDir, focused!.cwd)));
          if (parsed.roleFile) {
            const base = parsed.roleFile.split(/[\\/]/).pop() ?? parsed.roleFile;
            const valueEl = text("", base);
            valueEl.title = parsed.roleFile;
            const roleFileRow = detailRowNode("Role", valueEl);
            d.push(roleFileRow);
            const focusedId = focused!.id;
            const roleFilePath = parsed.roleFile;
            invoke("file_kb", { path: roleFilePath }).then((kb) => {
              if (focused?.id !== focusedId || !moduleOn("claude") || signal?.aborted) return;
              if (kb == null) valueEl.textContent = `${base} (Not Found)`;
            });
          } else if (parsed.rolePromptInline) {
            d.push(detailRow("Role", parsed.rolePromptInline.slice(0, 60)));
          }
        }
        return d;
      }),
    );

    // Other agents and gateway tabs have no reader (load() skips them); Launch still applies to every agent.
    const reads = isClaude && !isGateway(focused.art);
    if (!reads && !isCodex) {
      list.replaceChildren(...rows);
      return;
    }

    if (error) {
      rows.push(text("sub tool-err", `Loadout – Unavailable (${error})`));
      list.replaceChildren(...rows);
      return;
    }
    if (!loaded || (isClaude && loaded.kind !== "claude") || (isCodex && loaded.kind !== "codex")) {
      rows.push(text("dim sub", "Querying…"));
      list.replaceChildren(...rows);
      return;
    }

    if (loaded.kind === "codex") {
      rows.push(...codexRows(loaded.data, focused.cwd));
      paintRows(rows);
      return;
    }
    const loadout = loaded.data;

    // 2. Instructions — no headline value; per-file KB (at-start and on-touch)
    // lives in the detail viz only
    rows.push(
      buildRow(
        "Instructions",
        scopeValue(""),
        () => (loadout.instructions.length ? [buildInstructionsViz(loadout.instructions)] : []),
        !loadout.instructions.length,
      ),
    );

    // 3. Memory
    rows.push(
      buildRow("Memory", scopeValue(""), () => {
        const memory = pathNode(loadout.memoryPath, focused!.cwd);
        if (!loadout.memoryPath) memory.textContent = DASH;
        const details = [infoLine("filing-cabinet", memory, `${loadout.memoryEntries} Memory Entries`)];
        if (loadout.handoffNewest) {
          details.push(infoLine("restore", pathNode(loadout.handoffNewest, focused!.cwd), "Latest Handoff"));
        }
        return details;
      }, !loadout.memoryPath && !loadout.handoffNewest && !loadout.memoryEntries),
    );

    // 4. Agents — Claude Code subagent profiles read from ~/.claude/agents only (a Codex tab's role files list in loadout-codex.ts).
    // Count-free rows sit together at the top
    rows.push(
      buildRow("Agents", scopeValue(""), () =>
        loadout.agents.length
          ? loadout.agents.map((a) => detailRow(a.name, a.model ? prettyModel(a.model) : DASH)) // "opus" and "claude-sonnet-5-5" read alike (2026-10-05)
          : [],
        !loadout.agents.length,
      ),
    );

    // 5. Skills
    rows.push(
      buildRow("Skills", scopeValue(""), () =>
        loadout.skills.length
          ? [
              (() => {
                const list = document.createElement("div");
                list.className = "item-btn-list";
                list.append(
                  ...loadout.skills.map((s) => {
                    // one button per skill, no action yet (a toggle later); the
                    // description is hover
                    const el = document.createElement("button");
                    el.type = "button";
                    el.className = "item-btn";
                    el.append(text("item-btn-dot", ""), text("item-btn-name", skillLabel(s.name)));
                    if (s.description) el.title = s.description;
                    return el;
                  }),
                );
                return list;
              })(),
            ]
          : [],
        !loadout.skills.length,
      ),
    );

    // 7. Hooks — one compact line per distinct script under its event; source and repeat count
    // live in the tooltip. Rust supplies basenames, not full commands.
    rows.push(
      buildRow("Hooks", scopeValue(""), () => {
        if (!loadout.hooks.length) return [];
        const byEvent = new Map<string, { path: string; scripts: string[] }[]>();
        for (const h of loadout.hooks) {
          for (const [event, scripts] of h.events) {
            if (!byEvent.has(event)) byEvent.set(event, []);
            byEvent.get(event)!.push({ path: h.path, scripts });
          }
        }
        const d: HTMLElement[] = [];
        for (const [event, contributions] of [...byEvent].sort((a, b) => a[0].localeCompare(b[0]))) {
          const scripts = new Map<string, { count: number; paths: string[] }>();
          for (const c of contributions) for (const script of c.scripts) {
            const entry = scripts.get(script) ?? { count: 0, paths: [] };
            entry.count++;
            if (!entry.paths.includes(c.path)) entry.paths.push(c.path);
            scripts.set(script, entry);
          }
          const lines = [...scripts].map(([script, entry]) => {
            const line = text("loadout-item-line loadout-mono", entry.count > 1 ? `${script} ×${entry.count}` : script);
            line.title = `${script} · ${entry.paths.join(", ")}`;
            return line;
          });
          d.push(groupedLines(
            groupHead("timer", event.replace(/([a-z])([A-Z])/g, "$1 $2"), event),
            lines.length ? lines : [text("dim", DASH)],
          ));
        }
        return d;
      }, !loadout.hooks.length),
    );

    // 8. Permissions — action groups once, with source paths on hover.
    // Ask is optional until the native read_loadout contract exposes it.
    rows.push(
      buildRow("Permissions", scopeValue(""), () => {
        if (!loadout.permissions.length) return [text("dim sub", DASH)];
        const d: HTMLElement[] = [];
        const allow = loadout.permissions.filter((p) => p.allow).map((p) => {
          const line = document.createElement("div");
          line.className = "loadout-item-line loadout-source-line";
          line.append(pathNode(p.path, focused!.cwd), text("loadout-mono", String(p.allow)));
          return line;
        });
        if (allow.length) {
          d.push(groupedLines(groupHead("shield", "Allow", "Allowed Rules"), allow));
        }
        for (const [kind, icon] of [["ask", "question"], ["deny", "edit-clear"]] as const) {
          const lines = loadout.permissions.flatMap((p) => (p[kind] ?? []).map((pattern) => {
            const line = text("loadout-item-line loadout-mono", pattern);
            line.title = `${pattern} · ${p.path}`;
            return line;
          }));
          if (lines.length) d.push(groupedLines(groupHead(icon, kind === "ask" ? "Ask" : "Deny", `${kind === "ask" ? "Ask" : "Denied"} Rules`), lines));
        }
        return d.length ? d : [text("dim sub", DASH)];
      }, !loadout.permissions.length),
    );

    for (const n of loadout.notes) rows.push(text("sub tool-err", n));

    paintRows(rows);
  };

  const load = async () => {
    // Invalidate any earlier reply even when this focus has no reader.
    const gen = ++loadGen;
    const id = readerId(focused);
    if (!focused || !id) {
      lastLoadout = null;
      lastError = null;
      redraw(null, null, false);
      return;
    }
    // Capture the target now: `focused` can move on while this await is in
    // flight. Each call bumps `loadGen`, so a focus change during a load
    // does not get dropped — it queues its own load() — and the older
    // call's result is discarded by `stale` instead of being written over a newer one.
    const target = focused;
    const stale = () => gen !== loadGen || focused?.id !== target.id || focused.agent !== id || !moduleOn(id) || !!signal?.aborted;
    const key = loadKey(target)!;
    lastLoadout = rowsWhileLoading(key, id);
    redraw(lastLoadout, null);
    try {
      const fresh = await READERS[id].read(target);
      if (stale()) return;
      loadoutCache.set(key, fresh);
      lastError = null;
      if (sameLoadout(lastLoadout, fresh)) return;
      lastLoadout = fresh;
      redraw(lastLoadout, null);
    } catch (e) {
      if (stale()) return;
      lastLoadout = null;
      lastError = String(e);
      redraw(null, lastError, false);
    }
  };

  // what render() reads; a same-session vidar-focus (model change, alive/dead, rename) usually
  // changes none of it, and a redraw would collapse the open rows and drop focus
  let drawn: { key: string; loadout: LoadedLoadout | null; error: string | null } | null = null;
  const inputsKey = () => (focused ? JSON.stringify([focused.id, focused.agent, focused.cwd, focused.launchArgs ?? null, focused.profile ?? null, moduleOn("claude"), moduleOn("codex")]) : "");
  /** render() unless its inputs are unchanged. `keep`: a same-session redraw re-opens the open rows
   *  and puts focus back, by row key; a new session's draw (load) starts collapsed, as before */
  const redraw = (loadout: LoadedLoadout | null, error: string | null, keep = true) => {
    const key = inputsKey();
    if (drawn && drawn.key === key && drawn.loadout === loadout && drawn.error === error) return;
    drawn = { key, loadout, error };
    if (!keep) { render(loadout, error); return; }
    const rowKey = (n: Element | null) => n?.closest<HTMLElement>(".rack-row")?.dataset.key ?? null;
    const open = new Set(Array.from(list.querySelectorAll<HTMLElement>(".rack-row.open"), (r) => r.dataset.key ?? ""));
    const a = document.activeElement;
    const focusKey = a && list.contains(a) ? rowKey(a) : null;
    render(loadout, error);
    if (!open.size && focusKey === null) return;
    for (const row of list.querySelectorAll<HTMLElement>(".rack-row")) {
      const k = row.dataset.key ?? "";
      if (open.has(k)) rowToggles.get(row)?.();
      if (focusKey !== null && k === focusKey) row.querySelector<HTMLElement>(".rack-name")?.focus();
    }
  };

  document.addEventListener("vidar-focus", (e) => {
    const s = (e as CustomEvent<FocusedSession | null>).detail;
    focused = s;
    const key = loadKey(s);
    if (key !== lastLoadKey) {
      lastLoadKey = key;
      lastLoadout = null;
      lastError = null;
      void load();
    } else {
      redraw(lastLoadout, lastError);
    }
  }, { signal });

  const unsubscribeModules = onModulesChange(() => {
    const available = moduleOn("claude");
    const codex = moduleOn("codex");
    if (available === claudeAvailable && codex === codexAvailable) return;
    claudeAvailable = available;
    codexAvailable = codex;
    lastLoadout = null;
    lastError = null;
    void load();
  });
  signal?.addEventListener("abort", unsubscribeModules, { once: true });

  render(null, null);
}
