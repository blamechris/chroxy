import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager, UserShellDisabledError } from '../src/session-manager.js'
import { UserShellSession } from '../src/user-shell-session.js'
import { readRegistry } from '../src/user-shell-registry.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

/**
 * #5985 (epic #5982) — the fail-closed gate for the embedded user-shell
 * terminal. A `user-shell` session spawns the operator's `$SHELL` (arbitrary
 * code execution on the dev machine), so it is OFF unless the server config sets
 * `userShell.enabled:true` (threaded in as `userShellEnabled`).
 *
 * The gate lives in `SessionManager.createSession` (NOT the WS handler) so it
 * covers EVERY spawn path — WS create, restoreState, internal callers — per the
 * swarm-audit C3 finding. The `user-shell` provider itself ships later (#5983);
 * until then the gate fails closed (deny during build-out) and, when enabled,
 * flow falls through to `getProvider` which throws "Unknown provider" — which is
 * exactly how this test distinguishes "gate opened" from "gate blocked".
 */

let registerProvider

class CaptureProvider extends EventEmitter {
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

before(async () => {
  ({ registerProvider } = await import('../src/providers.js'))
  registerProvider('test-usershell-normal', CaptureProvider)
})

function makeMgr(extraOpts = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sm-usershell-'))
  const stateFile = join(tmpDir, 'state.json')
  const mgr = new SessionManager({
    skipPreflight: true,
    maxSessions: 10,
    defaultCwd: '/tmp',
    stateFilePath: stateFile,
    ...extraOpts,
  })
  mgr._tmpDir = tmpDir
  return mgr
}

function cleanup(mgr) {
  mgr.destroyAll()
  rmSync(mgr._tmpDir, { recursive: true, force: true })
}

describe('SessionManager user-shell gate (#5985)', () => {
  it('disabled by default: rejects provider:user-shell with USER_SHELL_DISABLED', () => {
    const mgr = makeMgr()
    try {
      assert.throws(
        () => mgr.createSession({ cwd: '/tmp', provider: 'user-shell' }),
        (err) => {
          assert.ok(err instanceof UserShellDisabledError, `expected UserShellDisabledError, got ${err?.name}`)
          assert.equal(err.code, 'USER_SHELL_DISABLED')
          return true
        },
      )
    } finally {
      cleanup(mgr)
    }
  })

  it('explicit userShellEnabled:false also rejects', () => {
    const mgr = makeMgr({ userShellEnabled: false })
    try {
      assert.throws(
        () => mgr.createSession({ cwd: '/tmp', provider: 'user-shell' }),
        (err) => err.code === 'USER_SHELL_DISABLED',
      )
    } finally {
      cleanup(mgr)
    }
  })

  it('userShellEnabled:true OPENS the gate (user-shell session is created)', () => {
    // #5983 registered the provider, so the gate-opens path now ends in a real
    // UserShellSession (re-asserts the #5989 follow-up). Stub the $SHELL spawn —
    // this test covers the gate, not node-pty.
    const origStart = UserShellSession.prototype.start
    UserShellSession.prototype.start = async function () {}
    const mgr = makeMgr({ userShellEnabled: true })
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'user-shell' })
      assert.ok(typeof id === 'string' && id.length > 0, 'gate opened → session created')
      assert.equal(mgr.getSession(id).session.constructor.isUserShell, true)
    } finally {
      UserShellSession.prototype.start = origStart
      cleanup(mgr)
    }
  })

  it('fail-closed: a truthy non-boolean userShellEnabled does NOT open the gate', () => {
    // The gate is strict `=== true` (no `!!` coercion), so a direct caller
    // passing a truthy non-boolean must still be rejected.
    for (const truthy of ['true', 1, {}]) {
      const mgr = makeMgr({ userShellEnabled: truthy })
      try {
        assert.throws(
          () => mgr.createSession({ cwd: '/tmp', provider: 'user-shell' }),
          (err) => err.code === 'USER_SHELL_DISABLED',
          `userShellEnabled=${JSON.stringify(truthy)} must NOT open the gate`,
        )
      } finally {
        cleanup(mgr)
      }
    }
  })

  it('does not affect a normal provider when the gate is disabled', () => {
    const mgr = makeMgr({ userShellEnabled: false })
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-usershell-normal' })
      assert.ok(typeof id === 'string' && id.length > 0, 'a non-shell provider creates normally')
    } finally {
      cleanup(mgr)
    }
  })
})

