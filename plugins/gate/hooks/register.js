// Gate mod: the context handoff gate and the session index as one local mod.
// Replaces ~\.claude\hooks\context-gate.mjs (UserPromptSubmit + Stop) and
// ~\.claude\hooks\session-index.mjs (SessionStart) with the same observable behaviour.
//
// Event map:
//   SessionStart (index file + sid8/handoff context) -> classic.SessionStart, which first writes
//     context-gate\<sessionId>.mod so the still-wired classic hooks stand down for this session.
//   UserPromptSubmit additionalContext                -> prompt.submit `context`
//   Stop {"decision":"block"}                         -> classic.Stop `{ block }` (same semantics)
//   (new) band                                        -> session.measure, ui.render AbovePrompt
//
// Token count: $.session.usage().context.tokens (uncached + cache-written + cache-read, the
// classic sum) instead of the statusline files, so sourceMaxAgeSec no longer applies.
// $.fs has no rename or unlink: every write here replaces in place (not atomic). The index and
// state files are a few hundred bytes.
// Every handler swallows its own errors and passes the event on: never affect the session.
// Home: the gate's config, crossedAt state, .mod and handoffs live in VIDAR_AGENT_HOME when set (a
// bare tab's own Claude config dir), else <USERPROFILE>\.claude. The session index stays under
// <USERPROFILE>\.claude.

const DEFAULT_CONFIG = { budget: 200000, headroom: 20000, sourceMaxAgeSec: 600, handoffMaxAgeHours: 24, handoffBodyMaxBytes: 2048 };
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

// The tab's Claude dir for the gate's config, state, .mod and handoffs: VIDAR_AGENT_HOME when set
// (a bare tab's own CLAUDE_CONFIG_DIR, profiles/bare/claude.json overlay; context-gate.mjs reads the
// .mod there), else <home>\.claude. `base` picks the home for the fallback (gateHome or homeDir).
async function claudeDir($, base) {
  const agent = await $.env.get('VIDAR_AGENT_HOME');
  return agent || joinPath(await base($), '.claude');
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

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function slugOf(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]+/g, '-');
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

// crossedAt, written once per session on the first crossing (classic ensureState).
async function ensureState($, dir, sessionId) {
  const path = joinPath(dir, 'context-gate', `${sessionId}.json`);
  try {
    const existing = JSON.parse(stripBom(await $.fs.read(path)));
    if (existing && Number.isFinite(existing.crossedAt)) return existing.crossedAt;
  } catch { /* not written yet */ }
  const crossedAt = Date.now();
  try { await $.fs.write(path, JSON.stringify({ crossedAt })); } catch { /* best effort */ }
  return crossedAt;
}

// A handoff up to this long before the first crossing still counts (classic HANDOFF_GRACE_MS):
// the 2026-10-06 double handoff was written 4 s before the gate crossed.
const HANDOFF_GRACE_MS = 10 * 60 * 1000;

// Newest own-sid8 handoff written after crossedAt minus the grace window; null when none.
async function freshHandoff($, handoffDir, crossedAt, sessionId) {
  let entries;
  try { entries = await $.fs.list(handoffDir); } catch { return null; }
  let best = null;
  for (const entry of entries) {
    if (!entry.name.endsWith(`-${sessionId.slice(0, 8)}.md`)) continue;
    if (entry.mtimeMs > crossedAt - HANDOFF_GRACE_MS && (!best || entry.mtimeMs > best.mtimeMs)) best = entry;
  }
  return best ? joinPath(handoffDir, best.name) : null;
}

// Trimmed text after the <!-- BODY --> line of handoffs\TEMPLATE.md; null when unreadable or no marker.
async function readTemplateBody($, templatePath) {
  try {
    const text = stripBom(await $.fs.read(templatePath)).replace(/\r\n/g, '\n');
    const at = text.indexOf('<!-- BODY -->');
    if (at < 0) return null;
    return text.slice(at + '<!-- BODY -->'.length).trim() || null;
  } catch { return null; }
}

