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
import { frameForPrincipal } from '../src/principal-policy.js'
import { writeDurableFile } from '../src/durable-write.js'
import { PrincipalSubscriptions } from '../src/principal-subscriptions.js'
import { PRINCIPAL_ALLOWED_MESSAGE_TYPES } from '../src/principal-policy.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { principalDispatchRefusal, refusePrincipalMessage, sendPrincipalRefusal, PRINCIPAL_ENVELOPES } from '../src/principal-policy.js'
import {
  PRINCIPAL_SNAPSHOT_REQUEST_ID_MAX, PRINCIPAL_SNAPSHOT_SESSION_IDS_MAX, PRINCIPAL_SNAPSHOT_SESSION_ID_MAX,
} from '../src/handlers/principal-handlers.js'
import { PrincipalPendingPermissionsSchema, PrincipalSessionsSnapshotSchema } from '@chroxy/protocol'

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
    assert.deepEqual([...OBSERVE].sort(), ['principal_events_read', 'principal_pending_permissions', 'principal_sessions_snapshot', 'principal_subscribe', 'principal_unsubscribe'])
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

  it('a journal reset ends the subscription with the reset reason; a removed session ends it with the removed reason', async () => {
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
    assert.deepEqual(sent.map((f) => [f.type, f.sessionId, f.reason, f.ended]), [['principal_gap', 'sess-1', 'journal_reset', true], ['principal_gap', 'sess-2', 'removed', true]])
    assert.equal(subs.size, 0)
  })
})

describe('a new journal id ends every affected subscription (#9118 round 2)', () => {
  const NO_TIMERS = { setTimeout: () => null, clearTimeout: () => {} }
  function deadJournal() {
    let mode = 'ok'
    let t = 1_800_000_000_000
    const journal = new PrincipalJournal({
      dir, now: () => t, timers: NO_TIMERS, reservationStep: 2, retryBackoffMs: 100,
      writeDurable: (path, data) => { if (mode === 'throw') throw new Error('ENOSPC'); return writeDurableFile(path, data) },
    })
    const say = (n) => journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: `m${n}` })
    return { journal, say, fail: () => { mode = 'throw' }, heal: () => { mode = 'ok'; t += 101 } }
  }

  it('subscribed during the dead window, then recovered: ended restart_loss, and no old-id frame carries the new journal\'s seq', async () => {
    const { journal, say, fail, heal } = deadJournal()
    say(1); say(2)
    fail(); say(3) // dead
    const sent = []
    const subs = new PrincipalSubscriptions({ journal, send: (_w, f) => sent.push(f) })
    subs.subscribe({ ws: {}, client: principalClient(), requestId: 'r', sessions: [{ sessionId: 'sess-1' }] })
    await new Promise((r) => setImmediate(r))
    const oldId = journal.head('sess-1').journalId
    heal(); say(4) // recovery: a NEW journal id, seq 1
    assert.notEqual(journal.head('sess-1').journalId, oldId)
    const gap = sent.find((f) => f.type === 'principal_gap')
    assert.deepEqual({ reason: gap.reason, ended: gap.ended }, { reason: 'restart_loss', ended: true })
    const gapAt = sent.indexOf(gap)
    assert.equal(sent.slice(gapAt + 1).some((f) => f.type === 'principal_event'), false, 'nothing is delivered after the end')
    assert.equal(sent.some((f) => f.type === 'principal_event' && !f.replay), false, 'the new journal\'s seq 1 was never stamped with the old id as a live event')
    assert.equal(subs.size, 0)
  })

  it('a replay that is still running when the id changes is ended, not left hung with a leaked listener', async () => {
    const { journal, say, fail, heal } = deadJournal()
    say(1); say(2)
    const sent = []
    let yields = 0
    const subs = new PrincipalSubscriptions({
      journal, send: (_w, f) => sent.push(f), replayBatch: 1,
      yieldFn: async () => { if (++yields === 1) { fail(); say(3); heal(); say(4) } },
    })
    subs.subscribe({ ws: {}, client: principalClient(), requestId: 'r', sessions: [{ sessionId: 'sess-1' }] })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(sent.some((f) => f.type === 'principal_gap' && f.reason === 'restart_loss' && f.ended === true), true)
    assert.equal(sent.some((f) => f.type === 'principal_live_fence'), false)
    assert.equal(subs.size, 0)
    assert.equal(journal._sessions.get('sess-1').listeners.size, 0, 'no listener leaked')
  })
})