describe('SessionManager user-shell orphan reaper (#6276)', () => {
  const sidecarOf = (mgr) => join(mgr._tmpDir, 'user-shells.json')

  function captureAudit(run) {
    const lines = []
    const listener = (e) => { if (e?.level === 'audit') lines.push(e.message) }
    addLogListener(listener)
    try { run() } finally { removeLogListener(listener) }
    return lines
  }

  it('boot reaper SIGTERMs a matching live orphan and emits an orphan_reaper destroy audit', () => {
    const killed = []
    const mgr = makeMgr({
      userShellReapSeams: { isAlive: () => true, commOf: () => 'zsh', kill: (pid) => { killed.push(pid); return true } },
    })
    try {
      writeFileSync(sidecarOf(mgr), JSON.stringify([{ sessionId: 'orphan-1', pid: 4242, shell: 'zsh' }]))
      const audit = captureAudit(() => mgr.restoreState())
      assert.deepEqual(killed, [4242], 'the matching live orphan was SIGTERM-ed')
      assert.ok(
        audit.some((m) => m.includes('user_shell_destroy') && m.includes('orphan-1') && m.includes('orphan_reaper')),
        `expected an orphan_reaper destroy audit, got: ${JSON.stringify(audit)}`,
      )
      assert.equal(existsSync(sidecarOf(mgr)), false, 'sidecar cleared after the reap')
    } finally {
      cleanup(mgr)
    }
  })

  it('boot reaper does NOT signal (or audit) a reused pid whose comm no longer matches the shell', () => {
    const killed = []
    const mgr = makeMgr({
      userShellReapSeams: { isAlive: () => true, commOf: () => 'postgres', kill: (pid) => { killed.push(pid); return true } },
    })
    try {
      writeFileSync(sidecarOf(mgr), JSON.stringify([{ sessionId: 'reused-1', pid: 4242, shell: 'zsh' }]))
      const audit = captureAudit(() => mgr.restoreState())
      assert.deepEqual(killed, [], 'must not signal an innocent reused pid')
      assert.ok(!audit.some((m) => m.includes('orphan_reaper')), 'no orphan_reaper audit for a skipped record')
      assert.equal(existsSync(sidecarOf(mgr)), false, 'sidecar still cleared (this instance starts fresh)')
    } finally {
      cleanup(mgr)
    }
  })

  it('boot reaper is a no-op when there is no sidecar (clean-shutdown case)', () => {
    const mgr = makeMgr()
    try {
      assert.equal(existsSync(sidecarOf(mgr)), false)
      const audit = captureAudit(() => mgr.restoreState())
      assert.ok(!audit.some((m) => m.includes('orphan_reaper')), 'no reaper audit without a sidecar')
    } finally {
      cleanup(mgr)
    }
  })

  it('records a shell on spawn and forgets it on clean destroy (record/forget wiring)', () => {
    const origStart = UserShellSession.prototype.start
    UserShellSession.prototype.start = async function () {
      this._term = { pid: 54321, kill: () => {}, write: () => {}, onData: () => {}, onExit: () => {}, on: () => {} }
      this._shellAlive = true
      this.emit('shell_spawned', { pid: 54321 })
    }
    const mgr = makeMgr({ userShellEnabled: true })
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'user-shell' })
      assert.deepEqual(
        readRegistry(sidecarOf(mgr)).map((r) => ({ sessionId: r.sessionId, pid: r.pid })),
        [{ sessionId: id, pid: 54321 }],
        'spawn recorded the pid to the sidecar',
      )
      mgr.destroySession(id)
      assert.equal(
        readRegistry(sidecarOf(mgr)).some((r) => r.sessionId === id), false,
        'clean destroy dropped the record',
      )
    } finally {
      UserShellSession.prototype.start = origStart
      cleanup(mgr)
    }
  })
})
