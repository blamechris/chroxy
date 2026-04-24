import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

/**
 * Tests for monotonic session auto-naming counter (#2338).
 *
 * Verifies that auto-generated session names do not regress when sessions
 * are destroyed between creations (i.e. the counter never reuses numbers).
 */

let registerProvider

before(async () => {
  ({ registerProvider } = await import('../src/providers.js'))

  // A no-op provider suitable for naming tests — start() is synchronous and
  // never throws, so createSession() succeeds without touching real processes.
  class NoopProvider extends EventEmitter {
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
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
  }
  registerProvider('test-noop-naming', NoopProvider)
})

function makeMgr() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sm-naming-'))
  const stateFile = join(tmpDir, 'state.json')
  const mgr = new SessionManager({ skipPreflight: true,
    maxSessions: 10,
    defaultCwd: '/tmp',
    stateFilePath: stateFile,
  })
  // Cleanup helper attached to manager for convenience
  mgr._tmpDir = tmpDir
  return mgr
}

function cleanup(mgr) {
  mgr.destroyAll()
  rmSync(mgr._tmpDir, { recursive: true, force: true })
}

describe('session auto-naming counter (#2338)', () => {
  it('names first session "Session 1"', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      assert.equal(mgr.getSession(id).name, 'Session 1')
    } finally {
      cleanup(mgr)
    }
  })

  it('names successive sessions sequentially', () => {
    const mgr = makeMgr()
    try {
      const id1 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      const id2 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      const id3 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      assert.equal(mgr.getSession(id1).name, 'Session 1')
      assert.equal(mgr.getSession(id2).name, 'Session 2')
      assert.equal(mgr.getSession(id3).name, 'Session 3')
    } finally {
      cleanup(mgr)
    }
  })

  it('does not reuse a number after a session is destroyed', () => {
    const mgr = makeMgr()
    try {
      const id1 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      const id2 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      const id3 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })

      // Destroy the middle session — size drops to 2
      mgr.destroySession(id2)

      // The next session should be "Session 4", not "Session 3"
      const id4 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      assert.equal(mgr.getSession(id4).name, 'Session 4',
        'counter must not regress after a session is destroyed')

      // Verify no duplicate names exist across all live sessions
      const names = [id1, id3, id4].map(id => mgr.getSession(id).name)
      assert.deepEqual(names, ['Session 1', 'Session 3', 'Session 4'])
      const uniqueNames = new Set(names)
      assert.equal(uniqueNames.size, names.length, 'all session names must be unique')
    } finally {
      cleanup(mgr)
    }
  })

  it('counter advances past restored "Session N" names so new sessions do not collide', () => {
    // Simulate restoreState() bringing back sessions named "Session 1", "Session 2",
    // "Session 3". The next auto-named session must be "Session 4", not "Session 1".
    const mgr = makeMgr()
    try {
      // Create and serialize three sessions
      const src = makeMgr()
      try {
        src.createSession({ cwd: '/tmp', provider: 'test-noop-naming' }) // Session 1
        src.createSession({ cwd: '/tmp', provider: 'test-noop-naming' }) // Session 2
        src.createSession({ cwd: '/tmp', provider: 'test-noop-naming' }) // Session 3
        src.serializeState()

        // Copy state file path so mgr can restore it
        mgr._persistence._stateFilePath = src._persistence._stateFilePath
        mgr._stateFilePath = src._persistence._stateFilePath
      } finally {
        // Destroy sessions but don't cleanup tmpDir yet — state file still needed
        src.destroyAll()
      }

      mgr.restoreState()

      // After restoring, counter should be at least 3
      assert.ok(mgr._sessionCounter >= 3,
        `_sessionCounter must be >= 3 after restoring "Session 1"–"Session 3", got ${mgr._sessionCounter}`)

      // The next auto-named session must NOT be "Session 1", "Session 2", or "Session 3"
      const newId = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })
      const newName = mgr.getSession(newId).name
      const existingNames = mgr.listSessions()
        .filter(s => s.sessionId !== newId)
        .map(s => s.name)
      assert.ok(
        !existingNames.includes(newName),
        `new session name "${newName}" must not collide with restored names: ${existingNames.join(', ')}`
      )

      // Specifically: should be "Session 4" (counter was 3, increments to 4)
      assert.equal(newName, 'Session 4',
        'first new session after restoring Session 1-3 must be Session 4')
    } finally {
      cleanup(mgr)
    }
  })

  it('respects explicit name and does not increment counter', () => {
    const mgr = makeMgr()
    try {
      const id1 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming', name: 'My Project' })
      const id2 = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-naming' })

      assert.equal(mgr.getSession(id1).name, 'My Project',
        'explicit name must be used as-is')
      // Counter was not incremented for the explicitly-named session, so the
      // first auto-named session gets "Session 1"
      assert.equal(mgr.getSession(id2).name, 'Session 1',
        'counter only increments when auto-naming is used')
    } finally {
      cleanup(mgr)
    }
  })
})
