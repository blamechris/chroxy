import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

// #6691 (E-4 part 3b): createSession accepts an opaque `metadata` annotation and
// listSessions() surfaces the orchestration badges (orchestrationRunId /
// orchestrationRole) for engine-owned sessions — absent for plain sessions.

let registerProvider

before(async () => {
  ({ registerProvider } = await import('../src/providers.js'))
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
  registerProvider('test-noop-badge', NoopProvider)
})

function makeMgr() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sm-badge-'))
  const mgr = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: join(tmpDir, 'state.json') })
  mgr._tmpDir = tmpDir
  return mgr
}
function cleanup(mgr) { mgr.destroyAll(); rmSync(mgr._tmpDir, { recursive: true, force: true }) }

describe('session-list orchestration badges (#6691 E-4)', () => {
  it('surfaces orchestrationRunId/orchestrationRole from createSession metadata', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({
        cwd: '/tmp', provider: 'test-noop-badge',
        metadata: { orchestrationRunId: 'run_abc', orchestrationRole: 'worker.audit' },
      })
      const entry = mgr.listSessions().find((s) => s.sessionId === id)
      assert.ok(entry, 'session listed')
      assert.equal(entry.orchestrationRunId, 'run_abc')
      assert.equal(entry.orchestrationRole, 'worker.audit')
    } finally {
      cleanup(mgr)
    }
  })

  it('omits the badge fields entirely for a plain (non-orchestration) session', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-noop-badge' })
      const entry = mgr.listSessions().find((s) => s.sessionId === id)
      assert.ok(entry)
      assert.equal('orchestrationRunId' in entry, false, 'no badge key on a plain session')
      assert.equal('orchestrationRole' in entry, false)
    } finally {
      cleanup(mgr)
    }
  })

  it('carries the architect badge too', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({
        cwd: '/tmp', provider: 'test-noop-badge',
        metadata: { orchestrationRunId: 'run_x', orchestrationRole: 'architect' },
      })
      const entry = mgr.listSessions().find((s) => s.sessionId === id)
      assert.equal(entry.orchestrationRole, 'architect')
    } finally {
      cleanup(mgr)
    }
  })
})
