import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

/**
 * Plumbing tests for `skipPermissions` (#4208 / #4209).
 *
 * The `claude-tui` provider's `--dangerously-skip-permissions` option was
 * wired at the constructor level in #4207, but `SessionManager.createSession`
 * never destructured the field and never forwarded it to providerOpts — so a
 * WS `create_session` payload carrying `skipPermissions: true` (or a
 * `chroxy start --dangerously-skip-permissions` server-wide default) was
 * dropped on the floor.
 *
 * These tests pin the plumbing using a synthetic provider that captures the
 * `skipPermissions` field of its constructor opts. We don't exercise the
 * real ClaudeTuiSession here — claude-tui-session.test.js already covers
 * the spawn-args + settings.json + env side of the contract; this file
 * covers the SessionManager -> providerOpts hop that #4208 noted was the
 * missing link.
 */

let registerProvider
let capturedProviderOpts = []

class CaptureProvider extends EventEmitter {
  constructor(opts) {
    super()
    capturedProviderOpts.push(opts)
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = null
    // Mirror ClaudeTuiSession's runtime coercion so the test can assert
    // both the providerOpts hand-off AND the resulting boolean shape.
    this.skipPermissions = !!opts.skipPermissions
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
  registerProvider('test-capture-skip-perm', CaptureProvider)
})

function makeMgr(extraOpts = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sm-skip-perm-'))
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

describe('SessionManager skipPermissions plumbing (#4208 / #4209)', () => {
  it('default (no per-session field, no server default): providerOpts.skipPermissions is undefined', () => {
    capturedProviderOpts = []
    const mgr = makeMgr()
    try {
      mgr.createSession({ cwd: '/tmp', provider: 'test-capture-skip-perm' })
      const opts = capturedProviderOpts.at(-1)
      assert.equal(opts.skipPermissions, undefined,
        'omitted field must not be forwarded — keeps providerOpts clean for non-TUI providers')
    } finally {
      cleanup(mgr)
    }
  })

  it('per-session skipPermissions=true: reaches the provider constructor', () => {
    capturedProviderOpts = []
    const mgr = makeMgr()
    try {
      mgr.createSession({
        cwd: '/tmp',
        provider: 'test-capture-skip-perm',
        skipPermissions: true,
      })
      const opts = capturedProviderOpts.at(-1)
      assert.equal(opts.skipPermissions, true,
        'createSession() MUST forward skipPermissions to providerOpts — the whole point of #4208')
    } finally {
      cleanup(mgr)
    }
  })

  it('per-session skipPermissions=false: explicit false overrides server default', () => {
    capturedProviderOpts = []
    const mgr = makeMgr({ defaultSkipPermissions: true })
    try {
      mgr.createSession({
        cwd: '/tmp',
        provider: 'test-capture-skip-perm',
        skipPermissions: false,
      })
      const opts = capturedProviderOpts.at(-1)
      // Explicit false from the caller must beat the server default —
      // otherwise a dashboard user could never un-check the box on a
      // server that was launched with --dangerously-skip-permissions.
      assert.equal(opts.skipPermissions, undefined,
        'explicit per-session false must override the server-wide default')
    } finally {
      cleanup(mgr)
    }
  })

  it('server defaultSkipPermissions=true: applied when per-session field is omitted', () => {
    capturedProviderOpts = []
    const mgr = makeMgr({ defaultSkipPermissions: true })
    try {
      // No skipPermissions in the call — should inherit the server default.
      mgr.createSession({ cwd: '/tmp', provider: 'test-capture-skip-perm' })
      const opts = capturedProviderOpts.at(-1)
      assert.equal(opts.skipPermissions, true,
        '`chroxy start --dangerously-skip-permissions` MUST seed createSession() defaults (#4209)')
    } finally {
      cleanup(mgr)
    }
  })

  it('non-boolean per-session value (e.g. string from a hand-edited state file) falls back to server default', () => {
    capturedProviderOpts = []
    const mgr = makeMgr({ defaultSkipPermissions: true })
    try {
      // typeof skipPermissions !== 'boolean' must trigger the default-path —
      // matches the same defensive shape promptEvaluator uses elsewhere
      // in createSession. Without this, a string 'yes' from an older
      // protocol version would coerce-bypass the server-wide gate.
      mgr.createSession({
        cwd: '/tmp',
        provider: 'test-capture-skip-perm',
        skipPermissions: 'yes',
      })
      const opts = capturedProviderOpts.at(-1)
      assert.equal(opts.skipPermissions, true,
        'non-boolean per-session value falls back to the server default')
    } finally {
      cleanup(mgr)
    }
  })

  it('defaultSkipPermissions coerces truthy non-boolean to true (defensive constructor)', () => {
    capturedProviderOpts = []
    // Pass a string the way a hand-edited config.json might.
    const mgr = makeMgr({ defaultSkipPermissions: 'yes' })
    try {
      mgr.createSession({ cwd: '/tmp', provider: 'test-capture-skip-perm' })
      const opts = capturedProviderOpts.at(-1)
      assert.equal(opts.skipPermissions, true,
        '!!"yes" === true — the constructor coerces defensively so config drift can\'t partially enable the flag')
    } finally {
      cleanup(mgr)
    }
  })

  it('defaultSkipPermissions defaults to false when omitted from SessionManager constructor', () => {
    capturedProviderOpts = []
    const mgr = makeMgr()
    try {
      // Sanity: omitting defaultSkipPermissions must keep the server-wide
      // gate OFF, regardless of any other state.
      mgr.createSession({ cwd: '/tmp', provider: 'test-capture-skip-perm' })
      const opts = capturedProviderOpts.at(-1)
      assert.equal(opts.skipPermissions, undefined,
        'omitting the constructor opt must NOT silently enable skipPermissions')
    } finally {
      cleanup(mgr)
    }
  })
})
