/* Browser-only mock that ipc.ts selects when `__TAURI_INTERNALS__` is absent
   (`npm run dev` in a plain browser): canned config/status/display data and a
   fake pty that plays scrollback. Fidelity is "renders", not "behaves".
   No @tauri-apps imports here: ipc.ts stays the only file allowed them. */

import { rel } from "./paths";

const mockPath = (id: string) => `C:\\Main\\Apps\\Vidar\\${rel(id).replace(/\//g, "\\")}\\`;

/* ---------------- mock event bus ---------------- */

type MockHandler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Set<MockHandler>>();
const cannedStarted = new Set<string>();

function emit(event: string, payload: unknown) {
  handlers.get(event)?.forEach((h) => h({ payload }));
}

export async function mockListen(event: string, handler: MockHandler): Promise<() => void> {
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(handler);
  // First listener on an event kicks off its canned emissions (slightly
  // delayed so sibling listeners registered in the same init pass see them).
  if (!cannedStarted.has(event)) {
    cannedStarted.add(event);
    if (event === "status-update") setTimeout(emitStatus, 300);
    if (event === "display-update") {
      setTimeout(() => {
        const { files, docs } = displayEntries();
        emit(event, { files, docs, newest: files[0]?.path ?? null });
      }, 300);
    }
  }
  return () => set.delete(handler);
}

// One TabStatus per spawned mock pty (status.ts renders the focused tab's
// entry only). The second tab spawned is stale (age > 60 s) so the dimmed
// styling gets exercised on a tab you can actually focus.
function emitStatus() {
  const tabs = [...ptyTimers.keys()];
  emit(
    "status-update",
    tabs.map((tab, i) => ({ tab, age_secs: i === 1 ? 400 : 12, payload: MOCK_STATUS.payload })),
  );
}

/* ---------------- mock invoke ---------------- */

