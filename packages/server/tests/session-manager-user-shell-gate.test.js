import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager, UserShellDisabledError } from '../src/session-manager.js'

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

  it('userShellEnabled:true OPENS the gate (flow proceeds past it to getProvider)', () => {
    const mgr = makeMgr({ userShellEnabled: true })
    try {
      // No `user-shell` provider is registered yet (#5983 ships it), so flow
      // falls through the gate to getProvider, which throws "Unknown provider".
      // The point: it is NOT the gate error — proving the gate opened.
      assert.throws(
        () => mgr.createSession({ cwd: '/tmp', provider: 'user-shell' }),
        (err) => {
          assert.ok(!(err instanceof UserShellDisabledError), 'gate must NOT block when enabled')
          assert.notEqual(err.code, 'USER_SHELL_DISABLED')
          assert.match(err.message, /Unknown provider/)
          return true
        },
      )
    } finally {
      cleanup(mgr)
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
