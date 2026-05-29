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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.allIdle(), true)
  })

  it('returns true when all sessions are idle', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

    const session1 = new EventEmitter()
    session1.model = 'claude-sonnet-4-6'
    session1.permissionMode = 'approve'
    Object.defineProperty(session1, 'resumeSessionId', { get: () => 'sdk-abc-123' })
    session1.destroy = () => {}
    mgr._sessions.set('chroxy-1', { session: session1, type: 'cli', name: 'Project A', cwd: '/tmp/a' })

    const session2 = new EventEmitter()
    session2.model = 'claude-opus-4-7'
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
    assert.equal(state.sessions[0].model, 'claude-sonnet-4-6')
    assert.equal(state.sessions[1].sdkSessionId, null)

    assert.ok(existsSync(stateFile), 'State file should exist')
    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(fileContents.sessions.length, 2)
  })

  it('persists lastActivityAt for visual session status', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', {
      session,
      type: 'cli',
      name: 'Activity Test',
      cwd: '/tmp',
      createdAt: 1_000,
    })
    mgr._sessionLastActivityAt.set('s1', 2_000)

    const state = mgr.serializeState()
    assert.equal(state.sessions[0].lastActivityAt, 2_000)

    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(fileContents.sessions[0].lastActivityAt, 2_000)
  })

  it('includes version field', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    const state = mgr.serializeState()
    assert.equal(state.version, 1)
    const fileContents = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(fileContents.version, 1)
  })

  it('includes message history per session', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    mgr.serializeState()
    assert.ok(existsSync(stateFile), 'State file should exist')
    assert.equal(existsSync(stateFile + '.tmp'), false, '.tmp file should not remain')
  })

  it('serializes CLI sessions', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: nestedFile })
    const state = mgr.serializeState()
    assert.equal(state.sessions.length, 0)
    assert.ok(existsSync(nestedFile), 'State file should be created')
  })

  // #3185: persisted promptEvaluator survives the round-trip so a
  // restart restores the toggle state.
  it('serializes promptEvaluator on each session entry', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

    const sessionOn = new EventEmitter()
    sessionOn.model = 'sonnet'
    sessionOn.permissionMode = 'approve'
    sessionOn.promptEvaluator = true
    Object.defineProperty(sessionOn, 'resumeSessionId', { get: () => null })
    sessionOn.destroy = () => {}
    mgr._sessions.set('s-on', { session: sessionOn, name: 'On', cwd: '/tmp' })

    const sessionOff = new EventEmitter()
    sessionOff.model = 'sonnet'
    sessionOff.permissionMode = 'approve'
    sessionOff.promptEvaluator = false
    Object.defineProperty(sessionOff, 'resumeSessionId', { get: () => null })
    sessionOff.destroy = () => {}
    mgr._sessions.set('s-off', { session: sessionOff, name: 'Off', cwd: '/tmp' })

    const state = mgr.serializeState()
    assert.equal(state.sessions.length, 2)
    const onEntry = state.sessions.find(s => s.name === 'On')
    const offEntry = state.sessions.find(s => s.name === 'Off')
    assert.equal(onEntry.promptEvaluator, true)
    assert.equal(offEntry.promptEvaluator, false)
    assert.equal(typeof onEntry.promptEvaluator, 'boolean')
  })

  // #3805: persisted chroxyContextHint survives the round-trip so a
  // restart restores the toggle state.
  it('serializes chroxyContextHint on each session entry (#3805)', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

    const sessionOn = new EventEmitter()
    sessionOn.model = 'sonnet'
    sessionOn.permissionMode = 'approve'
    sessionOn.chroxyContextHint = true
    Object.defineProperty(sessionOn, 'resumeSessionId', { get: () => null })
    sessionOn.destroy = () => {}
    mgr._sessions.set('s-on', { session: sessionOn, name: 'HintOn', cwd: '/tmp' })

    const sessionOff = new EventEmitter()
    sessionOff.model = 'sonnet'
    sessionOff.permissionMode = 'approve'
    sessionOff.chroxyContextHint = false
    Object.defineProperty(sessionOff, 'resumeSessionId', { get: () => null })
    sessionOff.destroy = () => {}
    mgr._sessions.set('s-off', { session: sessionOff, name: 'HintOff', cwd: '/tmp' })

    const state = mgr.serializeState()
    const onEntry = state.sessions.find(s => s.name === 'HintOn')
    const offEntry = state.sessions.find(s => s.name === 'HintOff')
    assert.equal(onEntry.chroxyContextHint, true)
    assert.equal(offEntry.chroxyContextHint, false)
    assert.equal(typeof onEntry.chroxyContextHint, 'boolean')
    assert.equal(typeof offEntry.chroxyContextHint, 'boolean')
  })

  // #3639: per-session promptEvaluatorSkipPattern survives the
  // round-trip so a restart preserves the operator's per-session
  // skip-list override.
  it('serializes promptEvaluatorSkipPattern on each session entry (#3639)', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

    const sessionWithPattern = new EventEmitter()
    sessionWithPattern.model = 'sonnet'
    sessionWithPattern.permissionMode = 'approve'
    sessionWithPattern.promptEvaluatorSkipPattern = '^lgtm ship it$'
    Object.defineProperty(sessionWithPattern, 'resumeSessionId', { get: () => null })
    sessionWithPattern.destroy = () => {}
    mgr._sessions.set('s-with', { session: sessionWithPattern, name: 'WithPattern', cwd: '/tmp' })

    const sessionNoPattern = new EventEmitter()
    sessionNoPattern.model = 'sonnet'
    sessionNoPattern.permissionMode = 'approve'
    sessionNoPattern.promptEvaluatorSkipPattern = null
    Object.defineProperty(sessionNoPattern, 'resumeSessionId', { get: () => null })
    sessionNoPattern.destroy = () => {}
    mgr._sessions.set('s-no', { session: sessionNoPattern, name: 'NoPattern', cwd: '/tmp' })

    const state = mgr.serializeState()
    const withEntry = state.sessions.find(s => s.name === 'WithPattern')
    const noEntry = state.sessions.find(s => s.name === 'NoPattern')
    assert.equal(withEntry.promptEvaluatorSkipPattern, '^lgtm ship it$')
    assert.equal(noEntry.promptEvaluatorSkipPattern, null,
      'unset pattern serializes as null (not undefined) so the wire shape is stable')
  })

  // #3540: persisted stdin_disabled latch survives the round-trip so a
  // server restart preserves the disabled state. Reconnecting clients
  // observe the flag through session_list / listSessions metadata
  // without waiting for a fresh `error` event (the original event was
  // proxied once against the previous process and will not replay).
  it('serializes stdinForwardingDisabled on each session entry (#3540)', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

    const sessionDisabled = new EventEmitter()
    sessionDisabled.model = 'sonnet'
    sessionDisabled.permissionMode = 'approve'
    sessionDisabled._stdinForwardingDisabled = true
    Object.defineProperty(sessionDisabled, 'resumeSessionId', { get: () => null })
    sessionDisabled.destroy = () => {}
    mgr._sessions.set('s-disabled', { session: sessionDisabled, name: 'Disabled', cwd: '/tmp' })

    const sessionOk = new EventEmitter()
    sessionOk.model = 'sonnet'
    sessionOk.permissionMode = 'approve'
    sessionOk._stdinForwardingDisabled = false
    Object.defineProperty(sessionOk, 'resumeSessionId', { get: () => null })
    sessionOk.destroy = () => {}
    mgr._sessions.set('s-ok', { session: sessionOk, name: 'Ok', cwd: '/tmp' })

    const state = mgr.serializeState()
    assert.equal(state.sessions.length, 2)
    const disabledEntry = state.sessions.find(s => s.name === 'Disabled')
    const okEntry = state.sessions.find(s => s.name === 'Ok')
    assert.equal(disabledEntry.stdinForwardingDisabled, true)
    assert.equal(okEntry.stdinForwardingDisabled, false)
    assert.equal(typeof disabledEntry.stdinForwardingDisabled, 'boolean')
    assert.equal(typeof okEntry.stdinForwardingDisabled, 'boolean')

    // Strict-boolean coerce: providers that never set the field
    // (CLI sessions, Codex, Gemini) must round-trip as `false`, not
    // `undefined` — JSON serialisation would otherwise omit the key
    // entirely and break the `!!` guard on restore.
    const sessionMissing = new EventEmitter()
    sessionMissing.model = 'sonnet'
    sessionMissing.permissionMode = 'approve'
    Object.defineProperty(sessionMissing, 'resumeSessionId', { get: () => null })
    sessionMissing.destroy = () => {}
    mgr._sessions.set('s-missing', { session: sessionMissing, name: 'Missing', cwd: '/tmp' })

    const state2 = mgr.serializeState()
    const missingEntry = state2.sessions.find(s => s.name === 'Missing')
    assert.equal(missingEntry.stdinForwardingDisabled, false)
    assert.equal(typeof missingEntry.stdinForwardingDisabled, 'boolean')
  })

  it('persists cumulativeUsage so the badge survives a restart (#4089)', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    const session = new EventEmitter()
    session.model = 'claude-opus-4-7'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', {
      session,
      type: 'cli',
      name: 'Cost Session',
      cwd: '/tmp',
      cumulativeUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
        costUsd: 0.0345,
        turnsBilled: 3,
      },
    })
    const state = mgr.serializeState()
    assert.deepEqual(state.sessions[0].cumulativeUsage, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      costUsd: 0.0345,
      turnsBilled: 3,
    })
  })

  it('persists costThresholdNotified latch (#4124)', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    const session = new EventEmitter()
    session.model = 'claude-opus-4-7'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', {
      session,
      type: 'cli',
      name: 'Latched',
      cwd: '/tmp',
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, turnsBilled: 0 },
      costThresholdNotified: true,
    })
    const state = mgr.serializeState()
    assert.equal(state.sessions[0].costThresholdNotified, true)
  })

  it('round-trips missing fields as defaults (older state files)', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    const session = new EventEmitter()
    session.model = null
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    // Entry without cumulativeUsage or costThresholdNotified (pre-#4089/#4124 shape)
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Legacy', cwd: '/tmp' })
    const state = mgr.serializeState()
    // Persistence emits explicit defaults — null for missing usage, false for missing latch.
    assert.equal(state.sessions[0].cumulativeUsage, null)
    assert.equal(state.sessions[0].costThresholdNotified, false)
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null)
  })

  it('returns null for invalid JSON', () => {
    writeFileSync(stateFile, 'not json')
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null)
    assert.equal(existsSync(stateFile), false, 'Invalid state file should be removed')
  })

  it('returns null for empty sessions array', () => {
    writeFileSync(stateFile, JSON.stringify({ timestamp: Date.now(), sessions: [] }))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null)
  })

  it('returns null for state older than TTL', () => {
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000 // 25 hours
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: staleTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    assert.equal(mgr.restoreState(), null, 'State older than 24h should be rejected')
  })

  it('accepts state within TTL (23h old)', () => {
    const recentTimestamp = Date.now() - 23 * 60 * 60 * 1000 // 23 hours
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: recentTimestamp,
      sessions: [{ name: 'test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile, stateTtlMs: 5 * 60 * 1000 })
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

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId, 'Should return the first restored session ID')

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 2, 'Should have 2 restored sessions')

    mgr.destroyAll()
  })

  it('restores cumulativeUsage and threshold latch (#4089 / #4124)', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        {
          name: 'Restored',
          cwd: '/tmp',
          model: null,
          permissionMode: 'approve',
          sdkSessionId: null,
          cumulativeUsage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheCreationTokens: 100,
            costUsd: 0.0345,
            turnsBilled: 3,
          },
          costThresholdNotified: true,
        },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 1)
    // cumulativeUsage survives the restart — badge shows the running cost.
    assert.equal(sessions[0].cumulativeUsage.costUsd, 0.0345)
    assert.equal(sessions[0].cumulativeUsage.turnsBilled, 3)
    // Latch survives — the threshold warning won't re-fire on next priced turn.
    const restoredSessionId = sessions[0].sessionId
    const entry = mgr._sessions.get(restoredSessionId)
    assert.equal(entry.costThresholdNotified, true,
      'threshold-notified latch must round-trip so the warning fires once per LOGICAL session')
    mgr.destroyAll()
  })

  it('coerces corrupt cumulativeUsage fields to defaults on restore (#4089 defensive)', () => {
    // A truncated/corrupt entry in session-state.json must not poison
    // the renderer. Two paths to test:
    //
    //   (a) JSON-representable corruption that round-trips intact:
    //       strings, nulls, negative numbers, missing fields. The
    //       restore-side coercion (nonNegFinite for tokens / turnsBilled,
    //       Number.isFinite for costUsd) defends against these.
    //
    //   (b) Non-JSON-serialisable values (NaN, Infinity) — these are
    //       serialised by JSON.stringify as `null`, so by the time the
    //       restored state lands they're already null. The "missing
    //       field" handler covers this case implicitly. We pin one
    //       NaN/Infinity input separately below to document the
    //       JSON conversion contract.
    //
    // #4128 review: previous version of this test labelled each
    // assertion with the input type pre-serialisation (e.g. "NaN → 0"),
    // which was misleading — by the time restoreState saw the value it
    // was already `null` because JSON had erased the NaN/Infinity.
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        {
          name: 'Corrupt',
          cwd: '/tmp',
          model: null,
          permissionMode: 'approve',
          sdkSessionId: null,
          cumulativeUsage: {
            // JSON.stringify(NaN) === 'null' and JSON.stringify(Infinity) === 'null'.
            // The labels below describe what arrives at restoreState,
            // not what was passed in.
            inputTokens: NaN,
            outputTokens: 'oops',
            cacheReadTokens: Infinity,
            cacheCreationTokens: null,
            // costUsd intentionally missing
            turnsBilled: -5, // negative, JSON-preserved
          },
        },
      ],
    }))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    const sessions = mgr.listSessions()
    // null (was NaN) → 0
    assert.equal(sessions[0].cumulativeUsage.inputTokens, 0, 'restored as null after JSON; clamped to 0')
    // string preserved by JSON → 0 via nonNegFinite
    assert.equal(sessions[0].cumulativeUsage.outputTokens, 0, 'non-number string clamped to 0')
    // null (was Infinity) → 0
    assert.equal(sessions[0].cumulativeUsage.cacheReadTokens, 0, 'restored as null after JSON; clamped to 0')
    // explicit null → 0
    assert.equal(sessions[0].cumulativeUsage.cacheCreationTokens, 0, 'explicit null clamped to 0')
    // missing field → 0
    assert.equal(sessions[0].cumulativeUsage.costUsd, 0, 'missing field falls back to 0')
    // #4128 review: negative tokens / turnsBilled clamp to 0 — they're
    // monotonic counters and a negative value indicates corruption.
    // costUsd is the exception (refunds, #4099) but turnsBilled is not.
    assert.equal(sessions[0].cumulativeUsage.turnsBilled, 0, 'negative turnsBilled clamps to 0')
    mgr.destroyAll()
  })

  it('preserves a legitimate negative costUsd on restore (#4099 refund flow)', () => {
    // costUsd is the one cumulativeUsage field allowed to be negative —
    // a refund / credit-adjustment turn subtracts from the running
    // total, and a session that received only refunds could legitimately
    // end up below zero. The restore clamp uses `Number.isFinite` (no
    // sign check) specifically to preserve this case (#4128 review).
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        {
          name: 'Refunded',
          cwd: '/tmp',
          model: null,
          permissionMode: 'approve',
          sdkSessionId: null,
          cumulativeUsage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: -0.25, // refund net-negative
            turnsBilled: 3,
          },
        },
      ],
    }))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    const sessions = mgr.listSessions()
    assert.equal(sessions[0].cumulativeUsage.costUsd, -0.25,
      'negative costUsd is preserved — refunds flow through restore')
    mgr.destroyAll()
  })

  it('restores lastActivityAt from state file', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'Session A', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, lastActivityAt: 12_345 },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].lastActivityAt, 12_345)

    mgr.destroyAll()
  })

  // #3185: promptEvaluator round-trips. A state file written with the
  // toggle on must restore with the toggle still on; pre-#3185 state
  // files (no field) restore as `false` so older state files don't
  // break.
  it('restores promptEvaluator across the state cycle (#3185)', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'Has Evaluator', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, promptEvaluator: true },
        { name: 'No Field', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    const sessions = mgr.listSessions()
    const withEval = sessions.find(s => s.name === 'Has Evaluator')
    const withoutEval = sessions.find(s => s.name === 'No Field')
    assert.equal(withEval.promptEvaluator, true)
    // Older state file without the field defaults to `false` —
    // BaseSession's coerce-to-bool ensures listSessions never emits
    // `undefined` on the wire.
    assert.equal(withoutEval.promptEvaluator, false)
    assert.equal(typeof withoutEval.promptEvaluator, 'boolean')

    mgr.destroyAll()
  })

  // #3805: chroxyContextHint round-trips. A state file written with the
  // flag ON must restore with the flag still ON (so a long-running
  // session keeps the model "mobile-aware" across a daemon restart);
  // pre-#3805 state files (no field) restore as `false` so legacy state
  // files keep the safe default. This also exercises the full plumbing
  // — `createSession` → providerOpts → SdkSession/CliSession constructor
  // → super(...) → BaseSession field. The middle-layer forwarding bug
  // [[feedback_jsonl_subprocess_middle_layer]] surfaces here as the
  // restored session having `chroxyContextHint=false` despite the
  // state file saying true.
  it('restores chroxyContextHint across the state cycle (#3805)', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'HintOn', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, chroxyContextHint: true },
        { name: 'HintOff', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, chroxyContextHint: false },
        { name: 'NoField', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    const sessions = mgr.listSessions()
    const hintOn = sessions.find(s => s.name === 'HintOn')
    const hintOff = sessions.find(s => s.name === 'HintOff')
    const noField = sessions.find(s => s.name === 'NoField')
    assert.equal(hintOn.chroxyContextHint, true,
      'a state file with chroxyContextHint:true must round-trip through createSession + providerOpts + provider constructor + super() into the BaseSession field')
    assert.equal(hintOff.chroxyContextHint, false)
    assert.equal(noField.chroxyContextHint, false,
      'pre-#3805 state files (no field) restore with the flag OFF — safe default')
    assert.equal(typeof noField.chroxyContextHint, 'boolean')

    mgr.destroyAll()
  })

  // #3639: per-session promptEvaluatorSkipPattern round-trips. A state
  // file written with the field must restore the session with the same
  // pattern; pre-#3639 state files (no field) restore as null. Malformed
  // patterns in the saved file fall back to null so a hand-edited state
  // file can't crash session restoration.
  it('restores promptEvaluatorSkipPattern across the state cycle (#3639)', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'WithPattern', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, promptEvaluatorSkipPattern: '^lgtm$' },
        { name: 'NoField', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
        { name: 'BadPattern', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, promptEvaluatorSkipPattern: '[unclosed' },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    const sessions = mgr.listSessions()
    const withPat = sessions.find(s => s.name === 'WithPattern')
    const noField = sessions.find(s => s.name === 'NoField')
    const badPat = sessions.find(s => s.name === 'BadPattern')
    assert.equal(withPat.promptEvaluatorSkipPattern, '^lgtm$')
    assert.equal(noField.promptEvaluatorSkipPattern, null,
      'pre-#3639 state files restore with the per-session field as null (global config still applies)')
    assert.equal(badPat.promptEvaluatorSkipPattern, null,
      'malformed regex source falls back to null on restore (BaseSession defends against schema drift)')

    mgr.destroyAll()
  })

  // #3540: the SidecarProcess `stdin_disabled` latch round-trips across a
  // server restart. A state file written with the flag set must restore
  // the SdkSession with the flag still set so a client connecting after
  // restart sees the disabled state in the initial `session_list`
  // payload — without this, the original transient `error` event fired
  // against the previous process and is not replayed. Pre-#3540 state
  // files (no field) restore as `false`.
  it('restores stdinForwardingDisabled across the state cycle (#3540)', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'StdinDisabled', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, stdinForwardingDisabled: true },
        { name: 'StdinOk', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, stdinForwardingDisabled: false },
        { name: 'NoField', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()
    const sessions = mgr.listSessions()

    const disabled = sessions.find(s => s.name === 'StdinDisabled')
    const ok = sessions.find(s => s.name === 'StdinOk')
    const missing = sessions.find(s => s.name === 'NoField')

    assert.equal(disabled.stdinForwardingDisabled, true,
      'persisted stdin_disabled latch must hydrate onto the restored SdkSession so reconnecting clients observe the disabled state')
    assert.equal(ok.stdinForwardingDisabled, false)
    // Pre-#3540 state file without the field defaults to `false` so older
    // snapshots round-trip cleanly without breaking the `!!` guard.
    assert.equal(missing.stdinForwardingDisabled, false)
    assert.equal(typeof missing.stdinForwardingDisabled, 'boolean')

    // Round-trip the in-memory state back to disk to confirm the flag
    // survives a second serialize cycle (catches a "hydrate at construct
    // but never persist again" regression).
    const state = mgr.serializeState()
    const persistedDisabled = state.sessions.find(s => s.name === 'StdinDisabled')
    const persistedOk = state.sessions.find(s => s.name === 'StdinOk')
    const persistedMissing = state.sessions.find(s => s.name === 'NoField')
    assert.equal(persistedDisabled.stdinForwardingDisabled, true,
      'second serialize cycle must still emit the latched flag')
    assert.equal(persistedOk.stdinForwardingDisabled, false)
    assert.equal(persistedMissing.stdinForwardingDisabled, false)

    mgr.destroyAll()
  })

  // #3540: restoring a session with stdinForwardingDisabled=true must NOT
  // re-emit the `error{code:'stdin_disabled'}` event. The metadata field
  // is the canonical signal for cold restarts; the original event already
  // fired against the previous process and the `_attachSidecarProcessListeners`
  // short-circuit (gated on `_stdinForwardingDisabled`) keeps a future
  // SidecarProcess `stdin_disabled` from re-firing the warn/error.
  it('does not replay error event when restoring a stdin-disabled session (#3540)', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'StdinDisabled', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, stdinForwardingDisabled: true },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })

    const errorEvents = []
    mgr.on('session_event', (data) => {
      if (data && data.event === 'error') errorEvents.push(data)
    })

    mgr.restoreState()

    const stdinErrors = errorEvents.filter(e => e?.data?.code === 'stdin_disabled')
    assert.equal(stdinErrors.length, 0,
      'restoring a stdin-disabled session must NOT re-emit the error event — metadata field is the canonical signal for cold restart')

    mgr.destroyAll()
  })

  it('keeps state file after restore', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'Test', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null }],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
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

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId)

    const restored = mgr.getHistory(firstId)
    assert.equal(restored.length, 3)
    assert.equal(restored[0].content, 'hello')
    assert.equal(restored[1].content, 'world')
    assert.equal(restored[2].cost, 0.01)

    mgr.destroyAll()
  })

  // Regression for #2906 / PR #2907 Copilot finding: createSession() flushes
  // synchronously on session-list mutations, but restoreState() calls it in a
  // loop and seeds history/budget AFTER the loop. Without skipPersist, each
  // createSession flush would rewrite the on-disk state with empty history,
  // permanently discarding the data being restored (and .bak wouldn't help
  // because main stays valid JSON).
  it('preserves on-disk history through restoreState + serializeState cycle', () => {
    const history = [
      { type: 'message', messageType: 'user_input', content: 'question one', timestamp: 1000 },
      { type: 'message', messageType: 'response', content: 'answer one', timestamp: 2000 },
    ]
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { name: 'A', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history },
        { name: 'B', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history: [{ type: 'message', messageType: 'user_input', content: 'B prompt', timestamp: 500 }] },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId)

    // restoreState flushes once at the end. The written file MUST still
    // contain the full history for every session, not the empty history
    // that createSession-alone would produce per session.
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(onDisk.sessions.length, 2)
    const bySavedName = Object.fromEntries(onDisk.sessions.map(s => [s.name, s]))
    assert.equal(bySavedName.A.history.length, 2, `A history lost on disk — got ${bySavedName.A.history?.length}`)
    assert.equal(bySavedName.A.history[0].content, 'question one')
    assert.equal(bySavedName.A.history[1].content, 'answer one')
    assert.equal(bySavedName.B.history.length, 1, `B history lost on disk — got ${bySavedName.B.history?.length}`)
    assert.equal(bySavedName.B.history[0].content, 'B prompt')

    mgr.destroyAll()
  })

  it('handles legacy state without version (skips history)', () => {
    writeFileSync(stateFile, JSON.stringify({
      timestamp: Date.now(),
      sessions: [{ name: 'Legacy', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history: [{ type: 'message', content: 'old' }] }],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
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

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    const firstId = mgr.restoreState()
    assert.ok(firstId, 'Should return the first successfully restored session')

    const sessions = mgr.listSessions()
    assert.equal(sessions.length, 1, 'Only the good session should be restored')

    mgr.destroyAll()
  })

  // Guardian FM-01 (#2954): surface restore failures and preserve history on disk
  it('emits session_restore_failed event when a session fails to restore', () => {
    const savedHistory = [
      { type: 'message', messageType: 'user_input', content: 'my question', timestamp: 1000 },
      { type: 'message', messageType: 'response', content: 'my answer', timestamp: 2000 },
    ]
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { id: 'failing-id', name: 'Gemini Bad', cwd: '/nonexistent/path/that/does/not/exist', model: null, permissionMode: 'approve', sdkSessionId: null, provider: 'gemini-cli', history: savedHistory },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })

    const failureEvents = []
    mgr.on('session_restore_failed', (ev) => failureEvents.push(ev))

    mgr.restoreState()

    assert.equal(failureEvents.length, 1, 'Should emit exactly one session_restore_failed event')
    const ev = failureEvents[0]
    assert.equal(ev.name, 'Gemini Bad')
    assert.equal(ev.provider, 'gemini-cli')
    assert.equal(ev.cwd, '/nonexistent/path/that/does/not/exist')
    assert.equal(ev.model, null)
    assert.equal(ev.permissionMode, 'approve')
    assert.ok(typeof ev.sessionId === 'string' && ev.sessionId.length > 0, 'Failed event should carry a sessionId')
    assert.ok(typeof ev.errorMessage === 'string' && ev.errorMessage.length > 0, 'Failed event should carry errorMessage')
    assert.ok(typeof ev.errorCode === 'string', 'Failed event should carry errorCode (even if generic)')
    assert.equal(ev.originalHistoryPreserved, true, 'history must be preserved on disk')
    assert.equal(ev.historyLength, savedHistory.length)

    mgr.destroyAll()
  })

  it('preserves failed session history on disk so retry works', () => {
    const savedHistory = [
      { type: 'message', messageType: 'user_input', content: 'preserved question', timestamp: 1000 },
      { type: 'message', messageType: 'response', content: 'preserved answer', timestamp: 2000 },
    ]
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { id: 'good-id', name: 'Good', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history: [{ type: 'message', messageType: 'user_input', content: 'good q', timestamp: 500 }] },
        { id: 'bad-id', name: 'Bad', cwd: '/nonexistent/path/that/does/not/exist', model: null, permissionMode: 'approve', sdkSessionId: null, provider: 'gemini-cli', history: savedHistory },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()

    const onDisk = JSON.parse(readFileSync(stateFile, 'utf-8'))
    // Failed session must survive on disk with its full history
    const bySavedName = Object.fromEntries(onDisk.sessions.map(s => [s.name, s]))
    assert.ok(bySavedName.Bad, 'Failed session should still be present on disk')
    assert.equal(bySavedName.Bad.history.length, 2, `Failed session history lost on disk — got ${bySavedName.Bad.history?.length}`)
    assert.equal(bySavedName.Bad.history[0].content, 'preserved question')
    assert.equal(bySavedName.Bad.history[1].content, 'preserved answer')
    assert.equal(bySavedName.Bad.provider, 'gemini-cli', 'Provider must be preserved so retry uses same provider')
    assert.equal(bySavedName.Bad.cwd, '/nonexistent/path/that/does/not/exist', 'cwd must be preserved')

    mgr.destroyAll()
  })

  it('listSessions includes failed restores with needs_attention flag', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [
        { id: 'bad-id', name: 'Bad', cwd: '/nonexistent/path/that/does/not/exist', model: null, permissionMode: 'approve', sdkSessionId: null, provider: 'gemini-cli', history: [] },
      ],
    }))

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgr.restoreState()

    const failed = mgr.getFailedRestores()
    assert.equal(failed.length, 1, 'getFailedRestores() should return the failed session')
    assert.equal(failed[0].name, 'Bad')
    assert.equal(failed[0].provider, 'gemini-cli')
    assert.equal(failed[0].needsAttention, true)
    assert.ok(failed[0].errorMessage)

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
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile, persistDebounceMs: 100 })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    Object.defineProperty(session, 'resumeSessionId', { get: () => 'conv-uuid-123' })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    assert.equal(mgr.getConversationId('s1'), 'conv-uuid-123')
  })

  it('returns null when resumeSessionId is not set', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp' })

    assert.equal(mgr.getConversationId('s1'), null)
  })

  it('returns null for nonexistent session', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.getConversationId('nonexistent'), null)
  })
})

