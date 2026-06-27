import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'fs'

/**
 * #6431 — when a stream delta exceeds MAX_PENDING_STREAM_SIZE the server drops it
 * from history, but the client already received it (forwarded independently), so
 * the persisted message silently diverges from what the client observed. The fix:
 * SessionManager emits a client-visible `error` session_event (code
 * `stream_truncated`) so the truncation is observable instead of a silent desync.
 */
describe('SessionManager — stream truncation client signal (#6431)', () => {
  it('emits one client-visible error session_event when an over-size delta is dropped', async () => {
    const { SessionManager } = await import('../src/session-manager.js')
    const tmpState = `/tmp/chroxy-truncsig-${Date.now()}-${Math.random()}.json`
    const sm = new SessionManager({ skipPreflight: true, stateFilePath: tmpState, persistenceDebounceMs: 0 })
    // Shrink the pending-stream cap so a small delta trips it (no 100MB alloc).
    sm._history._maxPendingStreamSize = 50

    const errors = []
    sm.on('session_event', (e) => { if (e.event === 'error') errors.push(e) })

    sm._recordHistory('s1', 'stream_start', { messageId: 'm1' })
    sm._recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'x'.repeat(100) }) // over-size → drop
    sm._recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'x'.repeat(100) }) // again → deduped

    assert.equal(errors.length, 1, 'truncation surfaces exactly one client-visible error (deduped)')
    assert.equal(errors[0].sessionId, 's1')
    assert.equal(errors[0].data.code, 'stream_truncated')
    assert.ok(errors[0].data.message, 'carries a human-readable message')
    // messageId/recoverable are intentionally absent — the normalizer's generic
    // error builder forwards only code + message, so we don't emit dead fields.
    assert.equal(errors[0].data.messageId, undefined)

    sm.destroy?.()
    try { rmSync(tmpState, { force: true }) } catch { /* never written (no persistNeeded) */ }
  })

  it('does not emit for a normal-size stream', async () => {
    const { SessionManager } = await import('../src/session-manager.js')
    const tmpState = `/tmp/chroxy-truncsig-ok-${Date.now()}-${Math.random()}.json`
    const sm = new SessionManager({ skipPreflight: true, stateFilePath: tmpState, persistenceDebounceMs: 0 })
    sm._history._maxPendingStreamSize = 50

    const errors = []
    sm.on('session_event', (e) => { if (e.event === 'error') errors.push(e) })

    sm._recordHistory('s2', 'stream_start', { messageId: 'm9' })
    sm._recordHistory('s2', 'stream_delta', { messageId: 'm9', delta: 'small' })

    assert.equal(errors.length, 0, 'a normal stream emits no truncation error')

    sm.destroy?.()
    try { rmSync(tmpState, { force: true }) } catch { /* ignore */ }
  })
})
