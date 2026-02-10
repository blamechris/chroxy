import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

const STATE_FILE = join(homedir(), '.chroxy', 'session-state.json')

/**
 * Tests for SessionManager serialization, restoration, and allIdle.
 *
 * Note: These tests use real filesystem I/O for the state file to
 * validate the complete serialize/restore cycle. The SdkSession
 * constructor is bypassed by setting useLegacyCli and mocking
 * around the session creation where needed.
 */

/** Clean up state file before/after tests */
function cleanStateFile() {
  try { unlinkSync(STATE_FILE) } catch {}
}

describe('SessionManager.allIdle', () => {
  it('returns true when no sessions exist', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.allIdle(), true)
  })

  it('returns true when all sessions are idle', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    // Manually add mock sessions
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
  beforeEach(cleanStateFile)
  afterEach(cleanStateFile)

  it('writes state file with session data', () => {
    const mgr = new SessionManager({ maxSessions: 5 })

    // Create mock sessions with resumeSessionId getter
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

    // Check returned state
    assert.equal(state.sessions.length, 2)
    assert.ok(state.timestamp > 0)
    assert.equal(state.sessions[0].sdkSessionId, 'sdk-abc-123')
    assert.equal(state.sessions[0].name, 'Project A')
    assert.equal(state.sessions[0].cwd, '/tmp/a')
    assert.equal(state.sessions[0].model, 'claude-sonnet-4-20250514')
    assert.equal(state.sessions[1].sdkSessionId, null)

    // Check file was written
    assert.ok(existsSync(STATE_FILE), 'State file should exist')
    const fileContents = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    assert.equal(fileContents.sessions.length, 2)
  })

  it('skips PTY sessions', () => {
    const mgr = new SessionManager({ maxSessions: 5 })

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

  it('creates .chroxy directory if needed', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    // Even with no sessions, it should write without error
    const state = mgr.serializeState()
    assert.equal(state.sessions.length, 0)
    assert.ok(existsSync(STATE_FILE), 'State file should be created')
  })
})

describe('SessionManager.restoreState', () => {
  beforeEach(cleanStateFile)
  afterEach(cleanStateFile)

  it('returns null when no state file exists', () => {
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.restoreState(), null)
  })

  it('returns null for invalid JSON', () => {
    mkdirSync(join(homedir(), '.chroxy'), { recursive: true })
    writeFileSync(STATE_FILE, 'not json')
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.restoreState(), null)
    // State file should be cleaned up
    assert.equal(existsSync(STATE_FILE), false, 'Invalid state file should be removed')
  })

  it('returns null for empty sessions array', () => {
    mkdirSync(join(homedir(), '.chroxy'), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ timestamp: Date.now(), sessions: [] }))
    const mgr = new SessionManager({ maxSessions: 5 })
    assert.equal(mgr.restoreState(), null)
  })

  it('returns null for stale state (>5 min)', () => {
    mkdirSync(join(homedir(), '.chroxy'), { recursive: true })
    const staleTimestamp = Date.now() - 6 * 60 * 1000 // 6 minutes ago
    writeFileSync(STATE_FILE, JSON.stringify({
      timestamp: staleTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))
    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp' })
    assert.equal(mgr.restoreState(), null, 'Stale state should be rejected')
  })

  it('restores sessions from valid state file', () => {
    mkdirSync(join(homedir(), '.chroxy'), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      timestamp: Date.now(),
      sessions: [
        { name: 'Session A', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: 'sdk-resume-1' },
        { name: 'Session B', cwd: '/tmp', model: null, permissionMode: 'auto', sdkSessionId: null },
      ],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp' })
    const firstId = mgr.restoreState()
    assert.ok(firstId, 'Should return the first restored session ID')

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 2, 'Should have 2 restored sessions')

    // State file should be cleaned up after restore
    assert.equal(existsSync(STATE_FILE), false, 'State file should be removed after restore')

    // Clean up created sessions
    mgr.destroyAll()
  })

  it('deletes state file after reading', () => {
    mkdirSync(join(homedir(), '.chroxy'), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp' })
    mgr.restoreState()
    assert.equal(existsSync(STATE_FILE), false, 'State file should be removed')
    mgr.destroyAll()
  })

  it('continues if one session fails to restore', () => {
    mkdirSync(join(homedir(), '.chroxy'), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      timestamp: Date.now(),
      sessions: [
        { name: 'Good', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
        { name: 'Bad', cwd: '/nonexistent/path/that/does/not/exist', model: null, permissionMode: 'approve', sdkSessionId: null },
      ],
    }))

    const mgr = new SessionManager({ maxSessions: 5, defaultCwd: '/tmp' })
    const firstId = mgr.restoreState()
    assert.ok(firstId, 'Should return the first successfully restored session')

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 1, 'Only the good session should be restored')

    mgr.destroyAll()
  })
})
