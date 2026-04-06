import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager, formatIdleDuration } from '../src/session-manager.js'

/**
 * Tests for SessionManager serialization, restoration, and allIdle.
 *
 * CRITICAL: Every SessionManager instance MUST use a temp stateFilePath.
 * Without it, tests write to real ~/.chroxy/session-state.json, contaminating
 * the user's server with test data like name:'S1', cwd:'/tmp' (see #429, #2314).
 */

// Module-level temp dir for tests that don't manage their own.
// Each call returns a unique file path to avoid cross-test interference.
let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'sm-global-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

describe('SessionManager.allIdle', () => {
  it('returns true when no sessions exist', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.allIdle(), true)
  })

  it('returns true when all sessions are idle', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
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

  it('serializes CLI sessions', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const cliSession = new EventEmitter()
    cliSession.model = 'sonnet'
    cliSession.permissionMode = 'approve'
    Object.defineProperty(cliSession, 'resumeSessionId', { get: () => null })
    cliSession.destroy = () => {}
    mgr._sessions.set('cli-1', { session: cliSession, name: 'CLI', cwd: '/tmp' })

    const state = mgr.serializeState()
    assert.equal(state.sessions.length, 1)
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

describe('SessionManager.getConversationId', () => {
  it('returns resumeSessionId when available', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    Object.defineProperty(session, 'resumeSessionId', { get: () => 'conv-uuid-123' })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    assert.equal(mgr.getConversationId('s1'), 'conv-uuid-123')
  })

  it('returns null when resumeSessionId is not set', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    assert.equal(mgr.getConversationId('s1'), null)
  })

  it('returns null for nonexistent session', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.getConversationId('nonexistent'), null)
  })
})

describe('SessionManager.listSessions includes conversationId', () => {
  it('includes conversationId in session list entries', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const session1 = new EventEmitter()
    session1.isRunning = false
    Object.defineProperty(session1, 'resumeSessionId', { get: () => 'conv-aaa' })
    session1.destroy = () => {}
    mgr._sessions.set('s1', { session: session1, type: 'cli', name: 'A', cwd: '/tmp/a', createdAt: Date.now() })

    const session2 = new EventEmitter()
    session2.isRunning = false
    Object.defineProperty(session2, 'resumeSessionId', { get: () => null })
    session2.destroy = () => {}
    mgr._sessions.set('s2', { session: session2, type: 'cli', name: 'B', cwd: '/tmp/b', createdAt: Date.now() })

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 2)

    const s1 = sessions.find(s => s.name === 'A')
    assert.equal(s1.conversationId, 'conv-aaa')

    const s2 = sessions.find(s => s.name === 'B')
    assert.equal(s2.conversationId, null)
  })
})

describe('SessionManager provider support', () => {
  it('defaults to claude-sdk provider', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._providerType, 'claude-sdk')
  })

  it('accepts providerType parameter', () => {
    const mgr = new SessionManager({ maxSessions: 5, providerType: 'claude-cli', stateFilePath: tmpStateFile() })
    assert.equal(mgr._providerType, 'claude-cli')
  })

  it('listSessions includes provider and capabilities', () => {
    const mgr = new SessionManager({ maxSessions: 5, providerType: 'claude-sdk', stateFilePath: tmpStateFile() })

    // Manually insert a mock session with a constructor that has capabilities
    class MockProvider extends EventEmitter {
      static get capabilities() {
        return { permissions: true, resume: true }
      }
    }
    const session = new MockProvider()
    session.isRunning = false
    session.model = 'test-model'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp', createdAt: Date.now() })

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].provider, 'claude-sdk')
    assert.deepEqual(sessions[0].capabilities, { permissions: true, resume: true })
  })
})

describe('SessionManager.serializeState includes conversationId', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-session-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('persists conversationId in serialized state', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })

    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => 'conv-persist-123' })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Persist Test', cwd: '/tmp' })

    const state = mgr.serializeState()
    assert.equal(state.sessions[0].conversationId, 'conv-persist-123')

    // Also verify the file
    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(fileContents.sessions[0].conversationId, 'conv-persist-123')
  })
})

