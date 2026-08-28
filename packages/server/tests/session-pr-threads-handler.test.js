import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionPrThreadsHandlers,
  NOT_AUTHORIZED_REASON,
  NO_SESSION_REASON,
  IN_PROGRESS_REASON,
  RATE_LIMITED_REASON,
  COUNT_MIN_INTERVAL_MS,
} from '../src/handlers/session-pr-threads-handlers.js'
import { registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy, createMockSessionManager, nsCtx } from './test-helpers.js'
import { ServerSessionPrThreadsSchema } from '@chroxy/protocol'

/**
 * Tests for the `session_pr_threads_request` handler (#7430).
 *
 * Same three properties the sibling `session_pr_status_request` handler holds,
 * for the same reasons (docs/security/bearer-token-authority.md §4):
 *
 *   - EVERY path replies with exactly one schema-valid `session_pr_threads`. A
 *     path that replied with nothing leaves a caller unable to distinguish
 *     "still counting" from "never answered".
 *   - The authority check runs BEFORE the session lookup, so a bound client
 *     cannot use the reply to probe which session ids exist.
 *   - Every degraded reply carries a `reason` and a NULL count. A refusal that
 *     came back as `unresolvedCount: 0` would be indistinguishable from a real
 *     zero, which is the false green this whole surface exists to prevent.
 *
 * Plus one of its own: the read spawns a `gh` subprocess per click, so it is
 * throttled per session, and a throttled request REPLAYS the last count rather
 * than degrading (a degraded reply would blank a count the user is looking at).
 */

const SAMPLE = {
  sessionId: 'sess-1',
  countedAt: '2026-08-28T00:00:00.000Z',
  prNumber: 7419,
  unresolvedCount: 2,
  totalCount: 9,
  truncated: false,
  reason: null,
}

function makeCtx(overrides = {}) {
  const sendSpy = createSpy()
  const { manager } = createMockSessionManager([
    { id: 'sess-1', name: 'Work', cwd: '/repo' },
    { id: 'sess-2', name: 'Other', cwd: '/other' },
  ])
  // Counted, because "authority is checked BEFORE the lookup" is an ORDERING
  // claim and the same-reason oracle test below cannot witness it: both replies
  // would still be NOT_AUTHORIZED if the lookup ran first and its result were
  // discarded.
  const lookup = createSpy(manager.getSession)
  manager.getSession = lookup
  return nsCtx({
    send: sendSpy,
    sessionManager: manager,
    surveySessionPrThreads: createSpy(async () => SAMPLE),
    ...overrides,
    _send: sendSpy,
    _lookup: lookup,
  })
}

/** The single reply, asserted to be exactly one and schema-valid. */
function soleReply(ctx) {
  assert.equal(ctx._send.callCount, 1, 'every path must reply exactly once')
  const msg = ctx._send.calls[0][1]
  assert.equal(msg.type, 'session_pr_threads')
  const parsed = ServerSessionPrThreadsSchema.safeParse(msg)
  assert.ok(parsed.success, `reply rejected by schema: ${JSON.stringify(parsed.error?.issues)}`)
  return msg
}

/** Every degraded reply must be count-free, not count-zero. */
function assertDegraded(msg, reason) {
  assert.equal(msg.reason, reason)
  assert.equal(msg.unresolvedCount, null, 'a refusal must never look like a counted zero')
  assert.equal(msg.totalCount, null)
  assert.equal(msg.truncated, false)
}

const handler = sessionPrThreadsHandlers.session_pr_threads_request
const ws = {}
const req = { type: 'session_pr_threads_request', sessionId: 'sess-1' }

describe('#7430 — handler registration', () => {
  it('registers session_pr_threads_request in the ws handler registry', () => {
    assert.ok(registeredMessageTypes.includes('session_pr_threads_request'))
  })
})

describe('#7430 — the happy path', () => {
  it('surveys the requested session and replies with the count', async () => {
    const ctx = makeCtx()
    await handler(ws, { id: 'c1' }, { ...req, requestId: 'r1' }, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.requestId, 'r1')
    assert.equal(msg.sessionId, 'sess-1')
    assert.equal(msg.unresolvedCount, 2)
    assert.equal(msg.totalCount, 9)
    assert.equal(msg.countedAt, SAMPLE.countedAt)
    assert.equal(msg.reason, null)
    assert.deepEqual(ctx.surveySessionPrThreads.calls[0][0], { sessionId: 'sess-1', cwd: '/repo' })
  })

  it('falls back to the client\'s active session when no sessionId is given', async () => {
    const ctx = makeCtx()
    await handler(ws, { id: 'c1', activeSessionId: 'sess-2' }, { type: 'session_pr_threads_request' }, ctx)
    soleReply(ctx)
    assert.equal(ctx.surveySessionPrThreads.calls[0][0].cwd, '/other')
  })

  it('passes a genuine zero through as a zero', async () => {
    const zero = { ...SAMPLE, unresolvedCount: 0, totalCount: 4 }
    const ctx = makeCtx({ surveySessionPrThreads: createSpy(async () => zero) })
    await handler(ws, { id: 'c1' }, req, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.unresolvedCount, 0)
    assert.equal(msg.reason, null, 'a counted zero is not a degradation')
  })
})