describe('SessionManager.listSessions includes conversationId', () => {
  it('includes conversationId in session list entries', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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

// #3573: hydrate cumulative stdin_dropped totals on reconnect via the
// `session_list` payload. PR #3572 (#3544) shipped the `stdin_dropped_totals`
// transient event but never seeded the running counters into the handshake,
// so a dashboard / mobile client that connects after one or more drops
// already happened painted `bytes=0, count=0` until the next drop fired.
// `listSessions()` is the canonical seed for both `auth_ok`-flow
// `session_list` and `broadcastSessionList()` re-broadcasts; surface the
// counters here so reconnecting clients re-hydrate without waiting.
describe('SessionManager.listSessions includes stdinDroppedTotals (#3573)', () => {
  it('reads the SDK session getter and exposes both counters', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

    // SdkSession exposes a `stdinDroppedTotals` getter (#3544) that returns
    // `{ bytes, count }`. listSessions() must read it through the public
    // accessor, NOT the private `_stdinDroppedBytesTotal` field, so the
    // contract stays stable if the storage shape changes later.
    const session = new EventEmitter()
    session.isRunning = false
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    Object.defineProperty(session, 'stdinDroppedTotals', {
      get: () => ({ bytes: 4096, count: 3 }),
    })
    session.destroy = () => {}
    mgr._sessions.set('s-with-drops', { session, name: 'Dropped', cwd: '/tmp', createdAt: Date.now() })

    const [entry] = mgr.listSessions()
    assert.equal(entry.stdinDroppedBytes, 4096)
    assert.equal(entry.stdinDroppedCount, 3)
    assert.equal(typeof entry.stdinDroppedBytes, 'number')
    assert.equal(typeof entry.stdinDroppedCount, 'number')
  })

  it('defaults to 0 / 0 for non-SDK providers without the getter', () => {
    // CliSession / Codex / Gemini do not drop stdin at the SidecarProcess
    // pre-dial cap (no SidecarProcess in the loop), so they have no
    // `stdinDroppedTotals` getter. listSessions() must round-trip these as
    // numeric `0` so reconnecting clients see a stable shape regardless of
    // provider — `undefined` would force every client to add a fallback.
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

    const session = new EventEmitter()
    session.isRunning = false
    session.model = null
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s-cli', { session, name: 'CliSession', cwd: '/tmp', createdAt: Date.now() })

    const [entry] = mgr.listSessions()
    assert.equal(entry.stdinDroppedBytes, 0)
    assert.equal(entry.stdinDroppedCount, 0)
    assert.equal(typeof entry.stdinDroppedBytes, 'number')
    assert.equal(typeof entry.stdinDroppedCount, 'number')
  })

  it('coerces non-finite getter values back to 0', () => {
    // Defensive: a malformed provider that returns NaN / null fields must
    // not leak NaN onto the wire — clients would render "X bytes lost over
    // NaN drops". Coerce to 0 so the indicator renders cleanly.
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

    const session = new EventEmitter()
    session.isRunning = false
    session.model = null
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    Object.defineProperty(session, 'stdinDroppedTotals', {
      get: () => ({ bytes: NaN, count: undefined }),
    })
    session.destroy = () => {}
    mgr._sessions.set('s-bad', { session, name: 'Bad', cwd: '/tmp', createdAt: Date.now() })

    const [entry] = mgr.listSessions()
    assert.equal(entry.stdinDroppedBytes, 0)
    assert.equal(entry.stdinDroppedCount, 0)
  })
})

// #4307: pending-background-shells snapshot in session_list. A client
// joining mid-flight (fresh tab, server reconnect, app resume) must
// see the waiting state through the session-list snapshot without
// waiting for the next `background_work_changed` event.
describe('SessionManager.listSessions includes pendingBackgroundShells (#4307)', () => {
  it('reads getPendingBackgroundShells() and surfaces the entries', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const pending = [
      { shellId: 'a', command: 'sleep 600', startedAt: 100 },
      { shellId: 'b', command: 'tail -f log', startedAt: 200 },
    ]
    const session = new EventEmitter()
    session.isRunning = true
    session.model = null
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.getPendingBackgroundShells = () => pending
    session.destroy = () => {}
    mgr._sessions.set('s-bg', { session, name: 'Waiting', cwd: '/tmp', createdAt: Date.now() })

    const [entry] = mgr.listSessions()
    assert.ok(Array.isArray(entry.pendingBackgroundShells))
    assert.equal(entry.pendingBackgroundShells.length, 2)
    assert.equal(entry.pendingBackgroundShells[0].shellId, 'a')
    assert.equal(entry.pendingBackgroundShells[1].shellId, 'b')
  })

  it('defaults to an empty array for providers without the getter', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.model = null
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s-old', { session, name: 'NoGetter', cwd: '/tmp', createdAt: Date.now() })

    const [entry] = mgr.listSessions()
    assert.deepEqual(entry.pendingBackgroundShells, [])
  })
})