describe('SessionManager ring buffer size', () => {
  it('defaults to 1000 max history entries', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._maxHistory, 1000)
  })

  it('trims history when exceeding the default limit', () => {
    const mgr = new SessionManager({ maxHistory: 500, maxSessions: 5, stateFilePath: tmpStateFile() })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    for (let i = 0; i < 600; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i }, 's1')
    }

    assert.equal(history.length, 500)
    // Oldest messages should have been dropped (0-99)
    assert.equal(history[0].content, 'msg-100')
    assert.equal(history[499].content, 'msg-599')
  })

  it('sets truncation flag via sessionId parameter without reverse lookup (#1928)', () => {
    const mgr = new SessionManager({ maxHistory: 500, maxSessions: 5, stateFilePath: tmpStateFile() })
    // Create history for s1 but do NOT register it in _messageHistory
    // This proves _pushHistory uses the sessionId param directly,
    // not a reverse-lookup scan of _messageHistory
    const history = []

    for (let i = 0; i < 501; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i }, 's1')
    }

    assert.equal(mgr.isHistoryTruncated('s1'), true)
  })
})

describe('SessionManager persist debounce default', () => {
  it('defaults to 2000ms persist debounce', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._persistDebounceMs, 2000)
  })

  it('allows overriding persist debounce', () => {
    const mgr = new SessionManager({ maxSessions: 5, persistDebounceMs: 500, stateFilePath: tmpStateFile() })
    assert.equal(mgr._persistDebounceMs, 500)
  })
})

describe('SessionManager.isHistoryTruncated', () => {
  it('returns false when history has not been truncated', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    for (let i = 0; i < 10; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i }, 's1')
    }

    assert.equal(mgr.isHistoryTruncated('s1'), false)
  })

  it('returns true after ring buffer drops messages', () => {
    const mgr = new SessionManager({ maxSessions: 5, maxHistory: 10, stateFilePath: tmpStateFile() })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    // Fill beyond capacity to trigger truncation
    for (let i = 0; i < 11; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i }, 's1')
    }

    assert.equal(mgr.isHistoryTruncated('s1'), true)
  })

  it('returns false for unknown session', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.isHistoryTruncated('nonexistent'), false)
  })

  it('clears truncation flag when session is destroyed', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })
    mgr._messageHistory.set('s1', [])
    mgr._historyTruncated.set('s1', true)

    mgr.destroySession('s1')

    assert.equal(mgr.isHistoryTruncated('s1'), false)
    assert.equal(mgr._historyTruncated.has('s1'), false)
  })
})

describe('formatIdleDuration', () => {
  it('formats zero', () => {
    assert.equal(formatIdleDuration(0), '0 seconds')
  })

  it('formats seconds (singular and plural)', () => {
    assert.equal(formatIdleDuration(1000), '1 second')
    assert.equal(formatIdleDuration(45000), '45 seconds')
  })

  it('formats exact minutes', () => {
    assert.equal(formatIdleDuration(60000), '1 minute')
    assert.equal(formatIdleDuration(120000), '2 minutes')
    assert.equal(formatIdleDuration(59 * 60000), '59 minutes')
  })

  it('rounds seconds to nearest minute when >= 60s', () => {
    // 90 seconds → rounds to 2 minutes
    assert.equal(formatIdleDuration(90000), '2 minutes')
  })

  it('formats exact hours', () => {
    assert.equal(formatIdleDuration(3600000), '1 hour')
    assert.equal(formatIdleDuration(7200000), '2 hours')
  })

  it('formats hours with minutes', () => {
    assert.equal(formatIdleDuration(5400000), '1 hour 30 minutes')
    assert.equal(formatIdleDuration(9000000), '2 hours 30 minutes')
  })

  it('handles large durations', () => {
    assert.equal(formatIdleDuration(86400000), '24 hours')
  })
})

