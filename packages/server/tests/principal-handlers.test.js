/**
 * The principal journal handlers called DIRECTLY (principal-handlers.js), dispatch bypassed:
 * each refuses on its own, the way tests/principal-policy.test.js proves it for the S2 types.
 * Plus the subscription manager's slow-consumer rule with a fake socket (principal-subscriptions.js).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REAL_HANDLERS, principalClient, plainCtx } from './principal-test-helpers.js'
import { PrincipalJournal } from '../src/principal-journal.js'
import { PrincipalSubscriptions } from '../src/principal-subscriptions.js'
import { PRINCIPAL_ALLOWED_MESSAGE_TYPES } from '../src/principal-policy.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

const SESSIONS = { 'sess-1': { cwd: '/tmp/a' }, other: { cwd: '/tmp/b' } }
const OBSERVE = Object.entries(PRINCIPAL_ALLOWED_MESSAGE_TYPES).filter(([, v]) => v.tier === 'observe').map(([k]) => k)

const FIXTURES = {
  principal_subscribe: { type: 'principal_subscribe', requestId: 'r1', sessionIds: ['sess-1'] },
  principal_events_read: { type: 'principal_events_read', requestId: 'r1', sessionId: 'sess-1' },
}

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-journal-h-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function ctxWith({ journal = null, subs = null } = {}) {
  const made = plainCtx({ sessions: SESSIONS })
  made.ctx.services = { principalJournal: journal, principalSubscriptions: subs }
  return made
}

function logs(fn) {
  const lines = []
  const l = (e) => lines.push(e.message)
  addLogListener(l)
  try { fn() } finally { removeLogListener(l) }
  return lines
}

const spySubs = () => {
  const calls = []
  return { calls, subscribe: (r) => calls.push(['subscribe', r]), unsubscribe: (...a) => calls.push(['unsubscribe', ...a]), size: 0 }
}

describe('the observe types are covered by this file', () => {
  it('every observe-tier allowed type is exercised below (so none can be skipped)', () => {
    assert.deepEqual([...OBSERVE].sort(), ['principal_events_read', 'principal_subscribe', 'principal_unsubscribe'])
    for (const t of OBSERVE) assert.equal(typeof REAL_HANDLERS[t], 'function', t)
  })
})

describe('refused by the handler on its own', () => {
  for (const type of Object.keys(FIXTURES)) {
    it(`${type}: a principal with no grant for the session is refused (scope), with no journal read and no subscription`, () => {
      const subs = spySubs()
      const journal = { resolveCursor: () => { throw new Error('journal touched') }, readFrom: () => { throw new Error('journal touched') } }
      const { ctx, sent } = ctxWith({ journal, subs })
      const client = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['other'] } } })
      const lines = logs(() => REAL_HANDLERS[type]({}, client, FIXTURES[type], ctx))
      assert.equal(sent.length, 1)
      assert.equal(sent[0].code, 'scope_denied')
      assert.deepEqual(subs.calls, [])
      assert.ok(lines.some((l) => l.includes('(scope)')), lines.join('|'))
    })

    it(`${type}: a session that does not exist is the same refusal as one that is not granted`, () => {
      const a = ctxWith({ journal: {}, subs: spySubs() })
      const b = ctxWith({ journal: {}, subs: spySubs() })
      const notGranted = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['other'] } } })
      const ghost = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['ghost'] } } })
      REAL_HANDLERS[type]({}, notGranted, FIXTURES[type], a.ctx)
      REAL_HANDLERS[type]({}, ghost, FIXTURES[type], b.ctx)
      assert.deepEqual(a.sent, b.sent)
    })

    it(`${type}: the target is the explicit session id, never the active session`, () => {
      const subs = spySubs()
      const { ctx, sent } = ctxWith({ journal: {}, subs })
      const client = principalClient({ activeSessionId: 'sess-1', principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } })
      const msg = { ...FIXTURES[type] }
      delete msg.sessionId
      delete msg.sessionIds
      REAL_HANDLERS[type]({}, client, msg, ctx)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].code, 'scope_denied')
      assert.deepEqual(subs.calls, [])
    })

    it(`${type}: a client that is not a principal is refused without touching the journal`, () => {
      const subs = spySubs()
      const { ctx, sent } = ctxWith({ journal: { resolveCursor: () => { throw new Error('touched') } }, subs })
      REAL_HANDLERS[type]({}, { id: 'host', isPrimaryToken: true, boundSessionId: null }, FIXTURES[type], ctx)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].code, 'scope_denied')
      assert.deepEqual(subs.calls, [])
    })

    it(`${type}: a granted principal with no journal wired gets a refusal, not an invented history`, () => {
      const { ctx, sent } = ctxWith({ journal: null, subs: null })
      const client = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } })
      const lines = logs(() => REAL_HANDLERS[type]({}, client, FIXTURES[type], ctx))
      assert.equal(sent[0].code, 'scope_denied')
      assert.ok(lines.some((l) => l.includes('(not_available)')))
    })
  }

  it('principal_subscribe: every id is checked, in order, before anything is subscribed (all-or-nothing)', () => {
    const subs = spySubs()
    const { ctx, sent } = ctxWith({ journal: {}, subs })
    const client = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } })
    REAL_HANDLERS.principal_subscribe({}, client, { type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1', 'other'] }, ctx)
    assert.equal(sent[0].code, 'scope_denied')
    assert.deepEqual(subs.calls, [])
    // positive control: the granted id alone is subscribed
    REAL_HANDLERS.principal_subscribe({}, client, { type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] }, ctx)
    assert.equal(subs.calls.length, 1)
    assert.deepEqual(subs.calls[0][1].sessions, [{ sessionId: 'sess-1', cursor: null }])
  })

  it('principal_subscribe: duplicate ids, a cursor for a session not named and a second cursor are malformed requests', () => {
    const subs = spySubs()
    const { ctx, sent } = ctxWith({ journal: {}, subs })
    const client = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['sess-1', 'other'] } } })
    const base = { type: 'principal_subscribe', requestId: 'r', sessionIds: ['sess-1'] }
    const c = (sessionId) => ({ sessionId, journalId: 'j', seq: 1 })
    for (const msg of [
      { ...base, sessionIds: ['sess-1', 'sess-1'] },
      { ...base, cursors: [c('other')] },
      { ...base, cursors: [c('sess-1'), c('sess-1')] },
      { ...base, cursors: [null] },
      { ...base, sessionIds: [] },
      { ...base, requestId: '' },
    ]) {
      sent.length = 0
      REAL_HANDLERS.principal_subscribe({}, client, msg, ctx)
      assert.equal(sent[0].code, 'scope_denied', JSON.stringify(msg))
    }
    assert.deepEqual(subs.calls, [])
  })
})

describe('principal_unsubscribe', () => {
  it('stops only the caller\'s own subscriptions, needs no grant and names nothing it could leak', () => {
    const subs = spySubs()
    const { ctx, sent } = ctxWith({ journal: {}, subs })
    const client = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } })
    REAL_HANDLERS.principal_unsubscribe({}, client, { type: 'principal_unsubscribe', sessionIds: ['sess-1', 'not-mine', 'ghost'] }, ctx)
    REAL_HANDLERS.principal_unsubscribe({}, client, { type: 'principal_unsubscribe' }, ctx)
    assert.deepEqual(sent, [], 'no reply that could tell a granted id from any other')
    assert.deepEqual(subs.calls, [['unsubscribe', client, ['sess-1', 'not-mine', 'ghost']], ['unsubscribe', client, null]])
  })

  it('a client that is not a principal is refused and touches nothing', () => {
    const subs = spySubs()
    const { ctx, sent } = ctxWith({ journal: {}, subs })
    REAL_HANDLERS.principal_unsubscribe({}, { id: 'host', isPrimaryToken: true }, { type: 'principal_unsubscribe' }, ctx)
    assert.equal(sent[0].code, 'scope_denied')
    assert.deepEqual(subs.calls, [])
  })
})

describe('principal_events_read through the handler', () => {
  function journalWith(n) {
    const journal = new PrincipalJournal({ dir, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    for (let i = 1; i <= n; i++) journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: `m${i}` })
    return journal
  }
  const granted = () => principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } })

  it('clamps any limit to 200, defaults to 50, and never returns a negative or zero page', () => {
    const journal = journalWith(260)
    const run = (limit) => {
      const { ctx, sent } = ctxWith({ journal })
      REAL_HANDLERS.principal_events_read({}, granted(), { type: 'principal_events_read', requestId: 'r', sessionId: 'sess-1', ...(limit === undefined ? {} : { limit }) }, ctx)
      return sent[0]
    }
    assert.equal(run(5000).events.length, 200)
    assert.equal(run(200).events.length, 200)
    assert.equal(run(undefined).events.length, 50)
    assert.equal(run(0).events.length, 1)
    assert.equal(run(-4).events.length, 1)
    assert.equal(run(3).events.length, 3)
  })

  it('every page frame is one of the declared shape', () => {
    const journal = journalWith(3)
    const { ctx, sent } = ctxWith({ journal })
    REAL_HANDLERS.principal_events_read({}, granted(), { type: 'principal_events_read', requestId: 'rq', sessionId: 'sess-1' }, ctx)
    const page = sent[0]
    assert.deepEqual(Object.keys(page).sort(), ['cursor', 'events', 'headSeq', 'journalId', 'more', 'requestId', 'sessionId', 'type'])
    assert.deepEqual(page.cursor, { sessionId: 'sess-1', journalId: page.journalId, seq: 3 })
    assert.equal(page.more, false)
  })
})

describe('a slow consumer ends the subscription instead of buffering without bound', () => {
  it('past the backpressure threshold a live event ends it with a gap; the replay waits for the socket to drain', async () => {
    const journal = new PrincipalJournal({ dir, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    for (let i = 1; i <= 5; i++) journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: `m${i}` })
    const sent = []
    const ws = { bufferedAmount: 0 }
    const subs = new PrincipalSubscriptions({ journal, send: (_w, f) => sent.push(f), backpressureBytes: 1000, sleepFn: async () => {} })
    const client = principalClient()
    subs.subscribe({ ws, client, requestId: 'r', sessions: [{ sessionId: 'sess-1', cursor: null }] })
    await new Promise((r) => setImmediate(r))
    assert.ok(sent.some((f) => f.type === 'principal_live_fence'))
    ws.bufferedAmount = 5000
    journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: 'live' })
    const gap = sent.find((f) => f.type === 'principal_gap')
    assert.deepEqual({ reason: gap.reason, ended: gap.ended }, { reason: 'backpressure', ended: true })
    assert.equal(subs.size, 0)
    assert.equal(sent.some((f) => f.type === 'principal_event' && f.journalSeq === 6), false)
  })

  it('a replay to a socket that never drains ends with a backpressure gap', async () => {
    const journal = new PrincipalJournal({ dir, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    for (let i = 1; i <= 10; i++) journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: `m${i}` })
    const sent = []
    const ws = { bufferedAmount: 5000 }
    const subs = new PrincipalSubscriptions({ journal, send: (_w, f) => sent.push(f), backpressureBytes: 1000, replayBatch: 3, sleepFn: async () => {}, yieldFn: async () => {} })
    subs.subscribe({ ws, client: principalClient(), requestId: 'r', sessions: [{ sessionId: 'sess-1', cursor: null }] })
    await new Promise((r) => setTimeout(r, 20))
    const gap = sent.find((f) => f.type === 'principal_gap')
    assert.equal(gap?.reason, 'backpressure')
    assert.equal(sent.some((f) => f.type === 'principal_live_fence'), false)
  })

  it('a journal reset ends the subscription with the reset reason; a removed session ends it silently', async () => {
    const journal = new PrincipalJournal({ dir, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: 'a' })
    journal.record({ type: 'message', sessionId: 'sess-2', messageType: 'response', content: 'b' })
    const sent = []
    const subs = new PrincipalSubscriptions({ journal, send: (_w, f) => sent.push(f) })
    subs.subscribe({ ws: {}, client: principalClient(), requestId: 'r', sessions: [{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }] })
    await new Promise((r) => setImmediate(r))
    sent.length = 0
    journal.resetSession('sess-1')
    journal.removeSession('sess-2')
    assert.deepEqual(sent.map((f) => [f.type, f.reason, f.ended]), [['principal_gap', 'journal_reset', true]])
    assert.equal(subs.size, 0)
  })
})
