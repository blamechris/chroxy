import { describe, it, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync, unlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { TokenManager } from '../src/token-manager.js'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { projectSlug } from '../src/jsonl-reader.js'
import { readContainedBytes, readContainedBytesSync } from '../src/utils/regular-file.js'
import { frameForBoundClient } from '../src/outgoing-policy.js'
import { isSafeRegexSource } from '../src/utils/safe-regex.js'
import { createReadLimiter, ReadLimitError } from '../src/utils/read-limiter.js'
import { createMockSessionManager, waitFor, createSpy, nsCtx, makeSessionIndexCtx } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const CONV = '99999999-9999-4999-8999-999999999999'
const SIBLING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const line = (text) => JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text }] } }) + '\n'

describe('a session-scoped connection receives its own conversation transcript', () => {
  let server
  let pm
  let root
  const sockets = []
  before(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-transcript-delivery-'))) })
  after(() => { rmSync(root, { recursive: true, force: true }) })
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close()
    if (server) { server.close(); server = null }
    if (pm) { pm.destroy(); pm = null }
  })

  async function connect(token) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    sockets.push(ws)
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    return { ws, messages }
  }

  it('delivers the replay frames to the bound client, and refuses a sibling conversation', async () => {
    const cwd = join(root, 'work', 'proj')
    mkdirSync(cwd, { recursive: true })
    const store = join(root, 'store')
    const dir = join(store, projectSlug(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${CONV}.jsonl`), line('own conversation text'))
    writeFileSync(join(dir, `${SIBLING}.jsonl`), line('sibling conversation text'))

    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'session-1', name: 'One', cwd }], {
      getConversationId: (id) => (id === 'session-1' ? CONV : null),
    })
    sessionsMap.get('session-1').session.resumeSessionId = CONV
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, pairingManager: pm })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))

    const scoped = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const guest = await connect(scoped)
    const owner = await connect('primary-tok')

    // Drive the real handler with the server's own handler context and send path.
    const base = server._handlerCtx
    const mkCtx = () => {
      const ctx = { ...base, runtime: { ...base.runtime, transcriptSources: [{ provider: 'claude', projectsDir: store }] } }
      ctx.scanConversations = async () => [
        { conversationId: CONV, provider: 'claude', cwd, sourceLocator: `${projectSlug(cwd)}/${CONV}.jsonl` },
        { conversationId: SIBLING, provider: 'claude', cwd, sourceLocator: `${projectSlug(cwd)}/${SIBLING}.jsonl` },
      ]
      return ctx
    }
    const guestClient = [...server.clients.values()].find((c) => c.boundSessionId === 'session-1')
    const guestWs = [...server.clients.entries()].find(([, c]) => c === guestClient)[0]
    const ownerClient = [...server.clients.values()].find((c) => c.authenticated && !c.boundSessionId)
    const ownerWs = [...server.clients.entries()].find(([, c]) => c === ownerClient)[0]

    await conversationHandlers.request_conversation_transcript(ownerWs, ownerClient, { type: 'request_conversation_transcript', conversationId: CONV }, mkCtx())
    await conversationHandlers.request_conversation_transcript(guestWs, guestClient, { type: 'request_conversation_transcript', conversationId: CONV }, mkCtx())
    await waitFor(() => owner.messages.find((m) => m.type === 'history_replay_end'), { label: 'owner replay end' })
    await waitFor(() => guest.messages.find((m) => m.type === 'history_replay_end'), { label: 'guest replay end' })
    const types = (c) => c.messages.filter((m) => m.sessionId === CONV).map((m) => m.type)
    assert.deepEqual(types(guest), types(owner), 'the bound client gets exactly the frames the owner gets')
    assert.ok(types(guest).includes('history_replay_start') && types(guest).includes('message'))

    guest.messages.length = 0
    await conversationHandlers.request_conversation_transcript(guestWs, guestClient, { type: 'request_conversation_transcript', conversationId: SIBLING }, mkCtx())
    await waitFor(() => guest.messages.find((m) => m.type === 'session_error'), { label: 'refusal' })
    assert.equal(JSON.stringify(guest.messages).includes('sibling conversation text'), false)
    assert.equal(guest.messages.some((m) => m.type === 'history_replay_start'), false)
  })

  it('a frame a client cannot mark is still withheld when it names another session', async () => {
    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const { manager } = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/p' }])
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, pairingManager: pm })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    const guest = await connect(pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken)
    const guestWs = [...server.clients.entries()].find(([, c]) => c.boundSessionId === 'session-1')[0]
    server._send(guestWs, { type: 'history_replay_start', sessionId: 'session-2' })
    server._send(guestWs, { type: 'history_replay_start', sessionId: 'session-1' })
    await waitFor(() => guest.messages.find((m) => m.sessionId === 'session-1'), { label: 'own' })
    assert.equal(guest.messages.some((m) => m.sessionId === 'session-2'), false)
  })
})

describe('scheduled rotation leaves a session-scoped connection\'s recorded credential alone', () => {
  it('does not record the rotated token on a bound client', async () => {
    const tokenManager = new TokenManager({ token: 'initial-token', graceMs: 5000 })
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const { manager } = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/p' }])
    const server = new WsServer({ port: 0, apiToken: 'initial-token', sessionManager: manager, authRequired: true, pairingManager: pm, tokenManager })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    const scoped = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    await new Promise((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'auth', token: scoped }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    const client = [...server.clients.values()].find((c) => c.boundSessionId === 'session-1')
    client.encryptionState = { sharedKey: new Uint8Array(32), sendNonce: 0, recvNonce: 0 }
    try {
      tokenManager.rotate()
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(client.authToken, scoped, 'its recorded credential is still its own')
      assert.equal(JSON.stringify(messages).includes('token_rotated'), false)
    } finally {
      ws.close(); server.close(); pm.destroy(); tokenManager.destroy()
    }
  })
})

describe('the contained readers check the root and its ancestors', () => {
  let base, root, outside
  before(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-root-swap-')))
  })
  after(() => { rmSync(base, { recursive: true, force: true }) })

  function fresh(name) {
    root = join(base, name, 'proj')
    outside = join(base, name, 'outside')
    mkdirSync(join(root, 'sub'), { recursive: true })
    mkdirSync(join(outside, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', 'f.txt'), 'INSIDE-MARKER\n')
    writeFileSync(join(outside, 'sub', 'f.txt'), 'OUTSIDE-MARKER\n')
    return join(root, 'sub', 'f.txt')
  }
  // `proj` is renamed away and replaced by a link to the outside tree when the
  // file is opened, and put back before the checks run.
  const swapRoot = (name, again) => ({
    beforeOpen: () => { renameSync(join(base, name, 'proj'), join(base, name, 'proj.real')); symlinkSync(join(base, name, 'outside'), join(base, name, 'proj')) },
    ...(again ? { afterOpen: () => { unlinkSync(join(base, name, 'proj')); renameSync(join(base, name, 'proj.real'), join(base, name, 'proj')) } } : {}),
  })

  it('async: a root swapped to a link that is still there at check time is refused', { skip: SKIP_NO_SYMLINK }, async () => {
    const file = fresh('a1')
    assert.equal(await readContainedBytes(file, root, 1024, { deps: swapRoot('a1', false) }), null)
  })

  it('async: a root swapped for the open and restored before the checks is refused', { skip: SKIP_NO_SYMLINK }, async () => {
    const file = fresh('a2')
    assert.equal(await readContainedBytes(file, root, 1024, { deps: swapRoot('a2', true) }), null)
  })

  it('async: an ANCESTOR of the root swapped for the open and restored is refused', { skip: SKIP_NO_SYMLINK }, async () => {
    const file = fresh('a3')
    const parent = join(base, 'a3')
    const out = await readContainedBytes(file, root, 1024, {
      deps: {
        beforeOpen: () => { renameSync(parent, `${parent}.real`); mkdirSync(parent); symlinkSync(join(`${parent}.real`, 'outside'), join(parent, 'proj')) },
        afterOpen: () => { unlinkSync(join(parent, 'proj')); rmSync(parent, { recursive: true }); renameSync(`${parent}.real`, parent) },
      },
    })
    assert.equal(out, null)
  })

  it('an ancestor of the root that is a link at check time is refused, by both readers', { skip: SKIP_NO_SYMLINK }, async () => {
    // `holder` becomes a link to a tree that also contains proj/sub/f.txt, so the
    // file, its parents and the root all look like real directories THROUGH the
    // link; only the ancestor's own lstat shows it is one.
    for (const kind of ['async', 'sync']) {
      const name = `anc-${kind}`
      const holder = join(base, name)
      mkdirSync(join(holder, 'proj', 'sub'), { recursive: true })
      mkdirSync(join(base, `${name}-outside`, 'proj', 'sub'), { recursive: true })
      writeFileSync(join(holder, 'proj', 'sub', 'f.txt'), 'INSIDE-MARKER\n')
      writeFileSync(join(base, `${name}-outside`, 'proj', 'sub', 'f.txt'), 'OUTSIDE-MARKER\n')
      const deps = {
        beforeOpen: () => { renameSync(holder, `${holder}.real`); symlinkSync(join(base, `${name}-outside`), holder) },
      }
      const file = join(holder, 'proj', 'sub', 'f.txt')
      const root = join(holder, 'proj')
      const out = kind === 'async' ? await readContainedBytes(file, root, 1024, { deps }) : readContainedBytesSync(file, root, 1024, { deps })
      assert.equal(out, null, kind)
    }
  })

  it('sync: the same root swaps are refused (the sync reader has the same seam)', { skip: SKIP_NO_SYMLINK }, () => {
    const file = fresh('s1')
    assert.equal(readContainedBytesSync(file, root, 1024, { deps: swapRoot('s1', false) }), null)
    const file2 = fresh('s2')
    assert.equal(readContainedBytesSync(file2, root, 1024, { deps: swapRoot('s2', true) }), null)
  })

  it('undisturbed, both readers return the inside file (control)', () => {
    const file = fresh('ok')
    assert.equal(readContainedBytesSync(file, root, 1024).toString(), 'INSIDE-MARKER\n')
  })

  it('sync: a file replaced after the open is refused by the identity check', () => {
    const file = fresh('s3')
    const out = readContainedBytesSync(file, root, 1024, {
      deps: { afterOpen: () => { unlinkSync(file); writeFileSync(file, 'REPLACEMENT\n') } },
    })
    assert.equal(out, null)
  })
})

describe('list_conversations and search_conversations report a refusal for load', () => {
  function ctxWith(limiter) {
    const sent = []
    const ctx = nsCtx({
      send: createSpy((_w, m) => sent.push(m)),
      ...makeSessionIndexCtx(),
      sessionManager: { getSession: () => null, getConversationId: () => null },
    })
    ctx.scanConversations = async () => []
    ctx.searchConversations = async () => []
    ctx.transcriptReadLimiter = limiter
    return { ctx, sent }
  }
  const refusing = { submit: () => Promise.reject(new ReadLimitError('queue', 'Too many transcript requests are in progress')) }

  for (const type of ['list_conversations', 'search_conversations']) {
    it(`${type}: a retryable error, not empty results`, async () => {
      const { ctx, sent } = ctxWith(refusing)
      await conversationHandlers[type]({ readyState: 1 }, { id: 'c' }, { query: 'x' }, ctx)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'session_error')
      assert.match(sent[0].message, /Try again/)
    })
  }
})

describe('smaller items', () => {
  it('cost_update loses the host-wide total for a session-scoped connection', () => {
    const out = frameForBoundClient({ type: 'cost_update', sessionId: 's', sessionCost: 1.5, totalCost: 99 })
    assert.equal('totalCost' in out, false)
    assert.equal(out.sessionCost, 1.5)
  })

  it('refuses a bounded repeat of a group holding an unbounded repeat', () => {
    for (const p of ['(.*a){12}$', '(.*a){20}$', '(a+b){2}c']) assert.equal(isSafeRegexSource(p), false, p)
    for (const p of ['(ab){3}', '(foo|bar)$']) assert.equal(isSafeRegexSource(p), true, p)
  })

  it('an unrestricted caller turned away at the waiter bound does not lift the restriction', async () => {
    const lim = createReadLimiter({ maxConcurrent: 2, maxPerClient: 100, maxQueued: 32, maxWaitersPerJob: 1 })
    let release
    const hold = new Promise((r) => { release = r })
    let started = 0
    const run = () => { started++; return hold }
    // Two slots: one filler (unrestricted), then a restricted read queues behind the reserved slot.
    const filler = lim.submit({ key: 'filler', clientKey: 'f' }, run)
    const restricted = lim.submit({ key: 'k', clientKey: 'r', restricted: true }, run)
    await new Promise((r) => setImmediate(r))
    assert.equal(started, 1, 'the restricted read waits for the reserved slot')
    let otherP = Promise.resolve()
    try {
      await assert.rejects(lim.submit({ key: 'k', clientKey: 'u' }, run), (e) => e instanceof ReadLimitError)
      // Any later submission re-examines the queue.
      const other = lim.submit({ key: 'other', clientKey: 'o' }, async () => 'x')
      otherP = other
      await new Promise((r) => setImmediate(r))
      assert.equal(started, 1, 'still waiting: the refused caller did not lift the restriction')
    } finally {
      // Release the held reads even when an assertion failed, so a failure is an
      // assertion and not a hung, cancelled run.
      release()
    }
    await Promise.all([filler, restricted, otherP])
  })
})
