import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PushManager } from '../src/push.js'

/**
 * Tests for the activity_update push notification category (#2085)
 *
 * Verifies:
 *   - activity_update category exists with correct rate limit
 *   - thinking/writing states are throttled (10s)
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

  beforeEach(() => {
    manager = new PushManager()
    manager.registerToken(TOKEN)
    fetchMock = mockFetchOk()
    globalThis.fetch = fetchMock
  })

  afterEach(() => {
    manager.tokens.clear()
    manager._lastSent.clear()
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

  it('throttles rapid activity_update sends (10s rate limit)', async () => {
    await manager.send('activity_update', 'T', 'thinking', { state: 'thinking' })
    await manager.send('activity_update', 'T', 'still thinking', { state: 'thinking' })

    // Second send should be blocked by 10s rate limit
    assert.equal(fetchMock.mock.calls.length, 1)
  })

  it('allows activity_update after rate limit window expires', async () => {
    await manager.send('activity_update', 'T', 'thinking', { state: 'thinking' })

    // Backdate by 11s to simulate expiry
    manager._lastSent.set('activity_update', Date.now() - 11_000)

    await manager.send('activity_update', 'T', 'writing', { state: 'writing' })
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
