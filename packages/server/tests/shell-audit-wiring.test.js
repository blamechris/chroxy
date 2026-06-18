import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'

/**
 * #5985 (epic #5982) — SessionManager destroy-audit WIRING. The shell-audit
 * trail's content is unit-tested in shell-audit.test.js; this asserts that
 * destroying a session routes through auditShellDestroy IFF it's a user-shell,
 * carrying the sessionId + the shell's preserved exit code/reason. The create
 * side lives in the WS handler (its own suite).
 *
 * Strategy: mock.module('../src/shell-audit.js') with spies BEFORE importing
 * session-manager.js, so the guard's call is observable.
 */
if (typeof mock.module !== 'function') {
  describe('shell-audit destroy wiring (#5985)', () => {
    it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks')
    })
  })
} else {
  const destroyCalls = []
  mock.module('../src/shell-audit.js', {
    namedExports: {
      auditShellCreate: () => {},
      auditShellDestroy: (entry) => { destroyCalls.push(entry) },
      formatShellAuditLine: () => '',
    },
  })

  const { SessionManager } = await import('../src/session-manager.js')
  const { registerProvider } = await import('../src/providers.js')

  // A fake user-shell: isUserShell static getter + preserved exit fields.
  class FakeUserShell extends EventEmitter {
    constructor(opts = {}) {
      super()
      this.cwd = opts.cwd
      this.isRunning = false
      this._exitCode = null
      this._exitReason = null
    }
    static get isUserShell() { return true }
    static get capabilities() { return {} }
    start() {}
    destroy() {}
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
  }

  // A normal (non-shell) provider — must NOT be audited on destroy.
  class FakeNormal extends EventEmitter {
    constructor(opts = {}) { super(); this.cwd = opts.cwd; this.isRunning = false }
    static get capabilities() { return {} }
    start() {}
    destroy() {}
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
  }

  before(() => {
    registerProvider('test-audit-usershell', FakeUserShell)
    registerProvider('test-audit-normal', FakeNormal)
  })

  function makeMgr() {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sm-audit-'))
    const mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      defaultCwd: '/tmp',
      stateFilePath: join(tmpDir, 'state.json'),
      userShellEnabled: true,
    })
    mgr._tmpDir = tmpDir
    return mgr
  }

  describe('shell-audit destroy wiring (#5985)', () => {
    beforeEach(() => { destroyCalls.length = 0 })

    it('audits destroy for a user-shell with sessionId + preserved exit fields', () => {
      const mgr = makeMgr()
      const sessionId = mgr.createSession({ name: 'shell', cwd: '/tmp', provider: 'test-audit-usershell' })
      // Simulate the shell having exited on its own before teardown.
      const entry = mgr.getSession(sessionId)
      entry.session._exitCode = 0
      entry.session._exitReason = 'exit'

      mgr.destroySession(sessionId)

      assert.equal(destroyCalls.length, 1)
      assert.equal(destroyCalls[0].sessionId, sessionId)
      assert.equal(destroyCalls[0].exitCode, 0)
      assert.equal(destroyCalls[0].reason, 'exit')
      rmSync(mgr._tmpDir, { recursive: true, force: true })
    })

    it('falls back to reason="destroyed" + null exit when the shell never exited', () => {
      const mgr = makeMgr()
      const sessionId = mgr.createSession({ name: 'shell', cwd: '/tmp', provider: 'test-audit-usershell' })
      mgr.destroySession(sessionId)

      assert.equal(destroyCalls.length, 1)
      assert.equal(destroyCalls[0].exitCode, null)
      assert.equal(destroyCalls[0].reason, 'destroyed')
      rmSync(mgr._tmpDir, { recursive: true, force: true })
    })

    it('does NOT audit destroy for a normal (non-shell) session', () => {
      const mgr = makeMgr()
      const sessionId = mgr.createSession({ name: 'chat', cwd: '/tmp', provider: 'test-audit-normal' })
      mgr.destroySession(sessionId)

      assert.equal(destroyCalls.length, 0)
      rmSync(mgr._tmpDir, { recursive: true, force: true })
    })
  })
}
