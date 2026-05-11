import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SdkSession } from '../src/sdk-session.js'
import { armResultTimeoutForTest } from './test-helpers.js'

/**
 * Tests for SdkSession inactivity-timer pause/resume during pending
 * permissions, and timeout cleanup of orphaned permissions.
 *
 * Issue #2831: the 5-minute result-inactivity timer was firing even
 * while the session was blocked on a user permission prompt. On fire
 * the handler cleared message state but left pending permissions
 * orphaned, so subsequent approvals resolved into a dead SDK turn and
 * no response ever streamed.
 */

// Pin the inactivity-timer window to 5 minutes for these tests. They were
// written before the timeout became configurable (#3749) and their tick
// arithmetic assumes a 5-min window throughout. Overriding here keeps the
// test semantics local instead of bleeding the prod default (20 min) into
// every `mock.timers.tick(N * 60_000)` call.
const TEST_RESULT_TIMEOUT_MS = 5 * 60_000

function createSession(opts = {}) {
  return new SdkSession({ cwd: '/tmp', resultTimeoutMs: TEST_RESULT_TIMEOUT_MS, ...opts })
}

describe('SdkSession — inactivity timer pause/resume (#2831)', () => {
  let session

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    session = createSession()
    session._processReady = true
  })

  afterEach(() => {
    session?.destroy()
    mock.timers.reset()
  })

  describe('Option A: pause timer while permissions are pending', () => {
    it('does NOT fire inactivity timeout while a permission is pending', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))

      session._isBusy = true
      session._currentMessageId = 'msg-1'
      armResultTimeoutForTest(session, 'msg-1', false)

      // Request permission — PermissionManager emits permission_request,
      // SdkSession listener pauses the inactivity timer.
      const permPromise = session._handlePermission('Bash', { command: 'ls' }, null)

      // Advance PAST the permission manager's own 5-min auto-deny but
      // well before any renewed inactivity timer could fire after it
      // resolves. 4.5 min + auto-deny + resume at 5 min + no further
      // activity → inactivity timer re-arms at 5 min, fires at 10 min.
      mock.timers.tick(4 * 60_000 + 30_000)
      assert.equal(errors.length, 0, 'no inactivity-timeout error while permission pending')

      // Resolve the permission — listener resumes the timer
      session.respondToPermission(
        Array.from(session._pendingPermissions.keys())[0],
        'allow',
      )
      await permPromise
    })

    it('re-arms the inactivity timer when the last permission is resolved', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))

      // Simulate an in-flight message
      session._isBusy = true
      session._currentMessageId = 'msg-1'
      armResultTimeoutForTest(session, 'msg-1', false)

      // Pending permission — PermissionManager emits permission_request,
      // session listener pauses the inactivity timer.
      const permPromise = session._handlePermission('Bash', { command: 'ls' }, null)

      mock.timers.tick(4 * 60_000) // 4 min while paused

      // Resolve the permission — re-arms the timer for a fresh 5 min
      const reqId = Array.from(session._pendingPermissions.keys())[0]
      session.respondToPermission(reqId, 'allow')
      await permPromise

      // Advance 4 more minutes (total elapsed 8 min, but timer was re-armed 4 min ago)
      mock.timers.tick(4 * 60_000)
      assert.equal(errors.length, 0, 'timer should not have fired yet')

      // Advance 2 more minutes — total 6 min since re-arm → should fire
      mock.timers.tick(2 * 60_000)
      assert.equal(errors.length, 1, 'timer should fire 5 min after resume')
      assert.match(errors[0].message, /timed out/)
    })

    it('keeps timer paused while multiple permissions are pending', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))
      session._isBusy = true
      session._currentMessageId = 'msg-multi'
      armResultTimeoutForTest(session, 'msg-multi', false)

      // Two concurrent permission requests — each pauses via the
      // PermissionManager listener, so the ref-counted pause count hits 2.
      // We bump the PermissionManager timeout high enough that its own
      // auto-deny doesn't resolve the permissions during this test.
      session._permissions._timeoutMs = 60 * 60_000
      const p1 = session._handlePermission('Bash', { command: 'ls' }, null)
      const p2 = session._handlePermission('WebFetch', { url: 'https://x' }, null)

      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 0, 'no timeout while 2 permissions pending')

      // Resolve only the first — counter drops to 1, timer stays paused
      const keys = Array.from(session._pendingPermissions.keys())
      session.respondToPermission(keys[0], 'allow')
      await p1

      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 0, 'still paused: one permission remains')

      // Resolve the second — counter drops to 0, timer re-arms
      session.respondToPermission(keys[1], 'allow')
      await p2

      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 1, 'timer fires 5 min after last resolution')
    })
  })

  describe('Option B: on actual timeout, clean up orphaned permissions', () => {
    it('auto-denies any pending permission on true inactivity timeout', async () => {
      const errors = []
      const expired = []
      session.on('error', (d) => errors.push(d))
      session.on('permission_expired', (d) => expired.push(d))
      session._isBusy = true
      session._currentMessageId = 'msg-2'

      // Force-orphaned state: a pending permission exists but the pause
      // bookkeeping was dropped (shouldn't happen normally, but the
      // handler must still clean up). Bump the PermissionManager timeout
      // so its own auto-deny doesn't fire first.
      session._permissions._timeoutMs = 60 * 60_000
      armResultTimeoutForTest(session, 'msg-2', false)
      const permPromise = session._handlePermission('Bash', { command: 'rm -rf /' }, null)
      session._permissionPauseCount = 0
      session._resultTimeoutPaused = false
      session._resetResultTimeout()

      mock.timers.tick(5 * 60_000 + 100)

      const result = await permPromise
      assert.equal(result.behavior, 'deny', 'orphaned permission must be auto-denied')
      assert.equal(expired.length, 1, 'permission_expired must be emitted')
      assert.ok(expired[0].requestId, 'permission_expired must carry the requestId')

      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /timed out/)
    })

    it('clears message state after timeout even with pending permissions', async () => {
      session.on('error', () => {})
      session.on('permission_expired', () => {})

      session._isBusy = true
      session._currentMessageId = 'msg-3'
      armResultTimeoutForTest(session, 'msg-3', false)
      session._handlePermission('Bash', { command: 'ls' }, null)
      session._permissionPauseCount = 0
      session._resultTimeoutPaused = false
      session._resetResultTimeout()

      mock.timers.tick(5 * 60_000 + 100)

      assert.equal(session._isBusy, false, 'isBusy cleared')
      assert.equal(session._currentMessageId, null, 'message id cleared')
      assert.equal(session._pendingPermissions.size, 0, 'pending map cleared')
    })
  })

  describe('AskUserQuestion pauses timer too', () => {
    it('pauses the inactivity timer while an AskUserQuestion is pending', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))
      session._isBusy = true
      session._currentMessageId = 'msg-q'
      armResultTimeoutForTest(session, 'msg-q', false)

      // Bump the permission-manager timeout so its own auto-deny
      // doesn't fire during the test window.
      session._permissions._timeoutMs = 60 * 60_000

      const qPromise = session._handlePermission('AskUserQuestion', { questions: [{ question: 'A?' }] }, null)

      mock.timers.tick(6 * 60_000)
      assert.equal(errors.length, 0, 'no timeout while AskUserQuestion is pending')

      session.respondToQuestion('answer')
      await qPromise
    })
  })

  // #3757: The pre-existing tests above use a 5-min fixture and assume the
  // resume path re-arms with that window. After #3754 made resultTimeoutMs
  // configurable, the resume path must read this._resultTimeoutMs at
  // re-arm time — not a hardcoded constant. Pin that contract: a session
  // constructed with an unusual 90-second window must re-arm to 90 s after
  // permission resolution, not the default 20 min and not the legacy 5 min.
  describe('resume re-arms using configured resultTimeoutMs (#3757)', () => {
    const NINETY_S = 90_000

    it('re-armed timer fires at exactly the configured window, not a hardcoded 5/20 min', async () => {
      const s = new SdkSession({ cwd: '/tmp', resultTimeoutMs: NINETY_S })
      s._processReady = true
      const errors = []
      s.on('error', (d) => errors.push(d))

      try {
        s._isBusy = true
        s._currentMessageId = 'msg-cfg'
        armResultTimeoutForTest(s, 'msg-cfg', false)

        // Bump PermissionManager auto-deny so it doesn't resolve early.
        s._permissions._timeoutMs = 60 * 60_000

        const p = s._handlePermission('Bash', { command: 'ls' }, null)
        mock.timers.tick(10_000) // 10s while paused
        assert.equal(errors.length, 0, 'no fire while paused')

        // Resolve — re-arms a fresh 90-second window
        const reqId = Array.from(s._pendingPermissions.keys())[0]
        s.respondToPermission(reqId, 'allow')
        await p

        // 89.999s elapsed since resume → must NOT fire
        mock.timers.tick(NINETY_S - 1)
        assert.equal(errors.length, 0, 'timer must not fire 1ms before configured window')

        // 1ms more → must fire
        mock.timers.tick(1)
        assert.equal(errors.length, 1, 'timer must fire at exactly the configured 90s window')
        assert.match(errors[0].message, /timed out/)
      } finally {
        s.destroy()
      }
    })
  })
})
