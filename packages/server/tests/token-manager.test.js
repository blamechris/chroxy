import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { TokenManager, parseDuration } from '../src/token-manager.js'

describe('parseDuration', () => {
  it('returns null for empty/invalid input', () => {
    assert.equal(parseDuration(null), null)
    assert.equal(parseDuration(''), null)
    assert.equal(parseDuration(undefined), null)
    assert.equal(parseDuration(123), null)
    assert.equal(parseDuration('abc'), null)
  })

  it('parses plain number as seconds', () => {
    assert.equal(parseDuration('60'), 60_000)
    assert.equal(parseDuration('3600'), 3_600_000)
  })

  it('parses single-unit durations', () => {
    assert.equal(parseDuration('30s'), 30_000)
    assert.equal(parseDuration('5m'), 300_000)
    assert.equal(parseDuration('2h'), 7_200_000)
    assert.equal(parseDuration('1d'), 86_400_000)
  })

  it('parses compound durations', () => {
    assert.equal(parseDuration('1h30m'), 5_400_000)
    assert.equal(parseDuration('1d12h'), 129_600_000)
    assert.equal(parseDuration('2h30m15s'), 9_015_000)
  })

  it('handles case-insensitive input', () => {
    assert.equal(parseDuration('1H'), 3_600_000)
    assert.equal(parseDuration('30M'), 1_800_000)
  })

  it('handles whitespace', () => {
    assert.equal(parseDuration('  1h  '), 3_600_000)
  })

  it('rejects strings with invalid characters', () => {
    assert.equal(parseDuration('1hour'), null)
    assert.equal(parseDuration('5min'), null)
    assert.equal(parseDuration('1.5h'), null)
    assert.equal(parseDuration('2h+30m'), null)
    assert.equal(parseDuration('10x'), null)
  })

  it('rejects all zero durations consistently', () => {
    assert.equal(parseDuration('0'), null)
    assert.equal(parseDuration('0h'), null)
    assert.equal(parseDuration('0m0s'), null)
  })

  it('parses single second', () => {
    assert.equal(parseDuration('1s'), 1_000)
  })
})

