import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager, formatIdleDuration } from '../src/session-manager.js'

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

describe('SessionManager.getConversationId', () => {
  it('returns resumeSessionId when available', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    const session = new EventEmitter()
    Object.defineProperty(session, 'resumeSessionId', { get: () => 'conv-uuid-123' })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    assert.equal(mgr.getConversationId('s1'), 'conv-uuid-123')
  })

  it('returns null when resumeSessionId is not set', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    const session = new EventEmitter()
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    assert.equal(mgr.getConversationId('s1'), null)
  })

  it('returns null for nonexistent session', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.getConversationId('nonexistent'), null)
  })
})

describe('SessionManager.listSessions includes conversationId', () => {
  it('includes conversationId in session list entries', () => {
    const mgr = new SessionManager({ maxSessions: 5 })

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
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr._providerType, 'claude-sdk')
  })

  it('accepts providerType parameter', () => {
    const mgr = new SessionManager({ maxSessions: 5, providerType: 'claude-cli' })
    assert.equal(mgr._providerType, 'claude-cli')
  })

  it('listSessions includes provider and capabilities', () => {
    const mgr = new SessionManager({ maxSessions: 5, providerType: 'claude-sdk' })

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
  it('defaults to 500 max history entries', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr._maxHistory, 500)
  })

  it('trims history when exceeding 500 entries', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    for (let i = 0; i < 600; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i })
    }

    assert.equal(history.length, 500)
    // Oldest messages should have been dropped (0-99)
    assert.equal(history[0].content, 'msg-100')
    assert.equal(history[499].content, 'msg-599')
  })
})

describe('SessionManager persist debounce default', () => {
  it('defaults to 2000ms persist debounce', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr._persistDebounceMs, 2000)
  })

  it('allows overriding persist debounce', () => {
    const mgr = new SessionManager({ maxSessions: 5, persistDebounceMs: 500 })
    assert.equal(mgr._persistDebounceMs, 500)
  })
})

describe('SessionManager.isHistoryTruncated', () => {
  it('returns false when history has not been truncated', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    for (let i = 0; i < 10; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i })
    }

    assert.equal(mgr.isHistoryTruncated('s1'), false)
  })

  it('returns true after ring buffer drops messages', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    // Fill beyond capacity to trigger truncation
    for (let i = 0; i < 501; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i })
    }

    assert.equal(mgr.isHistoryTruncated('s1'), true)
  })

  it('returns false for unknown session', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.isHistoryTruncated('nonexistent'), false)
  })

  it('clears truncation flag when session is destroyed', () => {
    const mgr = new SessionManager({ maxSessions: 5 })

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
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.isBudgetPaused('nonexistent'), false)
  })

  it('isBudgetPaused returns true after adding to _budgetPaused', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    mgr._budgetPaused.add('s1')
    assert.equal(mgr.isBudgetPaused('s1'), true)
  })

  it('resumeBudget removes session from _budgetPaused', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    mgr._budgetPaused.add('s1')
    assert.equal(mgr.isBudgetPaused('s1'), true)
    mgr.resumeBudget('s1')
    assert.equal(mgr.isBudgetPaused('s1'), false)
  })

  it('destroySession cleans up budget state', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })
    mgr._budgetPaused.add('s1')
    mgr._budgetWarned.add('s1')
    mgr._budgetExceeded.add('s1')
    mgr._sessionCosts.set('s1', 1.50)

    mgr.destroySession('s1')

    assert.equal(mgr.isBudgetPaused('s1'), false)
    assert.equal(mgr._budgetWarned.has('s1'), false)
    assert.equal(mgr._budgetExceeded.has('s1'), false)
    assert.equal(mgr._sessionCosts.has('s1'), false)
  })

  it('serializes cost and budget state', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: stateFile })
    mgr._sessionCosts.set('s1', 2.50)
    mgr._sessionCosts.set('s2', 0.75)
    mgr._budgetWarned.add('s1')
    mgr._budgetExceeded.add('s1')
    mgr._budgetPaused.add('s1')

    const state = mgr.serializeState()

    assert.deepEqual(state.costs, { s1: 2.50, s2: 0.75 })
    assert.deepEqual(state.budgetWarned, ['s1'])
    assert.deepEqual(state.budgetExceeded, ['s1'])
    assert.deepEqual(state.budgetPaused, ['s1'])
  })

  it('restores cost and budget state from disk', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
      costs: { s1: 3.00, s2: 0.50 },
      budgetWarned: ['s1'],
      budgetExceeded: ['s1'],
      budgetPaused: ['s1'],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()

    assert.equal(mgr._sessionCosts.get('s1'), 3.00)
    assert.equal(mgr._sessionCosts.get('s2'), 0.50)
    assert.equal(mgr._budgetWarned.has('s1'), true)
    assert.equal(mgr._budgetExceeded.has('s1'), true)
    assert.equal(mgr._budgetPaused.has('s1'), true)

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

    assert.equal(mgr._sessionCosts.has('s1'), false)
    assert.equal(mgr._sessionCosts.has('s2'), false)
    assert.equal(mgr._sessionCosts.has('s3'), false)
    assert.equal(mgr._sessionCosts.get('s4'), 1.25)

    mgr.destroyAll()
  })
})