describe('the replay loop itself refuses a journal id that moved under it (#9118 round 2)', () => {
  it('a mismatch seen by the pump (the listener having missed it) ends the subscription and frees its listener', async () => {
    const journal = new PrincipalJournal({ dir, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    for (let i = 1; i <= 5; i++) journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: `m${i}` })
    const sent = []
    const client = principalClient()
    let subs
    subs = new PrincipalSubscriptions({
      journal, send: (_w, f) => sent.push(f), replayBatch: 1,
      yieldFn: async () => { subs._byClient.get(client).get('sess-1').journalId = 'a-different-id' },
    })
    subs.subscribe({ ws: {}, client, requestId: 'r', sessions: [{ sessionId: 'sess-1' }] })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(sent.some((f) => f.type === 'principal_gap' && f.reason === 'restart_loss' && f.ended === true), true)
    assert.equal(subs.size, 0)
    assert.equal(journal._sessions.get('sess-1').listeners.size, 0)
  })
})

describe('a subscription is never dropped silently (#9118 round 2)', () => {
  const NO_TIMERS = { setTimeout: () => null, clearTimeout: () => {} }
  async function live(maySee) {
    const journal = new PrincipalJournal({ dir, timers: NO_TIMERS })
    journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: 'a' })
    const sent = []
    const subs = new PrincipalSubscriptions({ journal, send: (_w, f) => sent.push(f), maySee })
    subs.subscribe({ ws: {}, client: principalClient(), requestId: 'r', sessions: [{ sessionId: 'sess-1' }] })
    await new Promise((r) => setImmediate(r))
    sent.length = 0
    return { journal, subs, sent }
  }

  it('a grant that no longer covers the session ends it with reason scope', async () => {
    let may = true
    const { journal, subs, sent } = await live(() => may)
    may = false
    journal.record({ type: 'message', sessionId: 'sess-1', messageType: 'response', content: 'b' })
    assert.deepEqual(sent.map((f) => [f.type, f.reason, f.ended]), [['principal_gap', 'scope', true]])
    assert.equal(subs.size, 0)
  })

  it('a removed session ends it with reason removed', async () => {
    const { journal, subs, sent } = await live(() => true)
    journal.removeSession('sess-1')
    assert.deepEqual(sent.map((f) => [f.type, f.reason, f.ended]), [['principal_gap', 'removed', true]])
    assert.equal(subs.size, 0)
  })

  it('the end notice is deliverable although the session can no longer be seen; no other gap is', () => {
    const client = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: [] } } })
    const opts = { sessionExists: () => false }
    const notice = (reason, ended) => frameForPrincipal(client, { type: 'principal_gap', sessionId: 'sess-1', journalId: 'j', reason, ended }, opts)
    assert.ok(notice('scope', true))
    assert.ok(notice('removed', true))
    assert.equal(notice('scope', false), null)
    assert.equal(notice('held_overflow', true), null)
    assert.equal(notice('evicted', true), null)
  })
})

// The frame dispatch sends for the same message: refusePrincipalMessage itself where dispatch
// decides (an extra key), and the shared sender with the envelope reason where only the schema
// layer caps a value.
function dispatchRefusalFrame(client, msg) {
  const { ctx, sent } = ctxWith()
  if (!refusePrincipalMessage({}, client, msg, ctx)) sendPrincipalRefusal({}, client, msg, ctx, 'envelope')
  return sent[0]
}

