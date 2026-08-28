import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionPrStatusHandlers,
  NOT_AUTHORIZED_REASON,
  NO_SESSION_REASON,
  IN_PROGRESS_REASON,
} from '../src/handlers/session-pr-status-handlers.js'
import { registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy, createMockSessionManager, nsCtx } from './test-helpers.js'
import { ServerSessionPrStatusSchema } from '@chroxy/protocol'
import { SessionCiWatcher } from '../src/session-ci-watcher.js'

/**
 * Tests for the `session_pr_status_request` handler (#7344).
 *
 * The survey is injected via `ctx.surveySessionPrStatus` (the same seam the
 * Control Room handlers use for `ctx.surveyRepos`), so nothing here shells out
 * to real git/gh.
 *
 * Two properties carry most of the weight:
 *   - EVERY path replies with exactly one schema-valid `session_pr_status`. A
 *     path that replied with nothing would leave the chip spinning forever, and
 *     a caller cannot distinguish "still loading" from "never answered".
 *   - The authority check runs BEFORE the session lookup, so a bound client
 *     cannot use the reply to probe which session ids exist.
 *
 * #7427 adds a third: a successful survey is handed to `SessionCiWatcher.observe()`
 * on the way out, so opening the dashboard ARMS the CI watch. The watcher is
 * injected through `ctx.services.sessionCiWatcher`; the tests below pin that the
 * hand-off happens on exactly the path that surveyed, and — the real hazard —
 * that a throwing watcher cannot turn one reply into two.
 */

const SAMPLE = {
  sessionId: 'sess-1',
  generatedAt: '2026-08-27T00:00:00.000Z',
  branch: 'feat/x',
  repo: { owner: 'blamechris', name: 'chroxy' },
  pr: { number: 7419, title: 't', url: 'https://github.com/blamechris/chroxy/pull/7419', headRefOid: 'abc1234', isDraft: false },
  checks: { state: 'success', counts: { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0, unknown: 0 } },
  merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' },
  reason: null,
}

function makeCtx(overrides = {}) {
  const sendSpy = createSpy()
  const { manager } = createMockSessionManager([
    { id: 'sess-1', name: 'Work', cwd: '/repo' },
    { id: 'sess-2', name: 'Other', cwd: '/other' },
  ])
  return nsCtx({
    send: sendSpy,
    sessionManager: manager,
    surveySessionPrStatus: createSpy(async () => SAMPLE),
    ...overrides,
    _send: sendSpy,
  })
}

/** The single reply, asserted to be exactly one and schema-valid. */
function soleReply(ctx) {
  assert.equal(ctx._send.callCount, 1, 'every path must reply exactly once')
  const msg = ctx._send.calls[0][1]
  assert.equal(msg.type, 'session_pr_status')
  const parsed = ServerSessionPrStatusSchema.safeParse(msg)
  assert.ok(parsed.success, `reply rejected by schema: ${JSON.stringify(parsed.error?.issues)}`)
  return msg
}