describe('SessionManager budget pause lifecycle', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-budget-test-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('isBudgetPaused returns false for unknown session', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.isBudgetPaused('nonexistent'), false)
  })

  it('isBudgetPaused returns true after adding to _budgetPaused', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    mgr._costBudget._budgetPaused.add('s1')
    assert.equal(mgr.isBudgetPaused('s1'), true)
  })

  it('resumeBudget removes session from _budgetPaused', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    mgr._costBudget._budgetPaused.add('s1')
    assert.equal(mgr.isBudgetPaused('s1'), true)
    mgr.resumeBudget('s1')
    assert.equal(mgr.isBudgetPaused('s1'), false)

    // resumeBudget() schedules a debounced persist; clear it to avoid writes after cleanup
    if (mgr._persistTimer) {
      clearTimeout(mgr._persistTimer)
      mgr._persistTimer = null
    }
  })

  it('destroySession cleans up budget state', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })
    mgr._costBudget._budgetPaused.add('s1')
    mgr._costBudget._budgetWarned.add('s1')
    mgr._costBudget._budgetExceeded.add('s1')
    mgr._costBudget._sessionCosts.set('s1', 1.50)

    mgr.destroySession('s1')

    assert.equal(mgr.isBudgetPaused('s1'), false)
    assert.equal(mgr._costBudget._budgetWarned.has('s1'), false)
    assert.equal(mgr._costBudget._budgetExceeded.has('s1'), false)
    assert.equal(mgr._costBudget._sessionCosts.has('s1'), false)

    // destroySession schedules a debounced persist; clear it to avoid writes after cleanup
    if (mgr._persistTimer) {
      clearTimeout(mgr._persistTimer)
      mgr._persistTimer = null
    }
  })

  it('serializes cost and budget state', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    mgr._costBudget._sessionCosts.set('s1', 2.50)
    mgr._costBudget._sessionCosts.set('s2', 0.75)
    mgr._costBudget._budgetWarned.add('s1')
    mgr._costBudget._budgetExceeded.add('s1')
    mgr._costBudget._budgetPaused.add('s1')

    const state = mgr.serializeState()

    assert.deepEqual(state.costs, { s1: 2.50, s2: 0.75 })
    assert.deepEqual(state.budgetWarned, ['s1'])
    assert.deepEqual(state.budgetExceeded, ['s1'])
    assert.deepEqual(state.budgetPaused, ['s1'])
  })

  it('restores cost and budget state remapped to new session IDs', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { id: 'old-s1', name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
        { id: 'old-s2', name: 'Test 2', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
      ],
      costs: { 'old-s1': 3.00, 'old-s2': 0.50 },
      budgetWarned: ['old-s1'],
      budgetExceeded: ['old-s1'],
      budgetPaused: ['old-s1'],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()

    // Costs should be keyed by the NEW session IDs, not the old ones
    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 2)
    const session1 = sessions.find(s => s.name === 'Test')
    const session2 = sessions.find(s => s.name === 'Test 2')
    assert.ok(session1, 'session "Test" should exist')
    assert.ok(session2, 'session "Test 2" should exist')
    const newId1 = session1.sessionId
    const newId2 = session2.sessionId
    assert.notEqual(newId1, 'old-s1')
    assert.notEqual(newId2, 'old-s2')

    assert.equal(mgr._costBudget._sessionCosts.get(newId1), 3.00)
    assert.equal(mgr._costBudget._sessionCosts.get(newId2), 0.50)
    assert.equal(mgr._costBudget._budgetWarned.has(newId1), true)
    assert.equal(mgr._costBudget._budgetExceeded.has(newId1), true)
    assert.equal(mgr._costBudget._budgetPaused.has(newId1), true)
    // Old IDs should NOT be present
    assert.equal(mgr._costBudget._sessionCosts.has('old-s1'), false)
    assert.equal(mgr._costBudget._budgetWarned.has('old-s1'), false)

    mgr.destroyAll()
  })

  it('restores costs with old format (no id field) using old keys', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
      costs: { s1: 3.00 },
      budgetWarned: ['s1'],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()

    // Without id field in session, old keys are kept as-is (backwards compat).
    // This means the cost tracking data is preserved but remains associated with the legacy
    // key (e.g. "s1") rather than any new session ID, so session-specific cost features may
    // not work correctly for sessions restored from these old state files.
    assert.equal(mgr._costBudget._sessionCosts.get('s1'), 3.00)
    assert.equal(mgr._costBudget._budgetWarned.has('s1'), true)

    mgr.destroyAll()
  })

  it('ignores invalid cost values during restore', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
      costs: { s1: 'not-a-number', s2: -5, s3: 0, s4: 1.25 },
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()

    assert.equal(mgr._costBudget._sessionCosts.has('s1'), false)
    assert.equal(mgr._costBudget._sessionCosts.has('s2'), false)
    assert.equal(mgr._costBudget._sessionCosts.has('s3'), false)
    assert.equal(mgr._costBudget._sessionCosts.get('s4'), 1.25)

    mgr.destroyAll()
  })
})

