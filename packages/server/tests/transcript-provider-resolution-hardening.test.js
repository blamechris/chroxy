/**
 * #7828 follow-ups: the file that was resolved is the file that is read,
 * visibility is decided before any answer about how many records exist,
 * untagged sources and same-provider duplicates are reported accurately, and
 * the provider selector survives the public request schema.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, symlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClientMessageSchema } from '@chroxy/protocol/schemas'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { resolveTranscriptSource } from '../src/transcript-sources.js'
import { readConversationTranscriptStrictAsync } from '../src/jsonl-reader.js'
import { scanConversations, clearScanCache } from '../src/conversation-scanner.js'
import { createSpy, nsCtx, makeSessionIndexCtx } from './test-helpers.js'

const handler = conversationHandlers.request_conversation_transcript
const ID = '00000000-0000-0000-0000-0000000b7828'
const ALLOWED = '/tmp/allowed-repo'
const HIDDEN = '/tmp/hidden-repo'
const KEY = '-tmp-hardening'

const line = (text) => JSON.stringify({
  type: 'user', uuid: `u-${text}`, cwd: ALLOWED, timestamp: '2026-01-15T00:00:00.000Z',
  message: { content: [{ type: 'text', text }] },
})

let root
let claudeProjects
let codexProjects

const write = (dir, text, id = ID, key = KEY) => {
  mkdirSync(join(dir, key), { recursive: true })
  writeFileSync(join(dir, key, `${id}.jsonl`), [line(text), line(`${text}-2`), line(`${text}-3`)].join('\n'))
}

function makeCtx(extra = {}, getSession = () => undefined) {
  const sends = []
  const ctx = nsCtx({
    send: createSpy((_t, m) => { sends.push(m) }),
    ...makeSessionIndexCtx(),
    reseedActiveAgents: createSpy(),
    resendPendingQuestions: createSpy(),
    // A session-scoped client may read only the conversation its session runs.
    sessionManager: { getSession: createSpy(getSession), getConversationId: createSpy((sid) => (getSession(sid) ? ID : null)), createSession: createSpy() },
    ...extra,
  })
  ctx.runtime.transcriptSources = [
    { provider: 'claude', projectsDir: claudeProjects },
    { provider: 'codex', projectsDir: codexProjects },
  ]
  return { ctx, sends }
}
const ws = () => ({ readyState: 1, bufferedAmount: 0 })
const client = (extra = {}) => ({ id: 'c1', activeSessionId: null, subscribedSessionIds: new Set(), ...extra })
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
const texts = (sends) => sends.filter((m) => m.type === 'message').map((m) => m.content)
const rec = (provider, cwd) => ({ conversationId: ID, provider, cwd, sourceLocator: `${KEY}/${ID}.jsonl` })

describe('#7828 follow-ups', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'transcript-hardening-'))
    claudeProjects = join(root, 'claude', 'projects')
    codexProjects = join(root, 'codex', 'projects')
    mkdirSync(claudeProjects, { recursive: true })
    mkdirSync(codexProjects, { recursive: true })
    write(claudeProjects, 'CLAUDE')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  describe('the resolved file is the file that is read', () => {
    it('refuses when a different file has replaced the resolved one before the read', async () => {
      const id = '00000000-0000-0000-0000-0000000b0001'
      write(claudeProjects, 'ORIGINAL', id)
      const resolved = resolveTranscriptSource({
        provider: 'claude', conversationId: id, sourceLocator: `${KEY}/${id}.jsonl`,
        sources: [{ provider: 'claude', projectsDir: claudeProjects }],
      })
      assert.equal(resolved.ok, true)
      // A different file now sits at the path that was resolved.
      const replacement = join(root, 'replacement.jsonl')
      writeFileSync(replacement, [line('REPLACEMENT'), line('r2')].join('\n'))
      renameSync(replacement, resolved.path)

      await assert.rejects(
        readConversationTranscriptStrictAsync(resolved.path, undefined, { expectedIdentity: resolved.identity }),
        (e) => e.name === 'TranscriptDataError' && /changed after it was resolved/.test(e.message),
      )
    })

    it('POSITIVE CONTROL: the untouched resolved file reads with the same identity', async () => {
      const id = '00000000-0000-0000-0000-0000000b0002'
      write(claudeProjects, 'STABLE', id)
      const resolved = resolveTranscriptSource({
        provider: 'claude', conversationId: id, sourceLocator: `${KEY}/${id}.jsonl`,
        sources: [{ provider: 'claude', projectsDir: claudeProjects }],
      })
      const { messages } = await readConversationTranscriptStrictAsync(resolved.path, undefined, { expectedIdentity: resolved.identity })
      assert.equal(messages[0].content, 'STABLE')
    })
  })

  describe('transcript reads open each file once and accept only regular files', () => {
    const fifoId = '00000000-0000-0000-0000-0000000b0f1f'
    const linkId = '00000000-0000-0000-0000-0000000b0d1e'
    const opts = { timeout: 5000 }

    function fifoRecord(id) {
      return { conversationId: id, provider: 'claude', cwd: ALLOWED, sourceLocator: `${KEY}/${id}.jsonl` }
    }

    it('a FIFO at the transcript path gets a prompt error and never hangs', { ...opts, skip: process.platform === 'win32' && 'no mkfifo on Windows' }, async () => {
      mkdirSync(join(claudeProjects, KEY), { recursive: true })
      execFileSync('mkfifo', [join(claudeProjects, KEY, `${fifoId}.jsonl`)])
      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => [fifoRecord(fifoId)]) })
      await handler(ws(), client(), { type: 'request_conversation_transcript', conversationId: fifoId }, ctx)
      await settle()
      assert.equal(sends[0].type, 'session_error')
      assert.equal(sends[0].conversationId, fifoId)
      assert.deepEqual(texts(sends), [])
    })

    it('the strict reader refuses a non-regular file directly', { ...opts, skip: process.platform === 'win32' && 'no mkfifo on Windows' }, async () => {
      const path = join(claudeProjects, KEY, `${fifoId}.jsonl`)
      await assert.rejects(readConversationTranscriptStrictAsync(path), (e) => e.name === 'TranscriptDataError')
    })

    it('a symlink to a non-regular file is refused promptly', { ...opts, skip: process.platform === 'win32' && 'no /dev/null on Windows' }, async () => {
      mkdirSync(join(claudeProjects, KEY), { recursive: true })
      symlinkSync('/dev/null', join(claudeProjects, KEY, `${linkId}.jsonl`))
      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => [fifoRecord(linkId)]) })
      await handler(ws(), client(), { type: 'request_conversation_transcript', conversationId: linkId }, ctx)
      await settle()
      assert.equal(sends[0].type, 'session_error')
      assert.deepEqual(texts(sends), [])
    })
  })

  describe('visibility is decided before the ambiguity answer', () => {
    const boundTo = (cwd) => (sid) => (sid === 'b1' ? { cwd } : undefined)
    const bound = () => client({ boundSessionId: 'b1' })

    async function respond(records, getSession) {
      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => records) }, getSession)
      await handler(ws(), bound(), { type: 'request_conversation_transcript', conversationId: ID }, ctx)
      await settle()
      return sends[0]
    }

    it('records only under a hidden cwd answer exactly as a single hidden record does', async () => {
      const single = await respond([rec('claude', HIDDEN)], boundTo(ALLOWED))
      const several = await respond([rec('claude', HIDDEN), rec('codex', HIDDEN)], boundTo(ALLOWED))
      assert.match(single.message, /Not authorized/)
      assert.equal(several.message, single.message)
      assert.equal(several.code, single.code)
    })

    it('a hidden record does not turn a visible one into an ambiguous answer', async () => {
      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => [rec('claude', ALLOWED), rec('codex', HIDDEN)]) }, boundTo(ALLOWED))
      await handler(ws(), bound(), { type: 'request_conversation_transcript', conversationId: ID }, ctx)
      await settle()
      assert.deepEqual(texts(sends), ['CLAUDE', 'CLAUDE-2', 'CLAUDE-3'])
    })
  })

  describe('error accuracy and untagged sources', () => {
    it('two records with the same provider are reported as same-provider duplicates', async () => {
      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => [rec('claude', ALLOWED), rec('claude', ALLOWED)]) })
      await handler(ws(), client(), { type: 'request_conversation_transcript', conversationId: ID, provider: 'claude' }, ctx)
      await settle()
      assert.match(sends[0].message, /more than one record for this provider/)
      assert.doesNotMatch(sends[0].message, /more than one provider/)
    })

    it('an untagged source (no recorded provider) is refused, never treated as Claude', async () => {
      write(claudeProjects, 'MUST-NOT-READ')
      clearScanCache()
      const all = await scanConversations({ projectsDirs: [claudeProjects] })
      const found = all.find((c) => c.conversationId === ID)
      assert.equal(found.provider, null, 'a bare directory carries no provider')

      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => [found]) })
      await handler(ws(), client(), { type: 'request_conversation_transcript', conversationId: ID }, ctx)
      await settle()
      assert.match(sends[0].message, /no recorded provider/)
      assert.deepEqual(texts(sends), [])
    })

    it('the scanner\'s default store IS identified as Claude and replays', async () => {
      clearScanCache()
      const all = await scanConversations({ projectsDirs: [{ provider: 'claude', projectsDir: claudeProjects }] })
      assert.equal(all.find((c) => c.conversationId === ID).provider, 'claude')
    })

    it('errors name the conversation they answer, with a stable code', async () => {
      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => []) })
      await handler(ws(), client(), { type: 'request_conversation_transcript', conversationId: ID }, ctx)
      assert.equal(sends[0].code, 'TRANSCRIPT_UNAVAILABLE')
      assert.equal(sends[0].conversationId, ID)
    })
  })

  describe('the provider selector survives the public request schema', () => {
    it('parse retains `provider` and the handler reads only that provider\'s record', async () => {
      const parsed = ClientMessageSchema.parse({
        type: 'request_conversation_transcript', conversationId: ID, provider: 'codex',
      })
      assert.equal(parsed.provider, 'codex')
      const { ctx, sends } = makeCtx({ scanConversations: createSpy(async () => [rec('claude', ALLOWED), rec('codex', ALLOWED)]) })
      await handler(ws(), client(), parsed, ctx)
      await settle()
      // The selector reached the handler: it chose codex (explicitly
      // unsupported) instead of refusing as ambiguous or reading Claude.
      assert.match(sends[0].message, /not supported for codex/)
      assert.deepEqual(texts(sends), [])
    })
  })
})
