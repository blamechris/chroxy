import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'

/**
 * #7335 — a respawn must EXPIRE the permission prompts the dropped turn left
 * behind, instead of forgetting them silently.
 *
 * `_killAndRespawn` kills the `claude -p` child. Every PreToolUse hook that
 * child had blocked on dies with it, so the daemon's HTTP handler tears the
 * pending entry down via its `req 'aborted'` / `res 'close'` path — which
 * broadcasts NOTHING. Meanwhile `_emitInterruptedTurnResult` →
 * `_clearMessageState` wipes `_pendingPermissionIds` with no event either. The
 * prompt is dead on both sides and the client is never told, so the card sits
 * there live until its own 5-minute `expiresAt`, and clicking Allow returns the
 * server's "stale/unknown toolUseId … already resolved" path.
 *
 * The fix reuses the mechanism `_handleHardTimeout` has had since #2831 — that
 * path already emitted `permission_expired` for exactly this reason. It was
 * simply never wired to the OTHER way a turn dies, which is the
 * guard-wired-to-only-some-of-its-callers shape in docs/false-safety-guards.md.
 *
 * No client change is needed: the dashboard's `permission_expired` handler
 * already appends the expiry note and clears the prompt's `options`, which is
 * what makes the Allow button (and its confusing "already acknowledged"
 * response) go away.
 */

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  // Never emits 'close', so _killAndRespawn's respawn() (and start()) never
  // runs — these tests are about what happens BEFORE the new child exists.
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

function createReadySession(opts = {}) {
  const session = new CliSession({ cwd: '/tmp', ...opts })
  session._processReady = true
  session._child = createMockChild()
  return session
}

