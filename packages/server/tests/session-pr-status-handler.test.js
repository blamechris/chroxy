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
