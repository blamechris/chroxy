/**
 * The agent principal's journal read path over a REAL WsServer (principal-handlers.js,
 * principal-subscriptions.js, principal-journal.js; #9118, S3 of #9112;
 * docs/security/agent-principals.md sections 3.1 item 7, 7.1 and 7.2).
 *
 * A principal is a real credential: a token inserted into a TEMP store by the S1 fixture,
 * presented at `auth` from a loopback peer. The journal is fed by real broadcasts through the
 * server (`_broadcastToSession`), exactly the tap production uses. The oracle is what the test
 * itself broadcast (a counter in the test), never the journal's own head.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { PrincipalJournal, FLOORED_RESULT_PLACEHOLDER } from '../src/principal-journal.js'
import { HELD_MAX_EVENTS, HELD_MAX_BYTES } from '../src/principal-subscriptions.js'
import { PRINCIPAL_BROADCAST_ALLOWED } from '../src/principal-policy.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from './helpers/principal-store-fixture.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const SESSIONS = [
  { id: 'sess-1', name: 'One', cwd: '/tmp/project-1' },
  { id: 'sess-2', name: 'Two', cwd: '/tmp/project-2' },
  { id: 'sess-3', name: 'Three (not granted)', cwd: '/tmp/project-3' },
]
const PRIMARY = 'primary-tok'

describe('the principal journal over a real server', () => {
  let server
  let journalDir
  let sessionsOverride = null
  const cleanups = []
  const sockets = []
  afterEach(() => {
    sessionsOverride = null
    for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
    if (server) { server.close(); server = null }
    while (cleanups.length) cleanups.pop()()
  })

  async function boot({ journalOpts = {}, withJournal = true, constraints = { sessionIds: ['sess-1', 'sess-2'] }, scope = 'observe' } = {}) {
    const fixture = tempPrincipalDir()
    cleanups.push(fixture.cleanup)
    const store = testPrincipalStore(fixture.path)
    const { token } = insertPrincipal(store, { principalId: 'pr-1', label: 'sup', scope, constraints })
    journalDir = mkdtempSync(join(tmpdir(), 'chroxy-journal-wire-'))
    cleanups.push(() => rmSync(journalDir, { recursive: true, force: true }))
    const journal = withJournal
      ? new PrincipalJournal({ dir: journalDir, timers: { setTimeout: () => null, clearTimeout: () => {} }, ...journalOpts })
      : null
    const { manager } = createMockSessionManager(sessionsOverride ?? SESSIONS)
    server = new WsServer({ port: 0, apiToken: PRIMARY, sessionManager: manager, authRequired: true, principalStore: store, principalJournal: journal })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return { port: server.httpServer.address().port, token, store, journal }
  }

  async function open(port, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
    const messages = []
    ws.on('message', (d) => { try { const { seq: _s, ...frame } = JSON.parse(d.toString()); messages.push(frame) } catch { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    messages.length = 0
    return { ws, messages, send: (m) => ws.send(JSON.stringify(m)) }
  }

  /** A real broadcast the journal taps: one `message` frame is exactly one journal event. */
  const say = (sid, n, extra = {}) => server._broadcastToSession(sid, { type: 'message', messageType: 'response', content: `m${n}`, ...extra })
  const types = (c) => c.messages.map((m) => m.type)
  const eventSeqs = (c, pred = () => true) => c.messages.filter((m) => m.type === 'principal_event' && pred(m)).map((m) => m.journalSeq)
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

  describe('subscribe, replay, fence, live', () => {
    it('answers principal_subscribed, replays up to headSeq, fences, then goes live in seq order', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      for (let i = 1; i <= 5; i++) say('sess-1', i)
      c.send({ type: 'principal_subscribe', requestId: 'sub-1', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'), { label: 'fence' })
      say('sess-1', 6)
      say('sess-1', 7)
      await waitFor(() => eventSeqs(c).length === 7, { label: 'seven events' })

      const subscribed = c.messages[0]
      assert.equal(subscribed.type, 'principal_subscribed')
      assert.equal(subscribed.requestId, 'sub-1')
      assert.equal(subscribed.sessions.length, 1)
      assert.equal(subscribed.sessions[0].sessionId, 'sess-1')
      assert.equal(subscribed.sessions[0].headSeq, 5, 'headSeq is the oracle 5')
      assert.equal('gap' in subscribed.sessions[0], false)
      const journalId = subscribed.sessions[0].journalId

      assert.deepEqual(eventSeqs(c), range(1, 7), 'seq order, nothing repeated, nothing missed')
      const fenceAt = types(c).indexOf('principal_live_fence')
      const fence = c.messages[fenceAt]
      assert.deepEqual({ requestId: fence.requestId, sessionId: fence.sessionId, journalId: fence.journalId, journalSeq: fence.journalSeq }, { requestId: 'sub-1', sessionId: 'sess-1', journalId, journalSeq: 5 })
      c.messages.forEach((m, i) => {
        if (m.type !== 'principal_event') return
        assert.equal(m.requestId, 'sub-1')
        assert.equal(m.journalId, journalId)
        assert.equal(m.eventType, 'message')
        assert.equal(m.data.content, `m${m.journalSeq}`)
        if (m.journalSeq <= 5) assert.ok(m.replay === true && i < fenceAt, `replayed seq ${m.journalSeq} comes before the fence`)
        else assert.ok(m.replay === undefined && i > fenceAt, `live seq ${m.journalSeq} comes after the fence`)
      })
    })

    it('a cursor resumes after the last seen seq, and a bad one is reported as a gap, not honored', async () => {
      const { port, token, journal } = await boot()
      const c = await open(port, token)
      for (let i = 1; i <= 6; i++) say('sess-1', i)
      const { journalId } = journal.head('sess-1')
      c.send({ type: 'principal_subscribe', requestId: 's', sessionIds: ['sess-1'], cursors: [{ sessionId: 'sess-1', journalId, seq: 4 }] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'))
      assert.deepEqual(eventSeqs(c), [5, 6])

      c.messages.length = 0
      c.send({ type: 'principal_subscribe', requestId: 's2', sessionIds: ['sess-1'], cursors: [{ sessionId: 'sess-1', journalId: 'never-issued', seq: 4 }] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'))
      const sub = c.messages.find((m) => m.type === 'principal_subscribed')
      assert.deepEqual(sub.sessions[0].gap, { reason: 'unknown_cursor' })
      assert.deepEqual(eventSeqs(c), range(1, 6), 'an unknown cursor replays the whole retained window')
    })

    it('live events that arrive DURING replay are held and released in seq order after the fence', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      for (let i = 1; i <= 120; i++) say('sess-1', i)
      let yields = 0
      server._principalSubscriptions.yieldFn = async () => {
        yields++
        if (yields === 1) { say('sess-1', 121); say('sess-1', 122); say('sess-1', 123) } // live traffic mid-replay
        await new Promise((r) => setImmediate(r))
      }
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      await waitFor(() => eventSeqs(c).length === 123, { label: 'all 123' })
      assert.ok(yields >= 1, 'the replay really did yield (there was a mid-replay window)')
      assert.deepEqual(eventSeqs(c), range(1, 123), 'one total order, no gaps, no duplicates')
      const fenceAt = types(c).indexOf('principal_live_fence')
      assert.equal(c.messages[fenceAt].journalSeq, 120)
      const frameIndexOf = (seq) => c.messages.findIndex((m) => m.type === 'principal_event' && m.journalSeq === seq)
      for (const seq of [121, 122, 123]) assert.ok(frameIndexOf(seq) > fenceAt, `live seq ${seq} was held until after the fence`)
      for (const seq of range(1, 120)) assert.ok(frameIndexOf(seq) < fenceAt, `replayed seq ${seq} precedes the fence`)
    })

    it('a held buffer past its cap reports a gap and ENDS the subscription; a re-subscribe recovers', async () => {
      assert.equal(HELD_MAX_EVENTS, 500)
      assert.equal(HELD_MAX_BYTES, 1024 * 1024)
      const { port, token } = await boot()
      const c = await open(port, token)
      for (let i = 1; i <= 60; i++) say('sess-1', i)
      let yields = 0
      server._principalSubscriptions.yieldFn = async () => {
        if (++yields === 1) for (let i = 61; i <= 61 + HELD_MAX_EVENTS; i++) say('sess-1', i) // 501 held
        await new Promise((r) => setImmediate(r))
      }
      server._principalSubscriptions._replayBatch = 20
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      const gap = await waitFor(() => c.messages.find((m) => m.type === 'principal_gap'), { label: 'gap' })
      assert.equal(gap.reason, 'held_overflow')
      assert.equal(gap.ended, true)
      assert.equal(gap.sessionId, 'sess-1')
      assert.equal(server._principalSubscriptions.size, 0, 'the subscription is over')
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(c.messages.some((m) => m.type === 'principal_live_fence'), false, 'it never reached the fence')
      const before = c.messages.length
      say('sess-1', 9999)
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(c.messages.length, before, 'nothing more is delivered after the end')
      // recover: subscribe again from the last cursor
      server._principalSubscriptions.yieldFn = () => new Promise((r) => setImmediate(r))
      c.messages.length = 0
      c.send({ type: 'principal_subscribe', requestId: 'again', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'))
    })

    it('a held buffer past its BYTE cap ends it too (large events, fewer than 500)', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      for (let i = 1; i <= 60; i++) say('sess-1', i)
      let yields = 0
      server._principalSubscriptions._replayBatch = 20
      server._principalSubscriptions.yieldFn = async () => {
        if (++yields === 1) for (let i = 61; i <= 400; i++) say('sess-1', i, { content: 'z'.repeat(3500) })
        await new Promise((r) => setImmediate(r))
      }
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      const gap = await waitFor(() => c.messages.find((m) => m.type === 'principal_gap'), { label: 'gap' })
      assert.equal(gap.reason, 'held_overflow')
      assert.ok(340 < HELD_MAX_EVENTS, 'the count cap was NOT what ended it')
    })

    it('eviction between headSeq and the fence is reported as a gap, and the replay continues after it', async () => {
      const { port, token } = await boot({ journalOpts: { maxEvents: 60 } })
      const c = await open(port, token)
      for (let i = 1; i <= 60; i++) say('sess-1', i)
      let yields = 0
      server._principalSubscriptions._replayBatch = 20
      server._principalSubscriptions.yieldFn = async () => {
        if (++yields === 1) for (let i = 61; i <= 90; i++) say('sess-1', i) // evicts 1..30 while the replay is at 20
        await new Promise((r) => setImmediate(r))
      }
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      await waitFor(() => eventSeqs(c).length === 20 + 60, { label: 'replay + held' })
      const gap = c.messages.find((m) => m.type === 'principal_gap')
      assert.deepEqual({ reason: gap.reason, fromSeq: gap.fromSeq, toSeq: gap.toSeq, ended: gap.ended }, { reason: 'evicted', fromSeq: 21, toSeq: 30, ended: false })
      assert.deepEqual(eventSeqs(c), [...range(1, 20), ...range(31, 90)], 'the evicted range is skipped, never silently')
      const fence = c.messages.find((m) => m.type === 'principal_live_fence')
      assert.equal(fence.journalSeq, 60)
      const gapAt = types(c).indexOf('principal_gap')
      assert.ok(gapAt < types(c).indexOf('principal_live_fence'), 'the gap is reported before the fence')
    })

    it('principal_unsubscribe stops delivery, and the subscription count goes to zero', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1', 'sess-2'] })
      await waitFor(() => c.messages.filter((m) => m.type === 'principal_live_fence').length === 2)
      assert.equal(server._principalSubscriptions.size, 2)
      c.send({ type: 'principal_unsubscribe', sessionIds: ['sess-1'] })
      await waitFor(() => server._principalSubscriptions.size === 1)
      c.messages.length = 0
      say('sess-1', 1)
      say('sess-2', 1)
      await waitFor(() => eventSeqs(c).length === 1)
      assert.equal(c.messages.find((m) => m.type === 'principal_event').sessionId, 'sess-2')
      c.send({ type: 'principal_unsubscribe' })
      await waitFor(() => server._principalSubscriptions.size === 0)
    })

    it('a disconnect leaves no subscription behind', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'))
      c.ws.close()
      await waitFor(() => server._principalSubscriptions.size === 0, { label: 'subscription cleared on departure' })
    })

    it('a revoked principal is cut off and its subscriptions go', async () => {
      const { port, token, store } = await boot()
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'))
      store.revoke({ principalId: 'pr-1' })
      server._endPrincipalConnections('pr-1', 'revoked')
      await waitFor(() => server._principalSubscriptions.size === 0)
      c.messages.length = 0
      say('sess-1', 1)
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(c.messages.some((m) => m.type === 'principal_event'), false)
    })

    it('a grant narrowed mid-subscription withholds the next frame', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'))
      const record = [...server.clients.values()].find((r) => r.principal)
      record.principal = { ...record.principal, constraints: { sessionIds: ['sess-2'] } }
      c.messages.length = 0
      say('sess-1', 1)
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(c.messages.some((m) => m.type === 'principal_event'), false)
    })
  })

  describe('access: indistinguishable and all-or-nothing', () => {
    const strip = (frame) => { const { requestId: _r, ...rest } = frame; return rest }

    it('a session that is not granted and one that does not exist are refused with the same reply', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'a', sessionIds: ['sess-3'] })
      c.send({ type: 'principal_subscribe', requestId: 'b', sessionIds: ['no-such-session'] })
      c.send({ type: 'principal_events_read', requestId: 'c', sessionId: 'sess-3' })
      c.send({ type: 'principal_events_read', requestId: 'd', sessionId: 'no-such-session' })
      await waitFor(() => c.messages.filter((m) => m.type === 'session_error').length === 4, { label: 'four refusals' })
      const byId = Object.fromEntries(c.messages.map((m) => [m.requestId, m]))
      assert.deepEqual(strip(byId.a), strip(byId.b))
      assert.equal(byId.a.code, 'scope_denied')
      assert.equal(byId.a.requestType, 'principal_subscribe')
      assert.deepEqual(strip(byId.c), strip(byId.d))
      assert.equal(byId.c.code, 'scope_denied')
      assert.equal(server._principalSubscriptions.size, 0)
      assert.equal(c.messages.some((m) => String(m.type).startsWith('principal_') && m.type !== 'session_error'), false)
    })

    it('a multi-id subscribe is all-or-nothing: one id not granted refuses the whole request, nothing is subscribed', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'multi', sessionIds: ['sess-1', 'sess-3', 'sess-2'] })
      const refusal = await waitFor(() => c.messages.find((m) => m.type === 'session_error' && m.requestId === 'multi'))
      assert.equal(refusal.code, 'scope_denied')
      assert.equal(server._principalSubscriptions.size, 0, 'the granted ids were NOT subscribed')
      say('sess-1', 1)
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(c.messages.some((m) => m.type === 'principal_event' || m.type === 'principal_subscribed'), false)
      // the same ids minus the stranger succeed (positive control)
      c.send({ type: 'principal_subscribe', requestId: 'ok', sessionIds: ['sess-1', 'sess-2'] })
      await waitFor(() => c.messages.filter((m) => m.type === 'principal_live_fence').length === 2)
      assert.equal(server._principalSubscriptions.size, 2)
    })

    it('a cwd-root grant covers the sessions under it and no others', async () => {
      // realpath is taken of both sides, so the directories must exist
      const root = mkdtempSync(join(tmpdir(), 'chroxy-journal-roots-'))
      cleanups.push(() => rmSync(root, { recursive: true, force: true }))
      for (const d of ['project-1', 'project-2']) mkdirSync(join(root, d))
      sessionsOverride = [
        { id: 'sess-1', name: 'One', cwd: join(root, 'project-1') },
        { id: 'sess-2', name: 'Two', cwd: join(root, 'project-2') },
      ]
      const { port, token } = await boot({ constraints: { cwdRoots: [join(root, 'project-1')] } })
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'in', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_subscribed'))
      c.send({ type: 'principal_subscribe', requestId: 'out', sessionIds: ['sess-2'] })
      await waitFor(() => c.messages.find((m) => m.type === 'session_error' && m.requestId === 'out'))
    })

    it('a paged read: limit 200 returns at most 200 and a cursor that continues; 201 is refused', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      for (let i = 1; i <= 250; i++) say('sess-1', i)
      c.send({ type: 'principal_events_read', requestId: 'p1', sessionId: 'sess-1', limit: 200 })
      const page1 = await waitFor(() => c.messages.find((m) => m.type === 'principal_events_page' && m.requestId === 'p1'))
      assert.deepEqual(page1.events.map((e) => e.seq), range(1, 200))
      assert.equal(page1.more, true)
      assert.equal(page1.headSeq, 250)
      assert.deepEqual(page1.cursor, { sessionId: 'sess-1', journalId: page1.journalId, seq: 200 })
      c.send({ type: 'principal_events_read', requestId: 'p2', sessionId: 'sess-1', cursor: page1.cursor, limit: 200 })
      const page2 = await waitFor(() => c.messages.find((m) => m.type === 'principal_events_page' && m.requestId === 'p2'))
      assert.deepEqual(page2.events.map((e) => e.seq), range(201, 250))
      assert.equal(page2.more, false)
      assert.equal(page2.gap, undefined)
      // limit above the cap never produces a bigger page
      c.send({ type: 'principal_events_read', requestId: 'p3', sessionId: 'sess-1', limit: 201 })
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(c.messages.some((m) => m.type === 'principal_events_page' && m.requestId === 'p3' && m.events.length > 200), false)
    })

    it('a read with a stale journal id reports the gap and serves the retained window', async () => {
      const { port, token, journal } = await boot()
      const c = await open(port, token)
      for (let i = 1; i <= 3; i++) say('sess-1', i)
      journal.resetSession('sess-1')
      say('sess-1', 4)
      c.send({ type: 'principal_events_read', requestId: 'r', sessionId: 'sess-1', cursor: { sessionId: 'sess-1', journalId: 'old', seq: 3 } })
      const page = await waitFor(() => c.messages.find((m) => m.type === 'principal_events_page'))
      assert.deepEqual(page.gap, { reason: 'unknown_cursor' })
      assert.deepEqual(page.events.map((e) => e.seq), [1])
    })

    it('with no journal the read path refuses (nothing is invented), even for a granted session', async () => {
      const { port, token } = await boot({ withJournal: false })
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      c.send({ type: 'principal_events_read', requestId: 'r2', sessionId: 'sess-1' })
      await waitFor(() => c.messages.filter((m) => m.type === 'session_error').length === 2)
      assert.equal(c.messages.every((m) => m.code === 'scope_denied'), true)
    })
  })

  describe('what the journal holds', () => {
    it('thinking and raw PTY are never journaled, and the floored result is a placeholder', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      server._broadcastToSession('sess-1', { type: 'terminal_output', data: 'RAW PTY BYTES' })
      server._broadcastToSession('sess-1', { type: 'stream_start', messageId: 'th', thinking: true })
      server._broadcastToSession('sess-1', { type: 'stream_delta', messageId: 'th', delta: 'PRIVATE THINKING' })
      server._broadcastToSession('sess-1', { type: 'stream_end', messageId: 'th' })
      server._broadcastToSession('sess-1', { type: 'permission_request', requestId: 'r1', tool: 'Read', input: {}, floored: true, toolUseId: 'tu1' })
      server._broadcastToSession('sess-1', { type: 'tool_start', toolUseId: 'tu1', tool: 'Read', input: { file_path: '/home/u/.env' } })
      server._broadcastToSession('sess-1', { type: 'tool_result', toolUseId: 'tu1', result: 'API_KEY=hunter2-the-real-secret' })
      c.send({ type: 'principal_events_read', requestId: 'r', sessionId: 'sess-1' })
      const page = await waitFor(() => c.messages.find((m) => m.type === 'principal_events_page'))
      const wire = JSON.stringify(page)
      for (const leaked of ['RAW PTY BYTES', 'PRIVATE THINKING', 'hunter2-the-real-secret']) assert.equal(wire.includes(leaked), false, leaked)
      assert.deepEqual(page.events.map((e) => e.eventType), ['permission_request', 'tool_start', 'tool_result'])
      assert.equal(page.events[2].data.result, FLOORED_RESULT_PLACEHOLDER)
    })

    it('the delivered frame shares nothing with the journal: changing it cannot change the stored event', async () => {
      const { port, token, journal } = await boot()
      const c = await open(port, token)
      say('sess-1', 1, { nested: { a: [1, 2, 3] } })
      c.send({ type: 'principal_events_read', requestId: 'r', sessionId: 'sess-1' })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_events_page'))
      const stored = journal.readFrom('sess-1', 0, 10).events[0]
      assert.equal(Object.isFrozen(stored.data) && Object.isFrozen(stored.data.nested) && Object.isFrozen(stored.data.nested.a), true, 'the stored event is deep-frozen')
      const { frameForPrincipal } = await import('../src/principal-policy.js')
      const record = [...server.clients.values()].find((r) => r.principal)
      const delivered = frameForPrincipal(record, { type: 'principal_event', sessionId: 'sess-1', seq: 1, data: stored.data, journalId: 'j', ts: 1, eventType: 'message' }, server._principalPolicyOpts())
      assert.notEqual(delivered.data, stored.data)
      assert.notEqual(delivered.data.nested.a, stored.data.nested.a)
      delivered.data.nested.a.push(4) // the copy is the recipient's to change
      assert.deepEqual(stored.data.nested.a, [1, 2, 3])
    })
  })

  describe('isolation: the read path is the ONLY thing a principal receives', () => {
    it('a subscribed principal gets no ordinary session broadcast of any kind; a host client still does', async () => {
      const { port, token } = await boot()
      const c = await open(port, token)
      const host = await open(port, PRIMARY)
      c.send({ type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'))
      // the host client is on the session so it is a recipient of session broadcasts
      host.send({ type: 'switch_session', sessionId: 'sess-1' })
      await waitFor(() => host.messages.find((m) => m.type === 'session_switched'), { label: 'host switched' })
      c.messages.length = 0
      host.messages.length = 0
      const ordinary = [
        { type: 'stream_start', messageId: 'a' }, { type: 'stream_delta', messageId: 'a', delta: 'hello' },
        { type: 'stream_end', messageId: 'a' }, { type: 'tool_start', toolUseId: 't', tool: 'Read', input: {} },
        { type: 'terminal_output', data: 'pty' }, { type: 'session_activity', isBusy: true },
        { type: 'cost_update', sessionCost: 1 }, { type: 'user_input', text: 'secret prompt' },
      ]
      for (const m of ordinary) server._broadcastToSession('sess-1', m)
      server.broadcast({ type: 'server_status', message: 'host-wide' })
      await waitFor(() => host.messages.length >= ordinary.length, { label: 'host receives the ordinary frames' })
      await new Promise((r) => setTimeout(r, 100))
      const allowed = new Set(['principal_event', 'principal_gap', 'principal_live_fence', 'principal_subscribed', 'principal_events_page'])
      const stray = c.messages.filter((m) => !allowed.has(m.type))
      assert.deepEqual(stray.map((m) => m.type), [], 'only principal_* frames reach a principal')
      assert.equal(host.messages.some((m) => m.type === 'stream_delta'), true, 'positive control: the host client got the ordinary broadcast')
      assert.deepEqual(Object.keys(PRINCIPAL_BROADCAST_ALLOWED), [], 'the broadcast allowlist is still empty')
      assert.equal([...server._clientManager.getSessionSubscribers('sess-1')].some((cl) => cl.principal), false, 'the principal is not on the session index')
    })

    it('a primary client that sends a principal_* request is refused and the journal is untouched', async () => {
      const { port, journal } = await boot()
      const host = await open(port, PRIMARY)
      say('sess-1', 1)
      host.send({ type: 'principal_subscribe', requestId: 'h', sessionIds: ['sess-1'] })
      host.send({ type: 'principal_events_read', requestId: 'h2', sessionId: 'sess-1' })
      await waitFor(() => host.messages.filter((m) => m.type === 'session_error').length === 2)
      assert.equal(host.messages.filter((m) => m.type === 'session_error').every((m) => m.code === 'scope_denied'), true)
      assert.equal(server._principalSubscriptions.size, 0)
      assert.equal(journal.head('sess-1').headSeq, 1, 'only the one broadcast the test made is journaled (the refused requests wrote nothing)')
    })

    it('a principal frame never reaches a non-principal client, and a host client is byte-identical with the journal present', async () => {
      const { port } = await boot()
      const host = await open(port, PRIMARY)
      host.send({ type: 'switch_session', sessionId: 'sess-1' })
      await waitFor(() => host.messages.find((m) => m.type === 'session_switched'))
      host.messages.length = 0
      server._broadcastToSession('sess-1', { type: 'message', messageType: 'response', content: 'hi' })
      const got = await waitFor(() => host.messages.find((m) => m.type === 'message' && m.content === 'hi'))
      assert.deepEqual(got, { type: 'message', messageType: 'response', content: 'hi', sessionId: 'sess-1' }, 'exactly the broadcast, with no journal field added')
      assert.equal(host.messages.some((m) => String(m.type).startsWith('principal_')), false)
    })
  })
})
