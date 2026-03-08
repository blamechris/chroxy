import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PushManager } from '../src/push.js'

/**
 * PushManager unit tests (#1719)
 *
 * Fetch is mocked via globalThis.fetch to avoid real network calls.
 * Tests cover token registration, rate limiting, API integration, and token pruning.
 */

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'
const VALID_TOKEN_2 = 'ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]'

function mockFetchOk(data = []) {
  return mock.fn(async () => ({
    ok: true,
    json: async () => ({ data }),
  }))
}

function mockFetchErr(status = 500) {
  return mock.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
  }))
}

describe('PushManager', () => {
  let manager

  before(() => {
    manager = new PushManager()
  })

  afterEach(() => {
    manager.tokens.clear()
    manager._lastSent.clear()
    mock.restoreAll()
  })

  // -- registerToken --

  describe('registerToken', () => {
    it('accepts valid ExponentPushToken', () => {
      const result = manager.registerToken(VALID_TOKEN)
      assert.equal(result, true)
      assert.ok(manager.tokens.has(VALID_TOKEN))
    })

    it('rejects token not starting with ExponentPushToken[', () => {
      const result = manager.registerToken('invalid-token-string')
      assert.equal(result, false)
      assert.equal(manager.tokens.size, 0)
    })

    it('rejects non-string input', () => {
      assert.equal(manager.registerToken(null), false)
      assert.equal(manager.registerToken(42), false)
    })

    it('does not duplicate the same token', () => {
      manager.registerToken(VALID_TOKEN)
      manager.registerToken(VALID_TOKEN)
      assert.equal(manager.tokens.size, 1)
    })
  })

  // -- removeToken --

  describe('removeToken', () => {
    it('removes a registered token', () => {
      manager.registerToken(VALID_TOKEN)
      manager.removeToken(VALID_TOKEN)
      assert.equal(manager.tokens.size, 0)
    })
  })

  // -- hasTokens --

  describe('hasTokens', () => {
    it('returns false with no tokens', () => {
      assert.equal(manager.hasTokens, false)
    })

    it('returns true after registering a token', () => {
      manager.registerToken(VALID_TOKEN)
      assert.equal(manager.hasTokens, true)
    })
  })

  // -- send --

  describe('send', () => {
    it('does nothing when no tokens are registered', async () => {
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock
      await manager.send('permission', 'Title', 'Body')
      assert.equal(fetchMock.mock.calls.length, 0)
    })

    it('calls Expo Push API with correct payload', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock
      await manager.send('permission', 'Test Title', 'Test Body', { key: 'val' })

      assert.equal(fetchMock.mock.calls.length, 1)
      const [url, opts] = fetchMock.mock.calls[0].arguments
      assert.equal(url, 'https://exp.host/--/api/v2/push/send')
      assert.equal(opts.method, 'POST')

      const body = JSON.parse(opts.body)
      assert.equal(body.length, 1)
      assert.equal(body[0].to, VALID_TOKEN)
      assert.equal(body[0].title, 'Test Title')
      assert.equal(body[0].body, 'Test Body')
      assert.equal(body[0].data.key, 'val')
      assert.equal(body[0].data.category, 'permission')
    })

    it('sends to all registered tokens', async () => {
      manager.registerToken(VALID_TOKEN)
      manager.registerToken(VALID_TOKEN_2)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock
      await manager.send('result', 'Done', 'Task complete')

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body.length, 2)
    })

    it('includes categoryId when provided', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock
      await manager.send('permission', 'T', 'B', {}, 'MY_CATEGORY')

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body[0].categoryId, 'MY_CATEGORY')
    })

    it('does not include categoryId when not provided', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock
      await manager.send('permission', 'T', 'B')

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body[0].categoryId, undefined)
    })

    it('handles non-ok fetch response gracefully', async () => {
      manager.registerToken(VALID_TOKEN)
      globalThis.fetch = mockFetchErr(500)
      // Should not throw
      await assert.doesNotReject(() => manager.send('result', 'T', 'B'))
    })

    it('handles fetch network error gracefully', async () => {
      manager.registerToken(VALID_TOKEN)
      globalThis.fetch = mock.fn(async () => { throw new Error('Network error') })
      await assert.doesNotReject(() => manager.send('result', 'T', 'B'))
    })

    it('prunes tokens that return error status from Expo', async () => {
      manager.registerToken(VALID_TOKEN)
      manager.registerToken(VALID_TOKEN_2)
      const fetchMock = mockFetchOk([
        { status: 'error', message: 'DeviceNotRegistered' },
        { status: 'ok' },
      ])
      globalThis.fetch = fetchMock
      await manager.send('result', 'T', 'B')

      assert.equal(manager.tokens.size, 1)
      assert.ok(!manager.tokens.has(VALID_TOKEN))
      assert.ok(manager.tokens.has(VALID_TOKEN_2))
    })
  })

  // -- rate limiting --

  describe('rate limiting', () => {
    it('allows permission category to send immediately (rate limit 0)', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.send('permission', 'T', 'B')
      await manager.send('permission', 'T', 'B')
      // Permission limit is 0ms — both should go through
      assert.equal(fetchMock.mock.calls.length, 2)
    })

    it('blocks rapid sends for rate-limited categories (idle = 60s)', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.send('idle', 'T', 'B')
      await manager.send('idle', 'T', 'B')  // within 60s rate limit — blocked
      assert.equal(fetchMock.mock.calls.length, 1)
    })

    it('allows send after rate limit window expires', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      // Simulate first send
      await manager.send('result', 'T', 'B')

      // Backdate the last sent time by 31s to simulate expiry
      manager._lastSent.set('result', Date.now() - 31_000)

      await manager.send('result', 'T', 'B')
      assert.equal(fetchMock.mock.calls.length, 2)
    })
  })
})
