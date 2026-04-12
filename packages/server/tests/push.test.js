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

    it('accepts FCM-style tokens (#1926)', () => {
      const fcmToken = 'dGVzdC1mY20tdG9rZW4tZm9yLWFuZHJvaWQ6QVBBOTFiR3Q'
      const result = manager.registerToken(fcmToken)
      assert.equal(result, true)
      assert.ok(manager.tokens.has(fcmToken))
    })

    it('accepts any non-empty string token (#1926)', () => {
      const result = manager.registerToken('some-custom-token-format')
      assert.equal(result, true)
      assert.ok(manager.tokens.has('some-custom-token-format'))
    })

    it('rejects empty string (#1926)', () => {
      const result = manager.registerToken('')
      assert.equal(result, false)
      assert.equal(manager.tokens.size, 0)
    })

    it('rejects non-string input', () => {
      assert.equal(manager.registerToken(null), false)
      assert.equal(manager.registerToken(42), false)
    })

    it('rejects tokens shorter than 20 chars (2026-04-11 audit blocker 6)', () => {
      // Short strings are almost certainly not real push tokens — Expo
      // tokens are 50+ chars, FCM are typically 150+. Reject as a soft
      // defense layer. The real protection is the client-binding +
      // prune-on-disconnect in ws-server.js.
      assert.equal(manager.registerToken('short'), false)
      assert.equal(manager.registerToken('attacker'), false)
      assert.equal(manager.registerToken('a'.repeat(19)), false)
      // Length 20 exactly is the boundary
      assert.equal(manager.registerToken('a'.repeat(20)), true)
    })

    it('rejects tokens with whitespace or JSON/URL punctuation (2026-04-11 audit blocker 6)', () => {
      // These patterns signal the caller sent garbage (a JSON blob, an
      // error message, a random English string) rather than a real push
      // token. No real Expo/FCM token contains these characters.
      assert.equal(manager.registerToken('has whitespace here and more'), false)
      assert.equal(manager.registerToken('has\nnewline here tooxxxxxxx'), false)
      assert.equal(manager.registerToken('{"type":"error","msg":"garbage"}'), false)
      assert.equal(manager.registerToken('https://example.com/fake-token'), false)
      assert.equal(manager.registerToken('<script>alert(1)</scriptxx>'), false)
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

  // -- releaseTokenOwner (ref-counted prune) --

  describe('releaseTokenOwner (2026-04-11 audit blocker 6 — ref-counted via Copilot review on PR #2806)', () => {
    it('prunes a token when its sole owner releases it', () => {
      manager.registerToken(VALID_TOKEN, 'client-1')
      assert.equal(manager.tokens.size, 1)
      const pruned = manager.releaseTokenOwner(VALID_TOKEN, 'client-1')
      assert.equal(pruned, true, 'last-owner release should return true (token pruned)')
      assert.equal(manager.tokens.size, 0)
    })

    it('keeps a token alive when one of multiple owners releases it', () => {
      manager.registerToken(VALID_TOKEN, 'client-1')
      manager.registerToken(VALID_TOKEN, 'client-2')
      assert.equal(manager.tokens.size, 1, 'two owners share one registry entry')

      const prunedFirst = manager.releaseTokenOwner(VALID_TOKEN, 'client-1')
      assert.equal(prunedFirst, false, 'non-last-owner release should return false (token still held)')
      assert.ok(manager.tokens.has(VALID_TOKEN), 'token must still be in registry')

      const prunedSecond = manager.releaseTokenOwner(VALID_TOKEN, 'client-2')
      assert.equal(prunedSecond, true, 'final-owner release should return true')
      assert.equal(manager.tokens.size, 0)
    })

    it('releases unknown owner gracefully (no-op)', () => {
      manager.registerToken(VALID_TOKEN, 'client-1')
      // client-2 tries to release a token it never registered
      const pruned = manager.releaseTokenOwner(VALID_TOKEN, 'client-2')
      assert.equal(pruned, false)
      assert.ok(manager.tokens.has(VALID_TOKEN), 'token must still be held by client-1')
    })

    it('falls back to unconditional remove for legacy tokens with no owner tracking', () => {
      // Register WITHOUT an ownerId (legacy path)
      manager.registerToken(VALID_TOKEN)
      assert.equal(manager.tokens.size, 1)
      const pruned = manager.releaseTokenOwner(VALID_TOKEN, 'client-1')
      assert.equal(pruned, true)
      assert.equal(manager.tokens.size, 0, 'legacy untracked token is removed on first release')
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

    it('blocks rapid sends for rate-limited categories (result = 30s)', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.send('result', 'T', 'B')
      await manager.send('result', 'T', 'B')  // within 30s rate limit — blocked
      assert.equal(fetchMock.mock.calls.length, 1)
    })

    it('applies the 30s default rate limit to unknown/unregistered categories', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      // 'idle' was removed from the RATE_LIMITS map in the notification
      // duplicate-fire fix; the ?? 30_000 fallback in send() now applies.
      await manager.send('idle', 'T', 'B')
      await manager.send('idle', 'T', 'B')  // within 30s fallback — blocked
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

    it('unknown category defaults to 30s rate limit', async () => {
      manager.registerToken(VALID_TOKEN)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      // First send with unknown category — should go through
      await manager.send('custom', 'T', 'B')
      assert.equal(fetchMock.mock.calls.length, 1)

      // Rapid second send — blocked by 30s default limit
      await manager.send('custom', 'T', 'B')
      assert.equal(fetchMock.mock.calls.length, 1)

      // Backdate to just under 30s — still within default rate limit window, so blocked
      manager._lastSent.set('custom', Date.now() - 29_000)
      await manager.send('custom', 'T', 'B')
      assert.equal(fetchMock.mock.calls.length, 1)

      // Backdate to just over 30s — outside default window, so allowed
      manager._lastSent.set('custom', Date.now() - 31_000)
      await manager.send('custom', 'T', 'B')
      assert.equal(fetchMock.mock.calls.length, 2)
    })
  })
})
