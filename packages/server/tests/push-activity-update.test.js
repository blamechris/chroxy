import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PushManager } from '../src/push.js'

/**
 * Tests for the activity_update push notification category (#2085)
 *
 * Verifies:
 *   - activity_update category sends immediately with no rate limit
 *     (the noActiveViewers gate in server-cli.js is the real dedupe
 *     mechanism — see the 2026-04-11 notification audit fix)
 *   - waiting/error states send immediately (0ms)
 *   - Correct payload shape for activity updates
 */

const TOKEN = 'ExponentPushToken[test-activity-update]'

function mockFetchOk() {
  return mock.fn(async () => ({
    ok: true,
    json: async () => ({ data: [{ status: 'ok' }] }),
  }))
}

describe('PushManager — activity_update category (#2085)', () => {
  let manager
  let fetchMock
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    manager = new PushManager()
    manager.registerToken(TOKEN)
    fetchMock = mockFetchOk()
    globalThis.fetch = fetchMock
  })

  afterEach(() => {
    manager.tokens.clear()
    manager._lastSent.clear()
    globalThis.fetch = originalFetch
    mock.restoreAll()
  })

  it('sends activity_update notification with correct payload', async () => {
    await manager.send('activity_update', 'Session active', 'Claude is thinking', {
      sessionId: 'sess-1',
      sessionName: 'My Session',
      state: 'thinking',
    })

    assert.equal(fetchMock.mock.calls.length, 1)
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
    assert.equal(body[0].title, 'Session active')
    assert.equal(body[0].body, 'Claude is thinking')
    assert.equal(body[0].data.sessionId, 'sess-1')
    assert.equal(body[0].data.sessionName, 'My Session')
    assert.equal(body[0].data.state, 'thinking')
    assert.equal(body[0].data.category, 'activity_update')
  })

  it('sends activity_update immediately with no rate limit (notification audit 2026-04-11)', async () => {
    // The 10s rate limit was originally added when activity_update fired on
    // every stream_start / tool_start — those call sites were removed in
    // PR #2621, leaving only the unattended-completion call site in
    // server-cli.js, which is already structurally gated by the
    // noActiveViewers check. The rate limit was silently dropping legitimate
    // completions on fast back-to-back queries without preventing any real
    // spam, so the notification audit removed it and standardized on the
    // noActiveViewers gate as the sole dedupe mechanism.
    await manager.send('activity_update', 'T', 'thinking', { state: 'thinking' })
    await manager.send('activity_update', 'T', 'still thinking', { state: 'thinking' })

    // Both must go through — no rate limit on this category anymore.
    assert.equal(fetchMock.mock.calls.length, 2)
  })

  it('sends waiting state immediately via activity_waiting category', async () => {
    await manager.send('activity_waiting', 'Permission needed', 'Waiting for approval', {
      sessionId: 'sess-1',
      state: 'waiting',
    })
    await manager.send('activity_waiting', 'Permission needed', 'Still waiting', {
      sessionId: 'sess-1',
      state: 'waiting',
    })

    // Both should send — activity_waiting has 0ms rate limit
    assert.equal(fetchMock.mock.calls.length, 2)
  })

  it('sends error state immediately via activity_error category', async () => {
    await manager.send('activity_error', 'Session error', 'Something went wrong', {
      sessionId: 'sess-1',
      state: 'error',
      detail: 'Connection timeout',
    })
    await manager.send('activity_error', 'Session error', 'Another error', {
      sessionId: 'sess-1',
      state: 'error',
    })

    // Both should send — activity_error has 0ms rate limit
    assert.equal(fetchMock.mock.calls.length, 2)
  })

  it('includes optional detail and elapsed in payload', async () => {
    await manager.send('activity_update', 'Session active', 'Writing to file', {
      sessionId: 'sess-1',
      sessionName: 'Dev',
      state: 'writing',
      detail: 'src/index.js',
      elapsed: 5200,
    })

    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
    assert.equal(body[0].data.detail, 'src/index.js')
    assert.equal(body[0].data.elapsed, 5200)
  })
})
