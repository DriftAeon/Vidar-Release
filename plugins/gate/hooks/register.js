// Gate mod: the session index and the context band as one local mod (the handoff gate is retired).
// Replaces ~\.claude\hooks\context-gate.mjs (UserPromptSubmit + Stop) and
// ~\.claude\hooks\session-index.mjs (SessionStart) with the same observable behaviour.
//
// Event map:
//   session setup (.mod, index file, sid8 context)    -> prompt.submit, once per sid, only when
//     neither file exists; the .mod makes the still-wired classic hooks stand down for the session
//   Stop {"decision":"block"}                         -> classic.Stop `{ block }` (same semantics)
//   (new) band                                        -> session.measure, ui.render AbovePrompt
//
// Token count: $.session.usage().context.tokens (uncached + cache-written + cache-read, the
// classic sum) instead of the statusline files, so sourceMaxAgeSec no longer applies.
// $.fs has no rename or unlink: every write here replaces in place (not atomic). The index and
// state files are a few hundred bytes.
// Every handler swallows its own errors and passes the event on: never affect the session.
// Home: the gate's config, config and .mod live in VIDAR_AGENT_HOME when set (a
// bare tab's own Claude config dir), else <USERPROFILE>\.claude. The session index stays under
// <USERPROFILE>\.claude.

const DEFAULT_CONFIG = { budget: 200000, headroom: 20000, sourceMaxAgeSec: 600 };
const SID_RE = /^[0-9a-f-]{36}$/i;

// Last measurement, for the band. Module state: reset on reload, refilled by the next measure.
let band = null;

function joinPath(base, ...parts) {
  const sep = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

function stripBom(s) {
  return String(s).replace(/^﻿/, '');
}

async function homeDir($) {
  return (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '';
}

// The gate honours CONTEXT_GATE_HOME (tests) as the classic hook does; the index does not.
async function gateHome($) {
  return (await $.env.get('CONTEXT_GATE_HOME')) || homeDir($);
}

// The tab's Claude dir for the gate's config and .mod: VIDAR_AGENT_HOME when set
// (a bare tab's own CLAUDE_CONFIG_DIR, profiles/bare/claude.json overlay; context-gate.mjs reads the
// .mod there), else <gateHome>\.claude.
async function claudeDir($) {
  const agent = await $.env.get('VIDAR_AGENT_HOME');
  return agent || joinPath(await gateHome($), '.claude');
}

async function readConfig($, dir) {
  let config;
  try {
    const parsed = JSON.parse(stripBom(await $.fs.read(joinPath(dir, 'context-gate.json'))));
    config = { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  const override = await $.env.get('CONTEXT_GATE_BUDGET');
  if (override) {
    const b = Number(override);
    if (Number.isFinite(b) && b > 0) config.budget = b;
  }
  return config;
}

// Classic trigger: min(budget, 0.9 * window) - headroom. Returns null when there is no reading.
function measure(context, config) {
  if (!context) return null;
  const ctx = Number(context.tokens || 0);
  if (!Number.isFinite(ctx) || ctx === 0) return null;
  let window = Number(context.window);
  if (!Number.isFinite(window) || window === 0) window = 1000000;
  const trigger = Math.min(config.budget, 0.9 * window) - config.headroom;
  const pct = Number.isFinite(context.percent) ? context.percent : Math.round((ctx / window) * 100);
  return { ctx, window, trigger, pct, triggered: ctx >= trigger };
}

function indexRecord(sessionId, cwd, source, vidarTab, transcript, cliVersion) {
  return {
    sessionId,
    cwd,
    source,
    startedAt: new Date().toISOString(),
    vidarTab,
    transcript,
    cliVersion,
  };
}

async function writeIndex($, rec) {
  const path = joinPath(await homeDir($), '.claude', 'session-index', `${rec.sessionId}.json`);
  await $.fs.write(path, JSON.stringify(rec, null, 2) + '\n');
}

const sid8Text = (sessionId) =>
  `This session's id prefix: ${sessionId.slice(0, 8)} (names transcripts; it is not a SendMessage address: ListAgents prints that).`;

async function present($, path) {
  try {
    await $.fs.read(path);
    return true;
  } catch {
    return false;
  }
}

// A .catch handler: pass the event on unless the hook already did.
const passOn = async ($, e, next) => (next.called ? undefined : next(e));

export function register(on) {
  // The session's one-time setup, on its first prompt: write the context-gate .mod stand-down
  // marker and the session-index record, and add the sid8 line once. The files are the
  // once-per-sid key; module state would reset on reload. Not classic.SessionStart:
  // cc-plugin-sec-default skips person-installed plugins' classic.* events, and Claude Code
  // warns that the SessionStart hook was skipped.
  on('prompt.submit', async ($, e, next) => {
    let extra = null;
    try {
      const sessionId = (await $.session.id()) || '';
      if (SID_RE.test(sessionId)) {
        const modPath = joinPath(await claudeDir($), 'context-gate', `${sessionId}.mod`);
        const indexPath = joinPath(await homeDir($), '.claude', 'session-index', `${sessionId}.json`);
        if (!(await present($, modPath)) && !(await present($, indexPath))) {
          let wrote = false;
          try { await $.fs.write(modPath, ''); wrote = true; } catch { /* best effort */ }
          try {
            await writeIndex($, indexRecord(sessionId, await $.session.cwd(), 'prompt.submit',
              (await $.env.get('VIDAR_TAB')) ?? null, null, null));
            wrote = true;
          } catch { /* index is best effort */ }
          // Nothing on disk means no once-per-sid key: stay silent rather than repeat every prompt.
          if (wrote) extra = sid8Text(sessionId);
        }
      }
    } catch { /* never affect the prompt */ }
    if (!extra) return next(e);
    return next({ ...e, context: [...((e && e.context) ?? []), extra] });
  }).catch(passOn);

  // After each turn (and after /clear, /resume, /compact): the band's measurement.
  on('session.measure', async ($, e, next) => {
    try {
      if ((await $.env.get('CONTEXT_GATE')) !== '0') {
        const sessionId = await $.session.id();
        const config = await readConfig($, await claudeDir($));
        let context = e && e.context;
        if (!context || !context.tokens) context = (await $.session.usage()).context;
        const m = measure(context, config);
        if (sessionId && m) {
          band = { tokens: Math.round(m.ctx), budget: config.budget, triggered: m.triggered };
          $.ui.invalidate('ui.render');
        }
      }
    } catch { /* never affect the session */ }
    return next(e);
  }).catch(passOn);

  // Terminal band above the prompt. Text only: the docs do not confirm $.command.run starts a
  // user skill's turn. Rendered tabs draw no band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let ours = null;
    try {
      if (band) {
        const { Text } = $.ui.resolve(e);
        const line = `ctx ${band.tokens}/${band.budget}${band.triggered ? ' · over budget' : ''}`;
        ours = Text(band.triggered ? { color: 'yellow', children: [line] } : { dimColor: true, children: [line] });
      }
    } catch { ours = null; }
    // Keep what the mods after this one draw in the band.
    const rest = await next(e);
    if (!ours) return rest;
    try {
      const { Box } = $.ui.resolve(e);
      return rest && typeof rest === 'object'
        ? Box({ flexDirection: 'column', children: [ours, rest] })
        : ours;
    } catch {
      return rest;
    }
  }).catch(passOn);
}