describe('SessionManager provider support', () => {
  it('defaults to claude-sdk provider', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._providerType, 'claude-sdk')
  })

  it('accepts providerType parameter', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, providerType: 'claude-cli', stateFilePath: tmpStateFile() })
    assert.equal(mgr._providerType, 'claude-cli')
  })

  it('listSessions includes provider and capabilities', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, providerType: 'claude-sdk', stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._maxHistory, 1000)
  })

  it('trims history when exceeding the default limit', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxHistory: 500, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxHistory: 500, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._persistDebounceMs, 2000)
  })

  it('allows overriding persist debounce', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, persistDebounceMs: 500, stateFilePath: tmpStateFile() })
    assert.equal(mgr._persistDebounceMs, 500)
  })
})

describe('SessionManager.isHistoryTruncated', () => {
  it('returns false when history has not been truncated', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    for (let i = 0; i < 10; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i }, 's1')
    }

    assert.equal(mgr.isHistoryTruncated('s1'), false)
  })

  it('returns true after ring buffer drops messages', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, maxHistory: 10, stateFilePath: tmpStateFile() })
    mgr._messageHistory.set('s1', [])
    const history = mgr._messageHistory.get('s1')

    // Fill beyond capacity to trigger truncation
    for (let i = 0; i < 11; i++) {
      mgr._pushHistory(history, { type: 'message', content: `msg-${i}`, timestamp: i }, 's1')
    }

    assert.equal(mgr.isHistoryTruncated('s1'), true)
  })

  it('returns false for unknown session', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.isHistoryTruncated('nonexistent'), false)
  })

  it('clears truncation flag when session is destroyed', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    assert.equal(mgr.isBudgetPaused('nonexistent'), false)
  })

  it('isBudgetPaused returns true after adding to _budgetPaused', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    mgr._costBudget._budgetPaused.add('s1')
    assert.equal(mgr.isBudgetPaused('s1'), true)
  })

  it('resumeBudget removes session from _budgetPaused', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
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

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
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

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
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

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(typeof mgr.getFullHistory, 'undefined',
      'getFullHistory (sync) should not exist — only getFullHistoryAsync')
    assert.equal(typeof mgr.getFullHistoryAsync, 'function',
      'getFullHistoryAsync should still exist')
  })

  it('destroySession flushes persist synchronously (regression: #2906)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sm-persist-'))
    const mgr = new SessionManager({ skipPreflight: true,
      maxSessions: 5,
      stateFilePath: join(tmpDir, 'state.json'),
      persistDebounceMs: 10_000, // large — proves we're not waiting for the debounce
    })

    // Insert a mock session
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'S1', cwd: '/tmp' })
    mgr.touchActivity('s1')

    // Spy on _flushPersist
    let flushCallCount = 0
    const original = mgr._flushPersist.bind(mgr)
    mgr._flushPersist = () => { flushCallCount++; original() }

    mgr.destroySession('s1')

    assert.equal(flushCallCount, 1,
      `destroySession should call _flushPersist once, got ${flushCallCount}`)

    // State file must exist immediately — no debounce — because the session
    // removal has to survive an abrupt shutdown (SIGKILL, power loss, pkill).
    const stateFile = join(tmpDir, 'state.json')
    assert.ok(existsSync(stateFile),
      `destroySession should write state file synchronously (not wait for debounce)`)

    // Clean up timer and temp dir
    clearTimeout(mgr._persistTimer)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('createSession failure cleanup (FM-03)', () => {
  it('cleans up _sessions and _lastActivity when session.start() throws', async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })

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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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

    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    mgr.createSession({ cwd: '/tmp', provider: 'test-session-id' })

    const [sessionId] = [...mgr._sessions.keys()]
    assert.equal(sessionId.length, 32, 'Session ID should be 32 hex chars (128-bit)')
    assert.match(sessionId, /^[0-9a-f]{32}$/, 'Session ID should be lowercase hex')

    mgr.destroySession(sessionId)
  })
})