// Contract 4.1.1: the closed envelope is checked at the handler as well as at dispatch.
describe('the snapshot handlers check the request envelope on their own', () => {
  const SNAPSHOT_TYPES = ['principal_pending_permissions', 'principal_sessions_snapshot']
  const grantedClient = () => principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } })
  const run = (type, msg) => {
    const { ctx, sent } = ctxWith()
    REAL_HANDLERS[type]({}, grantedClient(), { type, ...msg }, ctx)
    return sent
  }

  for (const type of SNAPSHOT_TYPES) {
    it(`${type}: exactly the allowed fields (positive control) is answered, not refused`, () => {
      assert.deepEqual([...PRINCIPAL_ENVELOPES[type].fields].sort(), ['requestId', 'sessionIds', 'type'])
      const sent = run(type, { requestId: 'r1', sessionIds: ['sess-1'] })
      assert.equal(sent.length, 1)
      assert.notEqual(sent[0].type, 'session_error', JSON.stringify(sent[0]))
      assert.equal(sent[0].requestId, 'r1')
    })

    for (const [label, msg] of [
      ['an extra key', { requestId: 'r1', sessionIds: ['sess-1'], cwd: '/x' }],
      ['an extra key with ids omitted', { requestId: 'r1', limit: 5 }],
      ['an oversized requestId', { requestId: 'r'.repeat(PRINCIPAL_SNAPSHOT_REQUEST_ID_MAX + 1), sessionIds: ['sess-1'] }],
      ['too many ids', { requestId: 'r1', sessionIds: Array.from({ length: PRINCIPAL_SNAPSHOT_SESSION_IDS_MAX + 1 }, (_, i) => `s${i}`) }],
      ['an oversized id', { requestId: 'r1', sessionIds: ['s'.repeat(PRINCIPAL_SNAPSHOT_SESSION_ID_MAX + 1)] }],
      ['non-array ids', { requestId: 'r1', sessionIds: 'sess-1' }],
      ['ids that are not all strings', { requestId: 'r1', sessionIds: ['sess-1', 7] }],
    ]) {
      it(`${type}: ${label} is refused scope_denied, byte for byte as dispatch refuses it`, () => {
        const full = { type, ...msg }
        // Dispatch's own verdict, for the cases it decides on its own (keys); the rest are the Zod layer's.
        if (label.startsWith('an extra key')) assert.equal(principalDispatchRefusal(grantedClient(), full), 'envelope')
        const sent = run(type, msg)
        assert.equal(sent.length, 1)
        assert.equal(sent[0].type, 'session_error')
        assert.equal(sent[0].code, 'scope_denied')
        assert.equal(JSON.stringify(sent[0]), JSON.stringify(dispatchRefusalFrame(grantedClient(), full)))
      })
    }
  }

  it('the handler caps are the protocol schemas\' own boundaries', () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => `s${i}`)
    for (const [Schema, type] of [[PrincipalPendingPermissionsSchema, 'principal_pending_permissions'], [PrincipalSessionsSnapshotSchema, 'principal_sessions_snapshot']]) {
      const ok = (extra) => Schema.safeParse({ type, requestId: 'r', ...extra }).success
      assert.equal(ok({ requestId: 'r'.repeat(PRINCIPAL_SNAPSHOT_REQUEST_ID_MAX) }), true, type)
      assert.equal(ok({ requestId: 'r'.repeat(PRINCIPAL_SNAPSHOT_REQUEST_ID_MAX + 1) }), false, type)
      assert.equal(ok({ sessionIds: ids(PRINCIPAL_SNAPSHOT_SESSION_IDS_MAX) }), true, type)
      assert.equal(ok({ sessionIds: ids(PRINCIPAL_SNAPSHOT_SESSION_IDS_MAX + 1) }), false, type)
      assert.equal(ok({ sessionIds: ['s'.repeat(PRINCIPAL_SNAPSHOT_SESSION_ID_MAX)] }), true, type)
      assert.equal(ok({ sessionIds: ['s'.repeat(PRINCIPAL_SNAPSHOT_SESSION_ID_MAX + 1)] }), false, type)
    }
  })
})
