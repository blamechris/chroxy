import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'

/**
 * #5985 (epic #5982) — shell-audit WIRING. The trail's line content is
 * unit-tested in shell-audit.test.js; this asserts the call sites fire:
 *   - destroy: SessionManager routes through auditShellDestroy IFF user-shell,
 *     carrying sessionId + the shell's preserved exit code/reason.
 *   - create: the WS create handler calls auditShellCreate for a user-shell with
 *     tokenClass='primary' and a non-null resolved shell (locks the regression
 *     where _shellPath was read before async start() populated it).
 *
 * Strategy: mock.module('../src/shell-audit.js') with spies BEFORE importing the
 * modules under test, so the guards' calls are observable.
 */
if (typeof mock.module !== 'function') {
  describe('shell-audit destroy wiring (#5985)', () => {
    it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks')
    })
  })
} else {
  const destroyCalls = []
  const createCalls = []
  mock.module('../src/shell-audit.js', {
    namedExports: {
      auditShellCreate: (entry) => { createCalls.push(entry) },
      auditShellDestroy: (entry) => { destroyCalls.push(entry) },
      formatShellAuditLine: () => '',
    },
  })

  const { SessionManager } = await import('../src/session-manager.js')
  const { registerProvider } = await import('../src/providers.js')
  const { sessionHandlers } = await import('../src/handlers/session-handlers.js')
  const { UserShellSession } = await import('../src/user-shell-session.js')
  const { nsCtx, makeSessionIndexCtx, createSpy } = await import('./test-helpers.js')

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

  // Create side — exercise the real WS create handler with a real
  // UserShellSession so _shellPath is populated by its constructor (the fix).
  function makeHandlerCtx(createdSessions) {
    return nsCtx({
      ...makeSessionIndexCtx(),
      send: createSpy(),
      broadcastSessionList: createSpy(),
      sendSessionInfo: createSpy(),
      sessionManager: {
        listSessions: createSpy(() => []),
        getSession: createSpy((id) => createdSessions.get(id)),
        createSession: createSpy((opts) => {
          // Build a real UserShellSession (no start() → no PTY spawn) so the
          // constructor's synchronous resolveShell() sets _shellPath.
          const session = new UserShellSession({ cwd: opts.cwd })
          const id = 'shell-sess-1'
          createdSessions.set(id, { name: opts.name, cwd: opts.cwd, session })
          return id
        }),
        getSessionPreset: () => null,
        firstSessionId: null,
      },
    })
  }

  describe('shell-audit create wiring (#5985)', () => {
    beforeEach(() => { createCalls.length = 0 })

    it('audits create for a user-shell with tokenClass=primary and a non-null shell', () => {
      const ctx = makeHandlerCtx(new Map())
      sessionHandlers.create_session(
        makeWs(),
        { id: 'client-x', authenticated: true, isPrimaryToken: true, deviceInfo: { deviceName: 'Mac' }, subscribedSessionIds: new Set(), boundSessionId: null },
        { provider: 'user-shell' },
        ctx,
      )
      assert.equal(createCalls.length, 1)
      assert.equal(createCalls[0].tokenClass, 'primary')
      assert.equal(createCalls[0].clientId, 'client-x')
      assert.equal(createCalls[0].deviceName, 'Mac')
      // The regression lock: _shellPath is set in the constructor, so the
      // create-audit reads a real shell path (not null).
      assert.ok(typeof createCalls[0].shell === 'string' && createCalls[0].shell.length > 0)
    })

    it('does NOT audit create for a normal (non-shell) provider', () => {
      const createdSessions = new Map()
      const ctx = nsCtx({
        ...makeSessionIndexCtx(),
        send: createSpy(),
        broadcastSessionList: createSpy(),
        sendSessionInfo: createSpy(),
        sessionManager: {
          listSessions: createSpy(() => []),
          getSession: createSpy((id) => createdSessions.get(id)),
          createSession: createSpy((opts) => {
            const id = 'chat-sess-1'
            createdSessions.set(id, { name: opts.name, cwd: opts.cwd, session: { constructor: { isUserShell: false } } })
            return id
          }),
          getSessionPreset: () => null,
          firstSessionId: null,
        },
      })
      sessionHandlers.create_session(
        makeWs(),
        { id: 'client-y', authenticated: true, isPrimaryToken: true, subscribedSessionIds: new Set(), boundSessionId: null },
        { provider: 'claude-tui' },
        ctx,
      )
      assert.equal(createCalls.length, 0)
    })
  })

  // #5985 revoke-kills-live-shells — destroyAllUserShellSessions severs every
  // live user-shell on token rotation, leaves other sessions, audits with the
  // revoke reason.
  describe('destroyAllUserShellSessions (#5985 revoke-kills-live-shells)', () => {
    beforeEach(() => { destroyCalls.length = 0 })

    it('destroys every user-shell, leaves non-shell sessions, audits reason=token-rotated', () => {
      const mgr = makeMgr()
      const shellA = mgr.createSession({ name: 'shA', cwd: '/tmp', provider: 'test-audit-usershell' })
      const shellB = mgr.createSession({ name: 'shB', cwd: '/tmp', provider: 'test-audit-usershell' })
      const chat = mgr.createSession({ name: 'chat', cwd: '/tmp', provider: 'test-audit-normal' })

      const count = mgr.destroyAllUserShellSessions('token-rotated')

      assert.equal(count, 2, 'both user-shells destroyed')
      assert.equal(mgr.getSession(shellA), null)
      assert.equal(mgr.getSession(shellB), null)
      assert.ok(mgr.getSession(chat), 'non-shell session survives')
      assert.equal(destroyCalls.length, 2)
      assert.ok(destroyCalls.every((c) => c.reason === 'token-rotated'))
      rmSync(mgr._tmpDir, { recursive: true, force: true })
    })

    it('is a no-op (returns 0) when there are no user-shell sessions', () => {
      const mgr = makeMgr()
      mgr.createSession({ name: 'chat', cwd: '/tmp', provider: 'test-audit-normal' })
      assert.equal(mgr.destroyAllUserShellSessions('token-rotated'), 0)
      assert.equal(destroyCalls.length, 0)
      rmSync(mgr._tmpDir, { recursive: true, force: true })
    })
  })
}

function makeWs() { return {} }
