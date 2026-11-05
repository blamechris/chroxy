import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs'
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

  // #5309 (WP-0.3) — serializeState must route its atomic temp through a
  // per-pid suffix, not writeFileRestricted's shared default `.tmp`, so a second
  // process writing the same state file can't clobber a shared intermediate.
  // Proof without forking: occupy the DEFAULT `.tmp` path with a directory — if
  // serializeState used the default suffix it would EISDIR; succeeding proves it
  // routes through `.tmp-<pid>` instead. (Binds the caller fix, not just the
  // platform primitive, which is covered by the #4874 platform test.)
  it('routes its atomic temp through a per-pid suffix, not the shared .tmp (#5309)', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    mkdirSync(`${stateFile}.tmp`) // booby-trap the shared default temp path
    const state = { version: 1, timestamp: Date.now(), sessions: [{ id: 's1', name: 'A', cwd: '/tmp' }] }
    assert.doesNotThrow(() => p.serializeState(state), 'must not write through the shared .tmp')
    assert.strictEqual(JSON.parse(readFileSync(stateFile, 'utf-8')).sessions[0].id, 's1')
    // The per-pid temp is renamed into place, leaving no orphan after success.
    assert.strictEqual(existsSync(`${stateFile}.tmp-${process.pid}`), false, 'per-pid temp cleaned after rename')
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

describe('SessionStatePersistence.flushPersist (#5701)', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-flush-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns true when the write succeeds', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const ok = p.flushPersist(() => p.serializeState({ version: 1, timestamp: Date.now(), sessions: [] }))
    assert.strictEqual(ok, true)
  })

  it('returns false (no longer swallows) when the serialize throws', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const ok = p.flushPersist(() => { throw new Error('ENOSPC: no space left on device') })
    assert.strictEqual(ok, false)
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

  it('does not restore state older than TTL, and hands the entry over (#7627)', () => {
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: staleTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp', history: [{ role: 'user', content: 'x' }] }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    // #7627: still not RESTORED (the guard), but no longer deleted unseen — the
    // entry is handed to SessionManager, which is the only layer that can tell a
    // merely-stale session from one whose restore would refuse.
    const out = p.restoreState()
    assert.deepEqual(out.sessions, [], 'nothing stale is offered for restore')
    assert.equal(out.staleSessions.length, 1, 'and the entry survives for adjudication')
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
      sessions: [{ name: 'test', cwd: '/tmp', history: [{ role: 'user', content: 'x' }] }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile, stateTtlMs: 5 * 60 * 1000 })
    const out = p.restoreState()
    assert.deepEqual(out.sessions, [], 'State older than the custom 5min TTL is still not restored')
    assert.equal(out.staleSessions.length, 1, 'the custom TTL selects which entries are set aside (#7627)')
  })

  it('drops only the stale sessions, keeping fresh ones by per-entry lastActivityAt (audit P2-12)', () => {
    const now = Date.now()
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      // Whole-file timestamp is old enough that the legacy whole-file check
      // would have discarded EVERYTHING.
      timestamp: now - 25 * 60 * 60 * 1000,
      sessions: [
        { id: 'stale', name: 'Stale', cwd: '/tmp', lastActivityAt: now - 25 * 60 * 60 * 1000, history: [{ role: 'user', content: 'x' }] },
        { id: 'fresh', name: 'Fresh', cwd: '/tmp', lastActivityAt: now - 60 * 1000 },
      ],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const result = p.restoreState()
    assert.ok(result, 'fresh session keeps the restore alive')
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0].id, 'fresh')
  })

  it('restores none when every session is individually stale, setting all aside (audit P2-12, #7627)', () => {
    const now = Date.now()
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: now,
      sessions: [
        { id: 'a', name: 'A', cwd: '/tmp', lastActivityAt: now - 25 * 60 * 60 * 1000, history: [{ role: 'user', content: 'x' }] },
        { id: 'b', name: 'B', cwd: '/tmp', lastActivityAt: now - 26 * 60 * 60 * 1000, history: [{ role: 'user', content: 'x' }] },
      ],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const out = p.restoreState()
    assert.deepEqual(out.sessions, [], 'neither individually-stale session is restored')
    assert.deepEqual(out.staleSessions.map(x => x.id), ['a', 'b'], 'both are set aside, in order (#7627)')
  })

  it('returns null for an EMPTY session list (the guard an all-stale file no longer reaches)', () => {
    // Named for what it actually exercises: the `sessions.length === 0` guard.
    // It was previously named for the all-stale early return, which #7627 made
    // unreachable — the loop partitions a non-empty list into fresh ∪ stale, so
    // "no fresh AND no stale" cannot happen and that branch is gone. This test
    // never reached it either way, which is exactly why the name mattered.
    writeFileSync(stateFile, JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [] }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.equal(p.restoreState(), null)
  })

  it('an ALL-stale file is no longer null — it carries every entry for adjudication (#7627)', () => {
    const stale = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(stateFile, JSON.stringify({
      version: 1, timestamp: stale,
      sessions: [{ id: 'a', name: 'A', cwd: '/tmp', lastActivityAt: stale, history: [{ role: 'user', content: 'x' }] }],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const out = p.restoreState()
    assert.notEqual(out, null, 'the all-stale case is a result now, not an absence')
    assert.deepEqual(out.sessions, [])
    assert.deepEqual(out.staleSessions.map(x => x.id), ['a'])
  })

  it('restores a stale session that has NO history instead of setting it aside (#8870)', () => {
    // Setting it aside ends in the archive skipping it (nothing to read), so it
    // left the list with no record — the startup "Default" vanished overnight.
    const stale = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(stateFile, JSON.stringify({
      version: 1, timestamp: stale,
      sessions: [
        { id: 'empty', name: 'Default', cwd: '/tmp', lastActivityAt: stale, history: [] },
        // No `history` field at all: unknown content falls on the keep side,
        // because the archive would skip it too.
        { id: 'legacy', name: 'No field', cwd: '/tmp', lastActivityAt: stale },
        { id: 'full', name: 'Work', cwd: '/tmp', lastActivityAt: stale, history: [{ role: 'user', content: 'x' }] },
      ],
    }))
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    const out = p.restoreState()
    assert.deepEqual(out.sessions.map(x => x.id), ['empty', 'legacy'], 'both history-less entries are offered for restore')
    assert.deepEqual(out.staleSessions.map(x => x.id), ['full'], 'only the one with history is set aside, for the archive')
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

  // #4908 crash-safety pin: serializeState was collapsed onto the shared
  // writeFileRestricted helper. The key invariant pinned here is that rotation
  // must happen BEFORE the main-path write so `.bak` always captures the prior
  // generation — without reintroducing a bespoke tmp+rename layer on top of
  // the shared helper. Reversing the order (write-then-rotate) would mean a
  // successful write followed by rotation would copy the NEW generation into
  // `.bak`, overwriting the recoverable prior generation. Spy on the instance's
  // `_rotateToBak` method (instance binding, not an imported one, so we can
  // replace it directly) and capture filesystem state at the moment rotation
  // is invoked.
  it('rotates BEFORE writing the new generation (crash-safety pin for #4908)', () => {
    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 'gen1', name: 'Gen1', cwd: '/tmp' }] })

    // Capture main file contents at the moment _rotateToBak runs. Rotate-then-
    // write means main still holds Gen1 at this point; write-then-rotate would
    // mean main already holds Gen2.
    let mainAtRotation = null
    const originalRotate = p._rotateToBak.bind(p)
    p._rotateToBak = function spyRotate(mainPath, bakPath) {
      mainAtRotation = existsSync(mainPath) ? JSON.parse(readFileSync(mainPath, 'utf-8')) : null
      return originalRotate(mainPath, bakPath)
    }

    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 'gen2', name: 'Gen2', cwd: '/tmp' }] })

    assert.ok(mainAtRotation, '_rotateToBak must be called while main still exists (rotate-then-write order)')
    assert.equal(mainAtRotation.sessions[0].name, 'Gen1',
      'at rotation time, main must hold the PRIOR generation — proves rotation runs BEFORE the new write')

    const main = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const bak = JSON.parse(readFileSync(stateFile + '.bak', 'utf-8'))
    assert.equal(main.sessions[0].name, 'Gen2')
    assert.equal(bak.sessions[0].name, 'Gen1')
  })
})