describe('#7427 — the reply arms the CI watcher', () => {
  const handler = sessionPrStatusHandlers.session_pr_status_request
  const ws = {}
  const req = { type: 'session_pr_status_request', sessionId: 'sess-1' }

  it('hands the survey snapshot to observe(), so a dashboard pull arms the watch', async () => {
    const observe = createSpy(() => 'armed')
    const ctx = makeCtx({ sessionCiWatcher: { observe } })
    await handler(ws, { id: 'c1' }, req, ctx)
    soleReply(ctx)
    assert.equal(observe.callCount, 1)
    assert.deepEqual(observe.calls[0], ['sess-1', SAMPLE], 'observe(sessionId, snapshot), verbatim')
  })

  it('arms the session that was SURVEYED, not the one the client is sitting on', async () => {
    // The fallback path: no explicit sessionId, so the survey ran against the
    // client's active session. Arming any other id would watch the wrong repo.
    const observe = createSpy()
    const ctx = makeCtx({ sessionCiWatcher: { observe } })
    await handler(ws, { id: 'c1', activeSessionId: 'sess-2' }, { type: 'session_pr_status_request' }, ctx)
    soleReply(ctx)
    assert.equal(observe.calls[0][0], 'sess-2')
  })

  it('arms only AFTER the reply is on the wire', async () => {
    // The handler's doc block calls this order load-bearing, but the
    // "throwing observe still yields ONE reply" test below actually pins the
    // inner `try` — it stays green with the call moved ABOVE `send()`. Review on
    // #7432 confirmed that mutation survives the whole 94-test suite, so the
    // ordering gets its own assertion: read the send count AT call time.
    let sendsAtObserveTime = null
    const ctx = makeCtx({ sessionCiWatcher: { observe: () => { sendsAtObserveTime = ctx._send.callCount } } })
    await handler(ws, { id: 'c1' }, req, ctx)
    soleReply(ctx)
    assert.equal(sendsAtObserveTime, 1, 'the client must have its answer before the watcher is touched')
  })

  it('a watcher whose observe() THROWS still yields exactly ONE reply, and the real snapshot', async () => {
    // The hand-off runs AFTER send() and inside its own try. Left in the
    // survey's try instead, a throw here lands in the degraded-reply catch and
    // the client receives a SECOND `session_pr_status` for one request —
    // breaking the one-reply property every other test in this file rests on.
    const ctx = makeCtx({ sessionCiWatcher: { observe: () => { throw new Error('watcher exploded') } } })
    await handler(ws, { id: 'c1' }, req, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.reason, null, 'the reply must still be the survey, not a degraded one')
    assert.equal(msg.pr.number, 7419)
  })

  it('replies normally when no watcher is wired at all', async () => {
    // `sessionCi.watch: false` leaves ctx.services.sessionCiWatcher null, and an
    // older daemon has no such field. Absence is not an error.
    for (const watcher of [null, undefined, {}]) {
      const ctx = makeCtx({ sessionCiWatcher: watcher })
      await handler(ws, { id: 'c1' }, req, ctx)
      assert.equal(soleReply(ctx).reason, null)
    }
  })

  it('does not arm on any path that never surveyed', async () => {
    const cases = [
      ['unauthorised', { id: 'c1', boundSessionId: 'sess-1' }, { type: 'session_pr_status_request', sessionId: 'sess-2' }, {}],
      ['unknown session', { id: 'c1' }, { type: 'session_pr_status_request', sessionId: 'nope' }, {}],
      ['survey threw', { id: 'c1' }, req, { surveySessionPrStatus: createSpy(async () => { throw new Error('boom') }) }],
    ]
    for (const [label, client, msg, overrides] of cases) {
      const observe = createSpy()
      const ctx = makeCtx({ sessionCiWatcher: { observe }, ...overrides })
      await handler(ws, client, msg, ctx)
      soleReply(ctx)
      assert.equal(observe.callCount, 0, `${label}: nothing was surveyed, so there is nothing to arm`)
    }
  })

  it('END TO END: this handler arms a REAL watcher, and one sweep then fires exactly one event', async () => {
    // #7427's verification bar, verbatim: "Arm through the handler only (no
    // sweep), then let one sweep observe the settled state: exactly one event."
    //
    // Every other test here injects a fake `{ observe }`, which would stay green
    // against a real `observe()` that rejected the snapshot shape the survey
    // actually produces, or whose arguments were in the other order. This one
    // runs the production object.
    const counts = (o) => ({ total: 2, passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0, ...o })
    const PENDING = { ...SAMPLE, checks: { state: 'pending', counts: counts({ pending: 2 }) } }
    const SETTLED = { ...SAMPLE, checks: { state: 'success', counts: counts({ passed: 2 }) } }

    const events = []
    const watcher = new SessionCiWatcher({
      listSessions: () => [{ sessionId: 'sess-1', cwd: '/repo' }],
      survey: async () => SETTLED,
      notify: (e) => events.push(e),
      wakeAgent: false,
      logger: { debug() {}, info() {}, warn() {} },
    })
    const ctx = makeCtx({ sessionCiWatcher: watcher, surveySessionPrStatus: createSpy(async () => PENDING) })

    // The handler is the ONLY thing that has ever seen this run pending. Before
    // #7427 the sweep would not have surveyed this session for five minutes,
    // and a run finishing inside that window fired nothing at all.
    await handler(ws, { id: 'c1' }, req, ctx)
    soleReply(ctx)
    assert.equal(events.length, 0, 'the client-triggered path must not fire')

    await watcher.tick()
    assert.equal(events.length, 1, 'one sweep closes the transition the dashboard armed')
    assert.equal(events[0].verdict, 'success')
    assert.equal(events[0].prNumber, 7419)

    await watcher.tick()
    assert.equal(events.length, 1, 'and the arm is consumed — it cannot fire twice')
  })

  it('END TO END NEGATIVE: a handler observation of an ALREADY-settled PR fires nothing', async () => {
    // The honest half. Nothing watched this run start, so no sweep may announce
    // that it finished — otherwise every dashboard open replays the CI status of
    // every long-finished branch on the machine.
    const events = []
    const watcher = new SessionCiWatcher({
      listSessions: () => [{ sessionId: 'sess-1', cwd: '/repo' }],
      survey: async () => SAMPLE,
      notify: (e) => events.push(e),
      wakeAgent: false,
      logger: { debug() {}, info() {}, warn() {} },
    })
    // SAMPLE is already green (2 of 2 passed, nothing pending).
    const ctx = makeCtx({ sessionCiWatcher: watcher })
    await handler(ws, { id: 'c1' }, req, ctx)
    soleReply(ctx)
    await watcher.tick()
    await watcher.tick()
    assert.equal(events.length, 0)
  })

  it('POSITIVE CONTROL: the same ctx DOES arm on the path that surveyed', async () => {
    // Without this, the refusals above would be satisfied by a handler that
    // never calls observe() anywhere — including the one place it must.
    const observe = createSpy()
    const ctx = makeCtx({ sessionCiWatcher: { observe } })
    await handler(ws, { id: 'c1' }, req, ctx)
    assert.equal(observe.callCount, 1)
  })
})

