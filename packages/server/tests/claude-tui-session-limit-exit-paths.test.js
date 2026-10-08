import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #8441 (follow-up to #8400 / #8426 and #8252 / #8387): a usage limit that ENDS
 * claude, or ends a turn with no Stop payload, must still reach the chat as the
 * limit. #8387 moved the terminal tail (which carried the limit text) out of the
 * chat, so the two branches below said only "Claude exited mid-turn" / "Claude
 * exited" and the real reason lived in the log:
 *
 *   - the poll loop's no-Stop-payload branch (PTY exited mid-turn, or the loop
 *     ran out its hard timeout), and
 *   - `_onPtyGone`'s no-turn branch (claude exited at idle).
 *
 * Both now classify THIS turn's PTY output the way the stall handlers do, and
 * honour the same episode / repeat-notice rules. No real claude is spawned: the
 * PTY is a stub and the output is real-shaped rendering written into the tail.
 */

// What claude paints for a limit: a cursor-forward escape is the space between
// words (the same painting the #8252 tests use), the sentence is claude's own.
const PAINT = (s) => s.replace(/ /g, '\x1b[1C')
const SESSION_LIMIT = "You've hit your session limit · resets 11:30pm (America/Los_Angeles)"
const WEEKLY_LIMIT = "You've hit your weekly limit · resets Jul 22 at 4pm (America/Los_Angeles)"
const CREDITS_LIMIT = 'Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.'
const OVERLOAD = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'
const framed = (sentence) => `\x1b[?2004h\x1b7\x1b8\r\n\x1b[38;5;174m⏺\x1b[39m ${PAINT(sentence)}\r\n\x1b[2m? for shortcuts\x1b[0m`

const SESSION_MESSAGE = "Claude's session usage limit was reached. It resets 11:30pm (America/Los_Angeles); messages will not go through until then."
const SESSION_REPEAT = 'Still at the session usage limit — resets 11:30pm (America/Los_Angeles).'
const GENERIC_MID_TURN = 'Claude exited mid-turn — restarting.'
const GENERIC_IDLE = 'Claude exited — restarting.'

