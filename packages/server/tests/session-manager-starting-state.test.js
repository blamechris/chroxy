import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8872 — a session whose provider start() has not settled is listed as
 * `starting`, so no client offers it as openable before it is usable. The case
 * that matters most is a restore whose start REJECTS: it is re-parked, and a
 * client that opened it in the meantime got "Session not found".
 */

// The registry is process-global and `node --test` runs files in parallel, so
// this name must be unique to this file.
let startMode = 'sync'
let pendingStart = null
class Starting8872 extends EventEmitter {
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.isRunning = false
  }
  static get capabilities() { return {} }
  start() {
    if (startMode === 'sync') return
    // A start the test settles by hand, the way Codex app-server and claude-tui
    // settle theirs some time after createSession returned.
    return new Promise((resolve, reject) => { pendingStart = { resolve, reject } })
  }
  destroy() {} sendMessage() {} interrupt() {} setModel() {} setPermissionMode() {}
}
declareUnknownCustomization(Starting8872)
registerProvider('test-starting-8872', Starting8872)

/** Settle the pending start and let its handlers run. */
async function settle(how) {
  const p = pendingStart
  pendingStart = null
  if (how === 'resolve') p.resolve()
  else p.reject(Object.assign(new Error('thread/resume refused'), { code: 'CODEX_NATIVE_LOCATOR_MISSING' }))
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function rowOf(sm, sessionId) {
  return sm.listSessions().find((s) => s.sessionId === sessionId)
}

describe('session_list starting state (#8872)', () => {
  let sm
  let dir

  afterEach(() => {
    startMode = 'sync'
    pendingStart = null
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function makeSm() {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-starting-8872-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json'), providerType: 'test-starting-8872' })
    return sm
  }

  it('lists a sync-started session as not starting', () => {
    makeSm()
    const sessionId = sm.createSession({ cwd: dir, name: 'sync' })
    assert.equal(rowOf(sm, sessionId).starting, false)
  })

  it('lists an async start as starting until it resolves, then announces the change once', async () => {
    makeSm()
    startMode = 'async'
    const settled = []
    sm.on('session_start_settled', (payload) => settled.push(payload))

    const sessionId = sm.createSession({ cwd: dir, name: 'async' })
    assert.equal(rowOf(sm, sessionId).starting, true, 'listed as starting while start() is pending')
    assert.equal(settled.length, 0, 'nothing announced before the start settles')

    await settle('resolve')

    assert.equal(rowOf(sm, sessionId).starting, false, 'openable once start() resolved')
    assert.deepEqual(settled, [{ sessionId }], 'the change is announced exactly once')
  })

  it('never lists a restore whose start rejects as openable', async () => {
    makeSm()
    startMode = 'async'
    const saved = {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'Parked',
      cwd: dir,
      provider: 'test-starting-8872',
      model: null,
      permissionMode: null,
      lastActivityAt: Date.now(),
      history: [{ type: 'user', content: 'first' }],
    }
    sm._failedRestores.set(saved.id, { saved, error: Object.assign(new Error('boom'), { code: 'START_FAILED' }) })
    const settled = []
    sm.on('session_start_settled', (payload) => settled.push(payload))

    const retry = sm.retryFailedRestore(saved.id, { settleTimeoutMs: 5000 })
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // CONTROL: the session really is in the list while its start is pending —
    // without this the assertion below would also pass for a session that was
    // simply never listed.
    const during = rowOf(sm, saved.id)
    assert.ok(during, 'the restoring session is listed while its start is pending')
    assert.equal(during.starting, true, 'and is listed as starting, not openable')

    await settle('reject')
    const result = await retry

    assert.equal(result.ok, false, 'the retry reports the rejection')
    assert.equal(rowOf(sm, saved.id), undefined, 're-parked, so no longer listed')
    assert.equal(settled.length, 0, 'a rejected start announces nothing as settled')
  })

  it('lists a fresh session whose start rejects as starting until it is gone', async () => {
    makeSm()
    startMode = 'async'
    const sessionId = sm.createSession({ cwd: dir, name: 'fails' })
    assert.equal(rowOf(sm, sessionId).starting, true)

    await settle('reject')

    assert.equal(rowOf(sm, sessionId), undefined, 'destroyed after the rejection')
  })

  it('announces nothing for a session destroyed before its start resolved', async () => {
    makeSm()
    startMode = 'async'
    const settled = []
    sm.on('session_start_settled', (payload) => settled.push(payload))
    const sessionId = sm.createSession({ cwd: dir, name: 'gone' })

    sm.destroySession(sessionId)
    await settle('resolve')

    assert.equal(settled.length, 0)
  })
})
