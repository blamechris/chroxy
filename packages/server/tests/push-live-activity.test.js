import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PushManager } from '../src/push.js'

/**
 * PushManager Live Activity token support (#2172)
 *
 * Live Activity tokens are separate from regular push tokens.
 * They use a different Expo push endpoint flow and have their own
 * rate-limit category (live_activity: 5s throttle).
 */

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'
const LA_TOKEN_1 = 'ExponentPushToken[la-token-1-xxxxxxxxxxxxx]'
const LA_TOKEN_2 = 'ExponentPushToken[la-token-2-xxxxxxxxxxxxx]'

function mockFetchOk(data = []) {
  return mock.fn(async () => ({
    ok: true,
    json: async () => ({ data }),
  }))
}

describe('PushManager Live Activity tokens (#2172)', () => {
  let manager

  beforeEach(() => {
    manager = new PushManager()
  })

  afterEach(() => {
    manager.tokens.clear()
    manager._liveActivityTokens.clear()
    manager._lastSent.clear()
    mock.restoreAll()
  })

  // -- registerLiveActivityToken --

  describe('registerLiveActivityToken', () => {
    it('accepts a valid token string', () => {
      const result = manager.registerLiveActivityToken(LA_TOKEN_1)
      assert.equal(result, true)
      assert.ok(manager._liveActivityTokens.has(LA_TOKEN_1))
    })

    it('rejects empty string', () => {
      const result = manager.registerLiveActivityToken('')
      assert.equal(result, false)
      assert.equal(manager._liveActivityTokens.size, 0)
    })

    it('rejects non-string input', () => {
      assert.equal(manager.registerLiveActivityToken(null), false)
      assert.equal(manager.registerLiveActivityToken(42), false)
    })

    it('does not duplicate the same token', () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      manager.registerLiveActivityToken(LA_TOKEN_1)
      assert.equal(manager._liveActivityTokens.size, 1)
    })

    it('does not affect regular push tokens', () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      assert.equal(manager.tokens.size, 0)
      assert.equal(manager._liveActivityTokens.size, 1)
    })
  })

  // -- unregisterLiveActivityToken --

  describe('unregisterLiveActivityToken', () => {
    it('removes a registered Live Activity token', () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      manager.unregisterLiveActivityToken(LA_TOKEN_1)
      assert.equal(manager._liveActivityTokens.size, 0)
    })

    it('does not affect regular push tokens', () => {
      manager.registerToken(VALID_TOKEN)
      manager.registerLiveActivityToken(LA_TOKEN_1)
      manager.unregisterLiveActivityToken(LA_TOKEN_1)
      assert.equal(manager.tokens.size, 1)
      assert.ok(manager.tokens.has(VALID_TOKEN))
    })
  })

  // -- sendLiveActivityUpdate --

  describe('sendLiveActivityUpdate', () => {
    it('does nothing when no Live Activity tokens registered', async () => {
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock
      await manager.sendLiveActivityUpdate('thinking', 'Processing request')
      assert.equal(fetchMock.mock.calls.length, 0)
    })

    it('sends to Live Activity tokens only, not regular push tokens', async () => {
      manager.registerToken(VALID_TOKEN)
      manager.registerLiveActivityToken(LA_TOKEN_1)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.sendLiveActivityUpdate('thinking', 'Processing request')

      assert.equal(fetchMock.mock.calls.length, 1)
      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body.length, 1)
      assert.equal(body[0].to, LA_TOKEN_1)
    })

    it('sends correct payload with state and detail', async () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.sendLiveActivityUpdate('writing', 'Editing main.js')

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body[0].data.state, 'writing')
      assert.equal(body[0].data.detail, 'Editing main.js')
      assert.equal(body[0].data.category, 'live_activity')
    })

    it('sends to all registered Live Activity tokens', async () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      manager.registerLiveActivityToken(LA_TOKEN_2)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.sendLiveActivityUpdate('idle', 'Waiting for input')

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body.length, 2)
    })

    it('prunes invalid Live Activity tokens from Expo API errors', async () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      manager.registerLiveActivityToken(LA_TOKEN_2)
      const fetchMock = mockFetchOk([
        { status: 'error', message: 'DeviceNotRegistered' },
        { status: 'ok' },
      ])
      globalThis.fetch = fetchMock

      await manager.sendLiveActivityUpdate('thinking', 'Working')

      assert.equal(manager._liveActivityTokens.size, 1)
      assert.ok(!manager._liveActivityTokens.has(LA_TOKEN_1))
      assert.ok(manager._liveActivityTokens.has(LA_TOKEN_2))
    })
  })

  // -- rate limiting (live_activity category: 5s) --

  describe('rate limiting', () => {
    it('throttles rapid Live Activity updates (5s window)', async () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.sendLiveActivityUpdate('thinking', 'Step 1')
      await manager.sendLiveActivityUpdate('thinking', 'Step 2') // within 5s — blocked
      assert.equal(fetchMock.mock.calls.length, 1)
    })

    it('allows send after 5s window expires', async () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.sendLiveActivityUpdate('thinking', 'Step 1')

      // Backdate the last sent time by 6s
      manager._lastSent.set('live_activity', Date.now() - 6_000)

      await manager.sendLiveActivityUpdate('writing', 'Step 2')
      assert.equal(fetchMock.mock.calls.length, 2)
    })
  })

  // -- backward compatibility --

  describe('backward compatibility', () => {
    it('regular push send is unaffected by Live Activity tokens', async () => {
      manager.registerToken(VALID_TOKEN)
      manager.registerLiveActivityToken(LA_TOKEN_1)
      const fetchMock = mockFetchOk()
      globalThis.fetch = fetchMock

      await manager.send('permission', 'Title', 'Body')

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
      assert.equal(body.length, 1)
      assert.equal(body[0].to, VALID_TOKEN)
    })

    it('hasTokens still reflects only regular push tokens', () => {
      manager.registerLiveActivityToken(LA_TOKEN_1)
      assert.equal(manager.hasTokens, false)

      manager.registerToken(VALID_TOKEN)
      assert.equal(manager.hasTokens, true)
    })
  })
})