describe('#7344 — session_pr_status_request handler', () => {
  let ctx, ws
  const handler = sessionPrStatusHandlers.session_pr_status_request

  beforeEach(() => {
    ctx = makeCtx()
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(registeredMessageTypes.includes('session_pr_status_request'))
    assert.equal(typeof handler, 'function')
  })

  it('replies with the survey snapshot for an unbound client, echoing requestId', async () => {
    await handler(ws, { id: 'c1' }, { type: 'session_pr_status_request', sessionId: 'sess-1', requestId: 'r1' }, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.requestId, 'r1')
    assert.equal(msg.pr.number, 7419)
    // Check state and merge state arrive as separate facts — 21/21-style green
    // alongside BLOCKED is the case that must survive the round trip intact.
    assert.equal(msg.checks.state, 'success')
    assert.equal(msg.merge.mergeStateStatus, 'BLOCKED')
  })

  it('falls back to the client\'s active session when no sessionId is given', async () => {
    await handler(ws, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'session_pr_status_request' }, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.sessionId, 'sess-1')
    assert.equal(ctx.surveySessionPrStatus.calls[0][0].cwd, '/repo')
  })

  it('lets a BOUND client read its OWN session', async () => {
    // Positive control for the refusal below: without it, a handler that refused
    // every bound client would pass the refusal test for the wrong reason.
    await handler(ws, { id: 'c1', boundSessionId: 'sess-1' }, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.reason, null)
    assert.equal(msg.pr.number, 7419)
  })

  it('REFUSES a bound client asking about a DIFFERENT session', async () => {
    await handler(ws, { id: 'c1', boundSessionId: 'sess-1' }, { type: 'session_pr_status_request', sessionId: 'sess-2' }, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.reason, NOT_AUTHORIZED_REASON)
    assert.equal(msg.pr, null)
    assert.equal(ctx.surveySessionPrStatus.callCount, 0, 'no survey may run for an unauthorised request')
  })

  it('refuses a bound client BEFORE looking the session up, so existence cannot be probed', async () => {
    // A bound client gets the SAME reason for a session that exists and one that
    // does not — otherwise the reply is an existence oracle for session ids.
    const client = { id: 'c1', boundSessionId: 'sess-1' }
    await handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-2' }, ctx)
    const existing = soleReply(ctx)

    ctx = makeCtx()
    await handler(ws, client, { type: 'session_pr_status_request', sessionId: 'does-not-exist' }, ctx)
    const missing = soleReply(ctx)

    assert.equal(existing.reason, missing.reason)
    assert.equal(missing.reason, NOT_AUTHORIZED_REASON)
  })

  it('replies with a reason (not silence) for an unknown session', async () => {
    await handler(ws, { id: 'c1' }, { type: 'session_pr_status_request', sessionId: 'nope' }, ctx)
    const msg = soleReply(ctx)
    assert.equal(msg.reason, NO_SESSION_REASON)
  })

  it('rejects a SECOND concurrent survey from the same client rather than queueing it', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    ctx = makeCtx({ surveySessionPrStatus: createSpy(async () => { await gate; return SAMPLE }) })
    const client = { id: 'c1' }

    const first = handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx)
    // BOUNDED, deliberately: without the guard the second call would block on
    // the same gate as the first, and an unbounded await would HANG rather than
    // fail. A mutant that hangs has two states — green and flake — never red, so
    // the second call is raced against a timer and the assertion below is what
    // reports the verdict.
    await Promise.race([
      handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx),
      new Promise(resolve => setTimeout(resolve, 250).unref?.()),
    ])

    // The second replied immediately; the first is still gated.
    assert.equal(ctx._send.callCount, 1, 'the second request must be REJECTED, not queued behind the first')
    assert.equal(ctx._send.calls[0][1].reason, IN_PROGRESS_REASON)
    assert.equal(ctx.surveySessionPrStatus.callCount, 1, 'the rejected request must not spawn a second survey')

    release()
    await first
    assert.equal(ctx._send.callCount, 2)
    assert.equal(ctx._send.calls[1][1].reason, null)
  })

  it('does NOT let one session\'s in-flight survey refuse a DIFFERENT session', async () => {
    // The guard is per (client, session), not per client. A tab switch mid-survey
    // is not abuse, and refusing it left the second session's chip reading
    // "CI unavailable" with nothing scheduled to retry — because every reply is
    // stored under its own session id, so the refusal clobbered that session.
    let release
    const gate = new Promise(resolve => { release = resolve })
    ctx = makeCtx({ surveySessionPrStatus: createSpy(async ({ sessionId }) => { await gate; return { ...SAMPLE, sessionId } }) })
    const client = { id: 'c1' }

    const first = handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx)
    const second = handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-2' }, ctx)

    // Neither has replied — the second is running its OWN survey, not refused.
    assert.equal(ctx._send.callCount, 0)
    release()
    await Promise.all([first, second])

    assert.equal(ctx._send.callCount, 2)
    for (const call of ctx._send.calls) {
      assert.equal(call[1].reason, null, 'neither session may be refused on account of the other')
    }
    assert.equal(ctx.surveySessionPrStatus.callCount, 2)
  })

  it('releases the per-session guard so the SAME session can be re-surveyed after one completes', async () => {
    // Positive control for the release: without it, the per-session guard would
    // simply never clear and the second request would be refused.
    const client = { id: 'c1' }
    await handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx)
    await handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx)
    assert.equal(ctx._send.callCount, 2)
    assert.equal(ctx._send.calls[1][1].reason, null)
  })

  it('releases the in-flight guard after a survey THROWS, and still answers', async () => {
    // Without the finally, one thrown survey would wedge the client's chip for
    // the life of the connection.
    let calls = 0
    ctx = makeCtx({
      surveySessionPrStatus: createSpy(async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return SAMPLE
      }),
    })
    const client = { id: 'c1' }

    await handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx)
    const failed = ctx._send.calls[0][1]
    assert.match(failed.reason, /boom/)
    assert.ok(ServerSessionPrStatusSchema.safeParse(failed).success)

    await handler(ws, client, { type: 'session_pr_status_request', sessionId: 'sess-1' }, ctx)
    assert.equal(ctx._send.calls[1][1].reason, null, 'the guard must have been released')
  })
})
