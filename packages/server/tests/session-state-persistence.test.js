import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStatePersistence } from '../src/session-state-persistence.js'

describe('SessionStatePersistence.serializeState', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-persist-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes JSON state to file', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const state = {
      version: 1,
      timestamp: Date.now(),
      sessions: [{ id: 's1', name: 'Test', cwd: '/tmp' }],
    }

    const result = p.serializeState(state)

    assert.ok(existsSync(stateFile), 'State file should exist')
    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(fileContents.version, 1)
    assert.equal(fileContents.sessions.length, 1)
    assert.equal(fileContents.sessions[0].name, 'Test')
    assert.deepEqual(result, state)
  })

  it('creates parent directory if needed', () => {
    const nestedFile = join(tempDir, 'nested', 'deep', 'state.json')
    const p = new SessionStatePersistence({ stateFilePath: nestedFile })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [] })
    assert.ok(existsSync(nestedFile), 'Nested state file should be created')
  })

  it('uses atomic write (no .tmp file remains)', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [] })
    assert.ok(existsSync(stateFile), 'State file should exist')
    assert.equal(existsSync(stateFile + '.tmp'), false, '.tmp file should not remain')
  })

  it('returns the state object', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const state = { version: 1, timestamp: 12345, sessions: [] }
    const result = p.serializeState(state)
    assert.deepEqual(result, state)
  })

  it('includes cost data when provided', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const state = {
      version: 1,
      timestamp: Date.now(),
      sessions: [],
      costs: { s1: 2.50 },
      budgetWarned: ['s1'],
      budgetExceeded: [],
      budgetPaused: [],
    }

    p.serializeState(state)

    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.deepEqual(fileContents.costs, { s1: 2.50 })
    assert.deepEqual(fileContents.budgetWarned, ['s1'])
  })
})

describe('SessionStatePersistence.restoreState', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-persist-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null when no state file exists', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.equal(p.restoreState(), null)
  })

  it('returns null for invalid JSON and removes the file', () => {
    writeFileSync(stateFile, 'not json')
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.equal(p.restoreState(), null)
    assert.equal(existsSync(stateFile), false, 'Invalid state file should be removed')
  })

  it('returns null for empty sessions array', () => {
    writeFileSync(stateFile, JSON.stringify({ timestamp: Date.now(), sessions: [] }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.equal(p.restoreState(), null)
  })

  it('returns null for state older than TTL', () => {
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: staleTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp' }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.equal(p.restoreState(), null)
  })

  it('accepts state within default TTL (23h old)', () => {
    const recentTimestamp = Date.now() - 23 * 60 * 60 * 1000
    const state = {
      version: 1,
      timestamp: recentTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp' }],
    }
    writeFileSync(stateFile, JSON.stringify(state))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const result = p.restoreState()
    assert.ok(result, '23h old state should be accepted')
    assert.equal(result.sessions.length, 1)
  })

  it('respects custom stateTtlMs', () => {
    const staleTimestamp = Date.now() - 6 * 60 * 1000
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: staleTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp' }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile, stateTtlMs: 5 * 60 * 1000 })
    assert.equal(p.restoreState(), null, 'State older than custom 5min TTL should be rejected')
  })

  it('returns parsed state for valid file', () => {
    const state = {
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'Session A', cwd: '/tmp', model: null },
        { name: 'Session B', cwd: '/tmp', model: 'sonnet' },
      ],
    }
    writeFileSync(stateFile, JSON.stringify(state))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const result = p.restoreState()
    assert.ok(result)
    assert.equal(result.sessions.length, 2)
    assert.equal(result.sessions[0].name, 'Session A')
    assert.equal(result.sessions[1].name, 'Session B')
  })

  it('preserves state file after restore', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp' }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    p.restoreState()
    assert.ok(existsSync(stateFile), 'State file should be kept after restore')
  })
})