describe('SessionManager.defaultCwd getter (#1475)', () => {
  it('exposes defaultCwd via public getter', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp/test-cwd', stateFilePath: tmpStateFile() })
    assert.equal(mgr.defaultCwd, '/tmp/test-cwd')
  })

  it('defaults to process.cwd() when no defaultCwd provided', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.defaultCwd, process.cwd())
  })
})

describe('Configurable magic numbers (#1848)', () => {
  it('maxHistory defaults to 1000', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr._maxHistory, 1000)
  })

  it('maxHistory can be configured', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, maxHistory: 500, stateFilePath: tmpStateFile() })
    assert.equal(mgr._maxHistory, 500)
  })

  it('maxSessions can be configured', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 10, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxSessions, 10)
  })

  it('maxSessions defaults to 5', () => {
    const mgr = new SessionManager({ skipPreflight: true, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxSessions, 5)
  })
})

describe('#2692 — session destroy race: getSession rejects mid-destroy sessions', () => {
  it('sets _destroying flag at start of destroySession()', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Test', cwd: '/tmp', _destroying: true })

    assert.equal(mgr.getSession('s1'), null,
      'getSession should return null when _destroying is set on the entry')
  })

  it('getSession returns null during destroySession()', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const s = new EventEmitter()
    s.isRunning = false
    s.destroy = () => {}
    mgr._sessions.set('s1', { session: s, name: 'S1', cwd: '/tmp', createdAt: 1, _destroying: true })
    assert.equal(mgr.firstSessionId, null)
  })

  it('getFullHistoryAsync() returns [] for entries marked _destroying without reading JSONL', async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
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
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, maxMessages: 250, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxMessages, 250)
  })

  it('falls back to maxHistory alias when maxMessages is not provided', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, maxHistory: 175, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxMessages, 175)
  })

  it('maxMessages takes precedence over maxHistory when both are provided', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, maxMessages: 300, maxHistory: 100, stateFilePath: tmpStateFile() })
    assert.equal(mgr.maxMessages, 300)
  })
})

describe('#3700b — bootedModel round-trips through serialize/restore', () => {
  it('serializeState includes bootedModel for sessions that booted with no explicit model', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.model = null
    session.bootedModel = 'claude-opus-4-7'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'My Session', cwd: '/tmp', createdAt: Date.now() })

    const state = mgr.serializeState()
    assert.equal(state.sessions[0].model, null, 'explicit model stays null')
    assert.equal(state.sessions[0].bootedModel, 'claude-opus-4-7', 'bootedModel is persisted')
  })

  it('serializeState writes null bootedModel when session has not booted yet', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.model = null
    session.bootedModel = null
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Pending', cwd: '/tmp', createdAt: Date.now() })

    const state = mgr.serializeState()
    assert.equal(state.sessions[0].bootedModel, null)
  })
})

