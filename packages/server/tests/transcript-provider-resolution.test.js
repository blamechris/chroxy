/**
 * #7828 — closed-conversation transcript resolution is provider-aware.
 *
 * Every fixture lives under a temp dir passed in as an explicit tagged source;
 * nothing here reads or writes the real ~/.claude or ~/.codex.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { scanConversations, clearScanCache } from '../src/conversation-scanner.js'
import { resolveTranscriptSource } from '../src/transcript-sources.js'
import { getProviderTranscriptSources } from '../src/providers.js'
import { readConversationTranscriptStrictAsync } from '../src/jsonl-reader.js'
import { createSpy, nsCtx, makeSessionIndexCtx } from './test-helpers.js'

const handler = conversationHandlers.request_conversation_transcript
const ID = '00000000-0000-0000-0000-0000000a7828'
const PROJECT = '/tmp/provider-aware-repo'
const PROJECT_KEY = '-tmp-provider-aware-repo'

const userLine = (text) => JSON.stringify({
  type: 'user', uuid: `u-${text}`, cwd: PROJECT, timestamp: '2026-01-15T00:00:00.000Z',
  message: { content: [{ type: 'text', text }] },
})

let root
let claudeProjects
let codexProjects

function writeConv(projectsDir, text, { key = PROJECT_KEY, id = ID, raw } = {}) {
  const dir = join(projectsDir, key)
  mkdirSync(dir, { recursive: true })
  const body = raw ?? [userLine(text), userLine(`${text}-2`), userLine(`${text}-3`)].join('\n')
  writeFileSync(join(dir, `${id}.jsonl`), body)
}

function makeCtx(sources, extra = {}) {
  const sends = []
  const ctx = nsCtx({
    send: createSpy((_t, m) => { sends.push(m) }),
    ...makeSessionIndexCtx(),
    reseedActiveAgents: createSpy(),
    resendPendingQuestions: createSpy(),
    sessionManager: { getSession: createSpy(() => undefined), createSession: createSpy(() => 'new-id') },
    ...extra,
  })
  ctx.runtime.transcriptSources = sources
  return { ctx, sends }
}

const client = () => ({ id: 'c1', activeSessionId: null, subscribedSessionIds: new Set() })
const ws = () => ({ readyState: 1, bufferedAmount: 0 })

async function run(msg, sources, extra) {
  const { ctx, sends } = makeCtx(sources, extra)
  await handler(ws(), client(), { type: 'request_conversation_transcript', conversationId: ID, ...msg }, ctx)
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  return { sends, ctx }
}

const texts = (sends) => sends.filter((m) => m.type === 'message').map((m) => m.content)

describe('#7828 provider-aware transcript resolution', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'transcript-provider-'))
    claudeProjects = join(root, 'claude', 'projects')
    codexProjects = join(root, 'codex', 'projects')
    mkdirSync(claudeProjects, { recursive: true })
    mkdirSync(codexProjects, { recursive: true })
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  const sources = () => [
    { provider: 'claude', projectsDir: claudeProjects },
    { provider: 'codex', projectsDir: codexProjects },
  ]

  describe('scanner metadata', () => {
    it('tags each conversation with its provider and an opaque relative locator', async () => {
      writeConv(claudeProjects, 'claude-text')
      clearScanCache()
      const all = await scanConversations({ projectsDirs: sources() })
      const c = all.find((x) => x.conversationId === ID)
      assert.equal(c.provider, 'claude')
      assert.equal(c.sourceLocator, `${PROJECT_KEY}/${ID}.jsonl`)
      assert.ok(!c.sourceLocator.startsWith('/'), 'locator is relative, never an absolute path')
    })

    it('the registry exposes provider-tagged roots: claude family -> claude, codex -> codex', () => {
      const tagged = getProviderTranscriptSources()
      const providers = tagged.map((s) => s.provider)
      assert.ok(providers.includes('claude'))
      assert.ok(providers.includes('codex'))
      assert.equal(providers.filter((p) => p === 'claude').length, 1, 'claude-* share one store')
      assert.ok(tagged.every((s) => s.projectsDir.endsWith('projects')))
    })
  })

  describe('collision: the same id under Claude and Codex', () => {
    before(() => {
      writeConv(claudeProjects, 'CLAUDE-ONLY')
      writeConv(codexProjects, 'CODEX-ONLY')
      clearScanCache()
    })

    it('Claude request reads only the Claude file', async () => {
      const { sends } = await run({ provider: 'claude' }, sources(), { scanConversations })
      assert.deepEqual(texts(sends), ['CLAUDE-ONLY', 'CLAUDE-ONLY-2', 'CLAUDE-ONLY-3'])
    })

    it('Codex request never reads the Claude file: explicit unsupported, no frames', async () => {
      const { sends } = await run({ provider: 'codex' }, sources(), { scanConversations })
      assert.equal(sends.length, 1)
      assert.equal(sends[0].type, 'session_error')
      assert.match(sends[0].message, /not supported for codex/)
      assert.deepEqual(texts(sends), [])
    })

    it('an ambiguous id with no provider is refused, not resolved by scan order', async () => {
      const { sends } = await run({}, sources(), { scanConversations })
      assert.equal(sends[0].type, 'session_error')
      assert.match(sends[0].message, /more than one provider/)
      assert.deepEqual(texts(sends), [])
    })
  })

  describe('negative fixtures (no cross-provider fallback)', () => {
    it('unknown provider', async () => {
      const scan = createSpy(async () => [{ conversationId: ID, provider: 'mystery', cwd: PROJECT, sourceLocator: `${PROJECT_KEY}/${ID}.jsonl` }])
      writeConv(claudeProjects, 'must-not-be-read')
      const { sends } = await run({}, sources(), { scanConversations: scan })
      assert.match(sends[0].message, /Unknown transcript provider/)
      assert.deepEqual(texts(sends), [])
    })

    it('missing file: error, and a same-id Claude file is not substituted for a Codex-less lookup', async () => {
      const gone = '00000000-0000-0000-0000-00000000dead'
      const scan = createSpy(async () => [{ conversationId: gone, provider: 'claude', cwd: PROJECT, sourceLocator: `${PROJECT_KEY}/${gone}.jsonl` }])
      const { sends } = await run({ conversationId: gone }, sources(), { scanConversations: scan })
      assert.equal(sends[0].type, 'session_error')
      assert.match(sends[0].message, /not found/)
      assert.equal(sends.some((m) => m.type === 'history_replay_start'), false)
    })

    it('corrupt record in the middle', async () => {
      const id = '00000000-0000-0000-0000-00000000c0aa'
      writeConv(claudeProjects, 'x', { id, raw: [userLine('a'), '{not json', userLine('b')].join('\n') })
      const scan = createSpy(async () => [{ conversationId: id, provider: 'claude', cwd: PROJECT, sourceLocator: `${PROJECT_KEY}/${id}.jsonl` }])
      const { sends } = await run({ conversationId: id }, sources(), { scanConversations: scan })
      assert.equal(sends[0].type, 'session_error')
      assert.match(sends[0].message, /corrupt or truncated/)
      assert.deepEqual(texts(sends), [])
    })

    it('truncated final record', async () => {
      const id = '00000000-0000-0000-0000-00000000c0bb'
      writeConv(claudeProjects, 'x', { id, raw: `${userLine('a')}\n${userLine('b').slice(0, 30)}` })
      await assert.rejects(
        readConversationTranscriptStrictAsync(join(claudeProjects, PROJECT_KEY, `${id}.jsonl`)),
        (e) => e.name === 'TranscriptDataError' && e.code === 'corrupt',
      )
    })

    it('a tail-only read tolerates its own mid-record cut on line one', async () => {
      const id = '00000000-0000-0000-0000-00000000c0cc'
      const lines = [userLine('aaaaaaaaaaaaaaaa'), userLine('b'), userLine('c')].join('\n')
      writeConv(claudeProjects, 'x', { id, raw: lines })
      const { messages, truncated } = await readConversationTranscriptStrictAsync(
        join(claudeProjects, PROJECT_KEY, `${id}.jsonl`), lines.length - 40)
      assert.equal(truncated, true)
      assert.ok(messages.length >= 1)
    })

    it('disallowed cwd for a bound client reads nothing', async () => {
      writeConv(claudeProjects, 'secret')
      const scan = createSpy(async () => [{ conversationId: ID, provider: 'claude', cwd: PROJECT, sourceLocator: `${PROJECT_KEY}/${ID}.jsonl` }])
      const reader = createSpy(async () => ({ messages: [], truncated: false }))
      const { ctx, sends } = makeCtx(sources(), {
        scanConversations: scan,
        readConversationTranscript: reader,
        sessionManager: { getSession: createSpy(() => ({ cwd: '/somewhere/else' })), createSession: createSpy() },
      })
      await handler(ws(), { ...client(), boundSessionId: 'b1' }, { type: 'request_conversation_transcript', conversationId: ID }, ctx)
      assert.match(sends[0].message, /Not authorized/)
      assert.equal(reader.callCount, 0)
    })

    it('unsupported format provider (gemini) is refused with its reason', async () => {
      const scan = createSpy(async () => [{ conversationId: ID, provider: 'gemini', cwd: PROJECT, sourceLocator: `${PROJECT_KEY}/${ID}.jsonl` }])
      const { sends } = await run({}, sources(), { scanConversations: scan })
      assert.match(sends[0].message, /not supported for gemini/)
    })
  })

  describe('resolveTranscriptSource containment', () => {
    const base = { conversationId: ID, sources: null }
    it('rejects a locator naming another conversation, traversal, or extra segments', () => {
      const s = [{ provider: 'claude', projectsDir: claudeProjects }]
      for (const sourceLocator of [
        `${PROJECT_KEY}/other.jsonl`, `../${ID}.jsonl`, `a/b/${ID}.jsonl`, `/etc/${ID}.jsonl`,
        `..\\x/${ID}.jsonl`, `./${ID}.jsonl`, `../claude/${ID}.jsonl`,
      ]) {
        const r = resolveTranscriptSource({ ...base, provider: 'claude', sourceLocator, sources: s })
        assert.equal(r.ok, false, sourceLocator)
        assert.equal(r.code, 'invalid_source', sourceLocator)
      }
    })

    it('rejects a symlinked project dir that escapes the provider root', () => {
      const outside = join(root, 'outside')
      mkdirSync(outside, { recursive: true })
      const id = '00000000-0000-0000-0000-0000000005ca'
      writeFileSync(join(outside, `${id}.jsonl`), userLine('leak'))
      symlinkSync(outside, join(claudeProjects, '-escape'))
      const r = resolveTranscriptSource({
        provider: 'claude', conversationId: id, sourceLocator: `-escape/${id}.jsonl`,
        sources: [{ provider: 'claude', projectsDir: claudeProjects }],
      })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'invalid_source')
    })

    it('a provider with no registered root is unavailable, never another provider\'s root', () => {
      writeConv(claudeProjects, 'present')
      const r = resolveTranscriptSource({
        provider: 'claude', conversationId: ID, sourceLocator: `${PROJECT_KEY}/${ID}.jsonl`,
        sources: [{ provider: 'codex', projectsDir: codexProjects }],
      })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'source_unavailable')
    })

    it('Claude with a valid locator resolves to the real file under its root', () => {
      writeConv(claudeProjects, 'present')
      const r = resolveTranscriptSource({
        provider: 'claude', conversationId: ID, sourceLocator: `${PROJECT_KEY}/${ID}.jsonl`,
        sources: [{ provider: 'claude', projectsDir: claudeProjects }],
      })
      assert.equal(r.ok, true)
      assert.ok(r.path.endsWith(`${PROJECT_KEY}/${ID}.jsonl`))
    })
  })
})