export async function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "read_config":
      return { config: MOCK_CONFIG, error: null };
    case "read_default_cwd":
      return MOCK_CONFIG.defaultCwd;
    case "codex_cwd_refused":
      return false;
    case "vidar_worktree_open":
      return `${mockPath("bridge")}worktrees\\codex-20261022-120000`;
    case "list_characters":
      return { packs: [], default: null };
    case "spawn_pty":
      return spawnMockPty(String(args?.id), Number(args?.ptyGen));
    case "write_pty":
      return echoMockPty(String(args?.id), String(args?.data));
    case "kill_pty":
      return killMockPty(String(args?.id));
    case "save_clip":
      return `${mockPath("clips")}clip-${Date.now()}.txt`;
    case "read_display_file": {
      const f = DISPLAY_FILES[String(args?.path)];
      if (!f) throw `mock: no such display file: ${String(args?.path)}`;
      return f;
    }
    // Document tab: the same .md entries display-update advertises as docs.
    case "list_documents":
      return displayEntries().docs.map((d) => ({ path: d.path, name: d.path.split("\\").pop(), mtime_ms: d.mtime_ms }));
    case "read_document": {
      const p = String(args?.path);
      const f = DISPLAY_FILES[p];
      if (!f) throw `mock: no such document: ${p}`;
      const mtimeMs = displayEntries().docs.find((d) => d.path === p)?.mtime_ms ?? Date.now();
      return { name: p.split("\\").pop(), bytes: f.content.length, mtimeMs, text: f.content, lossy: false };
    }
    case "stat_document":
      return displayEntries().docs.find((d) => d.path === String(args?.path))?.mtime_ms ?? null;
    case "create_document": {
      const name = String(args?.name ?? "").trim();
      if (!name || /[\\/:<>"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw "invalid document name";
      const filename = name.includes(".") ? name : `${name}.md`;
      if (!/\.(md|txt)$/i.test(filename)) throw "unsupported document type";
      const path = DISPLAY_DIR + filename;
      if (Object.keys(DISPLAY_FILES).some((p) => p.toLowerCase() === path.toLowerCase())) throw "file exists";
      DISPLAY_FILES[path] = { kind: "md", content: `# ${filename.replace(/\.(md|txt)$/i, "")}\n` };
      documentMtimes.set(path, Date.now());
      return path;
    }
    case "write_document": {
      const path = String(args?.path), file = DISPLAY_FILES[path];
      const mtime = documentMtimes.get(path);
      if (!file || mtime === undefined || mtime !== args?.expectedMtime) throw "conflict: changed on disk";
      const text = String(args?.text);
      if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw "document over 2 MiB";
      file.content = text;
      // Match filesystem milliseconds: two writes may share a timestamp.
      const next = Date.now();
      documentMtimes.set(path, next);
      return next;
    }
    case "read_mcp_servers":
      return MOCK_RACK;
    case "list_mcp_tools":
    case "list_mcp_tools_stdio":
    case "list_external_sessions":
    case "list_codex_threads":
    case "codex_list_models":
    case "codex_rollout_threads":
      return [];
    case "agent_reap_all":
      return 0;
    case "read_codex_model":
    case "read_codex_limits":
      return null;
    case "status_snapshot":
      return [];
    case "runes_catalog":
      return {
        libraries: [
          { key: "global", root: "~/.claude/mock-library", present: false, sets: [], runes: [] },
          {
            key: "vidar", root: "mock-library", present: true,
            sets: [{ id: "mock-core", target: "CLAUDE.md", targetAbs: "CLAUDE.md", activate: "none", paths: [], scope: ["global"], tier: 1, members: [{ id: "mock-rule", recall: false }] }],
            runes: [{ id: "mock-rule", kind: "rule", scope: ["global"], state: "active", activate: "always", description: "Mock rule.", path: "mock-library/rules/mock-rule.md", body: "Mock body.\n" }],
          },
        ],
      };
    case "runes_loaded":
      return { source: "none", reason: "No Session Yet", files: [], truncated: false };
    case "lab_item":
      return { cases: [], runs: [], runnerPresent: false };
    case "read_session_meta":
      return { model: null, effort: null };
    // Flow's file store (flow_store.rs) in memory: Flow persists for the page's life under Vite.
    case "flow_store_open":
      return { writable: true, entries: Object.fromEntries(mockFlowStore), page: ++mockFlowPage, seq: 0, lockError: null };
    case "flow_store_write":
      for (const [k, v] of (args?.entries ?? []) as [string, string | null][]) {
        if (v === null) mockFlowStore.delete(k);
        else mockFlowStore.set(k, v);
      }
      return true;
    // resize_pty, set_caption_color, open_url, open_in_editor, save_*,
    // Rules import (onboarding plan IPC Contract): one source, three bricks, one that names the profile.
    case "rules_import_sources":
      return [{ path: "~\\.claude\\CLAUDE.md", shown: "~\\.claude\\CLAUDE.md", agent: "claude", library: "claude-user", imported: false }];
    case "rules_import_scan":
      return {
        library: "claude-user",
        bricks: [
          { id: "keep-answers-short-1", section: ["Style"], body: "- Keep answers short.", line: 3, studs: 1, status: "new", kept: true, rows: [] },
          { id: "run-tests-first-2", section: ["Work"], body: "- Run tests first.", line: 7, studs: 1, status: "new", kept: true, rows: [] },
          { id: "notes-live-in-3", section: ["Known Locations"], body: "- Notes live in C:\\Users\\Acme\\notes.", line: 11, studs: 1, status: "profilePath", kept: false, rows: [] },
        ],
      };
    case "rules_import_apply":
      return { library: "claude-user", written: Array.isArray(args?.kept) ? args.kept.length : 0, rows: Object.keys((args?.rows as object) ?? {}) };
    case "bare_local_sources":
      return {
        files: [
          { path: "~\\.claude\\CLAUDE.md", shown: "~\\.claude\\CLAUDE.md", kind: "rules", library: "claude-user", scope: "global", ticked: true, pickable: true },
          { path: "~\\.claude\\hooks\\guard-cwd.mjs", shown: "~\\.claude\\hooks\\guard-cwd.mjs", kind: "hook", scope: "global", ticked: true, pickable: true,
            guard: { event: "PreToolUse", matcher: "Bash", run: ["~\\.claude\\hooks\\guard-cwd.mjs"] } },
          { path: "~\\.codex\\AGENTS.md", shown: "~\\.codex\\AGENTS.md", kind: "rules", library: "codex-user", scope: "global", ticked: true, pickable: true, agent: "codex" },
          { path: "~\\.codex\\config.toml#notion", shown: "notion", kind: "mcp", scope: "global", ticked: true, pickable: true, agent: "codex",
            hosted: "notion", url: "https://mcp.notion.com/mcp" },
          { path: "~\\.codex\\config.toml#local", shown: "local", kind: "mcp", scope: "global", ticked: false, pickable: false, agent: "codex", reason: "stdio" },
        ],
        memoryDir: null,
        guardsKey: false,
      };
    case "bare_actives":
      return {
        rowKey: typeof args?.rowKey === "string" ? args.rowKey : "claude-bare",
        libraries: [
          { library: "claude-user", source: "~\\.claude\\CLAUDE.md", scope: "global", sourceGone: false, bricks: [
            { id: "keep-answers-short-1", section: ["Style"], studs: 3, on: true, path: "runtime\\runes\\claude-user\\rules\\keep-answers-short-1.md",
              kind: "rule", activate: "always", description: "Style", body: "Keep answers short." },
            { id: "run-tests-first-2", section: ["Work"], studs: 3, on: false, path: "runtime\\runes\\claude-user\\rules\\run-tests-first-2.md",
              kind: "rule", activate: "always", description: "Work", body: "Run the tests first." },
          ] },
          { library: "vidar-recall", source: null, scope: "global", sourceGone: false, bricks: [
            { id: "recall-first-1", section: ["Recall"], studs: 3, on: true, path: "runtime\\runes\\vidar-recall\\rules\\recall-first-1.md",
              kind: "fact", activate: "recall", description: "Recall", body: "Search the notes first." },
          ] },
        ],
        skills: [],
        agents: [],
        codexSkills: [],
        codexMcp: [],
        guards: [{ event: "PreToolUse", matcher: "Bash", run: ["~\\.claude\\hooks\\guard-cwd.mjs"] }],
        guardsKey: true,
      };
    case "bare_set_layer_write":
      return null;
    case "bare_layer_set":
      return { written: ["guards", "skills", "agents", "codexSkills", "codexMcp"].filter((k) => Array.isArray((args as Record<string, unknown> | undefined)?.[k])) };
    case "rules_generate":
      return { library: "gen-claude-bare-0a1b2c3d", runes: 2, on: 2, encodedChars: null, costUsd: null,
        inputTokens: 12000, outputTokens: 3000, durationMs: 130000, warnings: [] };
    case "rules_generate_cancel":
      return null;
    case "rules_generate_toggle":
      return { library: typeof args?.library === "string" ? args.library : "gen-claude-bare-0a1b2c3d", written: 1, rows: [String(args?.rowKey ?? "claude-bare")] };
    case "bare_launch":
      return { createdUtc: "2026-10-17T09:00:00Z", agent: "claude", sets: ["claude-user"], skills: [], guards: ["guard-cwd.mjs"], warnings: [] };
    // voice_*, ocr_*, read_drop_*, adopt_session: callers tolerate
    // undefined or can't reach here from a browser.
    default:
      if (!mockWarned.has(cmd)) {
        mockWarned.add(cmd);
        console.warn(`ipc mock: no canned reply for "${cmd}", returning undefined`);
      }
      return undefined;
  }
}

