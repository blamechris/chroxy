import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readConversationHistoryWithMetaAsync,
  readConversationTranscriptStrictAsync,
  encodeProjectPath,
} from '../src/jsonl-reader.js'
import { createReadLimiter, ReadLimitError } from '../src/utils/read-limiter.js'
import { SessionManager } from '../src/session-manager.js'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { nsCtx, makeSessionIndexCtx, createSpy } from './test-helpers.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

const POSIX = process.platform !== 'win32'
const CONV = '44444444-4444-4444-8444-444444444444'
const LINE = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'hello from disk' }] } }) + '\n'

function within(ms, promise, label) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

describe('every transcript reader is admitted through the shared limiter', () => {
  let dir
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-readers-'))
    for (const n of ['a', 'b', 'c']) writeFileSync(join(dir, `${n}.jsonl`), LINE.repeat(3))
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the full-history reader submits to the limiter with the caller\'s client key', async () => {
    const seen = []
    const real = createReadLimiter()
    const limiter = { submit: (req, fn) => { seen.push(req); return real.submit(req, fn) } }
    const out = await readConversationHistoryWithMetaAsync(join(dir, 'a.jsonl'), undefined, { limiter, clientKey: 'conn-7' })
    assert.equal(out.messages.length, 3)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].clientKey, 'conn-7')
  })

  it('a connection with a read outstanding cannot start another through the strict reader either', async () => {
    const limiter = createReadLimiter({ maxConcurrent: 1, maxPerClient: 1, maxQueued: 4 })
    const first = readConversationTranscriptStrictAsync(join(dir, 'a.jsonl'), undefined, { limiter, clientKey: 'conn-1' })
    await assert.rejects(
      readConversationTranscriptStrictAsync(join(dir, 'b.jsonl'), undefined, { limiter, clientKey: 'conn-1' }),
      (e) => e instanceof ReadLimitError && e.scope === 'client',
    )
    await first
  })

  it('identical in-flight full-history reads share one read', async () => {
    const real = createReadLimiter()
    let runs = 0
    const limiter = { submit: (req, fn) => real.submit(req, (sig) => { runs++; return fn(sig) }) }
    const reads = await Promise.all([1, 2, 3].map((i) => readConversationHistoryWithMetaAsync(join(dir, 'c.jsonl'), undefined, { limiter, clientKey: `conn-${i}` })))
    assert.equal(runs, 1)
    assert.ok(reads.every((r) => r === reads[0]))
  })

  it('a read cancelled by its signal stops and yields an empty history', async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await readConversationHistoryWithMetaAsync(join(dir, 'a.jsonl'), undefined, { signal: ac.signal, clientKey: 'conn-x' })
    assert.deepEqual(out, { messages: [], truncated: false })
  })

  it('refuses a transcript path that is a link (final component)', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(join(dir, 'a.jsonl'), join(dir, 'link.jsonl'))
    const out = await readConversationHistoryWithMetaAsync(join(dir, 'link.jsonl'), undefined, { clientKey: 'conn-l' })
    assert.deepEqual(out.messages, [])
  })

  it('refuses a special file promptly instead of waiting on it', { skip: !POSIX && 'needs mkfifo' }, async () => {
    execFileSync('mkfifo', [join(dir, 'pipe.jsonl')])
    const out = await within(3000, readConversationHistoryWithMetaAsync(join(dir, 'pipe.jsonl'), undefined, { clientKey: 'conn-p' }), 'read of a FIFO')
    assert.deepEqual(out.messages, [])
  })
})