describe('#7430 — authority and lookup', () => {
  it('refuses a bound client asking about another session, BEFORE the lookup', async () => {
    const ctx = makeCtx()
    await handler(ws, { id: 'c1', boundSessionId: 'sess-2' }, req, ctx)
    const msg = soleReply(ctx)
    assertDegraded(msg, NOT_AUTHORIZED_REASON)
    assert.equal(ctx._lookup.callCount, 0, 'the lookup must not run for an unauthorised client')
  })

  it('gives the SAME refusal for an unknown session id, so existence cannot be probed', async () => {
    const ctx = makeCtx()
    await handler(ws, { id: 'c1', boundSessionId: 'sess-1' }, { type: 'session_pr_threads_request', sessionId: 'nope' }, ctx)
    assertDegraded(soleReply(ctx), NOT_AUTHORIZED_REASON)
  })

  it('allows a bound client to ask about the session it is bound to', async () => {
    const ctx = makeCtx()
    await handler(ws, { id: 'c1', boundSessionId: 'sess-1' }, req, ctx)
    assert.equal(soleReply(ctx).unresolvedCount, 2)
  })

  it('replies NO_SESSION for an unknown session from an unbound client', async () => {
    const ctx = makeCtx()
    await handler(ws, { id: 'c1' }, { type: 'session_pr_threads_request', sessionId: 'nope' }, ctx)
    assertDegraded(soleReply(ctx), NO_SESSION_REASON)
  })

  it('replies NO_SESSION when no session id can be resolved at all', async () => {
    const ctx = makeCtx()
    await handler(ws, { id: 'c1' }, { type: 'session_pr_threads_request' }, ctx)
    assertDegraded(soleReply(ctx), NO_SESSION_REASON)
  })
})

describe('#7430 — failure paths still answer', () => {
  it('answers with a reason when the survey THROWS', async () => {
    const ctx = makeCtx({ surveySessionPrThreads: createSpy(async () => { throw new Error('boom') }) })
    await handler(ws, { id: 'c1' }, req, ctx)
    const msg = soleReply(ctx)
    assert.match(msg.reason, /boom/)
    assert.equal(msg.unresolvedCount, null)
  })

  it('bars a CONCURRENT count for the same client + session', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const ctx = makeCtx({ surveySessionPrThreads: createSpy(async () => { await gate; return SAMPLE }) })
    const client = { id: 'c1' }
    const p = handler(ws, client, { ...req, requestId: 'r1' }, ctx)
    await handler(ws, client, { ...req, requestId: 'r2' }, ctx)
    const refusal = ctx._send.calls[0][1]
    assert.equal(refusal.requestId, 'r2')
    assertDegraded(refusal, IN_PROGRESS_REASON)
    release()
    await p
  })

  it('releases the in-flight guard after a failure', async () => {
    let calls = 0
    const ctx = makeCtx({
      surveySessionPrThreads: createSpy(async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return SAMPLE
      }),
    })
    const client = { id: 'c1' }
    await handler(ws, client, req, ctx)
    await handler(ws, client, req, ctx)
    assert.equal(ctx._send.calls[1][1].unresolvedCount, 2, 'the guard must have been released')
  })
})