describe('#3700 — messageId counter survives server restart (no dashboard collision)', () => {
  it('serializeState persists the per-session _messageCounter', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.model = null
    session.bootedModel = null
    session.permissionMode = 'approve'
    session._messageCounter = 27
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'My Session', cwd: '/tmp', createdAt: Date.now() })

    const state = mgr.serializeState()
    assert.equal(state.sessions[0].messageCounter, 27, 'counter is persisted as-is')
  })

  it('serializeState writes 0 when the session never sent a message', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.model = null
    session.permissionMode = 'approve'
    session._messageCounter = 0
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'Fresh', cwd: '/tmp', createdAt: Date.now() })

    const state = mgr.serializeState()
    assert.equal(state.sessions[0].messageCounter, 0)
  })

  it('createSession({ messageCounter }) pre-seeds session._messageCounter on the constructed session', async () => {
    // Use an actual provider so the session object has _messageCounter
    // initialized by BaseSession's constructor. Ignore that the spawn
    // would fail without the binary — we're checking the pre-seed
    // ordering happens BEFORE start() and we destroy immediately.
    const { CliSession } = await import('../src/cli-session.js')
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    // Stub the ProviderClass return so we can intercept construction.
    // CliSession's constructor just initialises fields — no async / I/O —
    // so calling it directly is safe even without a real binary.
    const orig = CliSession.prototype.start
    CliSession.prototype.start = function () { /* no-op */ }
    try {
      const sessionId = mgr.createSession({
        name: 'Restored',
        cwd: '/tmp',
        provider: 'claude-cli',
        messageCounter: 42,
      })
      const entry = mgr._sessions.get(sessionId)
      assert.ok(entry, 'session was created')
      assert.equal(entry.session._messageCounter, 42, '_messageCounter pre-seeded from opt')
      // Cleanup so destroyAll doesn't try to spawn anything
      entry.session.destroy = () => {}
      mgr.destroyAll()
    } finally {
      CliSession.prototype.start = orig
    }
  })

  it('createSession ignores non-numeric / negative / non-finite messageCounter', async () => {
    const { CliSession } = await import('../src/cli-session.js')
    const orig = CliSession.prototype.start
    CliSession.prototype.start = function () { /* no-op */ }
    try {
      // Each garbage value should be ignored — session falls back to the
      // BaseSession constructor default of 0. Run them through individual
      // SessionManager instances so destroyAll between cases doesn't leak
      // shared persistence state.
      const garbageValues = [
        ['negative number', -1],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['string', '5'],
        ['null', null],
      ]
      for (const [label, val] of garbageValues) {
        const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
        const sid = mgr.createSession({
          name: `Bad ${label}`, cwd: '/tmp', provider: 'claude-cli', messageCounter: val,
        })
        assert.equal(
          mgr._sessions.get(sid).session._messageCounter, 0,
          `${label} should fall back to 0`
        )
        mgr._sessions.get(sid).session.destroy = () => {}
        mgr.destroyAll()
      }
    } finally {
      CliSession.prototype.start = orig
    }
  })

  it('createSession accepts 0 as a valid messageCounter value', async () => {
    // Edge case: an explicit 0 should be honoured (it's a valid counter
    // for a fresh session that was persisted before any message was sent).
    // The Number.isFinite + >=0 guard correctly admits 0.
    const { CliSession } = await import('../src/cli-session.js')
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const orig = CliSession.prototype.start
    CliSession.prototype.start = function () { /* no-op */ }
    try {
      const sid = mgr.createSession({
        name: 'Zero', cwd: '/tmp', provider: 'claude-cli', messageCounter: 0,
      })
      assert.equal(mgr._sessions.get(sid).session._messageCounter, 0)
      mgr._sessions.get(sid).session.destroy = () => {}
      mgr.destroyAll()
    } finally {
      CliSession.prototype.start = orig
    }
  })
})