describe('CliSession — respawn expires pending permissions (#7335)', () => {
  let session
  let expired

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    session = createReadySession()
    expired = []
    session.on('permission_expired', (d) => expired.push(d))
    // Several of these paths emit `error` by design (a child close reports
    // "exited unexpectedly"). Sink it so node:test does not rethrow an
    // EventEmitter unhandled-'error' and bury the assertion under test.
    session.on('error', () => {})
  })

  afterEach(() => {
    mock.timers.reset()
    session.removeAllListeners()
  })

  it('THE BUG: _killAndRespawn emits permission_expired for every pending permission', async () => {
    await session.sendMessage('do something')
    session.notifyPermissionPending('perm-1')
    session.notifyPermissionPending('perm-2')

    session._killAndRespawn()

    assert.equal(expired.length, 2, 'one permission_expired per pending permission')
    assert.deepEqual(
      expired.map((e) => e.requestId).sort(),
      ['perm-1', 'perm-2'],
      'expired the ids that were actually pending',
    )
    for (const e of expired) {
      assert.equal(typeof e.message, 'string')
      assert.ok(e.message.length > 0, 'carries a reason string')
    }
    assert.equal(session._pendingPermissionIds.size, 0, 'bookkeeping cleared')
  })

  it('THE SCENARIO: flipping to auto while paused on a prompt expires that prompt', async () => {
    await session.sendMessage('run a command')
    session.notifyPermissionPending('perm-auto')

    // The #3729 panic-button: BaseSession lets 'auto' through the busy guard.
    session.setPermissionMode('auto')

    assert.equal(expired.length, 1, 'the open prompt is expired, not abandoned')
    assert.equal(expired[0].requestId, 'perm-auto')
  })

  it('THE ADJACENT PATH: a child that exits (crash or user Stop) also expires its prompts', async () => {
    await session.sendMessage('run a command')
    session.notifyPermissionPending('perm-crash')

    // interrupt()/Stop sends SIGINT and the child exits; a crash lands here
    // too. Neither goes through _killAndRespawn, so this path needed wiring of
    // its own — the hook died with the child either way.
    session._handleChildClose(1)

    assert.equal(expired.length, 1, 'the prompt the dead child was blocked on is expired')
    assert.equal(expired[0].requestId, 'perm-crash')
    assert.equal(session._pendingPermissionIds.size, 0, 'bookkeeping cleared')
  })

  it('POSITIVE CONTROL: a child close with NO pending permissions emits nothing', async () => {
    await session.sendMessage('do something')

    session._handleChildClose(0)

    assert.equal(expired.length, 0, 'no phantom expiries on a clean exit')
  })

  it('does not expire the SAME prompt twice across a respawn and the close it caused', async () => {
    await session.sendMessage('do something')
    session.notifyPermissionPending('perm-1')

    session._killAndRespawn()
    assert.equal(expired.length, 1, 'respawn expired it')

    session._handleChildClose(0)
    assert.deepEqual(expired.map((e) => e.requestId), ['perm-1'], 'not re-expired')
  })

  it('the _respawning short-circuit is REAL, not just an empty set', async () => {
    // The previous version of this case asserted only that the count stayed at
    // 1 — which it would with the `if (this._respawning) return` guard DELETED,
    // because _killAndRespawn had already emptied the set. Deleting the guard
    // left the whole suite green. Re-arm an id in the gap so the two outcomes
    // actually differ: with the guard, the close short-circuits and this id
    // survives to be expired later; without it, the close expires it now.
    await session.sendMessage('do something')
    session.notifyPermissionPending('perm-1')

    session._killAndRespawn()
    assert.equal(expired.length, 1, 'respawn expired the first prompt')

    // The old child lives for up to the 10s force-kill grace and can raise a
    // fresh PreToolUse hook in that window (the file asserts this itself).
    session.notifyPermissionPending('perm-during-grace')

    session._handleChildClose(0)

    assert.deepEqual(
      expired.map((e) => e.requestId),
      ['perm-1'],
      'the close short-circuited on _respawning and did NOT expire the late prompt',
    )
    assert.ok(
      session._pendingPermissionIds.has('perm-during-grace'),
      'the late prompt is still pending, owned by the respawned child',
    )
  })

  it('C1: expiring releases the inactivity PAUSE, not just the ids', async () => {
    // The set and _resultTimeoutPaused are one piece of bookkeeping.
    // notifyPermissionResolved only unsets the flag for an id still in the set,
    // so taking the ids without releasing the flag wedges it true — and
    // _armResultTimeout bails on it, leaving the inactivity warning, the hard
    // cap and the stream-stall recovery all dead for the rest of the session.
    await session.sendMessage('do something')
    // Drive _isBusy false first, so _emitInterruptedTurnResult early-returns and
    // cannot mask the bug by resetting the flag itself.
    session._clearMessageState()
    session.notifyPermissionPending('perm-late')
    assert.equal(session._resultTimeoutPaused, true, 'precondition: paused')
    assert.equal(session._isBusy, false, 'precondition: not busy')

    session._handleChildClose(1)

    assert.equal(session._resultTimeoutPaused, false, 'pause released')

    // The real consequence: the next turn must re-arm its safety timers.
    session._processReady = true
    session._child = createMockChild()
    await session.sendMessage('next turn')
    assert.ok(session._resultTimeout, 'inactivity warning re-armed')
    assert.ok(session._hardTimeout, 'hard cap re-armed')
  })

  it('F3: the interrupt safety timeout expires too — it aborts the turn, killing the hook', async () => {
    // Previously excused as "the child ignored SIGINT so the prompt is still
    // answerable". This file says otherwise at the markIntentionalStop comment:
    // claude only aborts the CURRENT TURN, so the in-flight hook dies with it.
    // That path also wiped the ids via _clearMessageState, so no later close
    // could expire them either.
    await session.sendMessage('do something')
    session.notifyPermissionPending('perm-int')

    // The safety timeout's body, reached 5s after interrupt() when the child
    // survived SIGINT.
    session._emitInterruptedTurnResult()

    assert.deepEqual(expired.map((e) => e.requestId), ['perm-int'], 'expired, not silently dropped')
    assert.equal(session._pendingPermissionIds.size, 0)
  })

  it('F4: a NORMAL turn end expires a prompt left pending, rather than dropping it', async () => {
    // The most common way a turn stops was in neither column of the original
    // audit table. _clearMessageState wiped the set with no event.
    await session.sendMessage('do something')
    session.notifyPermissionPending('perm-orphaned-by-result')

    session._clearMessageState()

    assert.deepEqual(expired.map((e) => e.requestId), ['perm-orphaned-by-result'])
  })

  it('POSITIVE CONTROL: a normal turn end with nothing pending emits nothing', async () => {
    await session.sendMessage('do something')
    session._clearMessageState()
    assert.equal(expired.length, 0, 'the funnel does not fire unconditionally')
  })

  it('POSITIVE CONTROL: a respawn with NO pending permissions emits nothing', async () => {
    await session.sendMessage('do something')

    session._killAndRespawn()

    assert.equal(expired.length, 0, 'no phantom expiries — the event is not unconditional')
  })

  it('POSITIVE CONTROL: a resolved permission is not expired again on respawn', async () => {
    await session.sendMessage('do something')
    session.notifyPermissionPending('perm-1')
    session.notifyPermissionResolved('perm-1')

    session._killAndRespawn()

    assert.equal(expired.length, 0, 'an already-resolved prompt is not double-reported')
  })

  it('does not emit twice when the hard-cap timeout is followed by a respawn', async () => {
    // Own session: the hard cap is pinned inside the stall window so the
    // hard-timeout path is what fires, not the #4467 stall recovery.
    const s = createReadySession({
      resultTimeoutMs: 5 * 60_000,
      hardTimeoutMs: 5 * 60_000,
      streamStallTimeoutMs: 0,
    })
    const seen = []
    s.on('permission_expired', (d) => seen.push(d))
    // The hard-cap path emits `error` by design; sink it so node:test does not
    // rethrow an EventEmitter unhandled-'error'.
    s.on('error', () => {})

    await s.sendMessage('do something')
    // Registered without the pause side effect, so the hard timer stays armed —
    // the orphan case _handleHardTimeout was written for.
    s._pendingPermissionIds.add('perm-orphan')
    mock.timers.tick(5 * 60_000 + 100)
    assert.equal(seen.length, 1, 'hard-cap expired it once')

    s._killAndRespawn()
    assert.equal(seen.length, 1, 'respawn does not re-expire an already-expired prompt')
    s.removeAllListeners()
  })
})
