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

describe('SessionStatePersistence.flushPersist (regression: #2906)', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-flush-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes synchronously without waiting for the debounce', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile, persistDebounceMs: 10_000 })
    let called = 0
    p.flushPersist(() => {
      called++
      p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's1', name: 'Flushed', cwd: '/tmp' }] })
    })
    assert.equal(called, 1, 'serializeFn must run immediately')
    assert.ok(existsSync(stateFile), 'state file exists after flush')
    const contents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(contents.sessions[0].name, 'Flushed')
  })

  it('cancels any pending debounce before flushing', () => {
    mock.timers.enable()
    try {
      const p = new SessionStatePersistence({ stateFilePath: stateFile, persistDebounceMs: 100 })
      let debouncedCalls = 0
      p.schedulePersist(() => { debouncedCalls++ })
      assert.ok(p._persistTimer !== null, 'debounced write is pending')

      let flushedCalls = 0
      p.flushPersist(() => { flushedCalls++ })
      assert.equal(flushedCalls, 1, 'flushPersist runs immediately')
      assert.equal(p._persistTimer, null, 'pending timer was cancelled')

      mock.timers.tick(500)
      assert.equal(debouncedCalls, 0, 'debounced write no longer fires')
      p.destroy()
    } finally {
      mock.timers.reset()
    }
  })

  it('catches errors from serializeFn', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.doesNotThrow(() => {
      p.flushPersist(() => { throw new Error('boom') })
    })
  })
})

describe('SessionStatePersistence backup rotation (regression: #2906)', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-bak-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('rotates the previous state file to .bak on each write', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's1', name: 'First', cwd: '/tmp' }] })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's2', name: 'Second', cwd: '/tmp' }] })

    assert.ok(existsSync(stateFile + '.bak'), '.bak file should exist')
    const bak = JSON.parse(readFileSync(stateFile + '.bak', 'utf-8'))
    assert.equal(bak.sessions[0].name, 'First', '.bak should hold the prior generation')
    const main = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(main.sessions[0].name, 'Second')
  })

  it('does not fail on the first write (no prior file to rotate)', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.doesNotThrow(() => {
      p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's1', name: 'Fresh', cwd: '/tmp' }] })
    })
    assert.ok(existsSync(stateFile))
    assert.equal(existsSync(stateFile + '.bak'), false, 'no .bak before any rotation')
  })

  it('recovers from .bak when main file is missing', () => {
    writeFileSync(stateFile + '.bak', JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ id: 's1', name: 'FromBak', cwd: '/tmp' }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const restored = p.restoreState()
    assert.ok(restored, 'restoreState should succeed from .bak')
    assert.equal(restored.sessions[0].name, 'FromBak')
  })

  it('recovers from .bak when main file is corrupt JSON', () => {
    writeFileSync(stateFile, 'not valid json')
    writeFileSync(stateFile + '.bak', JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ id: 's1', name: 'FromBak', cwd: '/tmp' }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const restored = p.restoreState()
    assert.ok(restored, 'restoreState falls back to .bak when main is corrupt')
    assert.equal(restored.sessions[0].name, 'FromBak')
    // Main file should be removed (it was unparseable), .bak preserved as a last-resort copy
    assert.equal(existsSync(stateFile), false)
    assert.ok(existsSync(stateFile + '.bak'), '.bak preserved for future recovery')
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