describe('#3697 — shutdown race must not overwrite good state with empty state', () => {
  it('serializeState() after destroyAll() is a no-op (does not write 0 sessions)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'chroxy-3697-'))
    const stateFile = join(tempDir, 'session-state.json')
    try {
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

      const session = new EventEmitter()
      session.model = 'claude-opus-4-7'
      session.permissionMode = 'approve'
      Object.defineProperty(session, 'resumeSessionId', { get: () => 'sdk-abc' })
      session.destroy = () => {}
      mgr._sessions.set('s1', { session, type: 'cli', name: 'My Work', cwd: '/tmp', createdAt: Date.now() })
      mgr._lastActivity.set('s1', Date.now())

      // First shutdown pass: writes the good state, then clears _sessions.
      mgr.destroyAll()
      const afterDestroy = JSON.parse(readFileSync(stateFile, 'utf-8'))
      assert.equal(afterDestroy.sessions.length, 1, 'destroyAll itself wrote the good state')

      // Second shutdown pass (e.g. SIGINT-after-SIGTERM, or duplicate handler):
      // would previously have written 0 sessions and rotated the good state to .bak.
      const result = mgr.serializeState()
      assert.equal(result, null, 'serializeState returns null after destroyAll')
      const afterSecond = JSON.parse(readFileSync(stateFile, 'utf-8'))
      assert.equal(afterSecond.sessions.length, 1, 'state on disk still has the session')
      assert.equal(afterSecond.sessions[0].name, 'My Work')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('_schedulePersist() after destroyAll() does not queue a debounced empty-state write', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'chroxy-3697b-'))
    const stateFile = join(tempDir, 'session-state.json')
    try {
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })

      const session = new EventEmitter()
      session.model = 'claude-opus-4-7'
      session.permissionMode = 'approve'
      Object.defineProperty(session, 'resumeSessionId', { get: () => 'sdk-xyz' })
      session.destroy = () => {}
      mgr._sessions.set('s1', { session, type: 'cli', name: 'Important', cwd: '/tmp', createdAt: Date.now() })

      mgr.destroyAll()

      // Spy on persistence.schedulePersist — must NOT be called after destroyAll
      let scheduled = 0
      mgr._persistence.schedulePersist = () => { scheduled++ }
      mgr._schedulePersist()
      assert.equal(scheduled, 0, '_schedulePersist must not queue a write once _destroying is set')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('SessionManager._trackUsage (#4072)', () => {
  function makeWiredManager() {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    // Mimic the entry shape `createSession` builds. The new cumulativeUsage
    // field on the entry is what `_trackUsage` increments.
    mgr._sessions.set('s1', {
      session,
      name: 'S1',
      cwd: '/tmp',
      provider: 'claude-byok',
      createdAt: Date.now(),
      cumulativeUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turnsBilled: 0,
      },
    })
    mgr._wireSessionEvents('s1', session)
    return { mgr, session }
  }

  function captureSessionUsage(mgr) {
    const events = []
    mgr.on('session_event', (e) => {
      if (e.event === 'session_usage') events.push(e)
    })
    return events
  }

  it('accumulates usage + cost across multiple result events', () => {
    const { mgr } = makeWiredManager()
    mgr._trackUsage('s1', { usage: { input_tokens: 10, output_tokens: 5 }, cost: 0.001 })
    mgr._trackUsage('s1', { usage: { input_tokens: 7, output_tokens: 3 }, cost: 0.0005 })
    const got = mgr.getCumulativeUsage('s1')
    assert.equal(got.inputTokens, 17)
    assert.equal(got.outputTokens, 8)
    assert.ok(Math.abs(got.costUsd - 0.0015) < 1e-9, `expected 0.0015, got ${got.costUsd}`)
    assert.equal(got.turnsBilled, 2)
  })

  it('emits session_usage on every priced result event', () => {
    const { mgr, session } = makeWiredManager()
    const events = captureSessionUsage(mgr)
    session.emit('result', { usage: { input_tokens: 5, output_tokens: 4 }, cost: 0.000375 })
    assert.equal(events.length, 1)
    assert.equal(events[0].sessionId, 's1')
    assert.equal(events[0].data.cumulativeUsage.inputTokens, 5)
    assert.equal(events[0].data.cumulativeUsage.turnsBilled, 1)
    assert.ok(Math.abs(events[0].data.cumulativeUsage.costUsd - 0.000375) < 1e-9)
  })

  it('does NOT accumulate when result has no `cost` (subscription-only providers)', () => {
    const { mgr, session } = makeWiredManager()
    const events = captureSessionUsage(mgr)
    // claude-tui-style result — usage may be absent or present, but no cost.
    session.emit('result', { usage: { input_tokens: 1000, output_tokens: 500 } })
    assert.equal(events.length, 0, 'no session_usage event without cost')
    const got = mgr.getCumulativeUsage('s1')
    assert.equal(got.turnsBilled, 0, 'turnsBilled stays zero')
    assert.equal(got.inputTokens, 0, 'tokens stay zero')
  })

  it('does NOT accumulate when result has `cost: null` (claude-tui subscription shape)', () => {
    // #4072 review: claude-tui emits `cost: null` to mean "subscription-
    // billed, not measured." The gate is `typeof cost === 'number'` so
    // null skips (typeof null === 'object'). Locking this down prevents
    // a regression where someone changes claude-tui back to `cost: 0`,
    // which would silently tick `turnsBilled` for non-billed sessions.
    const { mgr, session } = makeWiredManager()
    const events = captureSessionUsage(mgr)
    session.emit('result', { cost: null, usage: null })
    assert.equal(events.length, 0, 'cost: null must not fire session_usage')
    const got = mgr.getCumulativeUsage('s1')
    assert.equal(got.turnsBilled, 0)
  })

  it('DOES accumulate when result has `cost: 0` (legitimate free turn)', () => {
    // A genuinely-free turn (all cache-read, output truncated) is still a
    // billable interaction we want to count in turnsBilled. Distinguishing
    // semantically: cost: 0 = "tracked, and zero"; cost: null = "not
    // tracked." This test pins the semantics so a future widening of the
    // gate to `cost > 0` doesn't accidentally drop these.
    const { mgr, session } = makeWiredManager()
    const events = captureSessionUsage(mgr)
    session.emit('result', { cost: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000 } })
    assert.equal(events.length, 1, 'cost: 0 IS a tracked turn (free, but tracked)')
    const got = mgr.getCumulativeUsage('s1')
    assert.equal(got.turnsBilled, 1)
    assert.equal(got.cacheReadTokens, 1000)
    assert.equal(got.costUsd, 0)
  })

  it('does NOT accumulate when `cost` is NaN (provider bug, #4088 review)', () => {
    const { mgr, session } = makeWiredManager()
    const events = captureSessionUsage(mgr)
    session.emit('result', { cost: NaN, usage: { input_tokens: 100 } })
    assert.equal(events.length, 0, 'NaN cost must not pass the gate')
    const got = mgr.getCumulativeUsage('s1')
    assert.equal(got.turnsBilled, 0)
    assert.equal(got.inputTokens, 0)
  })

  it('does NOT accumulate when `cost` is Infinity (provider bug, #4088 review)', () => {
    const { mgr, session } = makeWiredManager()
    const events = captureSessionUsage(mgr)
    session.emit('result', { cost: Infinity, usage: { input_tokens: 100 } })
    assert.equal(events.length, 0, 'Infinity cost must not pass the gate')
    const got = mgr.getCumulativeUsage('s1')
    assert.equal(got.turnsBilled, 0)
    assert.equal(got.inputTokens, 0)
  })

  it('handles missing usage object on result gracefully (no NaN)', () => {
    const { mgr, session } = makeWiredManager()
    session.emit('result', { cost: 0.001 }) // usage missing entirely
    const got = mgr.getCumulativeUsage('s1')
    assert.ok(Number.isFinite(got.inputTokens) && got.inputTokens === 0)
    assert.equal(got.turnsBilled, 1)
    assert.ok(Math.abs(got.costUsd - 0.001) < 1e-9)
  })

  it('cache token fields accumulate independently of input/output', () => {
    const { mgr } = makeWiredManager()
    mgr._trackUsage('s1', {
      usage: {
        input_tokens: 0,
        output_tokens: 100,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 2000,
      },
      cost: 0.05,
    })
    const got = mgr.getCumulativeUsage('s1')
    assert.equal(got.inputTokens, 0)
    assert.equal(got.outputTokens, 100)
    assert.equal(got.cacheReadTokens, 5000)
    assert.equal(got.cacheCreationTokens, 2000)
  })

  it('getCumulativeUsage returns a shallow copy (callers cannot mutate the entry)', () => {
    const { mgr } = makeWiredManager()
    mgr._trackUsage('s1', { usage: { input_tokens: 10 }, cost: 0.001 })
    const snap = mgr.getCumulativeUsage('s1')
    snap.inputTokens = 999999
    snap.turnsBilled = 999999
    const fresh = mgr.getCumulativeUsage('s1')
    assert.equal(fresh.inputTokens, 10, 'mutating the snapshot must not corrupt the entry')
    assert.equal(fresh.turnsBilled, 1)
  })

  it('session_usage payload is a shallow copy (subscribers cannot mutate the entry)', () => {
    const { mgr, session } = makeWiredManager()
    const events = captureSessionUsage(mgr)
    session.emit('result', { usage: { input_tokens: 10 }, cost: 0.001 })
    // A subscriber mutates the payload.
    events[0].data.cumulativeUsage.inputTokens = 0
    events[0].data.cumulativeUsage.turnsBilled = 0
    // The entry stays correct.
    const fresh = mgr.getCumulativeUsage('s1')
    assert.equal(fresh.inputTokens, 10)
    assert.equal(fresh.turnsBilled, 1)
  })

  it('getCumulativeUsage returns null for unknown sessionId', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.getCumulativeUsage('nope'), null)
  })

  it('listSessions snapshot includes cumulativeUsage (late-subscriber AC)', () => {
    const { mgr, session } = makeWiredManager()
    // Make the entry minimally-shaped enough for listSessions() to consume it.
    const entry = mgr._sessions.get('s1')
    Object.assign(entry.session, {
      model: 'claude-opus-4-7',
      bootedModel: 'claude-opus-4-7',
      permissionMode: 'approve',
      isRunning: false,
      _stdinForwardingDisabled: false,
      stdinDroppedTotals: { bytes: 0, count: 0 },
      promptEvaluator: false,
      promptEvaluatorSkipPattern: null,
      resumeSessionId: null,
    })
    Object.assign(entry, { provider: 'claude-byok' })
    // Two turns happen BEFORE the late client connects.
    session.emit('result', { usage: { input_tokens: 10, output_tokens: 20 }, cost: 0.001 })
    session.emit('result', { usage: { input_tokens: 5, output_tokens: 3 }, cost: 0.0005 })
    // The late client calls `listSessions()` and gets the totals immediately.
    const snap = mgr.listSessions().find((s) => s.sessionId === 's1')
    assert.ok(snap)
    assert.ok(snap.cumulativeUsage, 'listSessions entries must include cumulativeUsage')
    assert.equal(snap.cumulativeUsage.inputTokens, 15)
    assert.equal(snap.cumulativeUsage.outputTokens, 23)
    assert.equal(snap.cumulativeUsage.turnsBilled, 2)
    assert.ok(Math.abs(snap.cumulativeUsage.costUsd - 0.0015) < 1e-9)
    // Snapshot is a copy — mutating it must not corrupt future snapshots.
    snap.cumulativeUsage.inputTokens = 999
    const second = mgr.listSessions().find((s) => s.sessionId === 's1')
    assert.equal(second.cumulativeUsage.inputTokens, 15, 'snapshot must be a fresh copy each call')
  })

  it('listSessions fills missing keys from the zero template (#4088 review)', () => {
    // A custom provider builds an entry with a partial cumulativeUsage
    // object — e.g. only inputTokens is tracked. The snapshot wire shape
    // must still carry every key (with zero defaults) so consumers can
    // safely destructure without optional-chaining each field.
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    Object.assign(session, {
      model: 'claude-opus-4-7',
      bootedModel: 'claude-opus-4-7',
      permissionMode: 'approve',
      _stdinForwardingDisabled: false,
      stdinDroppedTotals: { bytes: 0, count: 0 },
      promptEvaluator: false,
      promptEvaluatorSkipPattern: null,
      resumeSessionId: null,
    })
    mgr._sessions.set('s1', {
      session,
      name: 'S1',
      cwd: '/tmp',
      provider: 'claude-byok',
      createdAt: Date.now(),
      cumulativeUsage: { inputTokens: 42 }, // partial object — missing the other 5 fields
    })
    const snap = mgr.listSessions().find((s) => s.sessionId === 's1')
    assert.ok(snap.cumulativeUsage)
    assert.equal(snap.cumulativeUsage.inputTokens, 42, 'partial value passes through')
    // All other fields default to zero — wire shape stays stable.
    assert.equal(snap.cumulativeUsage.outputTokens, 0)
    assert.equal(snap.cumulativeUsage.cacheReadTokens, 0)
    assert.equal(snap.cumulativeUsage.cacheCreationTokens, 0)
    assert.equal(snap.cumulativeUsage.costUsd, 0)
    assert.equal(snap.cumulativeUsage.turnsBilled, 0)
  })

  it('listSessions provides a zero-default for entries built without cumulativeUsage', () => {
    // Defends against a custom provider building entries directly (without
    // going through createSession). The shape stays stable on the wire.
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    Object.assign(session, {
      model: 'claude-opus-4-7',
      bootedModel: 'claude-opus-4-7',
      permissionMode: 'approve',
      _stdinForwardingDisabled: false,
      stdinDroppedTotals: { bytes: 0, count: 0 },
      promptEvaluator: false,
      promptEvaluatorSkipPattern: null,
      resumeSessionId: null,
    })
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/tmp', provider: 'claude-byok', createdAt: Date.now() })
    const snap = mgr.listSessions().find((s) => s.sessionId === 's1')
    assert.ok(snap.cumulativeUsage)
    assert.equal(snap.cumulativeUsage.turnsBilled, 0)
  })
})

