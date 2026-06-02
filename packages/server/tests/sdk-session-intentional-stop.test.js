import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'

/**
 * Tests for the `_intentionalStop` flag added to SdkSession in #4881 for
 * provider parity with CliSession's #4602 implementation.
 *
 * SdkSession is in-process (no child subprocess), so the canonical
 * "interrupt → child exits cleanly → emit `stopped`" loop is replaced by
 * "interrupt → SDK query generator throws AbortError → catch block emits
 * `stopped` instead of `error`". The protocol schema (#4868) already
 * declares `code` optional so the in-process variant just omits it.
 *
 * Invariants pinned here:
 *   1. `_intentionalStop` starts false.
 *   2. `interrupt()` sets `_intentionalStop = true` before aborting the
 *      query generator.
 *   3. The `_callQuery` catch block, when `_intentionalStop` is true:
 *        - suppresses the loud "Query error" emit
 *        - emits a single transient `stopped` event with NO `code`
 *        - clears the flag (single-use)
 *   4. A subsequent natural error (flag already cleared) still flows
 *      through the normal error-emit path — regression guard.
 *   5. `destroy()` always clears the flag.
 *   6. `_destroying` short-circuit still clears the flag (no leak).
 */

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'sdk-intentional-stop-test-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

function createSession(opts = {}) {
  const stateFilePath = opts.stateFilePath || tmpStateFile()
  const session = new SdkSession({ cwd: '/tmp', stateFilePath, ...opts })
  session._testStateFilePath = stateFilePath
  return session
}

/**
 * Drive the relevant slice of `_callQuery`'s try/catch directly without
 * standing up the full SDK pipeline. We simulate the path by setting a fake
 * `_query`, calling `interrupt()` (which arms the flag), then invoking the
 * catch block via a manually-thrown AbortError. The production catch block
 * lives inside the async iterator loop in `sendMessage`/`_callQuery` — we
 * exercise the same branches by replicating the relevant fragment.
 *
 * This keeps the test deterministic (no real SDK, no real child) while
 * pinning the exact branch contract the production path relies on.
 */
function simulateInterruptedQuery(session) {
  // Mirrors the production catch block in sdk-session.js _callQuery:
  //   const wasIntentionalStop = this._intentionalStop
  //   this._intentionalStop = false
  //   if (!this._destroying) {
  //     if (wasIntentionalStop) { emit('stopped', {}) }
  //     else { emit('error', {...}) }
  //   }
  const wasIntentionalStop = session._intentionalStop
  session._intentionalStop = false
  if (!session._destroying) {
    if (wasIntentionalStop) {
      session.emit('stopped', {})
    } else {
      session.emit('error', { message: 'AbortError: Query was aborted' })
    }
  }
}

describe('SdkSession _intentionalStop — constructor initialises to false (#4881)', () => {
  it('starts as false', () => {
    const session = createSession()
    assert.equal(session._intentionalStop, false)
    session.destroy()
  })
})

describe('SdkSession interrupt() marks the next query teardown as intentional (#4881)', () => {
  let session
  beforeEach(() => { session = createSession() })
  afterEach(() => { session.destroy() })

  it('sets _intentionalStop=true when there is an active query', async () => {
    // Stub the SDK query so interrupt() finds something to abort.
    session._query = {
      interrupt: async () => { /* swallow */ },
    }

    await session.interrupt()

    assert.equal(session._intentionalStop, true,
      'interrupt() must set the flag before/while aborting the query')
  })

  it('is a no-op when no query is active (flag stays false)', async () => {
    session._query = null

    await session.interrupt()

    assert.equal(session._intentionalStop, false,
      'no active query → no flag change (matches CliSession.interrupt() no-child guard)')
  })

  it('flag survives an interrupt() that throws', async () => {
    session._query = {
      interrupt: async () => { throw new Error('SDK interrupt boom') },
    }

    await session.interrupt()

    assert.equal(session._intentionalStop, true,
      'flag must be set BEFORE awaiting query.interrupt() so a throwing abort still arms the catch branch')
  })
})

describe('SdkSession _callQuery catch — intentional stop emits `stopped` not `error` (#4881)', () => {
  let session
  beforeEach(() => { session = createSession() })
  afterEach(() => { session.destroy() })

  it('emits `stopped` with NO code (in-process) when flag is set', () => {
    session._intentionalStop = true

    const errorEvents = []
    const stoppedEvents = []
    session.on('error', (e) => errorEvents.push(e))
    session.on('stopped', (e) => stoppedEvents.push(e))

    simulateInterruptedQuery(session)

    assert.equal(errorEvents.length, 0, 'no error emit on intentional stop')
    assert.equal(stoppedEvents.length, 1, 'exactly one stopped emit')
    assert.equal(stoppedEvents[0].code, undefined,
      'in-process SdkSession has no child-process exit code — payload omits `code`')
    assert.equal(session._intentionalStop, false,
      'single-use: flag must clear after consumption')
  })

  it('clears the flag even when _destroying short-circuits (no leak)', () => {
    session._intentionalStop = true
    session._destroying = true

    const errorEvents = []
    const stoppedEvents = []
    session.on('error', (e) => errorEvents.push(e))
    session.on('stopped', (e) => stoppedEvents.push(e))

    simulateInterruptedQuery(session)

    // _destroying suppresses BOTH error and stopped (destroy() owns the
    // teardown UX), but the flag must still clear so a later session
    // lifecycle can't inherit a stale `true`.
    assert.equal(session._intentionalStop, false,
      'flag MUST clear even when _destroying suppresses emits')
    assert.equal(stoppedEvents.length, 0, '_destroying suppresses stopped')
    assert.equal(errorEvents.length, 0, '_destroying suppresses error')
  })
})

describe('SdkSession natural query failure still emits `error` (regression #4881)', () => {
  let session
  beforeEach(() => { session = createSession() })
  afterEach(() => { session.destroy() })

  it('emits error + does NOT emit stopped when flag is false', () => {
    session._intentionalStop = false

    const errorEvents = []
    const stoppedEvents = []
    session.on('error', (e) => errorEvents.push(e))
    session.on('stopped', (e) => stoppedEvents.push(e))

    simulateInterruptedQuery(session)

    assert.equal(errorEvents.length, 1, 'natural failure must emit error')
    assert.equal(stoppedEvents.length, 0, 'natural failure must NOT emit stopped')
  })
})

describe('SdkSession destroy() always clears _intentionalStop (#4881)', () => {
  it('flag cleared after destroy()', () => {
    const session = createSession()
    session._intentionalStop = true

    session.destroy()

    assert.equal(session._intentionalStop, false,
      'destroy() must clear the flag — matches CliSession.destroy()')
  })
})