describe('SessionStatePersistence Windows .bak rotation (regression: #2908)', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-win-bak-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    mock.restoreAll()
  })

  function makeFsError(code, msg) {
    const err = new Error(msg ?? `${code}: simulated`)
    err.code = code
    return err
  }

  it('retries rotation after clearing a locked .bak on Windows (EPERM)', () => {
    // Seed a prior main file and a stale .bak (as would exist after prior write).
    writeFileSync(stateFile, JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [{ id: 'prev', name: 'Previous', cwd: '/tmp' }] }))
    writeFileSync(stateFile + '.bak', 'stale-bak-contents')

    const originalRename = fs.renameSync
    const originalUnlink = fs.unlinkSync
    let renameCalls = 0
    let unlinkedBak = false

    mock.method(fs, 'renameSync', (src, dst) => {
      renameCalls++
      // First call is the rotate attempt: simulate Windows EPERM on locked .bak
      if (renameCalls === 1 && dst === stateFile + '.bak') {
        throw makeFsError('EPERM', 'operation not permitted, rename')
      }
      return originalRename(src, dst)
    })
    mock.method(fs, 'unlinkSync', (p) => {
      if (p === stateFile + '.bak') unlinkedBak = true
      return originalUnlink(p)
    })

    const p = new SessionStatePersistence({ stateFilePath: stateFile, isWindowsOverride: true })
    assert.doesNotThrow(() => {
      p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 'new', name: 'New', cwd: '/tmp' }] })
    })

    assert.ok(unlinkedBak, 'should unlink the locked .bak before retrying rotation')
    // Rename called twice via fs.renameSync (rotation path): (1) initial rotate
    // (threw EPERM), (2) retry rotate (succeeded). The final main-file write is
    // delegated to writeFileRestricted (#4908 collapse) which imports its rename
    // binding directly from 'fs' as a named import — that call bypasses
    // mock.method(fs, 'renameSync', ...) so it is not visible here. The
    // existsSync post-condition verifies the write happened.
    assert.equal(renameCalls, 2, 'fs.renameSync called twice in rotation path: initial rotate + retry (final write goes through writeFileRestricted)')
    assert.ok(existsSync(stateFile), 'main state file should exist after serialize')
    assert.ok(existsSync(stateFile + '.bak'), '.bak should exist after successful retry')
    const bak = JSON.parse(readFileSync(stateFile + '.bak', 'utf-8'))
    assert.equal(bak.sessions[0].name, 'Previous', '.bak should hold the prior generation after retry')
  })

  it('proceeds with the main write even if rotation retry still fails on Windows', () => {
    writeFileSync(stateFile, JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [{ id: 'prev', name: 'Previous', cwd: '/tmp' }] }))

    const originalRename = fs.renameSync
    let renameCalls = 0

    mock.method(fs, 'renameSync', (src, dst) => {
      renameCalls++
      // Fail both rotate attempts (main → .bak), let the final tmp → main succeed.
      if (dst === stateFile + '.bak') {
        throw makeFsError('EBUSY', 'resource busy or locked, rename')
      }
      return originalRename(src, dst)
    })

    const p = new SessionStatePersistence({ stateFilePath: stateFile, isWindowsOverride: true })
    assert.doesNotThrow(() => {
      p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 'new', name: 'New', cwd: '/tmp' }] })
    })

    // fs.renameSync called twice (rotation initial + retry, both threw EBUSY).
    // The main write goes through writeFileRestricted whose internal rename
    // bypasses mock.method(fs, ...) — see the EPERM test above. The existsSync
    // post-condition verifies the new generation was still written.
    assert.ok(renameCalls >= 2, 'rotate attempted twice (initial + retry)')
    assert.ok(existsSync(stateFile), 'main state file must still be written when rotation fails')
    const main = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(main.sessions[0].name, 'New', 'new state should be persisted even if .bak rotation failed')
  })

  it('does not retry rotation on POSIX (single rename attempt, no unlink)', () => {
    writeFileSync(stateFile, JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [{ id: 'prev', name: 'Previous', cwd: '/tmp' }] }))

    const originalRename = fs.renameSync
    let rotateAttempts = 0
    let unlinkOfBak = 0

    mock.method(fs, 'renameSync', (src, dst) => {
      if (dst === stateFile + '.bak') {
        rotateAttempts++
        throw makeFsError('EPERM', 'should not retry on POSIX')
      }
      return originalRename(src, dst)
    })
    mock.method(fs, 'unlinkSync', (p) => {
      if (p === stateFile + '.bak') unlinkOfBak++
      // Don't invoke real unlink for .bak — the rotate never happened so there's nothing to clean
    })

    const p = new SessionStatePersistence({ stateFilePath: stateFile, isWindowsOverride: false })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 'new', name: 'New', cwd: '/tmp' }] })

    assert.equal(rotateAttempts, 1, 'POSIX path must not retry rotation')
    assert.equal(unlinkOfBak, 0, 'POSIX path must not unlink the .bak (rename replaces atomically)')
  })

  it('restores the prior .bak if the retry rename fails (source was locked, not destination)', () => {
    // Seed a prior main file and an existing valid .bak holding the prior generation.
    writeFileSync(stateFile, JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [{ id: 'cur', name: 'Current', cwd: '/tmp' }] }))
    const priorBakContents = JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [{ id: 'old', name: 'PriorGen', cwd: '/tmp' }] })
    writeFileSync(stateFile + '.bak', priorBakContents)

    const originalRename = fs.renameSync
    // Simulate the source being locked: every rotate attempt throws EPERM,
    // but tmp → main succeeds (so state write still happens).
    mock.method(fs, 'renameSync', (src, dst) => {
      if (dst === stateFile + '.bak') {
        throw makeFsError('EPERM', 'operation not permitted, rename (source locked)')
      }
      return originalRename(src, dst)
    })

    const p = new SessionStatePersistence({ stateFilePath: stateFile, isWindowsOverride: true })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 'new', name: 'New', cwd: '/tmp' }] })

    // Prior generation must still be recoverable from .bak even though both
    // rotation attempts failed — we snapshotted and restored it.
    assert.ok(existsSync(stateFile + '.bak'), '.bak must be restored after retry failure')
    const bak = JSON.parse(readFileSync(stateFile + '.bak', 'utf-8'))
    assert.equal(bak.sessions[0].name, 'PriorGen', 'prior generation .bak contents must be preserved')
  })

  it('does not retry rotation for unrelated error codes on Windows', () => {
    writeFileSync(stateFile, JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [{ id: 'prev', name: 'Previous', cwd: '/tmp' }] }))

    const originalRename = fs.renameSync
    let rotateAttempts = 0

    mock.method(fs, 'renameSync', (src, dst) => {
      if (dst === stateFile + '.bak') {
        rotateAttempts++
        throw makeFsError('EIO', 'I/O error, not a lock')
      }
      return originalRename(src, dst)
    })

    const p = new SessionStatePersistence({ stateFilePath: stateFile, isWindowsOverride: true })
    p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 'new', name: 'New', cwd: '/tmp' }] })

    assert.equal(rotateAttempts, 1, 'non-lock errors should not trigger retry')
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