describe('TokenManager', () => {
  let manager

  afterEach(() => {
    if (manager) {
      manager.destroy()
      manager = null
    }
  })

  it('validates the current token', () => {
    manager = new TokenManager({ token: 'abc-123' })
    assert.equal(manager.validate('abc-123'), true)
    assert.equal(manager.validate('wrong'), false)
    assert.equal(manager.validate(''), false)
    assert.equal(manager.validate(null), false)
  })

  it('reports rotation disabled when no expiry', () => {
    manager = new TokenManager({ token: 'abc-123' })
    assert.equal(manager.rotationEnabled, false)
    assert.equal(manager.expiresAt, null)
  })

  it('reports rotation enabled when expiry is set', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '1h' })
    assert.equal(manager.rotationEnabled, true)
  })

  it('start is a no-op when rotation is disabled', () => {
    manager = new TokenManager({ token: 'abc-123' })
    manager.start()
    assert.equal(manager.expiresAt, null)
  })

  it('start sets expiresAt when rotation is enabled', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '1h' })
    const before = Date.now()
    manager.start()
    const after = Date.now()
    assert.ok(manager.expiresAt >= before + 3_600_000)
    assert.ok(manager.expiresAt <= after + 3_600_000)
  })

  it('rotate generates a new token', () => {
    manager = new TokenManager({ token: 'abc-123' })
    const newToken = manager.rotate()
    assert.notEqual(newToken, 'abc-123')
    assert.equal(manager.currentToken, newToken)
    assert.equal(manager.validate(newToken), true)
  })

  it('rotate keeps old token valid during grace period', () => {
    manager = new TokenManager({ token: 'abc-123', graceMs: 5000 })
    const newToken = manager.rotate()
    // Both old and new should be valid
    assert.equal(manager.validate('abc-123'), true)
    assert.equal(manager.validate(newToken), true)
  })

  it('rotate emits token_rotated event', () => {
    manager = new TokenManager({ token: 'abc-123' })
    let emitted = null
    manager.on('token_rotated', (data) => { emitted = data })
    const newToken = manager.rotate()
    assert.ok(emitted)
    assert.equal(emitted.oldToken, 'abc-123')
    assert.equal(emitted.newToken, newToken)
  })

  // #6006 — revoke is the panic button: it must NOT keep the old token valid
  // (no grace) and must mark the event so WsServer severs sessions + forces
  // re-auth. A scheduled rotation keeps today's graceful grace-window behavior.
  it('rotate carries reason "scheduled" by default', () => {
    manager = new TokenManager({ token: 'abc-123' })
    let emitted = null
    manager.on('token_rotated', (data) => { emitted = data })
    manager.rotate()
    assert.equal(emitted.reason, 'scheduled')
  })

  it('revoke generates a new token and carries reason "revoke"', () => {
    manager = new TokenManager({ token: 'abc-123' })
    let emitted = null
    manager.on('token_rotated', (data) => { emitted = data })
    const newToken = manager.revoke()
    assert.notEqual(newToken, 'abc-123')
    assert.equal(manager.currentToken, newToken)
    assert.equal(manager.validate(newToken), true)
    assert.equal(emitted.reason, 'revoke')
    assert.equal(emitted.oldToken, 'abc-123')
    assert.equal(emitted.newToken, newToken)
  })

  it('revoke invalidates the old token immediately (no grace)', () => {
    manager = new TokenManager({ token: 'abc-123', graceMs: 60_000 })
    const newToken = manager.revoke()
    // Unlike rotate(), the old token must be rejected at once.
    assert.equal(manager.validate('abc-123'), false)
    assert.equal(manager.validate(newToken), true)
  })

  it('revoke tears down an in-flight grace window from a prior rotation', () => {
    manager = new TokenManager({ token: 'abc-123', graceMs: 60_000 })
    const second = manager.rotate() // 'abc-123' now in grace
    assert.equal(manager.validate('abc-123'), true)
    const third = manager.revoke() // panic — kill everything but current
    assert.equal(manager.validate('abc-123'), false)
    assert.equal(manager.validate(second), false)
    assert.equal(manager.validate(third), true)
  })

  it('rotate calls onPersist callback', async () => {
    let persisted = null
    manager = new TokenManager({
      token: 'abc-123',
      onPersist: (newToken) => { persisted = newToken },
    })
    const newToken = manager.rotate()
    // onPersist is called via Promise.resolve so wait a tick
    await new Promise(r => setTimeout(r, 10))
    assert.equal(persisted, newToken)
  })

  // #6927 — onPersist receives the rotation `reason` so the persist site can make
  // the panic-button revoke DURABLE (fsync config before the compromised token can
  // resurrect on a crash) while leaving a routine scheduled rotation non-durable.
  it('revoke() passes reason "revoke" to onPersist; scheduled rotate passes "scheduled"', async () => {
    const reasons = []
    manager = new TokenManager({
      token: 'abc-123',
      onPersist: (_newToken, opts = {}) => { reasons.push(opts.reason) },
    })
    manager.rotate()   // routine scheduled rotation
    manager.revoke()   // operator panic button
    await new Promise(r => setTimeout(r, 10))
    assert.deepEqual(reasons, ['scheduled', 'revoke'])
  })

  it('successive rotations invalidate older tokens', () => {
    manager = new TokenManager({ token: 'first', graceMs: 5000 })
    const second = manager.rotate()
    const third = manager.rotate()
    // Only 'second' (previous) and 'third' (current) should be valid
    assert.equal(manager.validate('first'), false)
    assert.equal(manager.validate(second), true)
    assert.equal(manager.validate(third), true)
  })

  // #6004 — isCurrentToken accepts ONLY the current token, never the grace
  // (previous) token. Gates user-shell create so a just-rotated token can't
  // re-create a severed shell within its grace window.
  it('isCurrentToken accepts the current token but rejects grace + bogus tokens', () => {
    manager = new TokenManager({ token: 'abc-123', graceMs: 5000 })
    const newToken = manager.rotate() // 'abc-123' is now the grace/previous token
    assert.equal(manager.isCurrentToken(newToken), true, 'current token accepted')
    // validate() still honors the grace token, but isCurrentToken must NOT.
    assert.equal(manager.validate('abc-123'), true, 'grace token is still valid for auth')
    assert.equal(manager.isCurrentToken('abc-123'), false, 'grace token is NOT the current token')
    assert.equal(manager.isCurrentToken('bogus'), false)
    assert.equal(manager.isCurrentToken(''), false)
    assert.equal(manager.isCurrentToken(null), false)
  })

  it('revoke makes the old token fail isCurrentToken immediately', () => {
    manager = new TokenManager({ token: 'abc-123', graceMs: 5000 })
    const newToken = manager.revoke()
    assert.equal(manager.isCurrentToken('abc-123'), false)
    assert.equal(manager.isCurrentToken(newToken), true)
  })

  it('destroy clears timers and listeners', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '1h' })
    manager.start()
    manager.destroy()
    assert.equal(manager.listenerCount('token_rotated'), 0)
    manager = null // prevent afterEach double-destroy
  })

  it('clamps expiry below 5 minutes to 5 minutes', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '60' })
    // 60 seconds → clamped to 5 minutes (300000ms)
    assert.equal(manager._expiryMs, 300_000)
  })

  it('accepts expiry at exactly 5 minutes', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '5m' })
    assert.equal(manager._expiryMs, 300_000)
  })

  it('accepts expiry above 5 minutes without clamping', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '10m' })
    assert.equal(manager._expiryMs, 600_000)
  })

  it('clamps very short expiry (1s) to 5 minutes', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '1s' })
    assert.equal(manager._expiryMs, 300_000)
  })

  it('rotate generates 256-bit base64url tokens (#1855)', () => {
    manager = new TokenManager({ token: 'legacy-uuid-token' })
    const newToken = manager.rotate()
    // base64url encoding of 32 bytes = 43 characters
    assert.equal(newToken.length, 43, 'Rotated token should be 43-char base64url (256-bit)')
    assert.match(newToken, /^[A-Za-z0-9_-]+$/, 'Token should be URL-safe base64')
  })

  it('still validates legacy UUID-format tokens (#1855)', () => {
    // Existing tokens in old UUID format should still be accepted
    const uuidToken = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    manager = new TokenManager({ token: uuidToken })
    assert.equal(manager.validate(uuidToken), true)
  })
})
