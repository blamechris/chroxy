import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { AUTH_REQUIRED_MESSAGE } from '../src/claude-tui/pty-driver.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'

/**
 * #8223 — an EXPIRED claude login is invisible to the PTY scan: `claude auth
 * status` still says loggedIn:true, claude paints no "Not logged in" footer at
 * startup, and at a narrow PTY (the dashboard Chat tab's 10x6, #8254) it never
 * paints the "Please run /login" banner either — only "Retrying in 1s". What it
 * DOES do, at any width, is write the failed API call to the session transcript
 * as a structured entry (`isApiErrorMessage` + `error: 'authentication_failed'`).
 * While a turn has produced no output, the hook-poll loop reads that transcript
 * (throttled) and tears the turn down with AUTH_REQUIRED as soon as the count of
 * such entries rises above the count captured at turn start.
 *
 * Every test runs the real `sendMessage` poll loop (or, for the unit-level ones,
 * the real `_checkTranscriptForAuthFailure`) against a fixture per-PID session
 * file + transcript under a temp HOME — the pattern
 * claude-tui-session-observed-model.test.js uses — so no real claude, PTY or
 * `~/.claude` is touched. The first-output watchdog is set to 5s throughout and
 * the throttle shrunk to 0, so nothing here waits anywhere near 90s.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('ClaudeTuiSession — expired login from the transcript (#8223)', () => {
  let fakeHome
  let origHome
  let origUserProfile
  let fakePid
  let fakeCwd
  let session
  let skillsDir
  let sinkBase

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-authfast-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    // A pid that cannot name a real process (destroy() arms a real SIGKILL
    // escalation against `_term.pid`).
    fakePid = 2 ** 30
    fakeCwd = join(tmpdir(), 'chroxy-8223-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-authfast-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-authfast-sink-base-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    for (const d of [fakeHome, skillsDir, sinkBase]) if (d) rmSync(d, { recursive: true, force: true })
  })

  // --- fixtures -------------------------------------------------------------

  function writeSessFile(pid = fakePid, sessionId = 'sess-8223') {
    const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
    writeFileSync(path, JSON.stringify({ pid, sessionId, cwd: fakeCwd, startedAt: Date.now() }))
    return path
  }

  function writeJournal(sessFile, lines) {
    const transcriptPath = transcriptPathForSessionFile(sessFile)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
    return transcriptPath
  }

  function appendJournal(transcriptPath, lines) {
    appendFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
  }

  const userLine = (text = 'hi') => JSON.stringify({ type: 'user', timestamp: '2026-06-10T02:39:59.000Z', message: { role: 'user', content: text } })

  const authErrorLine = (ts = '2026-06-10T02:40:00.000Z') => JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'authentication_failed',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: 'Please run /login · API Error: 401 OAuth access token is invalid.' }],
    },
  })

  const assistantTextLine = (text) => JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-10T02:40:00.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  })

  /** A session wired for a real `sendMessage` poll loop: fixture pid + sink dir, throttle 0, first-output watchdog 5s. */
  function makeTurnSession(ctorOpts = {}) {
    const s = new ClaudeTuiSession({
      cwd: fakeCwd, skillsDir, repoSkillsDir: null,
      resultTimeoutMs: 8000, hardTimeoutMs: 8000, streamStallTimeoutMs: 8000, firstOutputTimeoutMs: 5000,
      ...ctorOpts,
    })
    session = s
    s._processReady = true
    s._sessionId = 'test-8223'
    const sinkDir = join(sinkBase, 's-test')
    mkdirSync(sinkDir, { recursive: true, mode: 0o700 })
    s._sinkDir = sinkDir
    s._waitForPrompt = async () => true
    s._authTranscriptScanMs = 0
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    const events = { errors: [], results: [], streamEnds: [], reasons: [], writes: [], scans: 0 }
    // Counts every transcript read, so a negative test can wait for N poll passes
    // to have happened instead of sleeping for a guessed time.
    const realScan = s._scanTranscript.bind(s)
    s._scanTranscript = () => { events.scans++; return realScan() }
    s.on('error', (e) => events.errors.push(e))
    s.on('result', (e) => events.results.push(e))
    s.on('stream_end', (e) => events.streamEnds.push(e))
    s._term.write = (b) => events.writes.push(b)
    const origTeardown = s._teardownTurn.bind(s)
    s._teardownTurn = (reason, opts) => { events.reasons.push(reason); return origTeardown(reason, opts) }
    return { s, events, sinkDir }
  }

  // Poll a condition instead of sleeping a guessed time: CI load cannot make it
  // flake early, and the happy path finishes as soon as the condition holds.
  async function waitFor(predicate, what, { timeoutMs = 3000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`)
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  // The turn is busy and has captured its baseline: the poll loop is running.
  const turnPolling = (s) => s._isBusy && s._authFailureBaseline !== null
  // At least `n` more transcript reads (one per poll pass, with the throttle at 0).
  async function afterScans(events, n, what) {
    const target = events.scans + n
    await waitFor(() => events.scans >= target, what)
  }
  const finishTurn = (sinkDir, name = 'stop-done.json') =>
    writeFileSync(join(sinkDir, name), JSON.stringify({ last_assistant_message: 'ok' }))

  // --- the fast path --------------------------------------------------------

  it('tears a busy, pre-first-output turn down with AUTH_REQUIRED well before the first-output timeout', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine('earlier turn')])
    const { s, events } = makeTurnSession()

    const startedAt = Date.now()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    assert.equal(s._isBusy, true, 'precondition: the turn is busy and has produced no output')
    assert.equal(s._firstOutputDisarmed, false, 'precondition: no first output yet')
    appendJournal(transcript, [authErrorLine()])
    await turn
    const elapsed = Date.now() - startedAt

    assert.ok(elapsed < 3000, `fast path fired in ${elapsed}ms, far inside the 5000ms first-output timeout`)
    assert.deepEqual(events.reasons, ['auth_required'], 'its own teardown reason, not first_output_timeout')
    assert.equal(events.errors.length, 1)
    assert.equal(events.errors[0].code, 'AUTH_REQUIRED')
    assert.equal(events.errors[0].message, AUTH_REQUIRED_MESSAGE)
    assert.equal(events.errors[0].timeoutMs, undefined, 'an auth error is not a stall')
    assert.equal(events.results.length, 1, 'result is emitted (before the error) so the client leaves the busy state')
    assert.equal(events.streamEnds.length, 1, 'stream_end gated on messageId, like the watchdog')
    assert.ok(events.writes.includes('\x03'), 'Ctrl-C written into the PTY, like every teardown')
    assert.equal(s._isBusy, false)
    assert.equal(s._firstOutputTimeout, null, 'the 90s watchdog was disarmed by the teardown')
  })

  it('also fires when the transcript did not exist at turn start (a fresh session\'s first turn)', async () => {
    const sessFile = writeSessFile()
    const { s, events } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    assert.equal(s._authFailureBaseline, 0, 'a transcript that does not exist yet baselines at a known 0')
    writeJournal(sessFile, [userLine(), authErrorLine()])
    await turn
    assert.deepEqual(events.errors.map((e) => e.code), ['AUTH_REQUIRED'])
    assert.deepEqual(events.reasons, ['auth_required'])
  })

  // The poll loop breaks unconditionally after calling the handler, so the handler
  // must always end the turn: a guard that returned early would strand `_isBusy`
  // with nobody polling, and the turn would end as "Stop hook timeout". (An early
  // return on `_pendingUserAnswers` used to sit here; it was unreachable behind the
  // pre-first-output gate and is gone.)
  it('_handleTranscriptAuthFailure always tears the turn down, even with an answer slot pending', () => {
    const { s, events } = makeTurnSession()
    s._isBusy = true
    s._currentMessageId = 'msg-auth-direct'
    s._activeTurn = { startedAt: s._nowMonotonic() - 5, aborted: false }
    s._pendingUserAnswers.set('toolu_question', { toolUseId: 'toolu_question' })
    s._handleTranscriptAuthFailure()
    assert.equal(s._isBusy, false, 'the turn is over, so the caller\'s break leaves nothing stranded')
    assert.deepEqual(events.errors.map((e) => e.code), ['AUTH_REQUIRED'])
    assert.deepEqual(events.reasons, ['auth_required'])
  })

  // --- negatives ------------------------------------------------------------

  it('does not fire for an auth-failure entry that was already in the transcript before the turn', async () => {
    const sessFile = writeSessFile()
    writeJournal(sessFile, [userLine('old turn'), authErrorLine('2026-06-09T10:00:00.000Z')])
    const { s, events, sinkDir } = makeTurnSession()

    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    await afterScans(events, 2, 'two poll passes to have re-read the transcript')
    assert.equal(s._authFailureBaseline, 1, 'the old entry is part of the baseline')
    assert.equal(s._isBusy, true, 'still waiting — the old failure did not tear the turn down')
    finishTurn(sinkDir)
    await turn

    assert.deepEqual(events.errors, [])
    assert.deepEqual(events.reasons, [])
    assert.equal(events.results.length, 1, 'the turn completed normally')
  })

  it('does not fire for an entry appended AFTER first output — the fast path is pre-first-output only', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events, sinkDir } = makeTurnSession()

    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    // First output: a consumed hook file disarms the first-output latch.
    const hook = (name) => writeFileSync(join(sinkDir, name), JSON.stringify({ tool_use_id: `toolu_${name}`, tool_name: 'Bash', tool_input: { command: 'ls' } }))
    hook('pre-a.json')
    await waitFor(() => s._firstOutputDisarmed === true, 'the first hook to be consumed (first output)')
    appendJournal(transcript, [authErrorLine()])
    // Two more hooks consumed after the append: the second one proves the poll pass that
    // consumed the first has fully finished (including its transcript check, were it ungated).
    hook('pre-b.json')
    await waitFor(() => !existsSync(join(sinkDir, 'pre-b.json')), 'a hook consumed after the append')
    hook('pre-c.json')
    await waitFor(() => !existsSync(join(sinkDir, 'pre-c.json')), 'a second hook consumed after the append')
    assert.equal(s._isBusy, true, 'the turn is untouched by a failure that arrives after first output')
    finishTurn(sinkDir)
    await turn

    assert.deepEqual(events.errors, [])
    assert.deepEqual(events.reasons, [])
  })

  it('does not fire for a normal assistant reply whose TEXT says "Please run /login · API Error"', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events, sinkDir } = makeTurnSession()

    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    appendJournal(transcript, [
      assistantTextLine('If you see "Please run /login · API Error: 401 OAuth access token is invalid." re-authenticate.'),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'slow down' }] } }),
    ])
    await afterScans(events, 2, 'two poll passes to have read the appended entries')
    assert.equal(s._isBusy, true)
    finishTurn(sinkDir)
    await turn

    assert.deepEqual(events.errors, [])
    assert.deepEqual(events.reasons, [])
  })

  // --- baseline, cadence, fail-quiet ----------------------------------------

  describe('_checkTranscriptForAuthFailure', () => {
    it('baselines on the first scan that can read the transcript, so an old entry never fires', () => {
      const { s } = makeTurnSession()
      // No per-PID session file yet: the scanner cannot be resolved.
      s._beginAuthFailureWatchForTurn()
      assert.equal(s._authFailureBaseline, null, 'nothing readable at turn start — no baseline guessed')

      const sessFile = writeSessFile()
      const transcript = writeJournal(sessFile, [userLine(), authErrorLine('2026-06-09T10:00:00.000Z')])
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false, 'the first readable scan baselines; it never fires')
      assert.equal(s._authFailureBaseline, 1)

      appendJournal(transcript, [authErrorLine()])
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), true, 'a NEW entry above the baseline fires')
    })

    it('a baseline is per turn: the next turn starts from the count then', () => {
      const sessFile = writeSessFile()
      const transcript = writeJournal(sessFile, [userLine()])
      const { s } = makeTurnSession()
      s._beginAuthFailureWatchForTurn()
      appendJournal(transcript, [authErrorLine()])
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), true)

      s._beginAuthFailureWatchForTurn() // next turn
      assert.equal(s._authFailureBaseline, 1)
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false, 'the previous turn\'s failure is not this turn\'s')
    })

    it('fails quiet: no pid, no transcript, an unreadable transcript, or a throwing scan all mean "no fast path"', () => {
      const { s } = makeTurnSession()
      // no PTY pid
      s._term = { write: () => {}, kill: () => {} }
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false)
      // pid but no per-PID session file
      s._term = { pid: fakePid, write: () => {}, kill: () => {} }
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false)
      assert.equal(s._authFailureBaseline, null)
      // session file but no transcript yet: a known 0, never a fire
      writeSessFile()
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false)
      assert.equal(s._authFailureBaseline, 0)
      // a scan that throws
      s._scanTranscript = () => { throw new Error('boom') }
      assert.doesNotThrow(() => s._checkTranscriptForAuthFailure({ force: true }))
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false)
    })

    it('does not baseline against an unreadable transcript (count unknown)', () => {
      const sessFile = writeSessFile()
      const transcript = transcriptPathForSessionFile(sessFile)
      mkdirSync(transcript, { recursive: true }) // a DIRECTORY where the .jsonl should be → EISDIR, not ENOENT
      const { s } = makeTurnSession()
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false)
      assert.equal(s._authFailureBaseline, null)
    })

    it('scans at most once per interval, on the monotonic clock', () => {
      let mono = 1000
      const { s } = makeTurnSession({ monotonicNow: () => mono })
      s._authTranscriptScanMs = 1000
      const sessFile = writeSessFile()
      writeJournal(sessFile, [userLine()])
      let scans = 0
      const real = s._scanTranscript.bind(s)
      s._scanTranscript = () => { scans++; return real() }

      s._lastAuthTranscriptScanMs = mono
      s._checkTranscriptForAuthFailure()
      mono += 400
      s._checkTranscriptForAuthFailure()
      mono += 400
      s._checkTranscriptForAuthFailure()
      assert.equal(scans, 0, 'inside the interval: no scan')

      mono += 400 // 1200ms since the last scan
      s._checkTranscriptForAuthFailure()
      assert.equal(scans, 1)
      mono += 500
      s._checkTranscriptForAuthFailure()
      assert.equal(scans, 1, 'throttled again right after a scan')
      mono += 600
      s._checkTranscriptForAuthFailure()
      assert.equal(scans, 2)
    })

    it('does not disturb the background-task poll: the shared scanner stays cumulative and no bookkeeping moves', () => {
      const sessFile = writeSessFile()
      const launch = JSON.stringify({
        type: 'assistant', timestamp: '2026-06-10T02:39:05.423Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg1', name: 'Bash', input: { description: 'watching', run_in_background: true } }] },
      })
      const transcript = writeJournal(sessFile, [launch])
      const { s } = makeTurnSession()

      // The idle poll's view: one outstanding task, key committed by a broadcast.
      const first = s.getBackgroundTaskSnapshot()
      assert.equal(first.backgroundTasks.length, 1)
      const keyBefore = s._lastBackgroundTaskKey
      s._stopBackgroundTaskPoll()

      // The task completes while a turn is polling for auth failures.
      const completion = JSON.stringify({
        type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-10T02:39:40.819Z',
        content: '<task-notification>\n<tool-use-id>toolu_bg1</tool-use-id>\n<status>completed</status>\n</task-notification>',
      })
      appendJournal(transcript, [completion])
      assert.equal(s._checkTranscriptForAuthFailure({ force: true }), false)
      assert.equal(s._lastBackgroundTaskKey, keyBefore, 'the auth check must not advance the broadcast baseline')

      // The next poll tick reads the same scanner: the completion consumed above still shows,
      // so the key differs and the indicator-clearing broadcast is not lost.
      const next = s._transcriptTaskScanner.scan()
      assert.deepEqual(next.backgroundTasks, [])
      assert.notEqual(s._backgroundTaskKey(next), keyBefore)
    })
  })
})
