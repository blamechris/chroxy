import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

/**
 * Tests for SessionManager serialization, restoration, and allIdle.
 *
 * All filesystem tests use temp directories via stateFilePath to avoid
 * writing to real ~/.chroxy/session-state.json (see #429).
 */

describe('SessionManager.allIdle', () => {
  it('returns true when no sessions exist', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.allIdle(), true)
  })

  it('returns true when all sessions are idle', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    const session1 = new EventEmitter()
    session1.isRunning = false
    session1.destroy = () => {}
    mgr._sessions.set('s1', { session: session1, type: 'cli', name: 'S1', cwd: '/tmp' })

    const session2 = new EventEmitter()
    session2.isRunning = false
    session2.destroy = () => {}
    mgr._sessions.set('s2', { session: session2, type: 'cli', name: 'S2', cwd: '/tmp' })

    assert.equal(mgr.allIdle(), true)
  })

  it('returns false when any session is busy', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    const session1 = new EventEmitter()
    session1.isRunning = false
    session1.destroy = () => {}
    mgr._sessions.set('s1', { session: session1, type: 'cli', name: 'S1', cwd: '/tmp' })

    const session2 = new EventEmitter()
    session2.isRunning = true
    session2.destroy = () => {}
    mgr._sessions.set('s2', { session: session2, type: 'cli', name: 'S2', cwd: '/tmp' })

    assert.equal(mgr.allIdle(), false)
  })
})

describe('SessionManager.serializeState', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-session-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes state file with session data', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const session1 = new EventEmitter()
    session1.model = 'claude-sonnet-4-20250514'
    session1.permissionMode = 'approve'
    Object.defineProperty(session1, 'resumeSessionId', { get: () => 'sdk-abc-123' })
    session1.destroy = () => {}
    mgr._sessions.set('chroxy-1', { session: session1, type: 'cli', name: 'Project A', cwd: '/tmp/a' })

    const session2 = new EventEmitter()
    session2.model = 'claude-opus-4-20250514'
    session2.permissionMode = 'auto'
    Object.defineProperty(session2, 'resumeSessionId', { get: () => null })
    session2.destroy = () => {}
    mgr._sessions.set('chroxy-2', { session: session2, type: 'cli', name: 'Project B', cwd: '/tmp/b' })

    const state = mgr.serializeState()

    assert.equal(state.sessions.length, 2)
    assert.ok(state.timestamp > 0)
    assert.equal(state.sessions[0].sdkSessionId, 'sdk-abc-123')
    assert.equal(state.sessions[0].name, 'Project A')
    assert.equal(state.sessions[0].cwd, '/tmp/a')
    assert.equal(state.sessions[0].model, 'claude-sonnet-4-20250514')
    assert.equal(state.sessions[1].sdkSessionId, null)

    assert.ok(existsSync(stateFile), 'State file should exist')
    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(fileContents.sessions.length, 2)
  })

  it('includes version field', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    const state = mgr.serializeState()
    assert.equal(state.version, 1)
    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(fileContents.version, 1)
  })

  it('includes message history per session', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })
    mgr._messageHistory.set('s1', [
      { type: 'message', messageType: 'user', content: 'hello', timestamp: 1000 },
      { type: 'message', messageType: 'response', content: 'world', timestamp: 2000 },
    ])

    const state = mgr.serializeState()
    assert.equal(state.sessions[0].history.length, 2)
    assert.equal(state.sessions[0].history[0].content, 'hello')
    assert.equal(state.sessions[0].history[1].content, 'world')
  })

  it('truncates large content in serialized history', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    const largeContent = 'x'.repeat(100 * 1024) // 100KB
    mgr._messageHistory.set('s1', [
      { type: 'message', messageType: 'response', content: largeContent, timestamp: 1000 },
    ])

    const state = mgr.serializeState()

    // Serialized version should be truncated
    assert.ok(state.sessions[0].history[0].content.length < 60 * 1024)
    assert.ok(state.sessions[0].history[0].content.endsWith('[truncated]'))

    // In-memory original should be untouched
    const inMemory = mgr._messageHistory.get('s1')
    assert.equal(inMemory[0].content.length, 100 * 1024)
  })

  it('truncates large input in tool_start entries', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    const largeInput = 'y'.repeat(100 * 1024)
    mgr._messageHistory.set('s1', [
      { type: 'tool_start', tool: 'Read', input: largeInput, timestamp: 1000 },
    ])

    const state = mgr.serializeState()
    assert.ok(state.sessions[0].history[0].input.endsWith('[truncated]'))
    assert.equal(mgr._messageHistory.get('s1')[0].input.length, 100 * 1024)
  })

  it('uses atomic write (no .tmp file remains)', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    mgr.serializeState()
    assert.ok(existsSync(stateFile), 'State file should exist')
    assert.equal(existsSync(stateFile + '.tmp'), false, '.tmp file should not remain')
  })

  it('skips PTY sessions', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const cliSession = new EventEmitter()
    cliSession.model = 'sonnet'
    cliSession.permissionMode = 'approve'
    Object.defineProperty(cliSession, 'resumeSessionId', { get: () => null })
    cliSession.destroy = () => {}
    mgr._sessions.set('cli-1', { session: cliSession, type: 'cli', name: 'CLI', cwd: '/tmp' })

    const ptySession = new EventEmitter()
    ptySession.model = null
    ptySession.destroy = () => {}
    mgr._sessions.set('pty-1', { session: ptySession, type: 'pty', name: 'PTY', cwd: '/tmp' })

    const state = mgr.serializeState()
    assert.equal(state.sessions.length, 1, 'PTY session should be skipped')
    assert.equal(state.sessions[0].sdkSessionId, null)
  })

  it('creates directory if needed', () => {
    const nestedFile = join(tempDir, 'nested', 'session-state.json')
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: nestedFile })
    const state = mgr.serializeState()
    assert.equal(state.sessions.length, 0)
    assert.ok(existsSync(nestedFile), 'State file should be created')
  })
})

