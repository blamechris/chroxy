import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'

/**
 * #8400 — a usage limit never reaches the Stop hook: claude renders "You've hit
 * your session limit · resets 11:30pm (America/Los_Angeles)", writes the same
 * thing to the transcript as a structured `isApiErrorMessage` / `rate_limit`
 * entry, and returns to its prompt. Chroxy used to sit until the 90s first-output
 * watchdog and then say "No response ... Try sending again.", which is wrong:
 * retrying cannot work until the limit resets (and since #8387 the terminal tail
 * is out of the chat, so the real reason was in the log only).
 *
 * The hook-poll loop now reads the transcript (throttled), and the stall /
 * first-output handlers read this turn's PTY output, and the turn ends with ONE
 * plain message carrying the reset time. A repeat of the same limit (the user
 * sends again) ends the turn without a second message.
 *
 * Same fixture pattern as claude-tui-session-transcript-auth.test.js: a real
 * `sendMessage` poll loop against a per-PID session file + transcript under a
 * temp HOME, no real claude, PTY or ~/.claude.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('ClaudeTuiSession — usage limit surfaced in the chat (#8400)', () => {
  let fakeHome
  let origHome
  let origUserProfile
  let fakePid
  let fakeCwd
  let session
  let skillsDir
  let sinkBase

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-limit-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    // A pid that cannot name a real process (destroy() arms a real SIGKILL
    // escalation against `_term.pid`).
    fakePid = 2 ** 30
    fakeCwd = join(tmpdir(), 'chroxy-8400-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-limit-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-limit-sink-base-'))
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

  function writeSessFile(pid = fakePid, sessionId = 'sess-8400') {
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
    s._sessionId = 'test-8400'
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

  const limitLine = (text = "You've hit your session limit \u00b7 resets 11:30pm (America/Los_Angeles)", { error = 'rate_limit', status = 429, ts = '2026-06-10T02:40:00.000Z' } = {}) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    isApiErrorMessage: true,
    error,
    apiErrorStatus: status,
    timestamp: ts,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
  })
  const WEEKLY = "You've hit your weekly limit \u00b7 resets Jul 22 at 4pm (America/Los_Angeles)"
  const SESSION_REPEAT = 'Still at the session usage limit \u2014 resets 11:30pm (America/Los_Angeles).'
  const SESSION_MESSAGE = "Claude's session usage limit was reached. It resets 11:30pm (America/Los_Angeles); messages will not go through until then."

  const hook = (sinkDir, name) => writeFileSync(join(sinkDir, name), JSON.stringify({ tool_use_id: `toolu_${name}`, tool_name: 'Bash', tool_input: { command: 'ls' } }))

  // --- the transcript fast path ---------------------------------------------

  it('ends a busy, pre-first-output turn with ONE plain usage-limit message, far inside the first-output timeout', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine('earlier turn')])
    const { s, events } = makeTurnSession()

    const startedAt = Date.now()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    appendJournal(transcript, [limitLine()])
    await turn
    const elapsed = Date.now() - startedAt

    assert.ok(elapsed < 3000, `fired in ${elapsed}ms, inside the 5000ms first-output timeout`)
    assert.deepEqual(events.reasons, ['usage_limit'], 'its own teardown reason, not first_output_timeout')
    assert.equal(events.errors.length, 1)
    assert.equal(events.errors[0].code, 'usage_limit')
    assert.equal(events.errors[0].message, SESSION_MESSAGE)
    assert.equal(events.errors[0].timeoutMs, undefined, 'a limit is not a stall')
    assert.equal(events.results.length, 1, 'result emitted so the client leaves the busy state')
    assert.equal(events.streamEnds.length, 1)
    assert.ok(events.writes.includes('\x03'), 'Ctrl-C into the PTY, like every teardown')
    assert.equal(s._isBusy, false)
    assert.equal(s._firstOutputTimeout, null, 'the 90s watchdog was disarmed')
  })

  it('also fires MID-turn, after tools have already produced output', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events, sinkDir } = makeTurnSession()

    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    hook(sinkDir, 'pre-a.json')
    await waitFor(() => s._firstOutputDisarmed === true, 'first output')
    appendJournal(transcript, [limitLine(WEEKLY)])
    await turn

    assert.deepEqual(events.reasons, ['usage_limit'])
    assert.equal(events.errors.length, 1)
    assert.ok(events.errors[0].message.startsWith("Claude's weekly usage limit was reached. It resets Jul 22 at 4pm (America/Los_Angeles)"), events.errors[0].message)
  })

  it('says overloaded for a 529 and rate-limited for a bare 429, each with its own code', async () => {
    for (const [line, code, word] of [
      [limitLine('API Error: 529 Overloaded. This is a server-side issue.', { error: 'server_error', status: 529 }), 'api_overloaded', /overloaded/],
      [limitLine('API Error: 429 rate_limit_error', { error: 'rate_limit', status: 429 }), 'api_rate_limit', /rate limit/],
    ]) {
      const sessFile = writeSessFile()
      const transcript = writeJournal(sessFile, [userLine()])
      const { s, events } = makeTurnSession()
      const turn = s.sendMessage('hi')
      await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
      appendJournal(transcript, [line])
      await turn
      assert.deepEqual(events.errors.map((e) => e.code), [code])
      assert.ok(word.test(events.errors[0].message), events.errors[0].message)
      await session.destroy(); session = null
    }
  })

  it('the Stop hook wins: a delivered response is not replaced by a limit seen in the same pass', async () => {
    const sessFile = writeSessFile()
    writeJournal(sessFile, [userLine()])
    const { s, events, sinkDir } = makeTurnSession()
    const deltas = []
    s.on('stream_delta', (d) => deltas.push(d.delta))
    // The transcript reports a limit exactly once the Stop file has been drained, i.e. in the
    // SAME poll pass that found the Stop. (A real entry written next to the Stop would race the
    // drain's readdir; this pins the ordering instead of the timing.)
    const stopFile = join(sinkDir, 'stop-done.json')
    s._checkTranscriptForUsageLimit = () => (existsSync(stopFile) ? null : { kind: 'session', code: 'usage_limit', message: 'x', episodeKey: 'k' })
    // Not busy-polling yet: arm the stub only once the Stop is on disk.
    const armed = s._checkTranscriptForUsageLimit
    s._checkTranscriptForUsageLimit = (...a) => (stopWritten ? armed(...a) : null)
    let stopWritten = false

    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    finishTurn(sinkDir)
    stopWritten = true
    await turn

    assert.deepEqual(events.errors, [])
    assert.deepEqual(events.reasons, [])
    assert.deepEqual(deltas, ['ok'])
  })

  // --- episodes: one full card per limit window, a one-line notice per repeat --

  it('a repeat of the same limit ends the turn with ONE short notice, not the full card; a successful turn re-arms it', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events, sinkDir } = makeTurnSession()

    // Turn 1 hits the limit: the message.
    let turn = s.sendMessage('one')
    await waitFor(() => turnPolling(s), 'turn 1 baseline')
    appendJournal(transcript, [limitLine()])
    await turn
    assert.equal(events.errors.length, 1)

    // Turn 2, same limit: the turn ends with a one-line notice (never silence), not the card again.
    turn = s.sendMessage('two')
    await waitFor(() => turnPolling(s), 'turn 2 baseline')
    appendJournal(transcript, [limitLine()])
    await turn
    assert.deepEqual(events.reasons, ['usage_limit', 'usage_limit'], 'the repeat turn ended through the same teardown')
    assert.equal(events.errors.length, 2, 'exactly one notice for the second send')
    assert.equal(events.errors[1].code, 'usage_limit', 'same code, so clients treat it alike')
    assert.equal(events.errors[1].message, SESSION_REPEAT)
    assert.ok(events.errors[1].message.length < events.errors[0].message.length, 'shorter than the full card')
    assert.equal(events.results.length, 2, 'and the client left the busy state')
    assert.equal(s._isBusy, false)

    // Turn 3 is answered normally: the episode is over.
    turn = s.sendMessage('three')
    await waitFor(() => turnPolling(s), 'turn 3 baseline')
    finishTurn(sinkDir, 'stop-3.json')
    await turn
    assert.equal(s._usageLimitEpisode, null)

    // Turn 4 hits a limit again: a new episode, a new message.
    turn = s.sendMessage('four')
    await waitFor(() => turnPolling(s), 'turn 4 baseline')
    appendJournal(transcript, [limitLine()])
    await turn
    assert.equal(events.errors.length, 3, 'a new episode gets the full card again')
    assert.equal(events.errors[2].message, SESSION_MESSAGE)
  })

  it('the same kind with a different reset time is a different episode: the full card, not the notice', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events } = makeTurnSession()
    let turn = s.sendMessage('one')
    await waitFor(() => turnPolling(s), 'turn 1 baseline')
    appendJournal(transcript, [limitLine()])
    await turn
    turn = s.sendMessage('two')
    await waitFor(() => turnPolling(s), 'turn 2 baseline')
    appendJournal(transcript, [limitLine("You've hit your session limit \u00b7 resets 4:10am (America/Los_Angeles)")])
    await turn
    assert.equal(events.errors.length, 2)
    assert.equal(events.errors[1].message, "Claude's session usage limit was reached. It resets 4:10am (America/Los_Angeles); messages will not go through until then.")
  })

  it('a different kind is a different episode', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events } = makeTurnSession()
    let turn = s.sendMessage('one')
    await waitFor(() => turnPolling(s), 'turn 1 baseline')
    appendJournal(transcript, [limitLine()])
    await turn
    turn = s.sendMessage('two')
    await waitFor(() => turnPolling(s), 'turn 2 baseline')
    appendJournal(transcript, [limitLine(WEEKLY)])
    await turn
    assert.equal(events.errors.length, 2)
    assert.ok(/weekly/.test(events.errors[1].message))
    assert.ok(!events.errors[1].message.startsWith('Still'))
  })

  it('the full card comes back once the episode window has passed', () => {
    let mono = 1_000_000
    const { s } = makeTurnSession({ monotonicNow: () => mono })
    const limit = { kind: 'session', code: 'usage_limit', message: SESSION_MESSAGE, repeatMessage: 'REPEAT', episodeKey: 'session|11:30pm (America/Los_Angeles)' }
    assert.equal(s._usageLimitPayload(limit).message, SESSION_MESSAGE)
    mono += s._usageLimitEpisodeMs - 1
    assert.equal(s._usageLimitPayload(limit).message, 'REPEAT', 'inside the window: the short notice')
    mono += 2
    assert.equal(s._usageLimitPayload(limit).message, SESSION_MESSAGE, 'after the window: said in full again')
  })

  it('a transient failure (overload) has no episode: every failed turn says so', () => {
    const { s } = makeTurnSession()
    const overloaded = { kind: 'overloaded', code: 'api_overloaded', message: 'FULL', repeatMessage: 'REPEAT', episodeKey: null }
    assert.equal(s._usageLimitPayload(overloaded).message, 'FULL')
    assert.equal(s._usageLimitPayload(overloaded).message, 'FULL', 'every failed request is said in full')
  })

  // --- negatives ------------------------------------------------------------

  it('does not fire for a limit entry that was already in the transcript before the turn', async () => {
    const sessFile = writeSessFile()
    writeJournal(sessFile, [userLine('old turn'), limitLine()])
    const { s, events, sinkDir } = makeTurnSession()

    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    await afterScans(events, 2, 'two poll passes')
    assert.equal(s._usageLimitBaseline, 1, 'the old entry is part of the baseline')
    assert.equal(s._isBusy, true)
    finishTurn(sinkDir)
    await turn

    assert.deepEqual(events.errors, [])
    assert.deepEqual(events.reasons, [])
  })

  it('does not fire for a normal reply that quotes the words, an auth failure, or a 500', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events, sinkDir } = makeTurnSession()

    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    appendJournal(transcript, [
      assistantTextLine("You've hit your session limit \u00b7 resets 3pm"),
      limitLine('API Error: 500 Internal server error.', { error: 'server_error', status: 500 }),
      limitLine('slow down', { error: 'invalid_request', status: null }),
    ])
    await afterScans(events, 2, 'two poll passes over the appended entries')
    assert.equal(s._isBusy, true)
    finishTurn(sinkDir)
    await turn

    assert.deepEqual(events.errors, [])
    assert.deepEqual(events.reasons, [])
  })

  it('an auth failure still wins over a limit entry in the same pass', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userLine()])
    const { s, events } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be busy with a baseline')
    appendJournal(transcript, [authErrorLine(), limitLine()])
    await turn
    assert.deepEqual(events.errors.map((e) => e.code), ['AUTH_REQUIRED'])
  })

  // --- the stall / first-output handlers (PTY text, transcript unavailable) --

  describe('when the transcript cannot be read, the stall handlers read this turn\'s PTY output', () => {
    function busy(extra) {
      const { s, events } = makeTurnSession(extra)
      s._term = { write: () => {}, kill: () => {} } // no pid: no transcript
      s._isBusy = true
      s._currentMessageId = 'msg-limit'
      s._activeTurn = { startedAt: s._nowMonotonic() - 100, aborted: false }
      s._markTurnOutputStart()
      return { s, events }
    }

    it('_handleFirstOutputTimeout says the limit, with the reset time, instead of "No response ... try again"', () => {
      const { s, events } = busy()
      s._appendToOutputTail("You've hit your session limit \u00b7 resets 11:30pm (America/Los_Angeles)")
      s._handleFirstOutputTimeout()
      assert.deepEqual(events.errors.map((e) => e.code), ['usage_limit'])
      assert.equal(events.errors[0].message, SESSION_MESSAGE)
      assert.deepEqual(events.reasons, ['first_output_timeout'])
    })

    it('_handleStreamStall does too, even from a narrow terminal where every cursor move was deleted', () => {
      const { s, events } = busy()
      s._appendToOutputTail("You've\x1b[1Chit\x1b[1Cyour\x1b[1Csession\x1b[1Climit\x1b[1C\u00b7\x1b[1Cresets\x1b[1C11:30pm\x1b[1C(America/Los_Angeles)")
      s._handleStreamStall()
      assert.deepEqual(events.errors.map((e) => e.code), ['usage_limit'])
      assert.equal(events.errors[0].message, SESSION_MESSAGE)
    })

    it('a repeat in the stall handler ends the turn with the one-line notice', () => {
      const { s, events } = busy()
      s._appendToOutputTail("You've hit your session limit \u00b7 resets 11:30pm (America/Los_Angeles)")
      s._handleStreamStall()
      assert.equal(events.errors.length, 1)
      s._isBusy = true
      s._currentMessageId = 'msg-limit-2'
      s._activeTurn = { startedAt: s._nowMonotonic() - 100, aborted: false }
      s._markTurnOutputStart()
      s._appendToOutputTail("You've hit your session limit \u00b7 resets 11:30pm (America/Los_Angeles)")
      s._handleStreamStall()
      assert.equal(events.errors.length, 2, 'one notice for the second send')
      assert.equal(events.errors[1].message, SESSION_REPEAT)
      assert.equal(s._isBusy, false, 'and the turn ended')
    })

    it('ordinary output that mentions a limit is still an ordinary stall', () => {
      const { s, events } = busy()
      s._appendToOutputTail('The rate limit for this endpoint is 100 requests per minute; set a limit of 5.')
      s._handleStreamStall()
      assert.deepEqual(events.errors.map((e) => e.code), ['stream_stall'])
    })

    it('limit text printed BEFORE this turn (resumed history) does not turn a stall into a limit', () => {
      const { s, events } = makeTurnSession()
      s._term = { write: () => {}, kill: () => {} }
      s._appendToOutputTail("You've hit your session limit \u00b7 resets 11:30pm (America/Los_Angeles)")
      s._isBusy = true
      s._currentMessageId = 'msg-limit'
      s._activeTurn = { startedAt: s._nowMonotonic() - 100, aborted: false }
      s._markTurnOutputStart()
      s._handleStreamStall()
      assert.deepEqual(events.errors.map((e) => e.code), ['stream_stall'])
    })

    it('source, diffs and logs the session shows do not make a stall a limit (bare identifiers)', () => {
      for (const shown of [
        "throw new Error('rate_limit_error: too many requests')",
        '+ { test: /overloaded_error/i, msg: "overloaded" }',
        "expect(err.message).toMatch('API Error: 529')",
        "const e = 'API Error: 429'",
      ]) {
        const { s, events } = busy()
        s._appendToOutputTail(shown)
        s._handleStreamStall()
        assert.deepEqual(events.errors.map((e) => e.code), ['stream_stall'], shown)
      }
    })

    it('claude\'s own API-error sentence still counts on the PTY path', () => {
      const { s, events } = busy()
      s._appendToOutputTail('API Error: 529 Overloaded. This is a server-side issue, usually temporary \u2014 try again in a moment.')
      s._handleStreamStall()
      assert.deepEqual(events.errors.map((e) => e.code), ['api_overloaded'])
    })

    it('an auth banner still wins over limit text in the same output', () => {
      const { s, events } = busy()
      s._appendToOutputTail("You've hit your session limit \u00b7 resets 3pm. Invalid API key \u00b7 Please run /login")
      s._handleStreamStall()
      assert.deepEqual(events.errors.map((e) => e.code), ['AUTH_REQUIRED'])
    })
  })
})
