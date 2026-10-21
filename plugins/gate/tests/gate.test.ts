import { expect, mock, test } from 'claude-code/testing'

const SID = '0123abcd-0000-4000-8000-000000000001'
const HOME = 'C:\\gatehome'
const CWD = 'C:\\work\\repo'
const CONFIG = JSON.stringify({ budget: 230000, headroom: 20000, sourceMaxAgeSec: 600, handoffMaxAgeHours: 24 })

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

// An in-memory file system answering $.fs, keyed by normalised path.
function memFs(on: any, files: Record<string, string> = {}, listing: { name: string; mtimeMs: number }[] | null = null) {
  const store = new Map<string, string>(Object.entries(files).map(([k, v]) => [norm(k), v]))
  const writes: { path: string; text: string }[] = []
  on('fs.read', ($: any, e: any) => {
    const v = store.get(norm(e.path))
    return v === undefined ? { deny: 'ENOENT' } : { value: v }
  })
  on('fs.write', ($: any, e: any) => {
    store.set(norm(e.path), e.text)
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.exists', ($: any, e: any) => ({ value: store.has(norm(e.path)) }))
  on('fs.list', () => (listing ? { value: listing } : { deny: 'ENOENT' }))
  return { store, writes }
}

function session(on: any, tokens: number, window = 1000000) {
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens, window, percent: Math.round((tokens / window) * 100) }, rateLimits: [] },
  }))
}

const contextOf = (r: any): string[] => (r && r.context ? [...r.context] : [])

test('below threshold: no injection', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 150000)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))

  const r = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  expect(contextOf(r).some((c) => c.startsWith('Context gate:'))).toBe(false)
})

test('above threshold: directive injected once per prompt, verbatim shape', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  const fs = memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 215000)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))

  const r = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  const gate = contextOf(r).filter((c) => c.startsWith('Context gate:'))
  expect(gate.length).toBe(1)
  expect(gate[0]).toMatch(/^Context gate: this session is at 215000 tokens of a 230000 budget \(trigger 210000\)\. Finish the current step only; start nothing new\. Then write the handoff to C:\\gatehome\\\.claude\\handoffs\\C-work-repo\\\d{4}-\d{2}-\d{2}-\d{4}-0123abcd\.md in one Write and stop\. The next session starts from that file\. If background agents you launched are still running, let them finish first: end turns waiting on them, absorb each report, and write the handoff only once none is running\. Exception: an agent whose deliverable is a file \(Mock-O, or a brief naming its output path\) is not waited on: the handoff names the output path and the pick it needs, then stop\.Follow C:\\gatehome\\\.claude\\handoffs\\TEMPLATE\.md\.$/)
  // crossedAt state written once
  expect(fs.writes.filter((w) => norm(w.path).endsWith('/.claude/context-gate/' + SID + '.json')).length).toBe(1)
})

// Same fixture and directive tail as context-gate.test.mjs test 6: the cross-repo contract, pinned on both sides.
test('above threshold: TEMPLATE with a BODY marker is inlined after Shape:', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  const shape = '# Handoff — <the work> — <YYYY-MM-DD>\n\nNext: <x>\nDispatch: <y>'
  memFs(on, {
    [`${HOME}\\.claude\\context-gate.json`]: CONFIG,
    [`${HOME}\\.claude\\handoffs\\TEMPLATE.md`]: `\uFEFF<!-- header -->\r\n<!-- BODY -->\r\n${shape.replace(/\n/g, '\r\n')}\r\n`,
  })
  session(on, 215000)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))

  const r = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  const gate = contextOf(r).filter((c) => c.startsWith('Context gate:'))
  expect(gate.length).toBe(1)
  expect(gate[0]).toMatch(/^Context gate: this session is at 215000 tokens of a 230000 budget \(trigger 210000\)\. Finish the current step only; start nothing new\. Then write the handoff to C:\\gatehome\\\.claude\\handoffs\\C-work-repo\\\d{4}-\d{2}-\d{2}-\d{4}-0123abcd\.md in one Write and stop\. The next session starts from that file\. If background agents you launched are still running, let them finish first: end turns waiting on them, absorb each report, and write the handoff only once none is running\. Exception: an agent whose deliverable is a file \(Mock-O, or a brief naming its output path\) is not waited on: the handoff names the output path and the pick it needs, then stop\.Keep the body under 2048 bytes, then end with a Session line and git status --short\. Shape:\n/)
  expect(gate[0].endsWith(`Shape:\n${shape}`)).toBe(true)
  expect(gate[0]).not.toContain('<!-- header -->')
  expect(gate[0]).not.toContain('Follow')
})

test('above threshold: Stop is blocked with the classic reason, not when stop_hook_active', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 215000)
  on('classic.Stop', () => ({}))

  const base = { session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'Stop' }
  const r1: any = await $.classic.Stop({ ...base, stop_hook_active: false } as any)
  expect(String(r1.block)).toMatch(/^Before stopping: Context gate: this session is at 215000 tokens/)
  const r2: any = await $.classic.Stop({ ...base, stop_hook_active: true } as any)
  expect(r2.block).toBeUndefined()
})