describe('#7430 — per-session throttle', () => {
  function throttleCtx(overrides = {}) {
    let now = 2_000_000
    const ctx = makeCtx({ _nowMs: () => now, ...overrides })
    return { ctx, advance: (ms) => { now += ms } }
  }

  it('is throttled at all — a bare click cannot fan out a gh subprocess per press', () => {
    assert.ok(COUNT_MIN_INTERVAL_MS > 0, 'the count spawns a subprocess; it must never be unthrottled')
  })

  it('replays the cached count on a back-to-back request instead of degrading', async () => {
    const { ctx } = throttleCtx()
    await handler(ws, { id: 'c1' }, { ...req, requestId: 'r1' }, ctx)
    await handler(ws, { id: 'c1' }, { ...req, requestId: 'r2' }, ctx)
    assert.equal(ctx._send.callCount, 2, 'a throttled request is still answered')
    const replay = ctx._send.calls[1][1]
    assert.ok(ServerSessionPrThreadsSchema.safeParse(replay).success)
    assert.equal(replay.requestId, 'r2', 'the replay answers THIS request')
    assert.equal(replay.reason, null, 'a cached good count must not be downgraded to a refusal')
    assert.equal(replay.unresolvedCount, 2)
    assert.equal(replay.countedAt, SAMPLE.countedAt, 'the replay is honest about when it was counted')
    assert.equal(ctx.surveySessionPrThreads.callCount, 1, 'no second subprocess ran')
  })

  it('degrades with RATE_LIMITED_REASON only before any count is cached', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { ctx } = throttleCtx({
      surveySessionPrThreads: createSpy(async () => { await gate; return SAMPLE }),
    })
    const p = handler(ws, { id: 'c1' }, { ...req, requestId: 'r1' }, ctx)
    await handler(ws, { id: 'c2' }, { ...req, requestId: 'r2' }, ctx)
    const refusal = ctx._send.calls[0][1]
    assert.equal(refusal.requestId, 'r2')
    assertDegraded(refusal, RATE_LIMITED_REASON)
    release()
    await p
  })

  it('POSITIVE CONTROL: past the interval the count is taken FRESH again', async () => {
    const { ctx, advance } = throttleCtx()
    await handler(ws, { id: 'c1' }, req, ctx)
    advance(COUNT_MIN_INTERVAL_MS + 1)
    await handler(ws, { id: 'c1' }, req, ctx)
    assert.equal(ctx.surveySessionPrThreads.callCount, 2, 'past the window the reply must be a fresh count')
    assert.equal(ctx._send.calls[1][1].reason, null)
  })

  it('throttles per SESSION — a second session is not refused on account of the first', async () => {
    const { ctx } = throttleCtx()
    await handler(ws, { id: 'c1' }, req, ctx)
    await handler(ws, { id: 'c1' }, { type: 'session_pr_threads_request', sessionId: 'sess-2' }, ctx)
    assert.equal(ctx.surveySessionPrThreads.callCount, 2)
  })

  it('applies across CLIENTS — a second client inside the window gets the cached count', async () => {
    const { ctx } = throttleCtx()
    await handler(ws, { id: 'c1' }, req, ctx)
    await handler(ws, { id: 'c2' }, req, ctx)
    assert.equal(ctx.surveySessionPrThreads.callCount, 1)
    assert.equal(ctx._send.calls[1][1].unresolvedCount, 2)
  })

  it('a replay does not EXTEND the window', async () => {
    const { ctx, advance } = throttleCtx()
    await handler(ws, { id: 'c1' }, req, ctx)
    advance(COUNT_MIN_INTERVAL_MS - 1000)
    await handler(ws, { id: 'c1' }, req, ctx)
    assert.equal(ctx.surveySessionPrThreads.callCount, 1, 'the mid-window request was a replay')
    advance(2000)
    await handler(ws, { id: 'c1' }, req, ctx)
    assert.equal(ctx.surveySessionPrThreads.callCount, 2, 'the replay must not have re-stamped the window')
  })

  it('a failed count rolls its stamp back so the retry is not refused for it', async () => {
    let calls = 0
    const { ctx } = throttleCtx({
      surveySessionPrThreads: createSpy(async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return SAMPLE
      }),
    })
    await handler(ws, { id: 'c1' }, req, ctx)
    await handler(ws, { id: 'c1' }, req, ctx)
    assert.equal(ctx.surveySessionPrThreads.callCount, 2, 'a throw spent no subprocess budget — the retry must be admitted')
    assert.equal(ctx._send.calls[1][1].unresolvedCount, 2)
  })

  it("a slow count's late failure cannot destroy a newer client's cache", async () => {
    let failA
    const gateA = new Promise((resolve, reject) => { failA = reject })
    let call = 0
    const { ctx, advance } = throttleCtx({
      surveySessionPrThreads: createSpy(async () => {
        call += 1
        if (call === 1) return gateA
        return SAMPLE
      }),
    })
    const pA = handler(ws, { id: 'cA' }, { ...req, requestId: 'rA' }, ctx)
    advance(COUNT_MIN_INTERVAL_MS + 1000)
    await handler(ws, { id: 'cB' }, { ...req, requestId: 'rB' }, ctx)
    failA(new Error('slow boom'))
    await pA
    await handler(ws, { id: 'cC' }, { ...req, requestId: 'rC' }, ctx)
    const last = ctx._send.calls[ctx._send.callCount - 1][1]
    assert.equal(last.requestId, 'rC')
    assert.equal(last.reason, null, "C must get B's cached count")
    assert.equal(ctx.surveySessionPrThreads.callCount, 2)
  })
})
