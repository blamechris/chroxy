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

  it('successive rotations invalidate older tokens', () => {
    manager = new TokenManager({ token: 'first', graceMs: 5000 })
    const second = manager.rotate()
    const third = manager.rotate()
    // Only 'second' (previous) and 'third' (current) should be valid
    assert.equal(manager.validate('first'), false)
    assert.equal(manager.validate(second), true)
    assert.equal(manager.validate(third), true)
  })

  it('destroy clears timers and listeners', () => {
    manager = new TokenManager({ token: 'abc-123', tokenExpiry: '1h' })
    manager.start()
    manager.destroy()
    assert.equal(manager.listenerCount('token_rotated'), 0)
    manager = null // prevent afterEach double-destroy
  })
})