// Live gate check. Returns null (no-op) on every classic no-op condition.
async function evaluate($, sessionId, cwd) {
  if ((await $.env.get('CONTEXT_GATE')) === '0') return null;
  if (!sessionId || typeof sessionId !== 'string') return null;
  const dir = await claudeDir($, gateHome);
  const config = await readConfig($, dir);
  const usage = await $.session.usage();
  const m = measure(usage && usage.context, config);
  if (!m || !m.triggered) return null;
  const handoffDir = joinPath(dir, 'handoffs', slugOf(cwd));
  const crossedAt = await ensureState($, dir, sessionId);
  const fresh = await freshHandoff($, handoffDir, crossedAt, sessionId);
  const handoffPath = fresh || joinPath(handoffDir, `${stamp(new Date(crossedAt))}-${sessionId.slice(0, 8)}.md`);
  const templatePath = joinPath(dir, 'handoffs', 'TEMPLATE.md');
  // Directive text mirrored in context-gate.mjs; change both.
  const head = `Context gate: this session is at ${Math.round(m.ctx)} tokens of a ${config.budget} budget `
    + `(trigger ${Math.round(m.trigger)}). Finish the current step only; start nothing new. Then write the `
    + `handoff to ${handoffPath} in one Write and stop. The next session starts from that file. `
    + `If background agents you launched are still running, let them finish first: end turns waiting `
    + `on them, absorb each report, and write the handoff only once none is running. Exception: an agent `
    + `whose deliverable is a file (Mock-O, or a brief naming its output path) is not waited on: the handoff `
    + `names the output path and the pick it needs, then stop.`;
  const shape = await readTemplateBody($, templatePath);
  const body = shape
    ? `${head} Keep the body under ${config.handoffBodyMaxBytes} bytes, then end with a Session line and git status --short. Shape:\n${shape}`
    : `${head} Follow ${templatePath}.`;
  return { body, handoffPath, fresh: Boolean(fresh) };
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

// The classic SessionStart additionalContext: sid8 line, plus a handoff pointer on startup/clear.
async function startContext($, sessionId, cwd, source) {
  const sid8Line = `This session's id prefix: ${sessionId.slice(0, 8)} (names handoffs and transcripts; it is not a SendMessage address: ListAgents prints that).`;
  let handoffLine = '';
  if (source === 'startup' || source === 'clear') try {
    const dir = await claudeDir($, homeDir);
    let handoffMaxAgeHours = 24;
    try {
      const cfg = JSON.parse(stripBom(await $.fs.read(joinPath(dir, 'context-gate.json'))));
      if (Number.isFinite(cfg.handoffMaxAgeHours)) handoffMaxAgeHours = cfg.handoffMaxAgeHours;
    } catch { /* default */ }
    const handoffDir = joinPath(dir, 'handoffs', slugOf(cwd));
    const maxAgeMs = handoffMaxAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    let newest = null;
    for (const entry of await $.fs.list(handoffDir)) {
      const name = entry.name;
      if (!name.endsWith('.md')) continue;
      const p = joinPath(handoffDir, name);
      const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
      const mtimeMs = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : entry.mtimeMs;
      if (now - mtimeMs > maxAgeMs) continue;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs };
    }
    if (newest) {
      const ageMin = Math.round((now - newest.mtimeMs) / 60000);
      const ageStr = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
      let topic = '';
      try {
        const first = String(await $.fs.read(newest.path)).split(/\r?\n/, 1)[0] ?? '';
        topic = first.replace(/^#+\s*handoff\s*[—-]*\s*/i, '').replace(/\s*[—-]+\s*\d{4}-\d{2}-\d{2}.*$/, '').trim();
      } catch { /* no topic */ }
      handoffLine = ` A handoff from a previous session exists at ${newest.path} (written ${ageStr} ago)${topic ? `, topic: "${topic}"` : ''}. Do not read it, mention it, or ask about it. /catapult reads it; only read it otherwise if the user refers to the previous session's work.`;
    }
  } catch { /* no handoff dir: sid8 line still goes out */ }
  return `${sid8Line}${handoffLine}`;
}

// A .catch handler: pass the event on unless the hook already did.
const passOn = async ($, e, next) => (next.called ? undefined : next(e));

export function register(on) {
  // startup, resume, clear, compact, fork: the classic SessionStart hook's whole job. Classic
  // events fire regardless of settings hooks, so this alone writes the index.
  on('classic.SessionStart', async ($, e, next) => {
    // Stand-down marker first: the classic context-gate.mjs and session-index.mjs exit when it exists.
    try {
      const sid = (e && e.session_id) || (await $.session.id()) || '';
      if (SID_RE.test(sid)) await $.fs.write(joinPath(await claudeDir($, gateHome), 'context-gate', `${sid}.mod`), '');
    } catch { /* best effort */ }
    const result = await next(e);
    try {
      const sessionId = (e && e.session_id) || (await $.session.id()) || '';
      if (!SID_RE.test(sessionId)) return result;
      const cwd = (e && e.cwd) || (await $.session.cwd());
      const source = (e && e.source) || '';
      try {
        await writeIndex($, indexRecord(sessionId, cwd, source, (await $.env.get('VIDAR_TAB')) ?? null,
          (e && e.transcript_path) ?? null, (e && e.version) ?? null));
      } catch { /* index is best effort */ }
      const text = await startContext($, sessionId, cwd, source);
      const base = result || {};
      return { ...base, additionalContext: [...(base.additionalContext ?? []), text] };
    } catch { /* never affect the session */ }
    return result;
  }).catch(passOn);

  // Classic UserPromptSubmit: every prompt while at or past the trigger carries the directive.
  on('prompt.submit', async ($, e, next) => {
    let extra = null;
    try {
      const sessionId = await $.session.id();
      const g = await evaluate($, sessionId, await $.session.cwd());
      if (g) {
        // Mirrored from postHandoffBody in ~/.claude/hooks/context-gate.mjs; keep the text identical.
        extra = g.fresh
          ? `Context gate: this session's handoff already exists at ${g.handoffPath}. Do not edit or rewrite it. `
            + 'A user\'s answer arriving now (a Relay ask, a question the handoff left open) is appended '
            + 'to the handoff as one line "Answer: <question> → <answer>", always, because the successor reads '
            + 'the handoff first. A result landing later (an agent, a commit) goes to the run\'s NOTES.md as one line '
            + '"<time> <sid8> <task>: ..."; with no run folder, one appended "Late update:" line in the handoff. '
            + 'Answer the user briefly, finish the current step only, and stop.'
          : g.body;
      }
    } catch { /* never affect the prompt */ }
    if (!extra) return next(e);
    return next({ ...e, context: [...(e.context ?? []), extra] });
  }).catch(passOn);

  // Classic Stop: block the stop once per stop chain until a fresh handoff exists.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e);
    try {
      if (result && result.block) return result;
      if (!e || e.agent_id) return result;
      if (e.stop_hook_active === true) return result;
      const sessionId = e.session_id || (await $.session.id());
      const g = await evaluate($, sessionId, e.cwd || (await $.session.cwd()));
      if (!g) return result;
      if (g.fresh) return result;
      return { ...(result || {}), block: `Before stopping: ${g.body}` };
    } catch { /* never affect the stop */ }
    return result;
  }).catch(passOn);

  // After each turn (and after /clear, /resume, /compact): the band's measurement.
  on('session.measure', async ($, e, next) => {
    try {
      if ((await $.env.get('CONTEXT_GATE')) !== '0') {
        const sessionId = await $.session.id();
        const config = await readConfig($, await claudeDir($, gateHome));
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
        const line = `ctx ${band.tokens}/${band.budget}${band.triggered ? ' · handoff due' : ''}`;
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
