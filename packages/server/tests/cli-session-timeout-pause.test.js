import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'

/**
 * Tests for CliSession inactivity-timer pause/resume during pending
 * permissions, and timeout cleanup of orphaned permissions.
 *
 * Issue #2831: the 5-minute result-inactivity timer was firing even
 * while the CLI process was blocked on a hook permission request. On
 * fire, the handler cleared message state; when the user later
 * approved, the CLI emitted tool results into a dead context so no
 * response ever streamed.
 */

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(chunk, enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
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

describe('CliSession — inactivity timer pause/resume (#2831)', () => {
  let session

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    session = createReadySession()
  })

  afterEach(() => {
    session?.destroy()
    mock.timers.reset()
  })

  describe('Option A: pause timer while permissions are pending', () => {
    it('does NOT fire inactivity timeout while a permission is pending', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))

      // Start a message (this arms the timeout)
      await session.sendMessage('do something')
      assert.ok(session._resultTimeout, 'timeout should be armed after sendMessage')

      // Register a pending permission — this should pause the timer
      session.notifyPermissionPending('perm-abc')

      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 0, 'no timeout should fire while permission is pending')

      // Resolve the permission — timer should re-arm
      session.notifyPermissionResolved('perm-abc')
      mock.timers.tick(4 * 60_000)
      assert.equal(errors.length, 0, 'still within fresh 5 min window')

      mock.timers.tick(2 * 60_000)
      assert.equal(errors.length, 1, 'timer fires 5 min after resume')
    })

    it('keeps timer paused while multiple permissions are pending', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))

      await session.sendMessage('do something')

      session.notifyPermissionPending('perm-1')
      session.notifyPermissionPending('perm-2')

      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 0, 'no timeout while 2 permissions pending')

      session.notifyPermissionResolved('perm-1')
      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 0, 'still paused: one permission remains')

      session.notifyPermissionResolved('perm-2')
      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 1, 'timer fires 5 min after last resolution')
    })

    it('ignores duplicate resolve calls for unknown requestIds', async () => {
      await session.sendMessage('do something')
      session.notifyPermissionResolved('never-registered')
      // Should not throw; counter should stay at 0; timer still armed.
      assert.ok(session._resultTimeout, 'timeout should remain armed')
    })
  })

  describe('Option B: on actual timeout, emit permission_expired for any pending', () => {
    it('emits permission_expired on timeout for any registered pending permissions', async () => {
      const expired = []
      const errors = []
      session.on('permission_expired', (d) => expired.push(d))
      session.on('error', (d) => errors.push(d))

      await session.sendMessage('do something')

      // Simulate a permission coming in AFTER the timer was already running,
      // but the session didn't know about it until just now. The timer
      // would fire naturally — we want the handler to still clean up.
      // To force this scenario, we register the permission but override
      // the pause behavior to keep the timer armed.
      session._pendingPermissionIds.add('perm-orphan')
      // Don't call the pause side effect — simulate a stale timer state
      mock.timers.tick(5 * 60_000 + 100)

      assert.equal(errors.length, 1, 'timeout error emitted')
      assert.equal(expired.length, 1, 'permission_expired emitted')
      assert.equal(expired[0].requestId, 'perm-orphan')
    })

    it('clears message state on timeout', async () => {
      session.on('error', () => {})

      await session.sendMessage('do something')
      assert.equal(session._isBusy, true)

      mock.timers.tick(5 * 60_000 + 100)

      assert.equal(session._isBusy, false, 'busy flag cleared')
      assert.equal(session._currentMessageId, null, 'message id cleared')
    })
  })
})
