import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'

/**
 * #6824 — persistence of the per-session parked (disabled) MCP server set.
 *
 * SessionManager must:
 *   1. serialize `disabledMcpServers` from a session's `getDisabledMcpServers()`
 *      getter (BYOK lane), and [] for providers without the getter;
 *   2. forward a non-empty persisted set into `providerOpts.disabledMcpServers`
 *      on createSession (so a respawned BYOK fleet skips the parked servers);
 *   3. round-trip the set through serialize → state file → restoreState.
 *
 * Uses a capturing provider (not the real BYOK session) so the plumbing is
 * asserted in isolation — the BYOK fleet-seed behaviour is covered by
 * byok-session.test.js / byok-mcp-fleet.test.js.
 */

// Module-scoped buffer of providerOpts handed to the capturing provider.
const capturedOpts = []

class McpCaptureProvider extends EventEmitter {
  constructor(opts) {
    super()
    capturedOpts.push(opts)
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = null
    // #6824: mirror the BYOK getter so serialize can read the parked set back
    // out of a live entry. Seeded from the forwarded opt.
    this._disabled = Array.isArray(opts.disabledMcpServers) ? [...opts.disabledMcpServers] : []
  }
  static get capabilities() { return {} }
  getDisabledMcpServers() { return [...this._disabled].sort() }
  start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}

let registered = false
function ensureProvider() {
  if (registered) return
  registerProvider('test-mcp-capture', McpCaptureProvider)
  registered = true
}

describe('MCP server disabled-set persistence (#6824)', () => {
  let tmpDir
  let stateFile

  beforeEach(() => {
    ensureProvider()
    capturedOpts.length = 0
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-persist-'))
    stateFile = join(tmpDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('serializes disabledMcpServers from the session getter', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.getDisabledMcpServers = () => ['beta', 'alpha']
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'byok', name: 'T', cwd: '/tmp', provider: 'test-mcp-capture' })

    const state = mgr.serializeState()
    assert.deepEqual(state.sessions[0].disabledMcpServers, ['beta', 'alpha'])
  })

  it('serializes [] when the provider lacks the getter', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    const session = new EventEmitter()
    session.model = 'sonnet'
    session.permissionMode = 'approve'
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set('s1', { session, type: 'cli', name: 'T', cwd: '/tmp', provider: 'test-mcp-capture' })

    const state = mgr.serializeState()
    assert.deepEqual(state.sessions[0].disabledMcpServers, [])
  })

  it('forwards a non-empty set into providerOpts.disabledMcpServers on createSession', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    mgr.createSession({ cwd: '/tmp', provider: 'test-mcp-capture', disabledMcpServers: ['x', 'y'] })
    assert.equal(capturedOpts.length, 1)
    assert.deepEqual(capturedOpts[0].disabledMcpServers, ['x', 'y'])
  })

  it('omits disabledMcpServers from providerOpts when unset or empty', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    mgr.createSession({ cwd: '/tmp', provider: 'test-mcp-capture' })
    mgr.createSession({ cwd: '/tmp', provider: 'test-mcp-capture', disabledMcpServers: [] })
    assert.equal(capturedOpts.length, 2)
    assert.equal(Object.prototype.hasOwnProperty.call(capturedOpts[0], 'disabledMcpServers'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(capturedOpts[1], 'disabledMcpServers'), false)
  })

  it('round-trips the parked set through serialize → state file → restoreState', () => {
    // Write a state file directly (mirrors what serializeState produces) with a
    // session that parked two servers, then restore in a fresh manager and
    // assert the respawned provider receives the set.
    const mgr1 = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    mgr1.createSession({
      cwd: '/tmp',
      provider: 'test-mcp-capture',
      disabledMcpServers: ['gamma'],
    })
    const state = mgr1.serializeState()
    assert.deepEqual(state.sessions[0].disabledMcpServers, ['gamma'])

    // Fresh manager restores from the just-written file.
    capturedOpts.length = 0
    const mgr2 = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: stateFile })
    mgr2.restoreState()
    // The restored provider was constructed with the parked set forwarded.
    const restored = capturedOpts.find((o) => Array.isArray(o.disabledMcpServers))
    assert.ok(restored, 'restored provider should receive disabledMcpServers')
    assert.deepEqual(restored.disabledMcpServers, ['gamma'])

    // And the on-disk file carried it.
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.deepEqual(onDisk.sessions[0].disabledMcpServers, ['gamma'])
  })
})
