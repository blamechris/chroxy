import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SessionManager } from '../src/session-manager.js'

/**
 * Tests for getFullHistoryAsync() error handling (#2145).
 *
 * When the JSONL read path throws (corrupt data, disk error, null cwd),
 * getFullHistoryAsync() must catch the error and fall back to the ring buffer
 * instead of propagating the rejection to callers.
 */

function createFakeSession({ resumeSessionId = null } = {}) {
  const session = new EventEmitter()
  session.isRunning = false
  session.model = 'claude-sonnet-4-6'
  session.permissionMode = 'approve'
  session.destroy = () => {}
  Object.defineProperty(session, 'resumeSessionId', { get: () => resumeSessionId })
  return session
}

describe('getFullHistoryAsync error handling', () => {
  let mgr

  beforeEach(() => {
    mgr = new SessionManager({ maxSessions: 5 })
  })

  it('falls back to ring buffer when JSONL path resolution throws', async () => {
    // Trigger resolveJsonlPath to throw by setting cwd to null.
    // resolveJsonlPath(null, id) calls null.replace() which throws TypeError.
    const session = createFakeSession({ resumeSessionId: 'conv-abc-123' })
    mgr._sessions.set('s1', { session, name: 'Test', cwd: null })

    const ringEntry = { type: 'message', messageType: 'response', content: 'from ring buffer', timestamp: 1 }
    mgr._messageHistory.set('s1', [ringEntry])

    // Before the fix, this rejects with TypeError: Cannot read properties of null
    // After the fix, it should catch and fall back to the ring buffer
    const result = await mgr.getFullHistoryAsync('s1')
    assert.deepStrictEqual(result, [ringEntry])
  })

  it('falls back to ring buffer when JSONL read returns empty', async () => {
    // conversationId exists but JSONL file doesn't — readConversationHistoryAsync returns []
    const session = createFakeSession({ resumeSessionId: 'conv-xyz-789' })
    mgr._sessions.set('s1', { session, name: 'Test', cwd: '/tmp/nonexistent-dir' })

    const ringEntry = { type: 'message', content: 'fallback content', timestamp: 99 }
    mgr._messageHistory.set('s1', [ringEntry])

    const result = await mgr.getFullHistoryAsync('s1')
    assert.deepStrictEqual(result, [ringEntry])
  })

  it('returns empty array for unknown session', async () => {
    const result = await mgr.getFullHistoryAsync('nonexistent')
    assert.deepStrictEqual(result, [])
  })

  it('returns ring buffer when no conversationId exists', async () => {
    const session = createFakeSession({ resumeSessionId: null })
    mgr._sessions.set('s1', { session, name: 'Test', cwd: '/tmp' })

    const ringEntry = { type: 'message', content: 'fallback', timestamp: 2 }
    mgr._messageHistory.set('s1', [ringEntry])

    const result = await mgr.getFullHistoryAsync('s1')
    assert.deepStrictEqual(result, [ringEntry])
  })
})