const mockWarned = new Set<string>();
const mockFlowStore = new Map<string, string>();
let mockFlowPage = 0;

/* ---------------- canned data ---------------- */

// Mirrors vidar.example.json.
const MOCK_CONFIG = {
  fontSize: 14,
  defaultCwd: "",
  riderPath: "",
  macros: [
    { label: "Claude", command: "claude", submit: false },
    { label: "Git Status", command: "git status", submit: true },
  ],
  // no `voice`: keeps initVoice (and voice_register) off in the browser
};

const MOCK_RACK = {
  servers: [
    { name: "proxy", scope: "user", transport: "http", target: "http://127.0.0.1:8399/mcp", args: [], envKeys: [], project: null, disabled: false },
    { name: "unreal", scope: "project", transport: "stdio", target: "node", args: ["unreal-mcp.js"], envKeys: ["UE_ROOT"], project: "C:\\Main\\UE", disabled: true, approved: true },
    { name: "repo-tools", scope: "project", transport: "stdio", target: "node", args: ["repo-mcp.js"], envKeys: [], project: "C:\\Work\\repo", disabled: false, approved: false },
  ],
  notes: [],
};

const MOCK_STATUS = {
  age_secs: 12,
  payload: {
    session_name: "vidar · mock",
    model: { display_name: "Opus 4.5" },
    context_window: { used_percentage: 42 },
    rate_limits: {
      five_hour: {
        used_percentage: 31,
        resets_at: Math.floor(Date.now() / 1000) + 3 * 3600,
      },
      seven_day: {
        used_percentage: 58,
        resets_at: Math.floor(Date.now() / 1000) + 4 * 86400,
      },
    },
  },
};