test('subagent never triggers', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 400000)
  on('classic.Stop', () => ({}))

  const r: any = await $.classic.Stop({
    session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'Stop',
    stop_hook_active: false, agent_id: 'a1',
  } as any)
  expect(r.block).toBeUndefined()
})

test('above threshold: Stop passes when a fresh handoff exists', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  // mtime far in the future so it is newer than the crossedAt the gate writes now
  memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG }, [{ name: '2026-10-02-1200-0123abcd.md', mtimeMs: Date.now() + 3600000 }])
  session(on, 215000)
  on('classic.Stop', () => ({}))

  const r: any = await $.classic.Stop({
    session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'Stop', stop_hook_active: false,
  } as any)
  expect(r.block).toBeUndefined()
})

test('first crossing: a handoff written seconds earlier counts, Stop passes and the prompt names it (double handoff 2026-10-06)', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  const name = '2026-10-06-1856-0123abcd.md'
  memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG }, [{ name, mtimeMs: Date.now() - 4000 }])
  session(on, 215000)
  on('classic.Stop', () => ({}))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))

  const r: any = await $.classic.Stop({
    session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'Stop', stop_hook_active: false,
  } as any)
  expect(r.block).toBeUndefined()
  const p = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  const gate = contextOf(p).filter((c) => c.startsWith('Context gate:'))
  expect(gate[0]).toContain(`handoff already exists at ${HOME}\\.claude\\handoffs\\C-work-repo\\${name}`)
})

test('first crossing: a handoff older than the grace window still blocks Stop', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG }, [{ name: '2026-10-06-1200-0123abcd.md', mtimeMs: Date.now() - 30 * 60 * 1000 }])
  session(on, 215000)
  on('classic.Stop', () => ({}))

  const r: any = await $.classic.Stop({
    session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'Stop', stop_hook_active: false,
  } as any)
  expect(r.block).toMatch(/^Before stopping: Context gate/)
})

test('SessionStart: handoff pointer line in additionalContext', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const name = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-deadbeef.md`
  const handoffPath = `${HOME}\\.claude\\handoffs\\C-work-repo\\${name}`
  memFs(on, {
    [`${HOME}\\.claude\\context-gate.json`]: CONFIG,
    [handoffPath]: '# Handoff — gate mod — 2026-10-02\n',
  }, [{ name, mtimeMs: Date.now() }])
  session(on, 0)
  on('classic.SessionStart', () => ({}))

  const r: any = await $.classic.SessionStart({
    session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'SessionStart', source: 'startup',
  } as any)
  expect(r.additionalContext[0]).toContain(`A handoff from a previous session exists at ${handoffPath} (written`)
  expect(r.additionalContext[0]).toContain('topic: "gate mod"')
})

test('SessionStart writes the .mod stand-down marker', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  const fs = memFs(on, {})
  session(on, 0)
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({
    session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'SessionStart', source: 'startup',
  } as any)
  const m = fs.writes.find((w) => norm(w.path).endsWith(`/.claude/context-gate/${SID}.mod`))
  expect(m).toBeDefined()
  expect(m!.text).toBe('')
})

test('session.measure writes no gate.json', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME, FALCON_SESSION: 'f1' }) // rendered tab: VIDAR_TAB stripped
  const fs = memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 215000)
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))

  await $.session.measure({ context: { tokens: 215000, window: 1000000, percent: 22 }, rateLimits: [], changed: ['context'] } as any)
  expect(fs.writes.find((x) => x.path.endsWith('.gate.json'))).toBeUndefined()
})

test('session files: classic index shape and sid8 context', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME, VIDAR_TAB: 's3-abc' })
  const fs = memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 0)
  on('classic.SessionStart', () => ({}))

  const r: any = await $.classic.SessionStart({
    session_id: SID, transcript_path: 'C:\\t.jsonl', cwd: CWD, hook_event_name: 'SessionStart', source: 'startup',
  } as any)
  const idx = fs.writes.find((x) => norm(x.path).endsWith(`/.claude/session-index/${SID}.json`))
  expect(idx).toBeDefined()
  expect(idx!.text.endsWith('}\n')).toBe(true)
  const rec = JSON.parse(idx!.text)
  expect(Object.keys(rec)).toEqual(['sessionId', 'cwd', 'source', 'startedAt', 'vidarTab', 'transcript', 'cliVersion'])
  expect(rec).toMatchObject({ sessionId: SID, cwd: CWD, source: 'startup', vidarTab: 's3-abc', transcript: 'C:\\t.jsonl', cliVersion: null })
  expect(r.additionalContext[0]).toBe("This session's id prefix: 0123abcd (names handoffs and transcripts; it is not a SendMessage address: ListAgents prints that).")
  expect(fs.writes.filter((x) => norm(x.path).endsWith(`/.claude/session-index/${SID}.json`)).length).toBe(1)
})