describe('SessionManager._trackCost integration with result events (#4086)', () => {
  // #4086 / #4056 AC #4: lock down the production wire end-to-end.
  // ClaudeByokSession (or any provider) emits `result` with cost →
  // SessionManager._wireSessionEvents → Number.isFinite(data?.cost) gate →
  // _trackCost(sessionId, cost, model) → CostBudgetManager.trackCost →
  // 'cost_update' session_event broadcast. A refactor of any link in
  // this chain (rename, gate-tightening, gate-swap to a different
  // predicate) would silently kill BYOK cost accounting; these tests
  // catch that.
  //
  // The CostBudgetManager itself is unit-tested in cost-budget-manager.test.js.
  // What's NEW here is the wire from a session's `result` event through
  // SessionManager's listener to the budget tracker.

  // Track managers so afterEach can cancel pending persistence timers
  // (#4086 review — emitting result events records history and schedules
  // a debounced persist; without explicit cancellation we leak timers
  // and extra state-file writes past the test).
  const _managers = []
  afterEach(() => {
    for (const mgr of _managers) {
      try { mgr._persistence?.cancelPersist?.() } catch {}
    }
    _managers.length = 0
  })

  function makeWired({ budget = null } = {}) {
    const mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      costBudget: budget,
    })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    session.currentModel = 'claude-opus-4-7'
    mgr._sessions.set('s1', {
      session,
      name: 'S1',
      cwd: '/tmp',
      provider: 'claude-byok',
      createdAt: Date.now(),
      cumulativeUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turnsBilled: 0,
      },
    })
    mgr._wireSessionEvents('s1', session)
    _managers.push(mgr)
    return { mgr, session }
  }

  function captureSessionEvents(mgr, eventName) {
    const events = []
    mgr.on('session_event', (e) => {
      if (e.event === eventName) events.push(e)
    })
    return events
  }

  it('a single BYOK result event drives _trackCost end-to-end', () => {
    const { mgr, session } = makeWired()
    const costUpdates = captureSessionEvents(mgr, 'cost_update')
    // Emit the exact shape a BYOK turn produces.
    session.emit('result', {
      messageId: 'msg_1',
      stopReason: 'end_turn',
      duration: 123,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: 0.025,
    })
    // CostBudgetManager has the cumulative.
    assert.ok(Math.abs(mgr.getSessionCost('s1') - 0.025) < 1e-9,
      `getSessionCost should reflect the trackCost call: got ${mgr.getSessionCost('s1')}`)
    // The wire broadcasts the cost_update.
    assert.equal(costUpdates.length, 1, 'one cost_update per priced result')
    assert.ok(Math.abs(costUpdates[0].data.sessionCost - 0.025) < 1e-9)
    // #4098: the cost_update payload also carries totalCost (multi-session
    // aggregator the dashboard reads) and budget (the gauge denominator).
    // Both fields are unpinned by sessionCost alone — a refactor that
    // drops either passes the sessionCost assertion silently.
    const payload = costUpdates[0].data
    assert.ok(Math.abs(payload.totalCost - 0.025) < 1e-9,
      `totalCost should match sessionCost when only one session is priced; got ${payload.totalCost}`)
    // No budget configured → budget field is null (CostBudgetManager.getBudget()).
    assert.equal(payload.budget, null)
  })

  it('cost_update payload carries the configured budget when one is set (#4098)', () => {
    // Pin that the gauge denominator (budget) actually arrives on the
    // wire when configured. Without this, a future refactor that drops
    // the budget field would break the dashboard's progress-bar render
    // with no test failure.
    const { mgr, session } = makeWired({ budget: 5.00 })
    const costUpdates = captureSessionEvents(mgr, 'cost_update')
    session.emit('result', { cost: 0.10, usage: { input_tokens: 1 } })
    assert.equal(costUpdates.length, 1, 'wire must emit one cost_update per priced result')
    assert.equal(costUpdates[0].data.budget, 5.00)
  })

  it('multiple result events accumulate via _trackCost', () => {
    const { mgr, session } = makeWired()
    const costUpdates = captureSessionEvents(mgr, 'cost_update')
    session.emit('result', { cost: 0.01, usage: { input_tokens: 10 } })
    session.emit('result', { cost: 0.02, usage: { input_tokens: 20 } })
    session.emit('result', { cost: 0.005, usage: { input_tokens: 5 } })
    assert.ok(Math.abs(mgr.getSessionCost('s1') - 0.035) < 1e-9,
      `expected cumulative 0.035, got ${mgr.getSessionCost('s1')}`)
    assert.equal(costUpdates.length, 3)
    // The third event's payload reflects the FULL cumulative, not just
    // the delta — locks down the budget-display contract.
    assert.ok(Math.abs(costUpdates[2].data.sessionCost - 0.035) < 1e-9)
  })

  it('configured budget triggers budget_warning at 80% via the wire', () => {
    // $1 budget; emit a single result that crosses 80% ($0.80+).
    const { mgr, session } = makeWired({ budget: 1.0 })
    const warnings = captureSessionEvents(mgr, 'budget_warning')
    session.emit('result', { cost: 0.85, usage: { input_tokens: 1 } })
    assert.equal(warnings.length, 1, 'budget_warning fires on the wire when cumulative crosses 80%')
    assert.equal(warnings[0].data.percent, 85)
    assert.ok(warnings[0].data.message.includes('85% of the $1.00 budget'))
  })

  it('configured budget triggers budget_exceeded at 100% via the wire', () => {
    const { mgr, session } = makeWired({ budget: 1.0 })
    const exceeded = captureSessionEvents(mgr, 'budget_exceeded')
    session.emit('result', { cost: 1.05, usage: { input_tokens: 1 } })
    assert.equal(exceeded.length, 1)
    assert.equal(exceeded[0].data.percent, 105)
  })

  it('budget_exceeded fires only once per session, not on every subsequent priced turn (#4100)', () => {
    // CostBudgetManager._budgetExceeded uses a Set as a one-shot guard.
    // Without this, every priced turn over budget would push a duplicate
    // notification to the dashboard + mobile app — a notification storm.
    // Pin the dedupe so a refactor that drops the Set fails loudly.
    const { mgr, session } = makeWired({ budget: 1.0 })
    const exceeded = captureSessionEvents(mgr, 'budget_exceeded')
    session.emit('result', { cost: 1.05, usage: { input_tokens: 1 } })
    session.emit('result', { cost: 0.10, usage: { input_tokens: 1 } })
    session.emit('result', { cost: 0.10, usage: { input_tokens: 1 } })
    assert.equal(exceeded.length, 1, 'dedupe via _budgetExceeded Set — one notification per session')
  })

  it('budget_warning fires only once per session between 80% and 100% (#4100)', () => {
    // Same dedupe semantics as budget_exceeded, but for the 80%-100%
    // band. _budgetWarned Set should prevent a notification storm during
    // a tool-heavy session approaching the budget.
    const { mgr, session } = makeWired({ budget: 1.0 })
    const warnings = captureSessionEvents(mgr, 'budget_warning')
    session.emit('result', { cost: 0.85, usage: { input_tokens: 1 } }) // 85% — fires
    session.emit('result', { cost: 0.05, usage: { input_tokens: 1 } }) // 90% — should NOT re-fire
    session.emit('result', { cost: 0.04, usage: { input_tokens: 1 } }) // 94% — should NOT re-fire
    assert.equal(warnings.length, 1, 'dedupe via _budgetWarned Set — one notification per session in the warn band')
  })

  it('allows negative cost (refund / credit-adjustment flows through, does not bypass gate) (#4099)', () => {
    // Per #4083 review: a weird-provider edge case (refund, credit
    // adjustment) could legitimately produce a negative cost. The gate
    // at session-manager.js (`Number.isFinite(data.cost)`) accepts
    // negative numbers and CostBudgetManager subtracts them from the
    // cumulative. Pin this so a future "tighten to cost >= 0" refactor
    // doesn't silently drop refunds.
    const { mgr, session } = makeWired()
    const costUpdates = captureSessionEvents(mgr, 'cost_update')
    session.emit('result', { cost: 0.05, usage: { input_tokens: 100 } })
    session.emit('result', { cost: -0.01, usage: { input_tokens: 0 } })
    assert.ok(Math.abs(mgr.getSessionCost('s1') - 0.04) < 1e-9,
      `cumulative after refund should be 0.04, got ${mgr.getSessionCost('s1')}`)
    assert.equal(costUpdates.length, 2, 'both priced events emit cost_update (the negative is not silently dropped)')
    assert.ok(Math.abs(costUpdates[1].data.sessionCost - 0.04) < 1e-9)
  })

  it('refuses to trackCost when `cost` is a string (gate is Number.isFinite, not typeof)', () => {
    // The #4086 issue body specifically calls out the regression risk
    // of a future change persisting + rehydrating cost and producing a
    // string-typed value. The gate (#4088) is Number.isFinite, which
    // rejects strings. Lock it down: a string-cost result must NOT
    // tick the cost counter or fire cost_update.
    const { mgr, session } = makeWired()
    const costUpdates = captureSessionEvents(mgr, 'cost_update')
    session.emit('result', { cost: '0.025', usage: { input_tokens: 100 } })
    assert.equal(mgr.getSessionCost('s1'), 0, 'string cost must be rejected')
    assert.equal(costUpdates.length, 0, 'no cost_update for string cost')
  })

  it('refuses to trackCost when `cost` is missing (claude-tui subscription shape)', () => {
    // Subscription-only providers emit result without cost — must not
    // tick the budget tracker.
    const { mgr, session } = makeWired({ budget: 1.0 })
    const costUpdates = captureSessionEvents(mgr, 'cost_update')
    const warnings = captureSessionEvents(mgr, 'budget_warning')
    session.emit('result', { usage: { input_tokens: 100 } })
    assert.equal(mgr.getSessionCost('s1'), 0)
    assert.equal(costUpdates.length, 0)
    assert.equal(warnings.length, 0)
  })

  it('refuses to trackCost when `cost` is null (claude-tui new shape)', () => {
    const { mgr, session } = makeWired({ budget: 1.0 })
    const costUpdates = captureSessionEvents(mgr, 'cost_update')
    session.emit('result', { cost: null, usage: null })
    assert.equal(mgr.getSessionCost('s1'), 0)
    assert.equal(costUpdates.length, 0)
  })
})

// ---------------------------------------------------------------------------
// SessionManager cost-threshold soft warning (#4075)
// ---------------------------------------------------------------------------