const DISPLAY_DIR = mockPath("display");

const DISPLAY_FILES: Record<string, { kind: string; content: string }> = {
  [DISPLAY_DIR + "layout-pass.svg"]: {
    kind: "svg",
    content: `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="320" viewBox="0 0 520 320">
  <rect width="520" height="320" rx="8" fill="#15151b"/>
  <rect x="16" y="16" width="40" height="288" rx="4" fill="#22222c"/>
  <rect x="64" y="16" width="332" height="256" rx="4" fill="#1b1b23" stroke="#d7b254" stroke-width="1.5"/>
  <rect x="404" y="16" width="100" height="288" rx="4" fill="#22222c"/>
  <rect x="64" y="280" width="332" height="24" rx="4" fill="#22222c"/>
  <text x="230" y="148" fill="#d7b254" font-family="monospace" font-size="14" text-anchor="middle">terminal</text>
  <text x="454" y="164" fill="#8888a0" font-family="monospace" font-size="11" text-anchor="middle">rightbar</text>
  <text x="36" y="164" fill="#8888a0" font-family="monospace" font-size="11" text-anchor="middle" transform="rotate(-90 36 164)">leftbar</text>
  <text x="230" y="296" fill="#8888a0" font-family="monospace" font-size="10" text-anchor="middle">macros · statusline</text>
</svg>`,
  },
  [DISPLAY_DIR + "build-report.html"]: {
    kind: "html",
    content: `<body style="margin:0;padding:24px;background:#15151b;color:#e8e5dd;font-family:monospace">
  <h2 style="color:#d7b254;margin-top:0">Build report</h2>
  <p>vidar.exe · 0 errors, 2 warnings · 41.3s</p>
  <ul style="color:#8888a0"><li>unused import: theme.rs:12</li><li>dead code: pty.rs:88</li></ul>
</body>`,
  },
  // Docs live in the same folder and list_display returns them beside the
  // files, so read_display_file must know them too (kind md → text view).
  [DISPLAY_DIR + "mock-mode.md"]: {
    kind: "md",
    content: `# Mock mode

Plain browser, no Tauri backend. Everything on screen is canned data from
\`src/ipc.ts\`; nothing persists.

## What works

- Sessions strip with a scripted Claude run and a pwsh tab
- Status bar numbers, MCP rack rows, this Document tab

## What doesn't

1. Drag-drop, voice, OCR — need the real backend
2. Anything you type is echoed locally, not run

| command | mock |
|---|---|
| read_config | canned config |
| spawn_pty | scripted scrollback |
`,
  },
  [DISPLAY_DIR + "handoff.md"]: {
    kind: "md",
    content: `# Handoff

Short second document so the catalog has two entries to switch between.

> Reading position is remembered per document across tab switches.
`,
  },
};

const documentMtimes = new Map<string, number>([
  [DISPLAY_DIR + "mock-mode.md", Date.now() - 900_000],
  [DISPLAY_DIR + "handoff.md", Date.now() - 3_600_000],
]);

function displayEntries() {
  // files[0] is newest. Docs are older
  // than both visuals.
  const now = Date.now();
  return {
    files: [
      { path: DISPLAY_DIR + "layout-pass.svg", kind: "svg", mtime_ms: now - 40_000 },
      { path: DISPLAY_DIR + "build-report.html", kind: "html", mtime_ms: now - 380_000 },
    ],
    docs: [...documentMtimes].map(([path, mtime_ms]) => ({ path, kind: "md", mtime_ms })),
  };
}

/* ---------------- fake pty ---------------- */

const O = "\x1b[38;5;208m"; // claude orange
const G = "\x1b[32m";
const R = "\x1b[31m";
const D = "\x1b[90m"; // dim
const B = "\x1b[94m"; // bright blue
const X = "\x1b[0m";