// -- persistence --

describe('PushManager Live Activity persistence (#2172)', () => {
  let tmpDir
  let storagePath

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'push-la-test-'))
    storagePath = join(tmpDir, 'push-tokens.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mock.restoreAll()
  })

  it('persists Live Activity tokens separately from regular tokens', () => {
    const manager = new PushManager({ storagePath })
    manager.registerToken(VALID_TOKEN)
    manager.registerLiveActivityToken(LA_TOKEN_1)

    const saved = JSON.parse(readFileSync(storagePath, 'utf-8'))
    assert.deepEqual(saved.tokens, [VALID_TOKEN])
    assert.deepEqual(saved.liveActivityTokens, [LA_TOKEN_1])
  })

  it('loads Live Activity tokens from disk on construction', () => {
    writeFileSync(storagePath, JSON.stringify({
      tokens: [VALID_TOKEN],
      liveActivityTokens: [LA_TOKEN_1, LA_TOKEN_2],
    }))
    const manager = new PushManager({ storagePath })

    assert.equal(manager.tokens.size, 1)
    assert.ok(manager.tokens.has(VALID_TOKEN))
    assert.equal(manager._liveActivityTokens.size, 2)
    assert.ok(manager._liveActivityTokens.has(LA_TOKEN_1))
    assert.ok(manager._liveActivityTokens.has(LA_TOKEN_2))
  })

  it('persists Live Activity token removal', () => {
    writeFileSync(storagePath, JSON.stringify({
      tokens: [],
      liveActivityTokens: [LA_TOKEN_1, LA_TOKEN_2],
    }))
    const manager = new PushManager({ storagePath })
    manager.unregisterLiveActivityToken(LA_TOKEN_1)

    const saved = JSON.parse(readFileSync(storagePath, 'utf-8'))
    assert.deepEqual(saved.liveActivityTokens, [LA_TOKEN_2])
  })

  it('migrates legacy array format (backward compat)', () => {
    // Old format: just an array of tokens
    writeFileSync(storagePath, JSON.stringify([VALID_TOKEN]))
    const manager = new PushManager({ storagePath })

    assert.equal(manager.tokens.size, 1)
    assert.ok(manager.tokens.has(VALID_TOKEN))
    assert.equal(manager._liveActivityTokens.size, 0)
  })

  it('persists after Live Activity token pruning from Expo API errors', async () => {
    const manager = new PushManager({ storagePath })
    manager.registerLiveActivityToken(LA_TOKEN_1)
    manager.registerLiveActivityToken(LA_TOKEN_2)

    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [
          { status: 'error', message: 'DeviceNotRegistered' },
          { status: 'ok' },
        ],
      }),
    }))

    await manager.sendLiveActivityUpdate('thinking', 'Working')

    const saved = JSON.parse(readFileSync(storagePath, 'utf-8'))
    assert.deepEqual(saved.liveActivityTokens, [LA_TOKEN_2])
  })
})