describe('#987 — dead code removal in session-manager (behavioral)', () => {
  it('does not export SessionNotFoundError', async () => {
    const mod = await import('../src/session-manager.js')
    assert.equal(mod.SessionNotFoundError, undefined,
      'SessionNotFoundError should be removed — it is never used')
  })

  it('does not have a sync getFullHistory method on instances', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(typeof mgr.getFullHistory, 'undefined',
      'getFullHistory (sync) should not exist — only getFullHistoryAsync')
    assert.equal(typeof mgr.getFullHistoryAsync, 'function',
      'getFullHistoryAsync should still exist')
  })

  it('destroySession calls _schedulePersist exactly once', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sm-persist-'))
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: join(tmpDir, 'state.json'),
    })

    // Insert a mock session
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'S1', cwd: '/tmp' })
    mgr.touchActivity('s1')

    // Spy on _schedulePersist
    let persistCallCount = 0
    const original = mgr._schedulePersist.bind(mgr)
    mgr._schedulePersist = () => { persistCallCount++; original() }

    mgr.destroySession('s1')

    assert.equal(persistCallCount, 1,
      `destroySession should call _schedulePersist once, got ${persistCallCount}`)

    // Clean up timer and temp dir
    clearTimeout(mgr._persistTimer)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('createSession failure cleanup (FM-03)', () => {
  it('cleans up _sessions and _lastActivity when session.start() throws', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    // Register a test provider whose start() throws
    const { registerProvider } = await import('../src/providers.js')
    class FailingProvider extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = opts.model || null
        this.permissionMode = opts.permissionMode || 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() { throw new Error('binary not found') }
      destroy() {}
      interrupt() {}
      sendMessage() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-failing', FailingProvider)

    assert.throws(
      () => mgr.createSession({ cwd: '/tmp', provider: 'test-failing' }),
      /binary not found/
    )

    // After the failure, no phantom session should remain
    assert.equal(mgr._sessions.size, 0, 'sessions map should be empty after start() failure')
    assert.equal(mgr._lastActivity.size, 0, 'lastActivity map should be empty after start() failure')
  })

  it('does not emit session_created when start() throws', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    let emitted = false
    mgr.on('session_created', () => { emitted = true })

    const { registerProvider } = await import('../src/providers.js')
    class FailingProvider2 extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = null
        this.permissionMode = 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() { throw new Error('spawn failed') }
      destroy() {}
      interrupt() {}
      sendMessage() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-failing2', FailingProvider2)

    assert.throws(
      () => mgr.createSession({ cwd: '/tmp', provider: 'test-failing2' }),
      /spawn failed/
    )
    assert.equal(emitted, false, 'session_created should not be emitted when start() fails')
  })

  it('calls session.destroy() when start() throws', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const { registerProvider } = await import('../src/providers.js')
    let destroyCalled = false
    class FailingProvider3 extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = null
        this.permissionMode = 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() { throw new Error('init crashed') }
      destroy() { destroyCalled = true }
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-failing3', FailingProvider3)

    assert.throws(
      () => mgr.createSession({ cwd: '/tmp', provider: 'test-failing3' }),
      /init crashed/
    )
    assert.equal(destroyCalled, true, 'session.destroy() should be called on start() failure')
  })
})

describe('#1204 — _cleanupSessionMaps helper cleans all maps', () => {
  it('sync start() failure cleans all session-scoped maps', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const { registerProvider } = await import('../src/providers.js')
    let sessionIdCapture = null
    class MapPolluter extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = null
        this.permissionMode = 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() {
        // Pollute maps before throwing
        // _wireSessionEvents already ran, so we can find our sessionId
        for (const [sid] of mgr._sessions) {
          sessionIdCapture = sid
          mgr._messageHistory.set(sid, [{ type: 'test' }])
          mgr._historyTruncated.set(sid, true)
          mgr._costBudget._sessionCosts.set(sid, 0.5)
          mgr._costBudget._budgetWarned.add(sid)
          mgr._costBudget._budgetExceeded.add(sid)
          mgr._costBudget._budgetPaused.add(sid)
          mgr._pendingStreams.set(`${sid}:msg-1`, 'partial delta')
        }
        throw new Error('polluted start')
      }
      destroy() {}
      interrupt() {}
      sendMessage() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-map-polluter', MapPolluter)

    assert.throws(
      () => mgr.createSession({ cwd: '/tmp', provider: 'test-map-polluter' }),
      /polluted start/
    )

    assert.ok(sessionIdCapture, 'should have captured sessionId')
    assert.equal(mgr._sessions.size, 0, '_sessions should be empty')
    assert.equal(mgr._lastActivity.size, 0, '_lastActivity should be empty')
    assert.equal(mgr._messageHistory.has(sessionIdCapture), false, '_messageHistory should be cleaned')
    assert.equal(mgr._historyTruncated.has(sessionIdCapture), false, '_historyTruncated should be cleaned')
    assert.equal(mgr._costBudget._sessionCosts.has(sessionIdCapture), false, '_sessionCosts should be cleaned')
    assert.equal(mgr._costBudget._budgetWarned.has(sessionIdCapture), false, '_budgetWarned should be cleaned')
    assert.equal(mgr._costBudget._budgetExceeded.has(sessionIdCapture), false, '_budgetExceeded should be cleaned')
    assert.equal(mgr._costBudget._budgetPaused.has(sessionIdCapture), false, '_budgetPaused should be cleaned')
    assert.equal(mgr._pendingStreams.has(`${sessionIdCapture}:msg-1`), false, '_pendingStreams should be cleaned')
  })
})

