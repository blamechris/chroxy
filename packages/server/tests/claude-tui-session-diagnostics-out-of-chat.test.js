import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

/**
 * #8252: an abnormal end of a claude-tui turn, a PTY exit and the respawn cap
 * each put ONE plain sentence in the chat's `error`, and the terminal tail --
 * cleaned of control-sequence debris -- in the daemon log instead.
 *
 * The cases the issue reproduced: Stop with prompts pending, a SIGTERM to the
 * session's claude child, and a flapping child.
 */

// What claude 2.1.x paints: private-mode CSI, save/restore cursor, cursor-forward
// as the space between words, the startup banner's block glyphs.
const PAINTED =
  '\x1b[?2004h\x1b7\x1b8\x1b[>0q\x1b[>4m\x1b[<u' +
  ' \x1b[38;5;174m▐▛███▜▌\x1b[39m   Claude Code v2.1.289\r\n' +
  '\x1b[38;5;174m▝▜█████▛▘\x1b[39m  Haiku 4.5 · Claude Max\r\n' +
  'Try "refactor <filepath>"\r\n' +
  'Use\x1b[2Cthe\x1b[2Csingle\x1b[2Cline\x1b[2Cto\x1b[2Cecho'

const ESCAPE_FRAGMENTS = [/\x1b/, /\[>0q/, /\[>4m/, /\[<u/, /\[2C/, /▐|▛|█|▜|▌|▝|▘/]

function assertNoTerminalDebris(text, label) {
  assert.equal(/TUI output tail/.test(text), false, `${label}: no "TUI output tail" in ${JSON.stringify(text)}`)
  for (const re of ESCAPE_FRAGMENTS) {
    assert.equal(re.test(text), false, `${label}: ${re} in ${JSON.stringify(text)}`)
  }
}

describe('claude-tui diagnostics stay out of the chat (#8252)', () => {
  let skillsDir
  let session
  let logLines
  const logSpy = (entry) => {
    if (entry.component === 'claude-tui-session') logLines.push({ level: entry.level, message: entry.message })
  }

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-diag-skills-'))
    logLines = []
    addLogListener(logSpy)
  })

  afterEach(async () => {
    removeLogListener(logSpy)
    mock.timers.reset()
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    rmSync(skillsDir, { recursive: true, force: true })
  })

  function makeSession(opts = {}) {
    return new ClaudeTuiSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null, resultTimeoutMs: 5000, hardTimeoutMs: 5000, ...opts })
  }

  function tailLog() {
    return logLines.find((l) => /TUI output tail/.test(l.message))
  }

  function assertCleanTailInLog() {
    const entry = tailLog()
    assert.ok(entry, `the tail went to the log; log was: ${JSON.stringify(logLines)}`)
    for (const re of ESCAPE_FRAGMENTS) assert.equal(re.test(entry.message), false, `${re} in the logged tail`)
    assert.ok(entry.message.includes('Use the single line to echo'), `cursor-forward became a space: ${JSON.stringify(entry.message)}`)
    assert.ok(entry.message.includes('Claude Code v2.1.289'))
  }

  // A session ready to run one turn whose PTY write is observable. `onWrite`
  // runs on the first write, i.e. after the turn is active.
  function turnSession(onWrite) {
    session = makeSession()
    session._processReady = true
    session._sessionId = 'sess-8252'
    const base = mkdtempSync(join(tmpdir(), 'chroxy-tui-diag-sink-'))
    session._sinkDir = join(base, 's-test')
    mkdirSync(session._sinkDir, { recursive: true, mode: 0o700 })
    session._waitForPrompt = async () => true
    session._appendToOutputTail(PAINTED)
    // The prompt write completes, THEN the turn is cut off: the poll loop is
    // what notices (a cut-off during the write has its own path, tested below).
    session._writePtyTextThrottled = async () => {
      onWrite(session)
      return true
    }
    session._term = { write: () => {}, kill: () => {}, pid: 4242 }
    return session
  }

  it('Stop with the turn in flight: the chat says "Stopped.", the cleaned tail is in the log', async () => {
    turnSession((s) => { s._activeTurn.aborted = true })
    const errors = []
    session.on('error', (e) => errors.push(e))

    // Unfake the clock for the poll loop's 150ms sleeps.
    mock.timers.reset()
    await session.sendMessage('Use the Bash tool to run exactly: echo f3')

    assert.equal(errors.length, 1, `one error, got ${JSON.stringify(errors)}`)
    assert.equal(errors[0].message, 'Stopped.')
    assertNoTerminalDebris(errors[0].message, 'stop')
    assertCleanTailInLog()
  })

  it('Stop DURING the prompt write says "Stopped." too', async () => {
    turnSession(() => {})
    session._writePtyTextThrottled = async (_text, { onAbort } = {}) => {
      session._activeTurn.aborted = true
      onAbort()
      return false
    }
    const errors = []
    session.on('error', (e) => errors.push(e))

    mock.timers.reset()
    await session.sendMessage('hello')

    assert.deepEqual(errors.map((e) => e.message), ['Stopped.'])
    assertCleanTailInLog()
  })

  it('the claude child is killed mid-turn: one plain sentence, no tail, no exit code', async () => {
    turnSession((s) => {
      s._ptyExited = true
      s._ptyExitInfo = { exitCode: 143, signal: 'SIGTERM' }
    })
    const errors = []
    session.on('error', (e) => errors.push(e))

    mock.timers.reset()
    await session.sendMessage('hello')

    const fatal = errors.find((e) => /exited/.test(e.message))
    assert.ok(fatal, `an exit error, got ${JSON.stringify(errors)}`)
    assert.equal(fatal.message, 'Claude exited mid-turn — restarting.')
    for (const e of errors) assertNoTerminalDebris(e.message, 'mid-turn exit')
    assertCleanTailInLog()
    assert.ok(logLines.some((l) => /exited mid-turn \(code=143 signal=SIGTERM\)/.test(l.message)), 'the exit code stays in the log')
  })

  it('the claude child dies with no turn in flight: one plain sentence, tail in the log', () => {
    session = makeSession()
    session._appendToOutputTail(PAINTED)
    const errors = []
    session.on('error', (e) => errors.push(e))

    session._onPtyGone({ exitCode: null, signal: null }, 'close')

    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'Claude exited — restarting.')
    assertNoTerminalDebris(errors[0].message, 'idle exit')
    assertCleanTailInLog()
  })

  it('the respawn cap: "kept exiting", the code is kept, no tail in the chat', () => {
    session = makeSession()
    session._appendToOutputTail(PAINTED)
    session._respawnCount = 5 // the next scheduling attempt is #6, past the cap
    const errors = []
    const exhausted = []
    session.on('error', (e) => errors.push(e))
    session.on('respawn_exhausted', (d) => exhausted.push(d))

    session._scheduleRespawn()

    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'pty_respawn_exhausted')
    assert.equal(errors[0].message, 'Claude kept exiting; stopped restarting it.')
    assertNoTerminalDebris(errors[0].message, 'respawn cap')
    assert.equal(exhausted.length, 1)
    assertCleanTailInLog()
  })

  it('the respawn rate cap says the same thing', () => {
    session = makeSession()
    session._appendToOutputTail(PAINTED)
    session._respawnRateLimiter.record = () => false
    const errors = []
    session.on('error', (e) => errors.push(e))

    session._scheduleRespawn()

    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'pty_respawn_exhausted')
    assert.equal(errors[0].message, 'Claude kept exiting; stopped restarting it.')
    assertNoTerminalDebris(errors[0].message, 'rate cap')
    assertCleanTailInLog()
  })

  it('a token echoed into the tail is redacted in the log (the redaction the chat copy had)', () => {
    session = makeSession()
    session._appendToOutputTail('login ok sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\x1b[1mBBBBBBBBBBBBBBBB\x1b[0m done')
    session.on('error', () => {})
    session._onPtyGone({ exitCode: 1, signal: null }, 'exit')
    const entry = tailLog()
    assert.ok(entry, 'tail logged')
    assert.equal(/sk-ant-oat01-A/.test(entry.message), false, `token leaked: ${entry.message}`)
    assert.equal(/BBBBBBBB/.test(entry.message), false, 'the part after the escape leaked too')
  })
})