describe('SessionStatePersistence.schedulePersist', () => {
  it('debounces rapid calls into a single invocation', () => {
    mock.timers.enable()
    try {
      const stateFile = join(tmpdir(), 'chroxy-persist-debounce-test.json')
      const p = new SessionStatePersistence({ stateFilePath: stateFile, persistDebounceMs: 100 })

      let callCount = 0
      const fn = () => { callCount++ }

      p.schedulePersist(fn)
      p.schedulePersist(fn)
      p.schedulePersist(fn)
      p.schedulePersist(fn)
      p.schedulePersist(fn)

      assert.equal(callCount, 0, 'Should not have called yet')

      mock.timers.tick(150)

      assert.equal(callCount, 1, 'Should have called exactly once after debounce')
      p.destroy()
    } finally {
      mock.timers.reset()
    }
  })

  it('resets timer on each call', () => {
    mock.timers.enable()
    try {
      const stateFile = join(tmpdir(), 'chroxy-persist-reset-test.json')
      const p = new SessionStatePersistence({ stateFilePath: stateFile, persistDebounceMs: 100 })

      let callCount = 0
      const fn = () => { callCount++ }

      p.schedulePersist(fn)
      mock.timers.tick(80)
      assert.equal(callCount, 0, 'Should not fire yet')

      // Reset by calling again
      p.schedulePersist(fn)
      mock.timers.tick(80)
      assert.equal(callCount, 0, 'Timer was reset, still should not fire')

      mock.timers.tick(30)
      assert.equal(callCount, 1, 'Should fire after full debounce from last call')
      p.destroy()
    } finally {
      mock.timers.reset()
    }
  })

  it('catches errors from serializeFn', () => {
    mock.timers.enable()
    try {
      const stateFile = join(tmpdir(), 'chroxy-persist-error-test.json')
      const p = new SessionStatePersistence({ stateFilePath: stateFile, persistDebounceMs: 50 })

      const fn = () => { throw new Error('serialize failed') }

      // Should not throw
      p.schedulePersist(fn)
      mock.timers.tick(100)

      // If we get here without throwing, the error was caught
      assert.ok(true, 'Error should be caught internally')
      p.destroy()
    } finally {
      mock.timers.reset()
    }
  })
})

describe('SessionStatePersistence.cancelPersist', () => {
  it('clears pending timer', () => {
    mock.timers.enable()
    try {
      const stateFile = join(tmpdir(), 'chroxy-persist-cancel-test.json')
      const p = new SessionStatePersistence({ stateFilePath: stateFile, persistDebounceMs: 100 })

      let callCount = 0
      const fn = () => { callCount++ }

      p.schedulePersist(fn)
      assert.ok(p._persistTimer !== null, 'Timer should be set')

      p.cancelPersist()
      assert.equal(p._persistTimer, null, 'Timer should be cleared')

      mock.timers.tick(200)
      assert.equal(callCount, 0, 'Should never fire after cancel')
      p.destroy()
    } finally {
      mock.timers.reset()
    }
  })
})

describe('SessionStatePersistence.destroy', () => {
  it('cancels pending timer', () => {
    mock.timers.enable()
    try {
      const stateFile = join(tmpdir(), 'chroxy-persist-destroy-test.json')
      const p = new SessionStatePersistence({ stateFilePath: stateFile, persistDebounceMs: 100 })

      let callCount = 0
      p.schedulePersist(() => { callCount++ })

      p.destroy()
      assert.equal(p._persistTimer, null, 'Timer should be cleared')

      mock.timers.tick(200)
      assert.equal(callCount, 0, 'Should never fire after destroy')
    } finally {
      mock.timers.reset()
    }
  })
})

describe('SessionStatePersistence defaults', () => {
  it('defaults to 2000ms persist debounce', () => {
    const p = new SessionStatePersistence({ stateFilePath: '/tmp/test.json' })
    assert.equal(p._persistDebounceMs, 2000)
  })

  it('defaults to 24h TTL', () => {
    const p = new SessionStatePersistence({ stateFilePath: '/tmp/test.json' })
    assert.equal(p._stateTtlMs, 24 * 60 * 60 * 1000)
  })

  it('allows overriding persist debounce', () => {
    const p = new SessionStatePersistence({ stateFilePath: '/tmp/test.json', persistDebounceMs: 500 })
    assert.equal(p._persistDebounceMs, 500)
  })

  it('allows overriding TTL', () => {
    const p = new SessionStatePersistence({ stateFilePath: '/tmp/test.json', stateTtlMs: 1000 })
    assert.equal(p._stateTtlMs, 1000)
  })
})