describe('#1202 — guard session.destroy() with try-catch', () => {
  it('propagates original start() error when destroy() also throws', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const { registerProvider } = await import('../src/providers.js')
    class DoubleFailProvider extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = null
        this.permissionMode = 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() { throw new Error('start exploded') }
      destroy() { throw new Error('destroy exploded') }
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-double-fail', DoubleFailProvider)

    assert.throws(
      () => mgr.createSession({ cwd: '/tmp', provider: 'test-double-fail' }),
      /start exploded/
    )

    // Verify cleanup still happened despite destroy() throwing
    assert.equal(mgr._sessions.size, 0, 'sessions map should be empty')
    assert.equal(mgr._lastActivity.size, 0, 'lastActivity map should be empty')
  })

  it('cleans up when async start() rejects and destroy() throws', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const { registerProvider } = await import('../src/providers.js')
    class AsyncDoubleFailProvider extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = null
        this.permissionMode = 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() { return Promise.reject(new Error('async start exploded')) }
      destroy() { throw new Error('async destroy exploded') }
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-async-double-fail', AsyncDoubleFailProvider)

    // Should not throw synchronously
    mgr.createSession({ cwd: '/tmp', provider: 'test-async-double-fail' })

    // Flush microtask queue
    await Promise.resolve()

    // Despite destroy() throwing inside destroySession, session should still be cleaned up
    assert.equal(mgr._sessions.size, 0, 'sessions map should be empty after async double failure')
    assert.equal(mgr._lastActivity.size, 0, 'lastActivity map should be empty after async double failure')
  })
})

describe('#1227 — guard destroyAll() session.destroy() with try-catch', () => {
  it('cleans up all sessions even when one destroy() throws', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    // Session 1: destroy throws
    const session1 = new EventEmitter()
    session1.isRunning = false
    session1.destroy = () => { throw new Error('destroy exploded') }
    session1.removeAllListeners = () => {}
    mgr._sessions.set('s1', { session: session1, type: 'cli', name: 'S1', cwd: '/tmp' })
    mgr._lastActivity.set('s1', Date.now())

    // Session 2: normal
    const session2 = new EventEmitter()
    session2.isRunning = false
    let session2Destroyed = false
    session2.destroy = () => { session2Destroyed = true }
    session2.removeAllListeners = () => {}
    mgr._sessions.set('s2', { session: session2, type: 'cli', name: 'S2', cwd: '/tmp' })
    mgr._lastActivity.set('s2', Date.now())

    // Should not throw despite session1.destroy() throwing
    mgr.destroyAll()

    assert.equal(mgr._sessions.size, 0, 'all sessions should be cleared')
    assert.equal(mgr._lastActivity.size, 0, '_lastActivity should be cleared')
    assert.equal(session2Destroyed, true, 'session2 should still be destroyed')
  })
})

describe('#1942 — destroyAll() wraps serializeState in try-catch', () => {
  it('continues destroying sessions when serializeState throws', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    // Make serializeState throw
    mgr.serializeState = () => { throw new Error('disk full') }

    // Add a session
    const session1 = new EventEmitter()
    session1.isRunning = false
    let destroyed = false
    session1.destroy = () => { destroyed = true }
    session1.removeAllListeners = () => {}
    mgr._sessions.set('s1', { session: session1, type: 'cli', name: 'S1', cwd: '/tmp' })
    mgr._lastActivity.set('s1', Date.now())

    // Should not throw despite serializeState failure
    mgr.destroyAll()

    assert.equal(mgr._sessions.size, 0, 'sessions should be cleared')
    assert.equal(destroyed, true, 'session should still be destroyed')
  })
})

