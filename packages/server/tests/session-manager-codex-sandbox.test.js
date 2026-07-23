import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'
import {
  CodexSession,
  resolveCodexSandbox,
  CODEX_SANDBOX_MODES,
  CODEX_DEFAULT_SANDBOX,
} from '../src/codex-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'

// #6901: the ACTIVE/resolved codex sandbox mode is surfaced in session_list
// (SessionInfo.codexSandbox) so a client can DISPLAY the current sandbox for a
// running codex session — the optional half of #6689. It is populated from the
// codex session's `getCodexSandbox()` (resolveCodexSandbox of the per-session
// override vs env/default) and OMITTED entirely for non-codex sessions.

let registerProvider

before(async () => {
  ({ registerProvider } = await import('../src/providers.js'))
  // A codex-like provider: exposes getCodexSandbox() (the contract listSessions
  // gates on) without spawning a real `codex` binary.
  class FakeCodexProvider extends EventEmitter {
    constructor(opts) {
      super()
      this.cwd = opts.cwd
      this.model = opts.model || null
      this.permissionMode = opts.permissionMode || 'approve'
      this.isRunning = false
      this.resumeSessionId = null
      this._sandbox = opts.codexSandbox || null
    }
    static get capabilities() { return {} }
    getCodexSandbox() { return resolveCodexSandbox(this._sandbox) }
    start() {}
    destroy() {}
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
  }
  // A plain (non-codex) provider with NO getCodexSandbox().
  class PlainProvider extends EventEmitter {
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
  registerProvider('test-fake-codex', FakeCodexProvider)
  registerProvider('test-plain', PlainProvider)
})

function makeMgr() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sm-codex-sandbox-'))
  const mgr = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: join(tmpDir, 'state.json') })
  mgr._tmpDir = tmpDir
  return mgr
}
function cleanup(mgr) { mgr.destroyAll(); rmSync(mgr._tmpDir, { recursive: true, force: true }) }

describe('session-list codexSandbox (#6901)', () => {
  it('surfaces the per-session sandbox override for a codex session', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-fake-codex', codexSandbox: 'read-only' })
      const entry = mgr.listSessions().find((s) => s.sessionId === id)
      assert.ok(entry, 'session listed')
      assert.equal(entry.codexSandbox, 'read-only')
    } finally {
      cleanup(mgr)
    }
  })

  it('falls back to the resolved default when no override is set', () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    delete process.env.CHROXY_CODEX_SANDBOX
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-fake-codex' })
      const entry = mgr.listSessions().find((s) => s.sessionId === id)
      assert.ok(entry)
      assert.equal(entry.codexSandbox, CODEX_DEFAULT_SANDBOX)
      assert.ok(CODEX_SANDBOX_MODES.includes(entry.codexSandbox))
    } finally {
      cleanup(mgr)
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('omits codexSandbox entirely for a non-codex session', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-plain' })
      const entry = mgr.listSessions().find((s) => s.sessionId === id)
      assert.ok(entry)
      assert.equal('codexSandbox' in entry, false, 'no codexSandbox key on a non-codex session')
    } finally {
      cleanup(mgr)
    }
  })
})

describe('CodexSession/CodexAppServerSession getCodexSandbox() (#6901)', () => {
  it('CodexSession.getCodexSandbox() resolves the per-session override', () => {
    const s = new CodexSession({ cwd: '/tmp', codexSandbox: 'danger-full-access' })
    assert.equal(s.getCodexSandbox(), 'danger-full-access')
  })

  it('CodexSession.getCodexSandbox() falls back to the resolved default', () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    delete process.env.CHROXY_CODEX_SANDBOX
    try {
      const s = new CodexSession({ cwd: '/tmp' })
      assert.equal(s.getCodexSandbox(), CODEX_DEFAULT_SANDBOX)
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('CodexAppServerSession also exposes getCodexSandbox() (app-server path)', () => {
    assert.equal(typeof CodexAppServerSession.prototype.getCodexSandbox, 'function')
  })
})
