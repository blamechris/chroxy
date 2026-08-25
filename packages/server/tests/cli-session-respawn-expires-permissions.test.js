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