describe('#1243 — destroyAll() clears all session-scoped maps', () => {
  it('clears messageHistory, historyTruncated, sessionCosts, budget maps, pendingStreams after destroyAll', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const session1 = new EventEmitter()
    session1.isRunning = false
    session1.destroy = () => {}
    session1.removeAllListeners = () => {}
    mgr._sessions.set('s1', { session: session1, type: 'cli', name: 'S1', cwd: '/tmp' })
    mgr._lastActivity.set('s1', Date.now())

    // Populate all session-scoped maps that destroyAll should clear
    mgr._messageHistory.set('s1', [{ type: 'response', content: 'hello' }])
    mgr._historyTruncated.set('s1', true)
    mgr._costBudget._sessionCosts.set('s1', 0.05)
    mgr._costBudget._budgetWarned.add('s1')
    mgr._costBudget._budgetExceeded.add('s1')
    mgr._costBudget._budgetPaused.add('s1')
    mgr._pendingStreams.set('s1:msg-1', 'partial text')

    mgr.destroyAll()

    assert.equal(mgr._sessions.size, 0, '_sessions should be cleared')
    assert.equal(mgr._lastActivity.size, 0, '_lastActivity should be cleared')
    assert.equal(mgr._sessionWarned.size, 0, '_sessionWarned should be cleared')
    assert.equal(mgr._messageHistory.size, 0, '_messageHistory should be cleared')
    assert.equal(mgr._historyTruncated.size, 0, '_historyTruncated should be cleared')
    assert.equal(mgr._costBudget._sessionCosts.size, 0, '_sessionCosts should be cleared')
    assert.equal(mgr._costBudget._budgetWarned.size, 0, '_budgetWarned should be cleared')
    assert.equal(mgr._costBudget._budgetExceeded.size, 0, '_budgetExceeded should be cleared')
    assert.equal(mgr._costBudget._budgetPaused.size, 0, '_budgetPaused should be cleared')
    assert.equal(mgr._pendingStreams.size, 0, '_pendingStreams should be cleared')
  })
})

describe('#1141 — async start() rejection guard', () => {
  it('cleans up phantom session when start() returns a rejected promise', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })

    const { registerProvider } = await import('../src/providers.js')
    let destroyCalled = false
    class AsyncFailingProvider extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = null
        this.permissionMode = 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() { return Promise.reject(new Error('async init failed')) }
      destroy() { destroyCalled = true }
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-async-failing', AsyncFailingProvider)

    // createSession should NOT throw synchronously for async rejection
    let destroyedEvent = null
    mgr.on('session_destroyed', (data) => { destroyedEvent = data })
    mgr.createSession({ cwd: '/tmp', provider: 'test-async-failing' })

    // Flush microtask queue for the .catch() handler
    await Promise.resolve()

    assert.equal(destroyCalled, true, 'session.destroy() should be called on async start() rejection')
    assert.equal(mgr._sessions.size, 0, 'sessions map should be empty after async start() failure')
    assert.equal(mgr._lastActivity.size, 0, 'lastActivity map should be empty after async start() failure')
    assert.ok(destroyedEvent, 'session_destroyed should be emitted after async cleanup')
    assert.ok(destroyedEvent.sessionId, 'session_destroyed event should include sessionId')
  })
})