describe('SessionStatePersistence rename-failure cleanup (regression: #2909)', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-rename-fail-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // Force both the .bak rotation and the final rename to fail by making
  // `<stateFile>` and `<stateFile>.bak` non-empty directories. `renameSync`
  // into a non-empty directory fails with ENOTEMPTY/EISDIR on POSIX, which
  // is the closest portable analogue of a "transient FS error".
  function blockRename() {
    mkdirSync(stateFile)
    writeFileSync(join(stateFile, 'sentinel'), 'block main rename')
    mkdirSync(stateFile + '.bak')
    writeFileSync(join(stateFile + '.bak', 'sentinel'), 'block bak rename')
  }

  it('removes the orphaned .tmp file when the final rename fails', () => {
    blockRename()

    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.throws(
      () => p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's1', name: 'T', cwd: '/tmp' }] }),
      /EISDIR|ENOTEMPTY|EEXIST|EPERM|EACCES/
    )

    assert.equal(existsSync(stateFile + '.tmp'), false, 'orphaned .tmp file must be cleaned up')
  })

  it('surfaces the original rename error (does not swallow)', () => {
    blockRename()

    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    let caught = null
    try {
      p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's1', name: 'T', cwd: '/tmp' }] })
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'serializeState must re-throw')
    const okCodes = new Set(['EISDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'])
    assert.ok(okCodes.has(caught.code), `unexpected error code: ${caught.code}`)
  })

  it('does not leak .tmp across repeated rename failures', () => {
    blockRename()

    const p = new SessionStatePersistence({ stateFilePath: stateFile })
    assert.throws(() => p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's1', name: 'T', cwd: '/tmp' }] }))
    assert.throws(() => p.serializeState({ version: 1, timestamp: Date.now(), sessions: [{ id: 's2', name: 'U', cwd: '/tmp' }] }))
    assert.equal(existsSync(stateFile + '.tmp'), false, '.tmp should never leak across repeated failures')
  })
})

