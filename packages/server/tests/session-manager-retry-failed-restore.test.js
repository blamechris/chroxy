import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'

/**
 * #7625 — SessionManager.retryFailedRestore(): the operator-triggered second
 * attempt at a session the boot restore could not bring back.
 *
 * The load-bearing claim is that a successful retry CLEARS the parked entry.
 * serializeState() writes one entry per `_sessions` id AND, in a separate
 * unguarded loop, one per `_failedRestores` entry, so an entry left behind puts
 * the id on disk twice and the next boot silently mints a random id for the
 * duplicate. Mutation-tested: removing the delete kills three of these tests.
 *
 * What these tests deliberately do NOT claim to catch is delete-LATE. Moving
 * the delete after the attempt was measured and is not observable — the success
 * path flushes again afterwards and overwrites any bad intermediate write — so
 * an assertion that appeared to cover it would be one that cannot fail.
 */

// The registry is process-global and `node --test` runs files in parallel, so
// this name must be unique to this file.
let failNextStart = false
class Retry7625 extends EventEmitter {
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.isRunning = false
  }
  static get capabilities() { return {} }
  start() {
    if (failNextStart) {
      const err = new Error('environment is not running')
      err.code = 'ENVIRONMENT_STOPPED'
      throw err
    }
    this.isRunning = true
  }
  destroy() {} sendMessage() {} interrupt() {} setModel() {} setPermissionMode() {}
}
registerProvider('test-retry-7625', Retry7625)

const DAY = 24 * 60 * 60 * 1000

function park(sm, dir, overrides = {}) {
  const saved = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Parked One',
    cwd: dir,
    provider: 'test-retry-7625',
    model: null,
    permissionMode: null,
    // Deliberately old: #7627 froze this value for a parked entry, and the
    // retry path must not thaw it.
    lastActivityAt: Date.now() - 20 * DAY,
    history: [
      { type: 'user', content: 'first' },
      { type: 'response', content: 'second' },
    ],
    ...overrides,
  }
  const err = new Error('environment is not running')
  err.code = 'ENVIRONMENT_STOPPED'
  sm._failedRestores.set(saved.id, { saved, error: err })
  return saved
}

/**
 * Every id serializeState() would write right now, in order, duplicates
 * included. This re-serializes CURRENT memory — it does not read the state file
 * — so it sees an entry left in both maps, which is the bug worth catching, and
 * deliberately not a transient bad write that a later flush overwrites.
 */
function serializedIds(sm) {
  return (sm.serializeState()?.sessions ?? []).map((s) => s.id)
}