describe('SessionManager.restoreState', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-session-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null when no state file exists', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null)
  })

  it('returns null for invalid JSON', () => {
    writeFileSync(stateFile, 'not json')
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null)
    assert.equal(existsSync(stateFile), false, 'Invalid state file should be removed')
  })

  it('returns null for empty sessions array', () => {
    writeFileSync(stateFile, JSON.stringify({ timestamp: Date.now(), sessions: [] }))
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null)
  })

  it('returns null for state older than TTL', () => {
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000 // 25 hours
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: staleTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))
    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null, 'State older than 24h should be rejected')
  })

  it('accepts state within TTL (23h old)', () => {
    const recentTimestamp = Date.now() - 23 * 60 * 60 * 1000 // 23 hours
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: recentTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))
    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId, '23h old state should be accepted (within 24h TTL)')
    mgr.destroyAll()
  })

  it('respects custom stateTtlMs', () => {
    const staleTimestamp = Date.now() - 6 * 60 * 1000 // 6 minutes
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: staleTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))
    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile, stateTtlMs: 5 * 60 * 1000 })
    assert.equal(mgr.restoreState(), null, 'State older than custom 5min TTL should be rejected')
  })

  it('restores sessions from valid state file', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'Session A', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: 'sdk-resume-1' },
        { name: 'Session B', cwd: '/tmp', model: null, permissionMode: 'auto', sdkSessionId: null },
      ],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId, 'Should return the first restored session ID')

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 2, 'Should have 2 restored sessions')

    mgr.destroyAll()
  })

  it('keeps state file after restore', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    assert.ok(existsSync(stateFile), 'State file should be kept after restore')
    mgr.destroyAll()
  })

  it('restores message history from v1 state', () => {
    const history = [
      { type: 'message', messageType: 'user', content: 'hello', timestamp: 1000 },
      { type: 'message', messageType: 'response', content: 'world', timestamp: 2000 },
      { type: 'result', cost: 0.01, duration: 500, timestamp: 3000 },
    ]
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history }],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId)

    const restored = mgr.getHistory(firstId)
    assert.equal(restored.length, 3)
    assert.equal(restored[0].content, 'hello')
    assert.equal(restored[1].content, 'world')
    assert.equal(restored[2].cost, 0.01)

    mgr.destroyAll()
  })

  it('handles legacy state without version (skips history)', () => {
    writeFileSync(stateFile, JSON.stringify({
      timestamp: Date.now(),
      sessions: [{ name: 'Legacy', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history: [{ type: 'message', content: 'old' }] }],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId, 'Legacy state should still restore metadata')

    const history = mgr.getHistory(firstId)
    assert.equal(history.length, 0, 'History should not be restored from legacy (versionless) state')

    mgr.destroyAll()
  })

  it('continues if one session fails to restore', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'Good', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
        { name: 'Bad', cwd: '/nonexistent/path/that/does/not/exist', model: null, permissionMode: 'approve', sdkSessionId: null },
      ],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId, 'Should return the first successfully restored session')

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 1, 'Only the good session should be restored')

    mgr.destroyAll()
  })
})

describe('SessionManager auto-persist', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-session-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('debounces rapid _schedulePersist calls into a single write', () => {
    mock.timers.enable()
    try {
      const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile, persistDebounceMs: 100 })

      const session = new EventEmitter()
      session.model = 'sonnet'
      session.permissionMode = 'approve'
      Object.defineProperty(session, 'resumeSessionId', { get: () => null })
      session.destroy = () => {}
      mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

      let writeCount = 0
      const origSerialize = mgr.serializeState.bind(mgr)
      mgr.serializeState = () => {
        writeCount++
        return origSerialize()
      }

      // Rapid-fire 5 persist requests
      mgr._schedulePersist()
      mgr._schedulePersist()
      mgr._schedulePersist()
      mgr._schedulePersist()
      mgr._schedulePersist()

      // Should not have written yet (debounce delay)
      assert.equal(writeCount, 0)

      // Advance mocked time past the debounce
      mock.timers.tick(150)

      assert.equal(writeCount, 1, 'Should have written exactly once after debounce')
      clearTimeout(mgr._persistTimer)
    } finally {
      mock.timers.reset()
    }
  })

  it('destroyAll writes final state synchronously', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Final', cwd: '/tmp' })

    mgr.destroyAll()

    assert.ok(existsSync(stateFile), 'State file should exist immediately after destroyAll')
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(state.version, 1)
    // Sessions were serialized before clear
    assert.equal(state.sessions.length, 1)
    assert.equal(state.sessions[0].name, 'Final')
  })
})
