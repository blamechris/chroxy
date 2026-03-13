import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PushManager } from '../src/push.js'

/**
 * PushManager activity_update category tests (#2085)
 *
 * Validates the activity_update push notification type for
 * session progress updates (thinking/writing/waiting/idle states).
 */

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'

function mockFetchOk(data = []) {
  return mock.fn(async () => ({
    ok: true,
    json: async () => ({ data }),
  }))
}

describe('PushManager activity_update', () => {
  let manager

  before(() => {
    manager = new PushManager()
  })

  afterEach(() => {
    manager.tokens.clear()
    manager._lastSent.clear()
    mock.restoreAll()
  })

  it('accepts activity_update as a valid category', async () => {
    manager.registerToken(VALID_TOKEN)
    const fetchMock = mockFetchOk()
    globalThis.fetch = fetchMock

    await manager.send('activity_update', 'Session Progress', 'Thinking...')
    assert.equal(fetchMock.mock.calls.length, 1)
  })

  it('has its own rate limit separate from other categories', async () => {
    manager.registerToken(VALID_TOKEN)
    const fetchMock = mockFetchOk()
    globalThis.fetch = fetchMock

    // Send an idle notification first
    await manager.send('idle', 'Idle', 'Session idle')

    // activity_update should not be blocked by idle's rate limit
    await manager.send('activity_update', 'Progress', 'Thinking...')
    assert.equal(fetchMock.mock.calls.length, 2)
  })

  it('rate limits activity_update at 60 seconds', async () => {
    manager.registerToken(VALID_TOKEN)
    const fetchMock = mockFetchOk()
    globalThis.fetch = fetchMock

    // First send goes through
    await manager.send('activity_update', 'Progress', 'Thinking...')
    assert.equal(fetchMock.mock.calls.length, 1)

    // Rapid second send within 60s window — blocked
    await manager.send('activity_update', 'Progress', 'Writing...')
    assert.equal(fetchMock.mock.calls.length, 1)

    // Backdate to just under 60s — still blocked
    manager._lastSent.set('activity_update', Date.now() - 59_000)
    await manager.send('activity_update', 'Progress', 'Writing...')
    assert.equal(fetchMock.mock.calls.length, 1)

    // Backdate past 60s — allowed
    manager._lastSent.set('activity_update', Date.now() - 61_000)
    await manager.send('activity_update', 'Progress', 'Writing...')
    assert.equal(fetchMock.mock.calls.length, 2)
  })

  it('includes correct payload structure with type, sessionId, state, elapsed', async () => {
    manager.registerToken(VALID_TOKEN)
    const fetchMock = mockFetchOk()
    globalThis.fetch = fetchMock

    const payload = {
      type: 'activity_update',
      sessionId: 'sess-abc-123',
      state: 'thinking',
      elapsed: 42,
    }

    await manager.send('activity_update', 'Session Progress', 'Thinking...', payload)

    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
    assert.equal(body.length, 1)
    assert.equal(body[0].data.type, 'activity_update')
    assert.equal(body[0].data.sessionId, 'sess-abc-123')
    assert.equal(body[0].data.state, 'thinking')
    assert.equal(body[0].data.elapsed, 42)
    assert.equal(body[0].data.category, 'activity_update')
  })

  it('supports all activity states in payload', async () => {
    manager.registerToken(VALID_TOKEN)

    for (const state of ['thinking', 'writing', 'waiting', 'idle']) {
      manager._lastSent.clear()
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      const payload = {
        type: 'activity_update',
        sessionId: 'sess-1',
        state,
        elapsed: 10,
      }

      await manager.send('activity_update', 'Progress', `State: ${state}`, payload)
      assert.equal(fetchMock.mock.calls.length, 1, `Failed for state: ${state}`)

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body[0].data.state, state)
    }
  })
})
