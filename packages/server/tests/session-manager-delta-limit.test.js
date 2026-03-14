import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from '../src/session-manager.js'
import { EventEmitter } from 'events'

/**
 * Tests for stream delta size limit (issue #2146).
 * Prevents OOM from malicious clients sending unbounded stream_delta data.
 */

function createFakeSession() {
  const session = new EventEmitter()
  session.isRunning = false
  session.destroy = () => {}
  return session
}

function setupManager() {
  const mgr = new SessionManager({ maxSessions: 5 })
  const session = createFakeSession()
  const sessionId = 'test-session-1'
  mgr._sessions.set(sessionId, { session, name: 'Test', cwd: '/tmp', createdAt: Date.now() })
  return { mgr, sessionId }
}

describe('stream delta size limit', () => {
  it('accumulates normal-sized deltas correctly', () => {
    const { mgr, sessionId } = setupManager()
    const messageId = 'msg-1'

    // Start a stream
    mgr._recordHistory(sessionId, 'stream_start', { messageId })

    // Send a few normal deltas
    mgr._recordHistory(sessionId, 'stream_delta', { messageId, delta: 'Hello ' })
    mgr._recordHistory(sessionId, 'stream_delta', { messageId, delta: 'world!' })

    const key = `${sessionId}:${messageId}`
    assert.equal(mgr._pendingStreams.get(key), 'Hello world!')
  })

  it('rejects stream deltas that exceed 100MB', () => {
    const { mgr, sessionId } = setupManager()
    const messageId = 'msg-2'

    mgr._recordHistory(sessionId, 'stream_start', { messageId })

    const key = `${sessionId}:${messageId}`

    // Set existing content to just under 100MB
    const limit = 100 * 1024 * 1024
    const existing = 'x'.repeat(limit - 10)
    mgr._pendingStreams.set(key, existing)

    // This delta would push it over the limit
    mgr._recordHistory(sessionId, 'stream_delta', { messageId, delta: 'y'.repeat(20) })

    // Should NOT have accumulated — content should remain at the pre-overflow value
    assert.equal(mgr._pendingStreams.get(key), existing)
  })

  it('allows deltas right at the 100MB boundary', () => {
    const { mgr, sessionId } = setupManager()
    const messageId = 'msg-3'

    mgr._recordHistory(sessionId, 'stream_start', { messageId })

    const key = `${sessionId}:${messageId}`

    const limit = 100 * 1024 * 1024
    const existing = 'x'.repeat(limit - 5)
    mgr._pendingStreams.set(key, existing)

    // This delta of exactly 5 chars should be accepted (total == limit)
    mgr._recordHistory(sessionId, 'stream_delta', { messageId, delta: 'abcde' })
    assert.equal(mgr._pendingStreams.get(key).length, limit)
  })
})
