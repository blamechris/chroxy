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
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

// Pin the inactivity-timer window to 5 minutes for these tests. They were
// written before the timeout became configurable (#3749) and their tick
// arithmetic assumes a 5-min window throughout. Overriding here keeps the
// test semantics local instead of bleeding the prod default (30 min as of
// #3884) into every `mock.timers.tick(N * 60_000)` call.
const TEST_RESULT_TIMEOUT_MS = 5 * 60_000

// #3899: pin the HARD-cap timeout to the same 5-min window. Pre-#3899
// the kill-on-timeout fired at `resultTimeoutMs`; post-#3899 the kill
// fires at `hardTimeoutMs` while `resultTimeoutMs` emits a soft warning.
// Setting them equal here preserves the existing test arithmetic
// (errors fire at the 5-min mark) and means the soft warning fires in
// the same tick as the hard kill. Tests that don't subscribe to
// `inactivity_warning` don't notice the extra event.
function createReadySession(opts = {}) {
  const session = new CliSession({
    cwd: '/tmp',
    resultTimeoutMs: TEST_RESULT_TIMEOUT_MS,
    hardTimeoutMs: TEST_RESULT_TIMEOUT_MS,
    ...opts,
  })
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

  // #3757: resume path must re-arm with this._resultTimeoutMs (not a
  // hardcoded constant). Construct a session with a 90-second window
  // (unusual, neither the legacy 5 min nor the current 30-min default) and
  // verify the re-armed timer honours that exact value.
  describe('resume re-arms using configured resultTimeoutMs (#3757)', () => {
    const NINETY_S = 90_000

    it('re-armed timer fires at exactly the configured window, not a hardcoded 5/30 min', async () => {
      // #3899: also pin hardTimeoutMs to the same window so the hard
      // kill (which is what emits the error) fires at the same 90s mark
      // as the soft warning. Without this override, createReadySession
      // would default hardTimeoutMs to TEST_RESULT_TIMEOUT_MS (5 min)
      // and the error wouldn't fire at 90s.
      const s = createReadySession({ resultTimeoutMs: NINETY_S, hardTimeoutMs: NINETY_S })
      const errors = []
      s.on('error', (d) => errors.push(d))

      try {
        await s.sendMessage('do something')
        assert.equal(s._isBusy, true)

        s.notifyPermissionPending('perm-cfg')
        mock.timers.tick(10_000)
        assert.equal(errors.length, 0, 'no fire while paused')

        s.notifyPermissionResolved('perm-cfg')

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

  // #3884: pre-fix the timer was wall-clock from sendMessage() to result,
  // so long-running CLI sessions emitting events the whole time still
  // got force-cleared after the window. The fix routes every parsed
  // stdout JSONL line through `_handleStdoutLine`, which calls
  // `_armResultTimeout()` before `_handleEvent`. SdkSession already had
  // this behaviour (sdk-session.js:554) — this test pins it for CLI.
  describe('inactivity timer resets on every parsed stdout event (#3884)', () => {
    it('does NOT fire timeout while stdout activity stays under the window', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))

      await session.sendMessage('do something')
      assert.ok(session._resultTimeout, 'timer armed by sendMessage')

      // Simulate four window-spans of continuous activity. Each iteration
      // ticks just under the window then feeds a parsed line through the
      // real production handler — that handler MUST call
      // _armResultTimeout(), or the cumulative tick (4× window) would have
      // long since fired the timeout.
      const ALMOST_WINDOW = TEST_RESULT_TIMEOUT_MS - 30_000
      for (let i = 0; i < 4; i++) {
        mock.timers.tick(ALMOST_WINDOW)
        session._handleStdoutLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"."}}}')
        assert.equal(errors.length, 0, `no timeout fired after activity iteration ${i + 1} (cumulative ${(i + 1) * ALMOST_WINDOW / 60_000} min)`)
      }

      // After the last activity, one full window of true silence should
      // fire the timeout. This validates we still catch genuine hangs.
      mock.timers.tick(TEST_RESULT_TIMEOUT_MS + 100)
      assert.equal(errors.length, 1, 'timer must fire after a full window of silence following last activity')
      assert.match(errors[0].message, /timed out/)
    })

    it('skips reset on blank lines and JSON-parse failures', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))

      await session.sendMessage('do something')

      // Tick to 1ms before expiry — any reset would push the deadline out.
      mock.timers.tick(TEST_RESULT_TIMEOUT_MS - 1)

      // Blank line: no reset. Parse failure: no reset.
      session._handleStdoutLine('')
      session._handleStdoutLine('   ')
      session._handleStdoutLine('not json at all { broken')

      // 1ms more → timer fires exactly at the original deadline, proving
      // none of those calls reset it.
      mock.timers.tick(1)
      assert.equal(errors.length, 1, 'timer must fire — blank/unparseable lines must not reset')
    })

    it('does NOT reset while the timer is paused for a pending permission', async () => {
      const errors = []
      session.on('error', (d) => errors.push(d))

      await session.sendMessage('do something')
      session.notifyPermissionPending('perm-xyz')
      assert.equal(session._resultTimeout, null, 'timer cleared while paused')

      // An activity event arriving while paused must not arm a fresh
      // timer — that would defeat the pause (and re-fire after the
      // permission resolves, potentially mid-tool-result).
      session._handleStdoutLine('{"type":"stream_event"}')
      assert.equal(session._resultTimeout, null, 'still null — _armResultTimeout no-op while paused')

      mock.timers.tick(TEST_RESULT_TIMEOUT_MS + 10_000)
      assert.equal(errors.length, 0, 'no timeout fires while paused, regardless of stdout activity')
    })
  })

  // #3899: SOFT inactivity warning is the new pre-kill prompt — fires at
  // `resultTimeoutMs` (default 30 min), emits an `inactivity_warning`
  // event WITHOUT clearing busy state or pending permissions. The HARD
  // cap (`hardTimeoutMs`, default 2h) is the existing kill path. The
  // pause/resume tests above all set both timeouts to the same window
  // (via createReadySession's helper) so the error fires at the same
  // tick as the soft warning. These tests pin the soft-vs-hard
  // distinction explicitly by using different windows.
  describe('soft inactivity warning + hard cap (#3899)', () => {
    // 1-min soft, 3-min hard. Soft must fire at 60s emitting
    // inactivity_warning + leaving the session alive; hard must fire at
    // 180s emitting the existing error + clearing state.
    const SOFT = 60_000
    const HARD = 3 * 60_000

    it('soft warning fires at resultTimeoutMs WITHOUT clearing busy state', async () => {
      const s = createReadySession({ resultTimeoutMs: SOFT, hardTimeoutMs: HARD })
      const warnings = []
      const errors = []
      s.on('inactivity_warning', (d) => warnings.push(d))
      s.on('error', (d) => errors.push(d))
      try {
        await s.sendMessage('long running task')
        assert.equal(s._isBusy, true)

        mock.timers.tick(SOFT - 1)
        assert.equal(warnings.length, 0, 'soft must not fire 1ms before window')

        mock.timers.tick(1)
        assert.equal(warnings.length, 1, 'soft fires at exactly resultTimeoutMs')
        assert.equal(warnings[0].prefab, 'Status update?')
        assert.equal(warnings[0].idleMs, SOFT)
        assert.equal(s._isBusy, true, 'session stays busy after soft warning')
        assert.equal(errors.length, 0, 'no error emitted on soft warning')
      } finally {
        s.destroy()
      }
    })

    it('hard cap fires at hardTimeoutMs and clears state (pre-#3899 behavior preserved)', async () => {
      const s = createReadySession({ resultTimeoutMs: SOFT, hardTimeoutMs: HARD })
      const warnings = []
      const errors = []
      s.on('inactivity_warning', (d) => warnings.push(d))
      s.on('error', (d) => errors.push(d))
      try {
        await s.sendMessage('totally stuck task')

        // After the SOFT fires the session keeps going. The HARD fires
        // HARD ms after sendMessage with no activity in between.
        mock.timers.tick(HARD - 1)
        assert.equal(warnings.length, 1, 'soft fired in the middle')
        assert.equal(errors.length, 0, 'hard not yet')

        mock.timers.tick(1)
        assert.equal(errors.length, 1, 'hard fires at exactly hardTimeoutMs')
        assert.match(errors[0].message, /timed out/)
        assert.equal(s._isBusy, false, 'busy state cleared by hard')
      } finally {
        s.destroy()
      }
    })

    it('activity in the silent stretch resets BOTH soft and hard', async () => {
      const s = createReadySession({ resultTimeoutMs: SOFT, hardTimeoutMs: HARD })
      const warnings = []
      const errors = []
      s.on('inactivity_warning', (d) => warnings.push(d))
      s.on('error', (d) => errors.push(d))
      try {
        await s.sendMessage('chatty agent')

        // Tick just before soft would fire, then activity → resets both
        mock.timers.tick(SOFT - 1_000)
        s._handleStdoutLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"."}}}')

        // Now full HARD - 1_000 has effectively passed in the original
        // timer's eyes, but both timers were reset → starting fresh.
        // Tick to the new SOFT window from the activity.
        mock.timers.tick(SOFT - 1)
        assert.equal(warnings.length, 0, 'soft must not fire — activity reset the timer')

        mock.timers.tick(1)
        assert.equal(warnings.length, 1, 'soft fires at SOFT ms after the activity, not original sendMessage')
        assert.equal(errors.length, 0, 'still no error — hard hasnt fired yet')
      } finally {
        s.destroy()
      }
    })

    it('permission pause clears BOTH timers; resume re-arms both', async () => {
      const s = createReadySession({ resultTimeoutMs: SOFT, hardTimeoutMs: HARD })
      const warnings = []
      const errors = []
      s.on('inactivity_warning', (d) => warnings.push(d))
      s.on('error', (d) => errors.push(d))
      try {
        await s.sendMessage('asking for permission')
        s.notifyPermissionPending('perm-cap')
        assert.equal(s._resultTimeout, null, 'soft cleared on pause')
        assert.equal(s._hardTimeout, null, 'hard cleared on pause')

        // Long pause — neither fires
        mock.timers.tick(HARD * 2)
        assert.equal(warnings.length, 0)
        assert.equal(errors.length, 0)

        s.notifyPermissionResolved('perm-cap')
        // After resume, soft fires at SOFT ms, hard at HARD ms — both
        // re-armed fresh from the moment of resolution
        mock.timers.tick(SOFT)
        assert.equal(warnings.length, 1, 'soft re-armed and fired')
        assert.equal(errors.length, 0)

        mock.timers.tick(HARD - SOFT)
        assert.equal(errors.length, 1, 'hard re-armed and fired')
      } finally {
        s.destroy()
      }
    })

    // Edge case raised in PR #3901 review (Copilot): the soft timer is
    // scheduled in `_armResultTimeout` and self-nulls its own field on
    // fire, but the closure captures whatever `this._currentMessageId`
    // is AT FIRE TIME. If `_clearMessageState` ran between scheduling
    // and firing (unlikely in production — `_isBusy` would also be
    // false and the handler early-returns — but possible if a future
    // refactor decouples them), the handler should not crash and the
    // emitted event should still be schema-valid.
    it('handles _handleInactivityWarning gracefully when _currentMessageId is null', async () => {
      const s = createReadySession({ resultTimeoutMs: SOFT, hardTimeoutMs: HARD })
      const warnings = []
      s.on('inactivity_warning', (d) => warnings.push(d))
      try {
        await s.sendMessage('something')
        // Force the no-message-id state while keeping busy true so the
        // handler's `if (!this._isBusy) return` guard doesn't short-circuit.
        s._currentMessageId = null
        // Call the handler directly — same path the soft timer would
        // take when it fires.
        s._handleInactivityWarning()
        assert.equal(warnings.length, 1, 'event still emitted')
        assert.equal(warnings[0].messageId, null, 'messageId is null, not undefined or crashed')
        assert.equal(warnings[0].prefab, 'Status update?')
        assert.equal(warnings[0].idleMs, SOFT)
      } finally {
        s.destroy()
      }
    })
  })
})