describe('claude-tui surfaces a usage limit from the exit paths (#8441)', () => {
  let skillsDir
  let sinkBase
  let session
  let mono

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-8441-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-8441-sink-'))
    mono = 1_000_000
  })

  afterEach(async () => {
    mock.timers.reset()
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(sinkBase, { recursive: true, force: true })
  })

  function makeSession(opts = {}) {
    // Hermetic on every host: a real `claude` on PATH would otherwise make the
    // pre-spawn login probe run `claude auth status` (#8412, #8448).
    const loginProbeRunner = async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' })
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null, loginProbeRunner,
      resultTimeoutMs: 5000, hardTimeoutMs: 5000, monotonicNow: () => mono, ...opts,
    })
    return session
  }

  // A session ready to run one turn. `onWrite` runs once the prompt is written,
  // i.e. after the turn is active and its PTY-output boundary is marked.
  function turnSession(onWrite) {
    const s = makeSession()
    s._processReady = true
    s._sessionId = 'sess-8441'
    s._sinkDir = join(sinkBase, 's-test')
    mkdirSync(s._sinkDir, { recursive: true, mode: 0o700 })
    s._waitForPrompt = async () => true
    s._writePtyTextThrottled = async () => { onWrite(s); return true }
    s._term = { write: () => {}, kill: () => {}, pid: 2 ** 30 } // a pid that names no process
    const errors = []
    s.on('error', (e) => errors.push(e))
    return { s, errors }
  }

  const exitMidTurn = (s, output) => {
    s._appendToOutputTail(output)
    s._ptyExited = true
    s._ptyExitInfo = { exitCode: 1, signal: null }
  }

  async function send(s) {
    mock.timers.reset() // the poll loop's 150ms sleeps are real
    return s.sendMessage('hello')
  }

  // --- the poll loop's no-Stop-payload branch ----------------------------------

  describe('PTY exits mid-turn after printing a limit', () => {
    const CASES = [
      ['session limit', SESSION_LIMIT, 'usage_limit', SESSION_MESSAGE],
      ['weekly limit', WEEKLY_LIMIT, 'usage_limit', "Claude's weekly usage limit was reached. It resets Jul 22 at 4pm (America/Los_Angeles); messages will not go through until then."],
      ['usage credits', CREDITS_LIMIT, 'usage_limit', 'Claude cannot run this model without usage credits. Switch to another model, or add usage credits, then send your message again.'],
      ['overload', OVERLOAD, 'api_overloaded', "Claude's API is overloaded (HTTP 529). Wait a moment, then send your message again."],
    ]
    for (const [name, sentence, code, message] of CASES) {
      it(`${name}: the chat says the limit, not "exited mid-turn"`, async () => {
        const { s, errors } = turnSession((x) => exitMidTurn(x, framed(sentence)))
        await send(s)
        assert.equal(errors.length, 1, `one error, got ${JSON.stringify(errors)}`)
        assert.equal(errors[0].code, code)
        assert.equal(errors[0].message, message)
      })
    }

    it('a narrow terminal that squeezes the words together is still the limit', async () => {
      const { s, errors } = turnSession((x) => exitMidTurn(x, "You'vehityoursessionlimit·resets11:30pm(America/Los_Angeles)"))
      await send(s)
      assert.deepEqual(errors.map((e) => e.message), [SESSION_MESSAGE])
    })

    it('the same limit again inside its window is the one-line notice (episode rules)', async () => {
      const { s, errors } = turnSession((x) => exitMidTurn(x, framed(SESSION_LIMIT)))
      await send(s)
      // The respawn brought claude back; the next turn hits the same limit and the PTY exits again.
      s._ptyExited = false
      s._processReady = true
      await send(s)
      assert.deepEqual(errors.map((e) => e.message), [SESSION_MESSAGE, SESSION_REPEAT])
      assert.deepEqual(errors.map((e) => e.code), ['usage_limit', 'usage_limit'])
    })

    it('CONTROL: an exit with unrelated output stays the generic sentence, with no code', async () => {
      const { s, errors } = turnSession((x) => exitMidTurn(x, framed('The rate limit is 100/min, so set a limit of 5 and see the usage limit docs; this resets the counter.')))
      await send(s)
      assert.deepEqual(errors.map((e) => e.message), [GENERIC_MID_TURN])
      assert.equal('code' in errors[0], false)
    })

    it('CONTROL: a limit printed BEFORE this turn is not this turn\'s limit', async () => {
      const { s, errors } = turnSession((x) => exitMidTurn(x, framed('Exited.')))
      s._appendToOutputTail(framed(SESSION_LIMIT)) // an earlier turn's banner, older than the turn boundary
      await send(s)
      assert.deepEqual(errors.map((e) => e.message), [GENERIC_MID_TURN])
    })

    it('CONTROL: a Stop the user asked for is never relabelled as a limit', async () => {
      const { s, errors } = turnSession((x) => {
        x._appendToOutputTail(framed(SESSION_LIMIT))
        x._activeTurn.aborted = true
      })
      await send(s)
      assert.deepEqual(errors.map((e) => e.message), ['Stopped.'])
      assert.equal('code' in errors[0], false)
    })

    it('CONTROL: a login failure still gets the dedicated auth error over a limit', async () => {
      const { s, errors } = turnSession((x) => exitMidTurn(x, '\r\nNot logged in · Please run /login\r\n' + framed(SESSION_LIMIT)))
      await send(s)
      assert.deepEqual(errors.map((e) => e.code), ['AUTH_REQUIRED'])
    })
  })

  describe('the poll loop gives up with no Stop payload', () => {
    // Nothing exited: the loop runs out its hard timeout with the turn still busy.
    // The loop captures its start AFTER the prompt write, so the injected clock
    // is advanced from inside the loop (its per-pass transcript auth check; the
    // transcript has nothing, which is the "transcript finds nothing" case).
    const timeoutAfterWrite = (output) => (x) => {
      x._appendToOutputTail(output)
      x._checkTranscriptForAuthFailure = () => { mono += x._hardTimeoutMs + 1; return false }
    }

    it('a limit on screen: the chat says the limit, not "did not finish responding"', async () => {
      const { s, errors } = turnSession(timeoutAfterWrite(framed(SESSION_LIMIT)))
      await send(s)
      assert.deepEqual(errors.map((e) => e.message), [SESSION_MESSAGE])
      assert.equal(errors[0].code, 'usage_limit')
    })

    it('CONTROL: the same timeout with unrelated output stays "did not finish responding"', async () => {
      const { s, errors } = turnSession(timeoutAfterWrite(framed('Still thinking about it.')))
      await send(s)
      assert.equal(errors.length, 1)
      assert.ok(/^Claude did not finish responding \(gave up after \d+s\)\.$/.test(errors[0].message), errors[0].message)
      assert.equal('code' in errors[0], false)
    })
  })

  // --- _onPtyGone's no-turn branch ---------------------------------------------

  describe('claude exits at idle after a turn ended on a limit', () => {
    // A turn has run on this PTY and printed the limit; no turn is in flight when it dies.
    const idleExit = (s, output) => {
      s._markTurnOutputStart()
      s._appendToOutputTail(output)
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      return errors
    }

    it('the chat says the limit, once, and the respawn still follows', () => {
      const s = makeSession()
      const errors = idleExit(s, framed(SESSION_LIMIT))
      assert.deepEqual(errors, [{ code: 'usage_limit', message: SESSION_MESSAGE }])
      assert.equal(s._respawnScheduled, true, 'the death still recovers')
    })

    it('a repeat inside the window is the one-line notice', () => {
      const s = makeSession()
      const first = idleExit(s, framed(SESSION_LIMIT))
      s._ptyExited = false
      s._respawnScheduled = false
      s._markTurnOutputStart()
      s._appendToOutputTail(framed(SESSION_LIMIT))
      const second = []
      s.on('error', (e) => second.push(e))
      s._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      assert.equal(first[0].message, SESSION_MESSAGE)
      assert.equal(second[0].message, SESSION_REPEAT)
    })

    it('CONTROL: an unrelated idle exit stays the generic sentence, with no code', () => {
      const s = makeSession()
      const errors = idleExit(s, framed('All done. The usage limit docs are in README.'))
      assert.deepEqual(errors, [{ message: GENERIC_IDLE }])
    })

    it('CONTROL: a limit banner in resumed history, before any turn ran on this PTY, is not a limit', () => {
      // `claude --resume` re-renders the old conversation, banner included; a crash
      // during warmup is then not "the limit" (the #8223 history class).
      const s = makeSession()
      s._appendToOutputTail(framed(SESSION_LIMIT))
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      assert.deepEqual(errors, [{ message: GENERIC_IDLE }])
    })

    it('CONTROL: a respawned PTY has no turn on it yet, so the previous PTY\'s turn does not count', () => {
      const s = makeSession()
      s._markTurnOutputStart() // a turn ran on the first PTY
      s._resetOutputForSpawn() // ...then claude was respawned and re-rendered history
      s._appendToOutputTail(framed(SESSION_LIMIT))
      const errors = []
      s.on('error', (e) => errors.push(e))
      s._onPtyGone({ exitCode: 1, signal: null }, 'exit')
      assert.deepEqual(errors, [{ message: GENERIC_IDLE }])
    })

    it('CONTROL: a login failure still gets the dedicated auth error over a limit', () => {
      const s = makeSession()
      const errors = idleExit(s, framed(SESSION_LIMIT) + '\r\nNot logged in · Run /login\r\n')
      assert.deepEqual(errors.map((e) => e.code), ['AUTH_REQUIRED'])
    })
  })
})
