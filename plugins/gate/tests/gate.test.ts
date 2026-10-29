import { expect, mock, test } from 'claude-code/testing'

const SID = '0123abcd-0000-4000-8000-000000000001'
const HOME = 'C:\\gatehome'
const CWD = 'C:\\work\\repo'
const CONFIG = JSON.stringify({ budget: 230000, headroom: 20000, sourceMaxAgeSec: 600 })

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

test('above threshold: no directive is injected and Stop is never blocked (handoffs retired)', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 215000)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))
  on('classic.Stop', () => ({}))

  const r = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  expect(contextOf(r).some((c) => c.startsWith('Context gate:'))).toBe(false)
  const s: any = await $.classic.Stop({
    session_id: SID, transcript_path: 'x', cwd: CWD, hook_event_name: 'Stop', stop_hook_active: false,
  } as any)
  expect(s.block).toBeUndefined()
})

test('the first prompt writes the .mod stand-down marker and no handoff pointer',async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  const fs = memFs(on, {})
  session(on, 0)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))

  const r = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  const m = fs.writes.find((w) => norm(w.path).endsWith(`/.claude/context-gate/${SID}.mod`))
  expect(m).toBeDefined()
  expect(m!.text).toBe('')
  expect(contextOf(r).some((c) => c.includes('handoff'))).toBe(false)
})

test('session.measure writes no gate.json', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME, FALCON_SESSION: 'f1' }) // rendered tab: VIDAR_TAB stripped
  const fs = memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 215000)
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))

  await $.session.measure({ context: { tokens: 215000, window: 1000000, percent: 22 }, rateLimits: [], changed: ['context'] } as any)
  expect(fs.writes.find((x) => x.path.endsWith('.gate.json'))).toBeUndefined()
})

const SID8 = "This session's id prefix: 0123abcd (names transcripts; it is not a SendMessage address: ListAgents prints that)."
const isIndex = (p: string) => norm(p).endsWith(`/.claude/session-index/${SID}.json`)
const isMod = (p: string) => norm(p).endsWith(`/.claude/context-gate/${SID}.mod`)

test('the first prompt writes .mod, index and sid8; the second adds nothing',async ($, on) => {
  mock.env(on, { USERPROFILE: HOME, VIDAR_TAB: 's3-abc' })
  const fs = memFs(on, { [`${HOME}\\.claude\\context-gate.json`]: CONFIG })
  session(on, 0)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))

  const r1 = await $.prompt.submit({ text: 'one', wait: false, origin: { kind: 'composer' } } as any)
  expect(contextOf(r1)).toContain(SID8)
  const idx = fs.writes.filter((w) => isIndex(w.path))
  expect(idx.length).toBe(1)
  expect(idx[0].text.endsWith('}\n')).toBe(true)
  const rec = JSON.parse(idx[0].text)
  expect(Object.keys(rec)).toEqual(['sessionId', 'cwd', 'source', 'startedAt', 'vidarTab', 'transcript', 'cliVersion'])
  expect(rec).toMatchObject({ sessionId: SID, cwd: CWD, source: 'prompt.submit', vidarTab: 's3-abc', transcript: null, cliVersion: null })
  expect(fs.writes.filter((w) => isMod(w.path)).length).toBe(1)

  const r2 = await $.prompt.submit({ text: 'two', wait: false, origin: { kind: 'composer' } } as any)
  expect(contextOf(r2)).not.toContain(SID8)
  expect(fs.writes.filter((w) => isIndex(w.path) || isMod(w.path)).length).toBe(2)
})

test('an index record left on disk (a reload, a resumed session) stops the fallback', async ($, on) => {
  mock.env(on, { USERPROFILE: HOME })
  const fs = memFs(on, { [`${HOME}\\.claude\\session-index\\${SID}.json`]: '{}\n' })
  session(on, 0)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))

  const r = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any)
  expect(contextOf(r)).not.toContain(SID8)
  expect(fs.writes.length).toBe(0)
})