// #8954 — the debounce used to reset on every call, so a continuously active
// turn postponed the write for its whole duration.
describe('SessionStatePersistence.schedulePersist max-wait (#8954)', () => {
  // The mocked-timer tests below drive the clock through mocked Date; the
  // real-timer tests at the end use the default (monotonic) clock.
  const make = (opts) => new SessionStatePersistence({ stateFilePath: join(tmpdir(), 'chroxy-persist-maxwait-test.json'), now: () => Date.now(), ...opts })
  const makeReal = (opts) => new SessionStatePersistence({ stateFilePath: join(tmpdir(), 'chroxy-persist-maxwait-test.json'), ...opts })
  // Deadline-based wait (never a tick count): resolves true as soon as pred()
  // holds, false once `ms` of real time has passed.
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (pred()) return true
      await new Promise((r) => setTimeout(r, 5))
    }
    return pred()
  }

  it('writes by persistMaxWaitMs while calls keep arriving faster than the debounce', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const p = make({ persistDebounceMs: 2000, persistMaxWaitMs: 10_000 })
    try {
      let writes = 0
      const fn = () => { writes++ }
      // Stream for 9.5s with a call every 500ms: the debounce alone never fires.
      for (let t = 0; t < 9500; t += 500) {
        p.schedulePersist(fn)
        mock.timers.tick(500)
      }
      assert.equal(writes, 0, 'no write before the max-wait')
      p.schedulePersist(fn)
      mock.timers.tick(500) // t = 10_000
      assert.equal(writes, 1, 'a write must land by persistMaxWaitMs')

      // The max-wait window restarts for the next stream.
      for (let t = 0; t < 9500; t += 500) {
        p.schedulePersist(fn)
        mock.timers.tick(500)
      }
      assert.equal(writes, 1)
      p.schedulePersist(fn)
      mock.timers.tick(500)
      assert.equal(writes, 2, 'second window also bounded')
    } finally {
      p.destroy()
      mock.timers.reset()
    }
  })

  it('still coalesces a short burst into one trailing write', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const p = make({ persistDebounceMs: 2000, persistMaxWaitMs: 10_000 })
    try {
      let writes = 0
      const fn = () => { writes++ }
      for (let i = 0; i < 5; i++) { p.schedulePersist(fn); mock.timers.tick(100) }
      assert.equal(writes, 0)
      mock.timers.tick(1899)
      assert.equal(writes, 0, 'trailing debounce not yet elapsed')
      mock.timers.tick(1)
      assert.equal(writes, 1, 'exactly one trailing write')
      mock.timers.tick(30_000)
      assert.equal(writes, 1, 'nothing further scheduled')
      assert.equal(p._persistTimer, null)
    } finally {
      p.destroy()
      mock.timers.reset()
    }
  })

  it('cancelPersist and destroy leave no timer behind and reset the max-wait anchor', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const p = make({ persistDebounceMs: 2000, persistMaxWaitMs: 10_000 })
    try {
      let writes = 0
      const fn = () => { writes++ }
      p.schedulePersist(fn)
      mock.timers.tick(1500)
      p.cancelPersist()
      assert.equal(p._persistTimer, null)
      assert.equal(p._persistPendingSince, null)
      mock.timers.tick(60_000)
      assert.equal(writes, 0)
      // A fresh schedule after cancel uses a fresh window, not a stale anchor.
      p.schedulePersist(fn)
      mock.timers.tick(1999)
      assert.equal(writes, 0)
      mock.timers.tick(1)
      assert.equal(writes, 1)
      p.schedulePersist(fn)
      p.destroy()
      assert.equal(p._persistTimer, null)
      mock.timers.tick(60_000)
      assert.equal(writes, 1)
    } finally {
      mock.timers.reset()
    }
  })

  it('flushPersist cancels the pending timer and anchor', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const p = make({ persistDebounceMs: 2000, persistMaxWaitMs: 10_000 })
    try {
      let writes = 0
      p.schedulePersist(() => { writes++ })
      p.flushPersist(() => {})
      assert.equal(p._persistTimer, null)
      assert.equal(p._persistPendingSince, null)
      mock.timers.tick(60_000)
      assert.equal(writes, 0)
    } finally {
      mock.timers.reset()
    }
  })

  it('is configurable and defaults to 10s', () => {
    assert.equal(make()._persistMaxWaitMs, 10_000)
    assert.equal(make({ persistMaxWaitMs: 3000 })._persistMaxWaitMs, 3000)
  })

  it('still writes by max-wait when the wall clock jumps backwards mid-stream', async () => {
    const p = makeReal({ persistDebounceMs: 60, persistMaxWaitMs: 150 })
    const realNow = Date.now.bind(Date)
    let writes = 0
    const fn = () => { writes++ }
    let ticker
    try {
      p.schedulePersist(fn)
      // Wall clock rolls back a minute; timers (monotonic) are unaffected.
      mock.method(Date, 'now', () => realNow() - 60_000)
      ticker = setInterval(() => p.schedulePersist(fn), 20)
      assert.ok(await waitFor(() => writes >= 1, 3000), 'a write must land by max-wait despite the rollback')
    } finally {
      clearInterval(ticker)
      mock.restoreAll()
      p.destroy()
    }
  })

  it('does not cancel and re-arm a timer that is already overdue', () => {
    // Injected monotonic clock + mocked timers: the clock is moved past the
    // deadline WITHOUT running the pending callback, which is exactly "a
    // scheduling call runs before the overdue timer callback".
    mock.timers.enable({ apis: ['setTimeout'] })
    let clock = 0
    const p = makeReal({ persistDebounceMs: 5, persistMaxWaitMs: 20, now: () => clock })
    try {
      let writes = 0
      const fn = () => { writes++ }
      p.schedulePersist(fn)
      const armed = p._persistTimer
      clock = 25 // past the deadline, timer callback has not run yet
      for (let i = 0; i < 50; i++) { clock += 1; p.schedulePersist(fn) }
      assert.equal(p._persistTimer, armed, 'the overdue timer must be left alone')
      mock.timers.tick(5)
      assert.equal(writes, 1, 'the overdue timer fires and writes once')
      assert.equal(p._persistTimer, null)
    } finally {
      p.destroy()
      mock.timers.reset()
    }
  })

  it('end to end: writes even when scheduling calls run before the overdue timer callback every time', async () => {
    const p = makeReal({ persistDebounceMs: 5, persistMaxWaitMs: 20 })
    let writes = 0
    const fn = () => { writes++ }
    let stop = false
    const pump = () => {
      if (stop) return
      p.schedulePersist(fn)
      setImmediate(pump)
    }
    try {
      pump()
      assert.ok(await waitFor(() => writes >= 1, 3000), 'an overdue timer must not be cancelled and re-armed forever')
    } finally {
      stop = true
      p.destroy()
    }
  })
})
