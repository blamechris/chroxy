import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSessionManager, createSpy, nsCtx } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { sessionPrStatusHandlers } from '../src/handlers/session-pr-status-handlers.js'
import { sessionPrThreadsHandlers } from '../src/handlers/session-pr-threads-handlers.js'
import { _testTotalRecordCount } from '../src/handlers/survey-throttle.js'

/**
 * Acceptance test for #7450: the per-session survey-throttle record must be
 * bounded by the LIVE session count, not by every session id ever surveyed
 * over the daemon's lifetime. `WsServer`'s real `session_destroyed` handler is
 * what has to do the pruning — a unit test against `survey-throttle.js` alone
 * (see survey-throttle.test.js) proves `forgetSurveyKey` works, but not that
 * anything actually CALLS it on the real lifecycle event.
 *
 * This drives BOTH handlers (session_pr_status_request AND
 * session_pr_threads_request) against the SAME session manager a real
 * `WsServer` is constructed with, so the acceptance property is genuinely "one
 * call reaches every throttle instance", not "the one instance this file
 * happens to import".
 */

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

describe('#7450 — WsServer prunes survey-throttle records on session_destroyed', () => {
  let server
  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('does not grow the per-owner record count as sessions are created and destroyed', async () => {
    const N = 6
    const sessionIds = Array.from({ length: N }, (_, i) => `sess-${i}`)
    const sessions = sessionIds.map(id => ({ id, name: id, cwd: '/tmp' }))
    const { manager } = createMockSessionManager(sessions)

    server = new WsServer({ port: 0, apiToken: 'test-token', sessionManager: manager })

    const ws = {}
    const client = { id: 'c1' }

    // Baseline: nothing surveyed yet.
    assert.equal(_testTotalRecordCount(manager), 0)

    for (const sessionId of sessionIds) {
      const ctx = nsCtx({
        send: createSpy(),
        sessionManager: manager,
        surveySessionPrStatus: createSpy(async () => ({ sessionId, pr: null, reason: null })),
        surveySessionPrThreads: createSpy(async () => ({ sessionId, unresolvedCount: 0, reason: null })),
      })
      await sessionPrStatusHandlers.session_pr_status_request(
        ws, client, { type: 'session_pr_status_request', sessionId }, ctx,
      )
      await sessionPrThreadsHandlers.session_pr_threads_request(
        ws, client, { type: 'session_pr_threads_request', sessionId }, ctx,
      )
      // Two records exist right now (one per handler's throttle instance) —
      // destroying the session must remove both before the next iteration.
      manager.emit('session_destroyed', { sessionId })
    }

    assert.equal(
      _testTotalRecordCount(manager), 0,
      `every one of ${N} sessions was destroyed, so no record should remain for either throttle instance`,
    )
  })

  it('POSITIVE CONTROL: the count DOES grow across the same cycle when destruction never happens', async () => {
    // Without this, the assertion above would also pass against a survey that
    // never wrote a record in the first place.
    const N = 4
    const sessionIds = Array.from({ length: N }, (_, i) => `sess-nodestroy-${i}`)
    const sessions = sessionIds.map(id => ({ id, name: id, cwd: '/tmp' }))
    const { manager } = createMockSessionManager(sessions)

    server = new WsServer({ port: 0, apiToken: 'test-token', sessionManager: manager })

    const ws = {}
    const client = { id: 'c1' }
    for (const sessionId of sessionIds) {
      const ctx = nsCtx({
        send: createSpy(),
        sessionManager: manager,
        surveySessionPrStatus: createSpy(async () => ({ sessionId, pr: null, reason: null })),
        surveySessionPrThreads: createSpy(async () => ({ sessionId, unresolvedCount: 0, reason: null })),
      })
      await sessionPrStatusHandlers.session_pr_status_request(
        ws, client, { type: 'session_pr_status_request', sessionId }, ctx,
      )
      await sessionPrThreadsHandlers.session_pr_threads_request(
        ws, client, { type: 'session_pr_threads_request', sessionId }, ctx,
      )
      // No session_destroyed here — this is the shape the bug had.
    }

    assert.equal(_testTotalRecordCount(manager), N * 2, 'one status + one threads record per undestroyed session')
  })
})