describe('SessionManager.getFullHistoryAsync reads inside the transcript store', () => {
  let root, home, realHome, realProfile, realConfig, cwd, store
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-fullhist-')))
    home = join(root, 'home')
    cwd = join(root, 'work', 'proj')
    mkdirSync(cwd, { recursive: true })
    store = join(home, '.claude', 'projects')
    mkdirSync(store, { recursive: true })
    realHome = process.env.HOME; realProfile = process.env.USERPROFILE; realConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR
  })
  after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile
    if (realConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = realConfig
    rmSync(root, { recursive: true, force: true })
  })

  // The method only needs the session table and the ring-buffer accessors.
  function history(sessionCwd, opts) {
    const self = {
      _sessions: new Map([['s1', { cwd: sessionCwd, session: { resumeSessionId: CONV, constructor: {} } }]]),
      getHistory: () => [{ type: 'user_input', content: 'from the ring buffer', timestamp: 1 }],
      isHistoryTruncated: () => false,
    }
    return SessionManager.prototype.getFullHistoryAsync.call(self, 's1', opts)
  }
  const projectDir = (c) => join(store, encodeProjectPath(c))

  it('reads the transcript from the store', async () => {
    mkdirSync(projectDir(cwd), { recursive: true })
    writeFileSync(join(projectDir(cwd), `${CONV}.jsonl`), LINE)
    const out = await history(cwd, { clientKey: 'conn-1' })
    assert.equal(out.source, 'jsonl')
    assert.equal(out.entries.some((e) => /hello from disk/.test(e.content)), true)
  })

  it('does not follow a project directory that is a link out of the store', { skip: SKIP_NO_SYMLINK }, async () => {
    const planted = join(root, 'work', 'planted')
    mkdirSync(planted, { recursive: true })
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, `${CONV}.jsonl`), JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'OUTSIDE-THE-STORE' }] } }) + '\n')
    symlinkSync(elsewhere, projectDir(planted))
    const out = await history(planted, { clientKey: 'conn-2' })
    assert.equal(out.source, 'ring')
    assert.equal(JSON.stringify(out).includes('OUTSIDE-THE-STORE'), false)
  })

  it('does not wait on a special file at the transcript path', { skip: !POSIX && 'needs mkfifo' }, async () => {
    const fifoCwd = join(root, 'work', 'fifo')
    mkdirSync(fifoCwd, { recursive: true })
    mkdirSync(projectDir(fifoCwd), { recursive: true })
    execFileSync('mkfifo', [join(projectDir(fifoCwd), `${CONV}.jsonl`)])
    const out = await within(3000, history(fifoCwd, { clientKey: 'conn-3' }), 'full history over a FIFO')
    assert.equal(out.source, 'ring')
  })
})

describe('request_full_history', () => {
  function build(getFullHistoryAsync) {
    const sent = []
    const ctx = nsCtx({
      send: createSpy((_w, m) => { sent.push(m) }),
      ...makeSessionIndexCtx(),
      reseedActiveAgents: createSpy(),
      resendPendingQuestions: createSpy(),
      resendPendingPermissions: createSpy(),
      sessionManager: {
        getSession: () => ({ session: {}, cwd: '/tmp/x', name: 'S' }),
        getFullHistoryAsync,
        isHistoryTruncated: () => false,
        getLatestHistorySeq: () => 0,
      },
    })
    return { ctx, sent }
  }
  const client = { id: 'conn-9', activeSessionId: 's1', boundSessionId: 's1', subscribedSessionIds: new Set() }

  it('passes the connection\'s identity and a close signal down to the reader', async () => {
    let got
    const { ctx } = build(async (_sid, opts) => { got = opts; return { entries: [], source: 'ring', truncated: false } })
    const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0 })
    await conversationHandlers.request_full_history(ws, client, { sessionId: 's1' }, ctx)
    assert.equal(got.clientKey, 'conn-9')
    assert.ok(got.signal instanceof AbortSignal)
  })

  it('stops the read, and sends nothing, when the connection closes while it waits', async () => {
    let signal
    const { ctx, sent } = build((_sid, opts) => new Promise((resolve) => {
      signal = opts.signal
      signal.addEventListener('abort', () => resolve({ entries: [{ type: 'user_input', content: 'late', timestamp: 1 }], source: 'ring', truncated: false }))
    }))
    const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0 })
    const pending = conversationHandlers.request_full_history(ws, client, { sessionId: 's1' }, ctx)
    await new Promise((r) => setImmediate(r))
    ws.emit('close')
    await pending
    assert.equal(signal.aborted, true)
    assert.equal(sent.length, 0)
  })
})
