import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import { SessionManager, PROVIDER_START_DEADLINE_MS } from '../src/session-manager.js'
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

// #8876 — same shape, but opts out of the start deadline.
class StartingNoDeadline extends Starting8872 {
  static get startDeadlineMs() { return null }
}
declareUnknownCustomization(StartingNoDeadline)
registerProvider('test-starting-8876-nodeadline', StartingNoDeadline)

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

describe('provider start deadline (#8876)', () => {
  let sm
  let dir

  afterEach(() => {
    mock.timers.reset()
    startMode = 'sync'
    pendingStart = null
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function makeSm(providerType = 'test-starting-8872') {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-starting-8876-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json'), providerType })
    startMode = 'async'
    mock.timers.enable({ apis: ['setTimeout'] })
    return sm
  }

  async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  async function tick(ms) {
    mock.timers.tick(ms)
    await flush()
  }

  function parked(id) {
    return {
      id,
      name: 'Parked',
      cwd: dir,
      provider: 'test-starting-8872',
      model: null,
      permissionMode: null,
      lastActivityAt: Date.now(),
      history: [{ type: 'user', content: 'first' }],
    }
  }

  function collect(event) {
    const out = []
    sm.on(event, (p) => out.push(p))
    return out
  }

  it('fails a fresh session whose start never settles, as START_TIMEOUT', async () => {
    makeSm()
    const failed = collect('session_create_failed')
    const settled = collect('session_start_settled')
    const sessionId = sm.createSession({ cwd: dir, name: 'wedged' })

    await tick(PROVIDER_START_DEADLINE_MS - 1)
    assert.equal(rowOf(sm, sessionId)?.starting, true, 'still starting just before the deadline')
    assert.equal(failed.length, 0)

    await tick(1)
    assert.equal(rowOf(sm, sessionId), undefined, 'gone once the deadline passed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].errorCode, 'START_TIMEOUT')
    assert.equal(settled.length, 0)
  })

  it('leaves a start that settles before the deadline alone, even after the deadline passes', async () => {
    makeSm()
    const failed = collect('session_create_failed')
    const settled = collect('session_start_settled')
    const sessionId = sm.createSession({ cwd: dir, name: 'ok' })

    await tick(1000)
    await settle('resolve')
    assert.equal(rowOf(sm, sessionId).starting, false)
    assert.equal(settled.length, 1)

    await tick(PROVIDER_START_DEADLINE_MS * 2)
    assert.equal(rowOf(sm, sessionId)?.starting, false, 'still listed and usable')
    assert.equal(failed.length, 0)
    assert.equal(settled.length, 1)
  })

  it('ignores a late resolution after the deadline re-parked a restore', async () => {
    makeSm()
    const saved = parked('cccccccccccccccccccccccccccccccc')
    sm._failedRestores.set(saved.id, { saved, error: Object.assign(new Error('boom'), { code: 'START_FAILED' }) })
    const restoreFailed = collect('session_restore_failed')
    const settled = collect('session_start_settled')

    const retry = sm.retryFailedRestore(saved.id, { settleTimeoutMs: 5000 })
    await flush()
    const late = pendingStart
    assert.ok(late, 'the restore started')

    await tick(PROVIDER_START_DEADLINE_MS)
    const result = await retry
    assert.equal(rowOf(sm, saved.id), undefined, 're-parked')
    assert.equal(restoreFailed.length, 1)
    assert.equal(restoreFailed[0].errorCode, 'START_TIMEOUT')
    assert.ok(sm._failedRestores.has(saved.id))
    assert.equal(result.ok, true, 'the retry itself had already reported pending')

    late.resolve()
    await flush()
    assert.equal(settled.length, 0, 'a late resolution announces nothing')
    assert.equal(rowOf(sm, saved.id), undefined, 'and does not re-list the session')
    assert.equal(restoreFailed.length, 1)
  })

  it('ignores a late rejection after the deadline failed a fresh session', async () => {
    makeSm()
    const failed = collect('session_create_failed')
    const sessionId = sm.createSession({ cwd: dir, name: 'late-reject' })
    const late = pendingStart
    assert.ok(late, 'the start is pending')

    await tick(PROVIDER_START_DEADLINE_MS)
    assert.equal(rowOf(sm, sessionId), undefined, 'failed at the deadline')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].errorCode, 'START_TIMEOUT')

    late.reject(Object.assign(new Error('PTY died'), { code: 'PTY_EXIT' }))
    await flush()
    assert.equal(failed.length, 1, 'the late rejection reports nothing more')
    assert.equal(failed[0].errorCode, 'START_TIMEOUT', 'and does not replace the timeout as the reason')
  })

  it('does not bound a provider that opts out with startDeadlineMs = null', async () => {
    makeSm('test-starting-8876-nodeadline')
    const failed = collect('session_create_failed')
    const sessionId = sm.createSession({ cwd: dir, name: 'patient' })

    await tick(PROVIDER_START_DEADLINE_MS * 10)
    assert.equal(rowOf(sm, sessionId)?.starting, true, 'still starting')
    assert.equal(failed.length, 0)
  })

  it('a first start\'s timer does not tear down a re-created entry under the same id', async () => {
    makeSm()
    const saved = parked('dddddddddddddddddddddddddddddddd')
    const restoreFailed = collect('session_restore_failed')

    sm._failedRestores.set(saved.id, { saved, error: new Error('boom') })
    const retry1 = sm.retryFailedRestore(saved.id, { settleTimeoutMs: 5000 })
    await flush()
    assert.equal(rowOf(sm, saved.id)?.starting, true)

    // Move well past the retry's own settle wait, then replace the entry:
    // destroy it and retry again so a NEW entry exists under the SAME id.
    await tick(30 * 1000)
    await retry1
    sm.destroySession(saved.id, { archive: false })
    sm._failedRestores.set(saved.id, { saved, error: new Error('boom') })
    const retry2 = sm.retryFailedRestore(saved.id, { settleTimeoutMs: 5000 })
    await flush()
    const second = rowOf(sm, saved.id)
    assert.equal(second?.starting, true, 'the second entry is live and starting')
    const secondEntry = sm._sessions.get(saved.id)

    // The FIRST timer fires now (t = 60 s); the second is due at t = 90 s.
    await tick(30 * 1000)
    assert.equal(sm._sessions.get(saved.id), secondEntry, 'the new entry is untouched by the stale timer')
    assert.equal(rowOf(sm, saved.id)?.starting, true)
    assert.equal(restoreFailed.length, 0, 'the stale timer re-parked nothing')

    // The second entry's own deadline still works.
    await tick(30 * 1000)
    await retry2
    assert.equal(restoreFailed.length, 1)
    assert.equal(restoreFailed[0].errorCode, 'START_TIMEOUT')
  })
})
