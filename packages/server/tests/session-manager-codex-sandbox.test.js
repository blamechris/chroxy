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

// #6929 review — a codex thread's sandbox is chosen ONCE (at construction for the
// exec-based CodexSession, at thread/start for CodexAppServerSession) and cannot
// change without a new session/thread. getCodexSandbox() used to re-resolve
// CHROXY_CODEX_SANDBOX at CALL time, so listSessions() could DISPLAY a sandbox
// that no longer matches what the already-running session actually got if the
// env changed mid-session. These pin the fix: the value is captured once and
// stays fixed even when the env changes afterward.
describe('getCodexSandbox() is fixed at start, not re-resolved on env change (#6929)', () => {
  it('CodexSession: captured at construction; a later env change does not drift it', () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    process.env.CHROXY_CODEX_SANDBOX = 'read-only'
    try {
      const s = new CodexSession({ cwd: '/tmp' })
      assert.equal(s.getCodexSandbox(), 'read-only', 'resolved from the env at construction time')

      process.env.CHROXY_CODEX_SANDBOX = 'danger-full-access'
      assert.equal(s.getCodexSandbox(), 'read-only',
        'still the value resolved at construction — must not drift with the env')
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('CodexSession: a per-session override is likewise fixed at construction', () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    try {
      const s = new CodexSession({ cwd: '/tmp', codexSandbox: 'workspace-write' })
      assert.equal(s.getCodexSandbox(), 'workspace-write')

      process.env.CHROXY_CODEX_SANDBOX = 'read-only' // env changes after the fact
      assert.equal(s.getCodexSandbox(), 'workspace-write', 'per-session override still wins, unchanged')
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('CodexSession: the value stays fixed across turns too (_buildArgs reuses the stored value)', () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    process.env.CHROXY_CODEX_SANDBOX = 'read-only'
    try {
      const s = new CodexSession({ cwd: '/tmp' })
      const argsBefore = s._buildArgs('hello')
      assert.ok(argsBefore.includes('read-only'), 'first turn spawns with the construction-time value')

      process.env.CHROXY_CODEX_SANDBOX = 'danger-full-access'
      const argsAfter = s._buildArgs('hello again')
      assert.ok(argsAfter.includes('read-only'), 'later turn still spawns with the ORIGINAL value, not the new env')
      assert.equal(s.getCodexSandbox(), 'read-only')
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('CodexAppServerSession: pre-start getCodexSandbox() live-resolves (no thread yet to drift from)', () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    process.env.CHROXY_CODEX_SANDBOX = 'read-only'
    try {
      const s = new CodexAppServerSession({ cwd: '/tmp' })
      assert.equal(s._resolvedCodexSandbox, null, 'nothing captured yet — start() has not run')
      assert.equal(s.getCodexSandbox(), 'read-only', 'pre-start falls back to a live resolve')
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  // start() itself spawns a real `codex app-server` child process (via
  // CodexAppServerClient.initialize()), so it isn't exercised directly in this
  // unit suite (no codex binary in CI). What IS under test here is the actual
  // fix: start()'s FIRST statement is
  //   `this._resolvedCodexSandbox = resolveCodexSandbox(this._codexSandbox)`
  // (see codex-app-server-session.js) — i.e. the resolve+store happens before
  // anything else, at the exact `thread/start` apply site. This reproduces
  // that assignment (the one line start() runs for sandbox purposes) and then
  // asserts getCodexSandbox() reads the STORED value, not a live re-resolve.
  it('CodexAppServerSession: captured at start(); a later env change does not drift it', () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    process.env.CHROXY_CODEX_SANDBOX = 'read-only'
    try {
      const s = new CodexAppServerSession({ cwd: '/tmp' })
      s._resolvedCodexSandbox = resolveCodexSandbox(s._codexSandbox) // start()'s apply-site line
      assert.equal(s.getCodexSandbox(), 'read-only', 'resolved at "start" time')

      process.env.CHROXY_CODEX_SANDBOX = 'danger-full-access'
      assert.equal(s.getCodexSandbox(), 'read-only',
        'still the value resolved at start — must not drift with the env')
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })
})