describe('SessionManager cost-threshold soft warning (#4075)', () => {
  function makeMgr({ threshold } = {}) {
    const mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      costThresholdUsd: threshold,
    })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set('s1', {
      session,
      name: 'S1',
      cwd: '/tmp',
      provider: 'claude-byok',
      createdAt: Date.now(),
      cumulativeUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turnsBilled: 0,
      },
    })
    mgr._wireSessionEvents('s1', session)
    return { mgr, session }
  }

  function captureCrossings(mgr) {
    const events = []
    mgr.on('session_event', (e) => {
      if (e.event === 'session_cost_threshold_crossed') events.push(e)
    })
    return events
  }

  it('defaults to $5.00 when no costThresholdUsd is configured', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    assert.equal(mgr.getCostThresholdUsd(), 5.00)
  })

  it('accepts a custom threshold from config', () => {
    const { mgr } = makeMgr({ threshold: 10.50 })
    assert.equal(mgr.getCostThresholdUsd(), 10.50)
  })

  it('emits session_cost_threshold_crossed exactly once when the running cost crosses the threshold', () => {
    const { mgr } = makeMgr({ threshold: 1.00 })
    const crossings = captureCrossings(mgr)
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 0.50 })
    assert.equal(crossings.length, 0, 'still under threshold')
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 0.49 })
    assert.equal(crossings.length, 0, 'still under threshold (0.99)')
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 0.02 })
    assert.equal(crossings.length, 1, 'fires on first crossing')
    assert.ok(crossings[0].data.costUsd >= 1.00, `costUsd should be >= 1.00; got ${crossings[0].data.costUsd}`)
    assert.equal(crossings[0].data.thresholdUsd, 1.00)
  })

  it('does NOT re-fire on subsequent turns once the latch is set (one warning per session)', () => {
    const { mgr } = makeMgr({ threshold: 1.00 })
    const crossings = captureCrossings(mgr)
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 1.50 })
    assert.equal(crossings.length, 1)
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 5.00 })
    assert.equal(crossings.length, 1, 'must not re-fire even at much higher cost')
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 100.00 })
    assert.equal(crossings.length, 1, 'still no re-fire')
  })

  it('does NOT fire for subscription-billed sessions (cost stays at 0)', () => {
    const { mgr, session } = makeMgr({ threshold: 0.001 })
    const crossings = captureCrossings(mgr)
    // claude-tui-like flow: cost is null on the result event. The wired
    // result handler gates _trackUsage on `Number.isFinite(data.cost)`
    // (#4088), so subscription-billed sessions never increment the
    // accumulator OR fire the threshold. From the badge's perspective
    // both surfaces stay at 0 — no clutter.
    session.emit('result', { usage: { input_tokens: 1000, output_tokens: 500 }, cost: null })
    session.emit('result', { usage: { input_tokens: 1000, output_tokens: 500 }, cost: null })
    assert.equal(crossings.length, 0, 'subscription sessions must never trigger the threshold')
    assert.equal(mgr.getCumulativeUsage('s1').costUsd, 0)
    assert.equal(mgr.getCumulativeUsage('s1').inputTokens, 0, 'tokens are not tracked when cost is null')
  })

  it('is disabled when threshold is 0', () => {
    const { mgr } = makeMgr({ threshold: 0 })
    const crossings = captureCrossings(mgr)
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 100.00 })
    assert.equal(crossings.length, 0, 'threshold=0 must disable the soft warning')
  })

  it('coerces invalid threshold values to the default', () => {
    // Negative, NaN, Infinity, strings all fall back to default $5.
    const mgrA = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile(), costThresholdUsd: -5 })
    assert.equal(mgrA.getCostThresholdUsd(), 5.00)
    const mgrB = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile(), costThresholdUsd: NaN })
    assert.equal(mgrB.getCostThresholdUsd(), 5.00)
    const mgrC = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile(), costThresholdUsd: Infinity })
    assert.equal(mgrC.getCostThresholdUsd(), 5.00)
    const mgrD = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile(), costThresholdUsd: '5.00' })
    assert.equal(mgrD.getCostThresholdUsd(), 5.00)
  })

  it('setCostThresholdUsd updates the active threshold at runtime', () => {
    const { mgr } = makeMgr({ threshold: 10 })
    const crossings = captureCrossings(mgr)
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 5.00 })
    assert.equal(crossings.length, 0)
    mgr.setCostThresholdUsd(4.00)
    assert.equal(mgr.getCostThresholdUsd(), 4.00)
    // Next turn crosses the NEW (lower) threshold.
    mgr._trackUsage('s1', { usage: { input_tokens: 1 }, cost: 0.01 })
    assert.equal(crossings.length, 1, 'lowered threshold should fire on the next crossing')
  })

  it('latches per-session (multiple sessions each fire once independently)', () => {
    const { mgr, session } = makeMgr({ threshold: 1.00 })
    // Add a second session.
    const session2 = new EventEmitter()
    session2.isRunning = false
    session2.destroy = () => {}
    mgr._sessions.set('s2', {
      session: session2,
      name: 'S2',
      cwd: '/tmp',
      provider: 'claude-byok',
      createdAt: Date.now(),
      cumulativeUsage: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheCreationTokens: 0, costUsd: 0, turnsBilled: 0,
      },
    })
    mgr._wireSessionEvents('s2', session2)
    const crossings = captureCrossings(mgr)
    session.emit('result', { usage: { input_tokens: 1 }, cost: 2.00 })
    session2.emit('result', { usage: { input_tokens: 1 }, cost: 2.00 })
    assert.equal(crossings.length, 2, 'each session fires its own latch')
    assert.deepEqual(crossings.map((e) => e.sessionId).sort(), ['s1', 's2'])
    // Second tick on each does NOT re-fire.
    session.emit('result', { usage: { input_tokens: 1 }, cost: 2.00 })
    session2.emit('result', { usage: { input_tokens: 1 }, cost: 2.00 })
    assert.equal(crossings.length, 2)
  })
})

// SessionManager forwards four operator-tunable timeout knobs via providerOpts
// using a "forward only when set" pattern: a configured positive value is
// passed through verbatim, while a null/unset value is OMITTED from
// providerOpts (rather than set to null) so each provider's BaseSession-level
// default applies. The consumer side (byok-session / base-session) has direct
// coverage for each knob; these tests close the forwarding-side gap (#4487).
describe('SessionManager providerOpts timeout forwarding (#4487)', () => {
  // Each captured opts snapshot from a test provider constructor is appended
  // to this array via the shared helper below.
  let captured

  // Bare-bones provider that records the providerOpts handed to its
  // constructor. Mirrors the FailingProvider/TestProvider shapes used
  // elsewhere in this file so registerProvider's validateProviderClass
  // contract is satisfied.
  class CapturingProvider extends EventEmitter {
    constructor(opts) {
      super()
      captured.push(opts)
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

  // Register the capturing provider once and reuse it across every assertion.
  // The provider registry is process-global so re-registering under the same
  // name is a no-op after the first import.
  let providerRegistered = false
  async function ensureProvider() {
    if (providerRegistered) return
    const { registerProvider } = await import('../src/providers.js')
    registerProvider('test-timeout-capture', CapturingProvider)
    providerRegistered = true
  }

  beforeEach(() => {
    captured = []
  })

  /**
   * Build a SessionManager with `configKey` set to `configValue`, drive
   * createSession() through the capturing provider, and return the captured
   * providerOpts so the caller can assert on a single key. Resets the
   * shared `captured` buffer per call so back-to-back invocations within
   * one test (set + null) read clean.
   */
  async function captureProviderOpts(configKey, configValue) {
    await ensureProvider()
    captured.length = 0
    const mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      [configKey]: configValue,
    })
    mgr.createSession({ cwd: '/tmp', provider: 'test-timeout-capture' })
    assert.equal(captured.length, 1, 'CapturingProvider should be instantiated exactly once per captureProviderOpts call')
    return captured[0]
  }

  /**
   * Shared helper: assert that `configKey` flows through as
   * `providerOpts[providerOptsKey]` when configured to a positive value, and
   * is OMITTED (key absent — not set to null/undefined) when configured to
   * null. The 4 knobs use identical forwarding semantics, so this collapses
   * the per-knob noise to a single line each.
   */
  async function assertForwardingPattern({ configKey, providerOptsKey, setValue }) {
    const setOpts = await captureProviderOpts(configKey, setValue)
    assert.equal(
      setOpts[providerOptsKey],
      setValue,
      `${providerOptsKey} should be forwarded verbatim when ${configKey}=${setValue}`,
    )

    const nullOpts = await captureProviderOpts(configKey, null)
    assert.equal(
      Object.prototype.hasOwnProperty.call(nullOpts, providerOptsKey),
      false,
      `${providerOptsKey} should be OMITTED from providerOpts when ${configKey} is null (got ${nullOpts[providerOptsKey]})`,
    )
  }

  it('forwards resultTimeoutMs when set; omits when null (#3749)', async () => {
    await assertForwardingPattern({
      configKey: 'resultTimeoutMs',
      providerOptsKey: 'resultTimeoutMs',
      setValue: 90_000,
    })
  })

  it('forwards hardTimeoutMs when set; omits when null (#3899)', async () => {
    await assertForwardingPattern({
      configKey: 'hardTimeoutMs',
      providerOptsKey: 'hardTimeoutMs',
      setValue: 3_600_000,
    })
  })

  it('forwards streamStallTimeoutMs when set; omits when null (#4467)', async () => {
    await assertForwardingPattern({
      configKey: 'streamStallTimeoutMs',
      providerOptsKey: 'streamStallTimeoutMs',
      setValue: 120_000,
    })
  })

  it('forwards mcpToolCallTimeoutMs when set; omits when null (#4482)', async () => {
    await assertForwardingPattern({
      configKey: 'mcpToolCallTimeoutMs',
      providerOptsKey: 'mcpToolCallTimeoutMs',
      setValue: 45_000,
    })
  })
})

// #4509: SessionManager's three operator-facing inactivity timeouts
// (resultTimeoutMs / hardTimeoutMs / streamStallTimeoutMs) are clamped to
// the shared MAX_SANE_DURATION_MS (24h) ceiling that the protocol schemas
// apply via `.max(MAX_SANE_DURATION_MS)`. Mirrors the wire-side guard #4503
// added to `ws-history.js sendPostAuthInfo`. A typoed CHROXY_* env var
// (extra digit, accidental exponent) is the realistic source of an
// over-ceiling value; without this guard the operator silently gets a >24h
// internal inactivity timer instead of the BaseSession default.
describe('SessionManager operator-timeout MAX_SANE_DURATION_MS ceiling (#4509)', () => {
  const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000

  // Spec table — each row is one operator-tunable timeout we expect to be
  // clamped. `internalField` is the underscore-prefixed slot the constructor
  // sets; `displayName` is the warn-log token the helper uses (matches the
  // CHROXY_* env-var stem so an operator scanning logs can correlate).
  const TIMEOUT_SPECS = [
    { configKey: 'resultTimeoutMs', internalField: '_resultTimeoutMs', displayName: 'resultTimeoutMs' },
    { configKey: 'hardTimeoutMs', internalField: '_hardTimeoutMs', displayName: 'hardTimeoutMs' },
    { configKey: 'streamStallTimeoutMs', internalField: '_streamStallTimeoutMs', displayName: 'streamStallTimeoutMs' },
  ]

  afterEach(() => {
    mock.restoreAll()
  })

  for (const { configKey, internalField, displayName } of TIMEOUT_SPECS) {
    it(`clamps ${configKey} above MAX_SANE_DURATION_MS back to null and warns`, () => {
      const warnings = []
      mock.method(console, 'warn', (msg) => warnings.push(msg))
      const mgr = new SessionManager({
        skipPreflight: true,
        maxSessions: 5,
        stateFilePath: tmpStateFile(),
        [configKey]: MAX_SANE_DURATION_MS + 1,
      })
      assert.equal(mgr[internalField], null,
        `${internalField} must fall back to null when ${configKey} exceeds the 24h ceiling (operator typo guardrail)`)
      const hit = warnings.find((w) => w.includes(displayName) && w.includes('MAX_SANE_DURATION_MS'))
      assert.ok(hit, `expected a single warn log mentioning ${displayName} + MAX_SANE_DURATION_MS, got: ${warnings.join(' | ')}`)
    })

    it(`accepts the exact MAX_SANE_DURATION_MS boundary for ${configKey}`, () => {
      const mgr = new SessionManager({
        skipPreflight: true,
        maxSessions: 5,
        stateFilePath: tmpStateFile(),
        [configKey]: MAX_SANE_DURATION_MS,
      })
      assert.equal(mgr[internalField], MAX_SANE_DURATION_MS,
        `the exact boundary is INCLUSIVE — clamping it would surprise operators who tuned the dial to exactly 24h`)
    })
  }
})