describe('SessionManager.retryFailedRestore (#7625)', () => {
  let sm
  let dir

  afterEach(() => {
    failNextStart = false
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function makeSm() {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-retry-7625-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json'), providerType: 'test-retry-7625' })
    return sm
  }

  it('restores the session and drops the parked entry when the retry succeeds', async () => {
    makeSm()
    const saved = park(sm, dir)

    const result = await sm.retryFailedRestore(saved.id)

    assert.equal(result.ok, true)
    assert.equal(sm._failedRestores.has(saved.id), false, 'parked entry cleared on success')
    assert.ok(sm._sessions.has(result.sessionId), 'session is live')
    assert.equal(result.sessionId, saved.id, 'the persisted id is preserved, so client-side ids still resolve')
  })

  it('clears the parked entry so the id is serialized once, not twice (#7625)', async () => {
    makeSm()
    const saved = park(sm, dir)

    // CONTROL: while parked, the id is on disk exactly once — via the
    // _failedRestores loop. Without this, the assertion below would also pass
    // if the entry had simply never been serialized at all.
    assert.deepEqual(serializedIds(sm), [saved.id], 'parked entry serializes once')

    await sm.retryFailedRestore(saved.id)

    const ids = serializedIds(sm)
    assert.deepEqual(
      ids,
      [saved.id],
      `after a successful retry the id must appear once (from _sessions), not twice; got ${JSON.stringify(ids)}`,
    )
  })

  it('re-seeds the saved history onto the restored session', async () => {
    makeSm()
    const saved = park(sm, dir)

    await sm.retryFailedRestore(saved.id)

    const history = sm._history.getHistory(saved.id)
    assert.equal(history.length, 2, 'both saved entries re-seeded')
    assert.equal(history[0].content, 'first')
    assert.equal(history[1].content, 'second')
  })

  it('re-parks with the SAME saved payload when the retry fails again', async () => {
    makeSm()
    const saved = park(sm, dir)
    const frozenActivity = saved.lastActivityAt
    failNextStart = true

    const events = []
    sm.on('session_restore_failed', (e) => events.push(e))

    const result = await sm.retryFailedRestore(saved.id)

    assert.equal(result.ok, false)
    assert.equal(result.code, 'ENVIRONMENT_STOPPED', 'the provider error code is reported, not a generic one')
    assert.equal(sm._failedRestores.has(saved.id), true, 'entry is re-parked, not dropped')
    assert.equal(sm._sessions.has(saved.id), false, 'no live session left behind')

    // #7627: the frozen lastActivityAt is what makes the 30-day TTL reachable.
    // Re-stamping it on every retry would let a chronically-failing session
    // outlive the TTL forever.
    const reparked = sm._failedRestores.get(saved.id).saved
    assert.equal(reparked.lastActivityAt, frozenActivity, 'lastActivityAt stays frozen across a retry')
    assert.equal(reparked.history.length, 2, 'history survives a failed retry')

    assert.equal(events.length, 1, 'clients are told the retry re-failed')
    assert.equal(events[0].sessionId, saved.id)
    assert.equal(events[0].errorCode, 'ENVIRONMENT_STOPPED')
    assert.equal(events[0].originalHistoryPreserved, true)
    assert.equal(events[0].historyLength, 2)
  })

  it('keeps lastActivityAt frozen across REPEATED failed retries', async () => {
    makeSm()
    const saved = park(sm, dir)
    const frozenActivity = saved.lastActivityAt
    failNextStart = true

    await sm.retryFailedRestore(saved.id)
    await sm.retryFailedRestore(saved.id)
    await sm.retryFailedRestore(saved.id)

    assert.equal(
      sm._failedRestores.get(saved.id).saved.lastActivityAt,
      frozenActivity,
      'three retries must not push the TTL out',
    )
  })

  it('does not write a duplicate id after a FAILED retry either', async () => {
    makeSm()
    const saved = park(sm, dir)
    failNextStart = true

    await sm.retryFailedRestore(saved.id)

    assert.deepEqual(serializedIds(sm), [saved.id], 're-parked entry serializes exactly once')
  })

  // #7625 review. The re-seed TAIL of _attemptRestoreOne runs after
  // createSession() has already returned, so a throw there leaves a live but
  // half-seeded session: no history (the seed never ran) and a lastActivityAt
  // of `now` from createSession's own touchActivity rather than the frozen
  // value #7627 depends on.
  //
  // The first implementation kept that session and flushed it. This test is the
  // one that proves it does not any more — it FAILED against that version, with
  // history erased and the freeze thawed, which is the whole reason the branch
  // was rewritten. Fault injection is the only way in: every step in that tail
  // is typeof-guarded, so no malformed state file reaches it today.
  it('re-parks verbatim when a RE-SEED step throws after the session was created', async () => {
    makeSm()
    const saved = park(sm, dir)
    const frozenActivity = saved.lastActivityAt

    // Throw in the tail, after createSession() has returned.
    const original = sm._advanceSessionCounterPast.bind(sm)
    let injected = false
    sm._advanceSessionCounterPast = (name) => {
      if (!injected) { injected = true; throw new Error('INJECTED: re-seed step failure') }
      return original(name)
    }

    const result = await sm.retryFailedRestore(saved.id)

    assert.equal(injected, true, 'CONTROL: the injected failure really did fire')
    assert.equal(result.ok, false)

    // The claim: NOTHING is lost. A retry must never destroy what not
    // retrying would have preserved.
    assert.equal(sm._failedRestores.has(saved.id), true, 'the entry is re-parked, not consumed')
    const reparked = sm._failedRestores.get(saved.id).saved
    assert.equal(reparked.history.length, 2, 'the preserved history survives')
    assert.equal(reparked.lastActivityAt, frozenActivity, 'the #7627 freeze is not thawed')

    // And no half-seeded session is left live under that id, which would put it
    // in BOTH maps and write the id to disk twice.
    assert.equal(sm._sessions.has(saved.id), false, 'the half-seeded session is torn down')
    assert.deepEqual(serializedIds(sm), [saved.id], 'the id is serialized exactly once')
  })

  // Copilot, #7630 review. createSession falls back to a RANDOM id when
  // `preserveId` is malformed (a corrupt state file is the reachable case, and
  // this file's own #7082 coercions already treat that file as untrusted) or
  // collides with a live session. So the id createSession used is not always
  // `saved.id` — and the teardown must key on the one it actually used, or it
  // misses the orphan in exactly the case that matters.
  it('tears down the half-seeded session even when its id is NOT the parked id', async () => {
    makeSm()
    // A malformed id: createSession's /^[a-f0-9]{32}$/ guard rejects it and
    // mints a random one instead.
    const saved = park(sm, dir, { id: 'NOT-A-VALID-HEX-ID' })
    const original = sm._advanceSessionCounterPast.bind(sm)
    let injected = false
    sm._advanceSessionCounterPast = (name) => {
      if (!injected) { injected = true; throw new Error('INJECTED: re-seed step failure') }
      return original(name)
    }

    const result = await sm.retryFailedRestore('NOT-A-VALID-HEX-ID')

    assert.equal(injected, true, 'CONTROL: the injected failure fired')
    assert.equal(result.ok, false)
    // The claim: NO live session is left behind under ANY id. Keying the
    // teardown on saved.id would leave the randomly-id'd one running.
    assert.equal(sm._sessions.size, 0, 'no orphan session under any id')
    assert.equal(sm._failedRestores.has('NOT-A-VALID-HEX-ID'), true, 're-parked')
    assert.equal(sm._failedRestores.get('NOT-A-VALID-HEX-ID').saved.history.length, 2, 'history intact')
  })

  it('reports the id the session was actually restored under', async () => {
    makeSm()
    const saved = park(sm, dir, { id: 'NOT-A-VALID-HEX-ID' })

    const result = await sm.retryFailedRestore('NOT-A-VALID-HEX-ID')

    assert.equal(result.ok, true)
    // The restored session is live under a MINTED id, so returning the
    // requested one would leave the caller unable to find what it recovered.
    assert.notEqual(result.sessionId, 'NOT-A-VALID-HEX-ID')
    assert.equal(sm._sessions.has(result.sessionId), true, 'the reported id is the live one')
    void saved
  })

  // The parked entry is constructed DIRECTLY here because production cannot
  // currently produce one: serializeState() skips isUserShell entries so a
  // user-shell session is never persisted or restored, and the re-park branch
  // in _handleAsyncStartFailure requires `_isRestore`, which a fresh user-shell
  // session never has. The guard is defence-in-depth for those two invariants
  // being maintained elsewhere — this test is what stops it being deleted as
  // dead code, and what would catch it silently regressing to a no-op.
  it('refuses to retry a user-shell session (defence in depth)', async () => {
    makeSm()
    const saved = park(sm, dir, { provider: 'user-shell' })

    const result = await sm.retryFailedRestore(saved.id)

    assert.equal(result.ok, false)
    assert.equal(result.code, 'RETRY_FORBIDDEN_USER_SHELL')
    assert.equal(sm._failedRestores.has(saved.id), true, 'the entry is left parked, not consumed')
    assert.equal(sm._sessions.has(saved.id), false, 'no shell was spawned')
  })

  it('reports a distinguishable code for an entry that is not parked', async () => {
    makeSm()

    const result = await sm.retryFailedRestore('ffffffffffffffffffffffffffffffff')

    assert.equal(result.ok, false)
    // The caller must be able to tell "your button is stale" (a concurrent
    // retry won, or the TTL pruned it) from "the retry ran and failed".
    assert.equal(result.code, 'FAILED_RESTORE_NOT_FOUND')
  })

  // NOTE ON WHAT THIS DOES NOT PROVE. This passes with `retryFailedRestore`'s
  // per-session lock REMOVED (measured). The get-then-delete critical section
  // contains no `await`, so JavaScript's single thread already makes it atomic
  // and two callers can never both see the entry. The lock is kept because it
  // serialises a retry against `destroySessionLocked` / `renameSessionLocked`,
  // which take the SAME per-session lock — and that is not covered here. Naming
  // this test after the lock would have made it a test that cannot fail.
  it('a lost race reports NOT_FOUND instead of restoring twice', async () => {
    makeSm()
    const saved = park(sm, dir)

    const [a, b] = await Promise.all([
      sm.retryFailedRestore(saved.id),
      sm.retryFailedRestore(saved.id),
    ])

    const outcomes = [a, b]
    assert.equal(outcomes.filter((r) => r.ok).length, 1, 'exactly one retry succeeds')
    const loser = outcomes.find((r) => !r.ok)
    assert.equal(loser.code, 'FAILED_RESTORE_NOT_FOUND', 'the loser sees the entry already claimed')
    assert.deepEqual(serializedIds(sm), [saved.id], 'a lost race still writes the id only once')
  })
})