// A Claude Code run inside pwsh — enough scrollback to make the terminal
// look lived-in.
const SCRIPT_CLAUDE = [
  `${D}PowerShell 7.5.1${X}`,
  `${B}PS C:\\Main\\Apps\\Vidar>${X} claude`,
  ``,
  `${O}╭───────────────────────────────────────────────────╮${X}`,
  `${O}│${X} ✻ Welcome to ${O}Claude Code${X}!                         ${O}│${X}`,
  `${O}│${X}                                                   ${O}│${X}`,
  `${O}│${X}   ${D}/help for help, /status for your current setup${X}  ${O}│${X}`,
  `${O}│${X}                                                   ${O}│${X}`,
  `${O}│${X}   ${D}cwd: C:\\Main\\Apps\\Vidar${X}                         ${O}│${X}`,
  `${O}╰───────────────────────────────────────────────────╯${X}`,
  ``,
  `${D}>${X} tighten the statusline flyout spacing and dim the section headers`,
  ``,
  `${O}●${X} I'll look at the flyout styles first.`,
  ``,
  `${O}●${X} ${G}Read${X}(src\\styles.css)`,
  `  ${D}⎿  Read 412 lines${X}`,
  ``,
  `${O}●${X} ${G}Edit${X}(src\\styles.css)`,
  `  ${D}⎿  Updated src\\styles.css with 4 additions and 2 removals${X}`,
  `       ${D}218${X}    #status-expanded h4 {`,
  `       ${D}219${X} ${R}-    margin: 10px 0 4px;${X}`,
  `       ${D}219${X} ${G}+    margin: 12px 0 4px;${X}`,
  `       ${D}220${X} ${G}+    opacity: 0.7;${X}`,
  `       ${D}221${X}    }`,
  ``,
  `${O}●${X} Done. Section headers are dimmed and the row gap is 6px —`,
  `  reload the flyout to see it.`,
  ``,
  `${D}>${X} `,
];

// Plain pwsh with some git output — second/later sessions alternate here.
const SCRIPT_PWSH = [
  `${D}PowerShell 7.5.1${X}`,
  `${B}PS C:\\Main\\Apps\\Vidar>${X} git status`,
  `On branch main`,
  `Your branch is up to date with 'origin/main'.`,
  ``,
  `Changes not staged for commit:`,
  `  ${D}(use "git add <file>..." to update what will be committed)${X}`,
  `        ${R}modified:   src/styles.css${X}`,
  `        ${R}modified:   src/panels/status.ts${X}`,
  ``,
  `no changes added to commit ${D}(use "git add" and/or "git commit -a")${X}`,
  `${B}PS C:\\Main\\Apps\\Vidar>${X} `,
];

const SCRIPTS = [SCRIPT_CLAUDE, SCRIPT_PWSH];
let spawnCount = 0;
const ptyTimers = new Map<string, number[]>();
const ptyGenerations = new Map<string, number>();

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function ptyEmit(id: string, gen: number, text: string) {
  emit("pty-output", { id, gen, data: b64(text) });
}

function spawnMockPty(id: string, gen: number) {
  const script = SCRIPTS[spawnCount++ % SCRIPTS.length];
  ptyGenerations.set(id, gen);
  const timers: number[] = [];
  ptyTimers.set(id, timers);
  ptyEmit(id, gen, "\x1b[6n"); // before the reply, as ConPTY's startup cursor query lands
  // status-update handlers persist past the first-listener gate, so a fresh
  // tab gets its bar from a re-emit rather than waiting on the canned one.
  if (handlers.has("status-update")) setTimeout(emitStatus, 200);
  script.forEach((line, i) => {
    const isLast = i === script.length - 1;
    timers.push(
      window.setTimeout(() => ptyEmit(id, gen, isLast ? line : line + "\r\n"), 150 + i * 35),
    );
  });
}

// Minimal local echo so typing in a mock terminal feels alive.
function echoMockPty(id: string, data: string) {
  if (!ptyTimers.has(id)) return;
  const gen = ptyGenerations.get(id)!;
  if (data === "\r") ptyEmit(id, gen, "\r\n");
  else if (data === "\x7f") ptyEmit(id, gen, "\b \b");
  else if (!data.startsWith("\x1b")) ptyEmit(id, gen, data);
}

function killMockPty(id: string) {
  ptyTimers.get(id)?.forEach((t) => window.clearTimeout(t));
  ptyTimers.delete(id);
  ptyGenerations.delete(id);
}