describe('#1091 — destroy-while-streaming event leak', () => {
  it('removes listeners before calling session.destroy()', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.destroy = () => {
      session.emit('stream_end', { messageId: 'msg-1' })
    }
    session.isRunning = false
    session.start = () => {}
    const sessionId = 'test-destroy-order'
    mgr._sessions.set(sessionId, { session, name: 'Test', cwd: '/tmp', provider: 'test' })
    mgr._lastActivity.set(sessionId, Date.now())
    mgr._wireSessionEvents(sessionId, session)
    const events = []
    mgr.on('session_event', (evt) => events.push(evt))
    mgr.destroySession(sessionId)
    const streamEndEvents = events.filter(e => e.event === 'stream_end')
    assert.equal(streamEndEvents.length, 0,
      'stream_end emitted during destroy() should not be proxied')
  })

  it('does not write to _pendingStreams when events fire during destroy()', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.destroy = () => {
      session.emit('stream_start', { messageId: 'orphan-1' })
    }
    session.isRunning = false
    session.start = () => {}
    const sessionId = 'test-orphan-streams'
    mgr._sessions.set(sessionId, { session, name: 'Test', cwd: '/tmp', provider: 'test' })
    mgr._lastActivity.set(sessionId, Date.now())
    mgr._wireSessionEvents(sessionId, session)
    mgr.destroySession(sessionId)
    const orphanKeys = [...mgr._pendingStreams.keys()].filter(k => k.startsWith(sessionId))
    assert.equal(orphanKeys.length, 0, '_pendingStreams should have no orphaned entries')
  })

  it('emits synthetic stream_end for pending streams on destroy', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.destroy = () => {}
    session.isRunning = false
    const sessionId = 'test-pending-cleanup'
    mgr._sessions.set(sessionId, { session, name: 'Test', cwd: '/tmp', provider: 'test' })
    mgr._lastActivity.set(sessionId, Date.now())
    mgr._pendingStreams.set(`${sessionId}:msg-a`, 'partial content A')
    mgr._pendingStreams.set(`${sessionId}:msg-b`, 'partial content B')
    mgr._pendingStreams.set('other-session:msg-c', 'other content')
    const events = []
    mgr.on('session_event', (evt) => events.push(evt))
    mgr.destroySession(sessionId)
    const streamEndEvents = events.filter(e => e.event === 'stream_end' && e.sessionId === sessionId)
    assert.equal(streamEndEvents.length, 2, 'should emit synthetic stream_end for each pending stream')
    const endedIds = streamEndEvents.map(e => e.data.messageId).sort()
    assert.deepEqual(endedIds, ['msg-a', 'msg-b'])
    const remainingKeys = [...mgr._pendingStreams.keys()].filter(k => k.startsWith(sessionId))
    assert.equal(remainingKeys.length, 0, '_pendingStreams should be empty for destroyed session')
    assert.equal(mgr._pendingStreams.get('other-session:msg-c'), 'other content')
  })
})

describe('Session ID generation (#1856)', () => {
  it('generates 32-character hex session IDs (128-bit)', async () => {
    const { randomBytes } = await import('crypto')
    const { registerProvider } = await import('../src/providers.js')

    class TestProvider extends EventEmitter {
      constructor(opts) {
        super()
        this.cwd = opts.cwd
        this.model = opts.model || null
        this.permissionMode = opts.permissionMode || 'approve'
        this.isRunning = false
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() {}
      destroy() {}
      interrupt() {}
      sendMessage() {}
      setModel() {}
      setPermissionMode() {}
    }
    registerProvider('test-session-id', TestProvider)

    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    mgr.createSession({ cwd: '/tmp', provider: 'test-session-id' })

    const [sessionId] = [...mgr._sessions.keys()]
    assert.equal(sessionId.length, 32, 'Session ID should be 32 hex chars (128-bit)')
    assert.match(sessionId, /^[0-9a-f]{32}$/, 'Session ID should be lowercase hex')

    mgr.destroySession(sessionId)
  })
})

describe('SessionManager.defaultCwd getter (#1475)', () => {
  it('exposes defaultCwd via public getter', () => {
    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp/test-cwd', stateFilePath: tmpStateFile() })
    assert.equal(mgr.defaultCwd, '/tmp/test-cwd')
  })

  it('defaults to process.cwd() when no defaultCwd provided', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.defaultCwd, process.cwd())
  })
})

describe('Configurable magic numbers (#1848)', () => {
  it('maxHistory defaults to 1000', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._maxHistory, 1000)
  })

  it('maxHistory can be configured', () => {
    const mgr = new SessionManager({ maxSessions: 5, maxHistory: 500, stateFilePath: tmpStateFile() })
    assert.equal(mgr._maxHistory, 500)
  })

  it('maxSessions can be configured', () => {
    const mgr = new SessionManager({ maxSessions: 10, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxSessions, 10)
  })

  it('maxSessions defaults to 5', () => {
    const mgr = new SessionManager({ stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxSessions, 5)
  })
})

describe('#2692 — session destroy race: getSession rejects mid-destroy sessions', () => {
  it('sets _destroying flag at start of destroySession()', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    let destroyingDuringCall = null
    session.destroy = () => {
      // Capture the flag value while destroy() is executing
      const entry = mgr._sessions.get('s1')
      destroyingDuringCall = entry ? entry._destroying : null
    }
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    mgr.destroySession('s1')

    assert.equal(destroyingDuringCall, true,
      '_destroying should be true on the entry while destroy() executes')
  })

  it('getSession returns null for a session with _destroying flag set', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp', _destroying: true })

    assert.equal(mgr.getSession('s1'), null,
      'getSession should return null when _destroying is set on the entry')
  })

  it('getSession returns null during destroySession()', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    let getSessionResultDuringDestroy = 'NOT_CALLED'
    session.destroy = () => {
      // Simulate reconnecting client calling getSession mid-destroy
      getSessionResultDuringDestroy = mgr.getSession('s1')
    }
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    // Confirm it's visible before destroy
    assert.ok(mgr.getSession('s1'), 'getSession should return entry before destroy')

    mgr.destroySession('s1')

    assert.equal(getSessionResultDuringDestroy, null,
      'getSession should return null while destroy() is executing')
    assert.equal(mgr.getSession('s1'), null,
      'getSession should return null after destroy completes')
  })

  it('destroySessionLocked sets _destroying before acquiring lock', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    // Start the locked destroy but check before it finishes
    const destroyPromise = mgr.destroySessionLocked('s1')

    // The _destroying flag should be set synchronously before lock acquisition
    // (lock.acquire() is async but flag is set before await)
    const entry = mgr._sessions.get('s1')
    assert.equal(entry ? entry._destroying : 'ENTRY_GONE', true,
      '_destroying should be set synchronously at the start of destroySessionLocked()')

    // getSession should return null immediately after destroySessionLocked() is called
    assert.equal(mgr.getSession('s1'), null,
      'getSession should return null once destroySessionLocked() starts')

    await destroyPromise

    // After completion, session should be fully removed from _sessions
    assert.equal(mgr._sessions.has('s1'), false,
      'session should be removed from _sessions after destroySessionLocked() completes')
  })
})

describe('SessionManager._destroying filter (#2728)', () => {
  function makeMgr() {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const mkSession = () => {
      const s = new EventEmitter()
      s.isRunning = false
      s.model = null
      s.permissionMode = 'approve'
      s.resumeSessionId = null
      s.destroy = () => {}
      return s
    }
    mgr._sessions.set('s1', { session: mkSession(), name: 'S1', cwd: '/tmp', createdAt: 1, _destroying: true })
    mgr._sessions.set('s2', { session: mkSession(), name: 'S2', cwd: '/tmp', createdAt: 2 })
    return mgr
  }

  it('listSessions() excludes entries marked _destroying', () => {
    const mgr = makeMgr()
    const list = mgr.listSessions()
    assert.equal(list.length, 1)
    assert.equal(list[0].sessionId, 's2')
    assert.equal(list[0].name, 'S2')
  })

  it('firstSessionId returns the first non-destroying session even if a destroying entry comes first', () => {
    const mgr = makeMgr()
    assert.equal(mgr.firstSessionId, 's2')
  })

  it('firstSessionId returns null when all sessions are destroying', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const s = new EventEmitter()
    s.isRunning = false
    s.destroy = () => {}
    mgr._sessions.set('s1', { session: s, name: 'S1', cwd: '/tmp', createdAt: 1, _destroying: true })
    assert.equal(mgr.firstSessionId, null)
  })

  it('getFullHistoryAsync() returns [] for entries marked _destroying without reading JSONL', async () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    // Set a resumeSessionId so the JSONL path would normally be attempted
    session.resumeSessionId = 'fake-conv-id'
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/tmp', createdAt: 1, _destroying: true })

    const history = await mgr.getFullHistoryAsync('s1')
    assert.deepEqual(history, [])
  })
})

describe('SessionManager.maxMessages option (#2735)', () => {
  it('accepts maxMessages and exposes it via getter', () => {
    const mgr = new SessionManager({ maxSessions: 5, maxMessages: 250, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxMessages, 250)
  })

  it('falls back to maxHistory alias when maxMessages is not provided', () => {
    const mgr = new SessionManager({ maxSessions: 5, maxHistory: 175, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxMessages, 175)
  })

  it('maxMessages takes precedence over maxHistory when both are provided', () => {
    const mgr = new SessionManager({ maxSessions: 5, maxMessages: 300, maxHistory: 100, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxMessages, 300)
  })
})
