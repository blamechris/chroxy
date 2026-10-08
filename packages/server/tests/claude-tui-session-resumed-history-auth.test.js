import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { AUTH_REQUIRED_MESSAGE } from '../src/claude-tui/pty-driver.js'
import { pinTmpDaemonBase } from './helpers/pin-tmp-daemon-base.js'

/**
 * #8223 — `claude --resume <id>` re-renders the conversation's history at
 * startup, INCLUDING a past API-error banner. A PTY capture of `claude --resume`
 * on a session whose last turn hit the 401 (no prompt sent) holds
 * `Pleaserun/login·APIError` and does NOT hold the live footer `Notloggedin·Run/login`.
 * The warmup auth scan used to match banners, so a user whose login expired —
 * who then ran `claude auth login` and restored the session — had it refused as
 * "not logged in" on EVERY restore, forever, because its history always holds
 * the banner. Warmup is now footer-only, and the turn-time scans (stall /
 * first-output timeout) look only at the bytes THIS turn produced.
 *
 * Two warmup defences, tested separately. FOOTER-ONLY (round 3): the footer scan
 * never matches a message banner. PROBE GATE (round 4): when the pre-spawn probe
 * positively answered `loggedIn: true`, the footer scan is skipped altogether, so a
 * resumed conversation that merely QUOTES "Not logged in · Run /login" is not
 * refused either. The footer-only tests therefore run with an INCONCLUSIVE probe
 * (the footer scan stays on, so only the footer-only restriction can save them);
 * the gate tests run with a positive one.
 *
 * The warmup tests run the REAL `start()` / `_respawnPty()` / `_spawnPty` /
 * `_waitForPrompt` against a fake node-pty (the `_ptyModOverride` seam) that
 * delivers its bytes the moment `onData` is registered — so they are in the tail
 * before the first poll, the way a `--resume` replays history — plus a fixture
 * per-PID session file reporting `idle`, under a temp HOME. The login probe's
 * runner is injected, so no real claude runs. The turn tests run the real
 * `sendMessage` poll loop with the first-output watchdog at 150ms.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

const HISTORY_WITH_BANNERS = [
  '\x1b[38;5;220m⏺\x1b[39m \x1b[38;5;220mPlease run /login · API Error: 401 OAuth access token is invalid.\x1b[39m\r\x1b[1B',
  '\x1b[38;5;220m⏺\x1b[39m \x1b[38;5;220mLogin expired · Please run /login\x1b[39m\r\x1b[1B',
].join('')
// The no-credentials TURN banner (not the footer): history can hold it too.
const BANNER_NO_CREDS = '  ⎿  \x1b[38;5;211mNot logged in · Please run /login\r\x1b[1B'
// The live footer claude paints from its first frame when it holds no credentials.
const FOOTER_LOGGED_OUT = '\x1b[93G\x1b[38;5;211mNot\x1b[97Glogged\x1b[104Gin\x1b[107G·\x1b[109GRun\x1b[113G/login\x1b[39m\r\r\n'
// A live expired-login banner at the dashboard Chat tab's 10-column PTY (#8254).
const BANNER_EXPIRED_10COL = ['⏺ Login', '\x1b[2Cexpired ·', '\x1b[2CPlease', '\x1b[2Crun', '\x1b[2C/login'].join('\r\x1b[1B')
const BANNER_EXPIRED_120COL = '\r\x1b[1B\x1b[38;5;220m⏺\x1b[39m \x1b[38;5;220mPlease run /login · API Error: 401 OAuth access token is invalid.\x1b[39m\x1b[K\r\x1b[2C\x1b[1B\x1b[K'

// #8352 — these tests run the REAL start(), which mkdirs under
// `ClaudeTuiSession.SINK_BASE`. The real one belongs to a live daemon that
// validates its dev/ino, so pin it to a per-test temp base (the sandbox guard
// in `_setup.mjs` throws CHROXY_TEST_SANDBOX if a test touches the real one).
let unpinSinkBase
beforeEach(() => { unpinSinkBase = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE') })
afterEach(() => { if (unpinSinkBase) unpinSinkBase(); unpinSinkBase = null })

describe('ClaudeTuiSession — resumed history is not a login failure (#8223)', () => {
  let fakeHome
  let origHome
  let origUserProfile
  let fakeCwd
  let skillsDir
  let sinkBase
  let session
  const fakePid = 2 ** 30
  const RESUME_ID = 'resume-uuid-8223'

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-history-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    fakeCwd = mkdtempSync(join(tmpdir(), 'chroxy-tui-history-cwd-'))
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-history-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-history-sink-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    for (const d of [fakeHome, fakeCwd, skillsDir, sinkBase]) if (d) rmSync(d, { recursive: true, force: true })
  })

  const writeIdleSessionFile = (sessionId) =>
    writeFileSync(join(fakeHome, '.claude', 'sessions', `${fakePid}.json`), JSON.stringify({ pid: fakePid, sessionId, cwd: fakeCwd, status: 'idle' }))

  /** A node-pty stand-in whose bytes are in the tail before `_waitForPrompt` first looks. */
  function fakePty(bytes) {
    const term = {
      pid: fakePid,
      write: () => {},
      kill: () => {},
      onExit: () => {},
      on: () => {},
      onData: (cb) => { if (bytes) cb(bytes) },
    }
    return { spawn: () => term }
  }

  // The pre-spawn probe's answer: 'logged_in' (exit 0, loggedIn:true) or 'inconclusive'
  // (the runner throws, the fail-open shape every non-answer takes).
  function makeResumedSession({ bytes = '', probe = 'inconclusive' } = {}) {
    const probeCalls = []
    const s = new ClaudeTuiSession({
      cwd: fakeCwd, skillsDir, repoSkillsDir: null, resumeSessionId: RESUME_ID,
      loginProbeRunner: async (call) => {
        probeCalls.push(call)
        if (probe === 'logged_in') return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }
        throw new Error('probe could not run')
      },
    })
    s._probeCalls = probeCalls
    session = s
    s._ptyModOverride = fakePty(bytes)
    const events = { errors: [], readys: [], exhausted: [] }
    s.on('error', (e) => events.errors.push(e))
    s.on('ready', (e) => events.readys.push(e))
    s.on('respawn_exhausted', (e) => events.exhausted.push(e))
    writeIdleSessionFile(RESUME_ID)
    return { s, events }
  }

  // --- warmup ---------------------------------------------------------------

  it('start() resolves, and nothing latches, when warmup shows re-rendered history with banners and no footer', async () => {
    const { s, events } = makeResumedSession({ bytes: HISTORY_WITH_BANNERS })
    await s.start()
    assert.equal(s._authFailureDetected, false, 'history banners must not latch an auth failure')
    assert.equal(s._processReady, true)
    assert.equal(events.readys.length, 1, 'the restored session became ready')
    assert.deepEqual(events.errors.filter((e) => e.code === 'AUTH_REQUIRED'), [])
  })

  it('start() resolves when the only banner in the tail is the no-credentials TURN banner ("Not logged in · Please run /login")', async () => {
    const { s, events } = makeResumedSession({ bytes: BANNER_NO_CREDS })
    await s.start()
    assert.equal(s._authFailureDetected, false)
    assert.equal(events.readys.length, 1)
    assert.deepEqual(events.errors, [])
  })

  it('start() still rejects with AUTH_REQUIRED on the live footer (the warmup backstop is unchanged)', async () => {
    const { s, events } = makeResumedSession({ bytes: FOOTER_LOGGED_OUT })
    await assert.rejects(s.start(), (err) => err.code === 'AUTH_REQUIRED' && err.message === AUTH_REQUIRED_MESSAGE)
    assert.equal(events.readys.length, 0)
    assert.deepEqual(events.errors.map((e) => e.code), ['AUTH_REQUIRED'])
  })

  it('start() still rejects when the footer sits BEHIND resumed history', async () => {
    const { s } = makeResumedSession({ bytes: HISTORY_WITH_BANNERS + FOOTER_LOGGED_OUT })
    await assert.rejects(s.start(), (err) => err.code === 'AUTH_REQUIRED')
  })

  it('the post-timeout fallback in _spawnPty is footer-only too', async () => {
    // No session file → never ready → the in-loop scan and then the fallback scan decide.
    const { s } = makeResumedSession({ bytes: HISTORY_WITH_BANNERS })
    rmSync(join(fakeHome, '.claude', 'sessions', `${fakePid}.json`), { force: true })
    const realWait = s._waitForPrompt.bind(s)
    s._waitForPrompt = (_ms, opts) => realWait(300, opts) // do not wait the real warmup budget
    await s.start()
    assert.equal(s._authFailureDetected, false)
    assert.equal(s._term !== null, true)
  })

  it('a respawn whose warmup re-renders history is marked ready, not exhausted as logged out', async () => {
    const { s, events } = makeResumedSession()
    await s.start()
    assert.equal(events.readys.length, 1)

    s._ptyExited = true // the PTY died; the respawn replays the conversation
    s._ptyModOverride = fakePty(HISTORY_WITH_BANNERS)
    await s._respawnPty()

    assert.equal(events.readys.length, 2, 'the respawned session became ready again')
    assert.deepEqual(events.exhausted, [])
    assert.deepEqual(events.errors.filter((e) => e.code === 'AUTH_REQUIRED'), [])
    assert.equal(s._authFailureDetected, false)
  })

  it('a respawn whose warmup shows the live footer still stops with AUTH_REQUIRED (#5355 M2 unchanged)', async () => {
    const { s, events } = makeResumedSession()
    await s.start()
    s._ptyExited = true
    s._ptyModOverride = fakePty(FOOTER_LOGGED_OUT)
    await s._respawnPty()
    assert.deepEqual(events.errors.map((e) => e.code).filter((c) => c === 'AUTH_REQUIRED'), ['AUTH_REQUIRED'])
    assert.deepEqual(events.exhausted.map((e) => e.reason), ['AUTH_REQUIRED'])
    assert.equal(events.readys.length, 1, 'no second ready on a logged-out respawn')
  })

  // --- the probe gate (round 4) ---------------------------------------------

  // A resumed conversation that QUOTES the footer (a session about this very issue)
  // re-renders it from history at warmup. After a positive probe that can only be
  // history, so the footer scan is off.
  const HISTORY_QUOTING_FOOTER = HISTORY_WITH_BANNERS + FOOTER_LOGGED_OUT

  it('probe loggedIn:true + a footer re-rendered from history at warmup: start() resolves and nothing latches', async () => {
    const { s, events } = makeResumedSession({ bytes: HISTORY_QUOTING_FOOTER, probe: 'logged_in' })
    await s.start()
    assert.equal(s._loginProbeOutcome, 'logged_in')
    assert.equal(s._authFailureDetected, false)
    assert.equal(events.readys.length, 1, 'the restored session became ready')
    assert.deepEqual(events.errors, [])
  })

  it('probe inconclusive + the footer at warmup still rejects AUTH_REQUIRED (the backstop)', async () => {
    const { s, events } = makeResumedSession({ bytes: HISTORY_QUOTING_FOOTER, probe: 'inconclusive' })
    await assert.rejects(s.start(), (err) => err.code === 'AUTH_REQUIRED')
    assert.equal(s._loginProbeOutcome, 'unknown')
    assert.equal(events.readys.length, 0)
  })

  it('the native route skips the probe, so the outcome stays unknown and the footer backstop stays on', async () => {
    const { s } = makeResumedSession({ bytes: FOOTER_LOGGED_OUT, probe: 'logged_in' })
    s._connectionAuthRoute = 'native'
    await s._probeLoginBeforeFirstSpawn({ binary: '/fixture/claude', cwd: fakeCwd, env: {} })
    assert.equal(s._probeCalls.length, 0)
    assert.equal(s._loginProbeOutcome, 'unknown')
    s._appendToOutputTail(FOOTER_LOGGED_OUT)
    assert.equal(s._scanWarmupOutputForAuthFailure(), true)
  })

  it('a respawn with the probe recorded as logged_in + the footer in history is marked ready', async () => {
    const { s, events } = makeResumedSession({ probe: 'logged_in' })
    await s.start()
    assert.equal(s._loginProbeOutcome, 'logged_in')
    assert.equal(events.readys.length, 1)

    s._ptyExited = true
    s._ptyModOverride = fakePty(HISTORY_QUOTING_FOOTER)
    await s._respawnPty()

    assert.equal(events.readys.length, 2)
    assert.deepEqual(events.exhausted, [])
    assert.deepEqual(events.errors.filter((e) => e.code === 'AUTH_REQUIRED'), [])
    assert.equal(s._probeCalls.length, 1, 'the outcome is kept across respawns: the probe is not re-run')
    assert.equal(s._loginProbeOutcome, 'logged_in')
  })

  it('a respawn after an INCONCLUSIVE probe still stops on the live footer', async () => {
    const { s, events } = makeResumedSession({ probe: 'inconclusive' })
    await s.start()
    s._ptyExited = true
    s._ptyModOverride = fakePty(FOOTER_LOGGED_OUT)
    await s._respawnPty()
    assert.deepEqual(events.exhausted.map((e) => e.reason), ['AUTH_REQUIRED'])
  })

  it('the no-turn PTY-death scan is gated too: a footer in history after a positive probe is just a PTY exit', () => {
    const { s, events } = makeResumedSession({ probe: 'logged_in' })
    s._loginProbeOutcome = 'logged_in'
    s._appendToOutputTail(HISTORY_QUOTING_FOOTER)
    s._onPtyGone({ exitCode: 1, signal: null }, 'exit') // no active turn
    assert.equal(events.errors.some((e) => e.code === 'AUTH_REQUIRED'), false)
    assert.ok(events.errors.some((e) => /Claude PTY exited/.test(e.message)))
  })

  it('the gate leaves the TURN-time scans alone: a live footer printed during a turn still reads as logged out', () => {
    const { s } = makeResumedSession({ probe: 'logged_in' })
    s._loginProbeOutcome = 'logged_in'
    s._markTurnOutputStart()
    s._appendToOutputTail(FOOTER_LOGGED_OUT)
    assert.equal(s._scanTurnOutputForAuthFailure(), true)
  })

  // --- turn time ------------------------------------------------------------

  describe('turn-time scans see only this turn\'s output', () => {
    function makeTurnSession() {
      const s = new ClaudeTuiSession({
        cwd: fakeCwd, skillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000, firstOutputTimeoutMs: 150,
      })
      session = s
      s._processReady = true
      s._sessionId = 'turn-8223'
      const sinkDir = join(sinkBase, 's-test')
      mkdirSync(sinkDir, { recursive: true, mode: 0o700 })
      s._sinkDir = sinkDir
      s._waitForPrompt = async () => true
      const errors = []
      s.on('error', (e) => errors.push(e))
      let onFirstWrite = null
      let wrote = false
      s._term = {
        write: () => {
          if (!wrote && onFirstWrite) { wrote = true; onFirstWrite() }
        },
        kill: () => {},
      }
      return { s, errors, duringTurn: (fn) => { onFirstWrite = fn } }
    }

    it('history in the tail BEFORE the turn started + a first-output timeout is a stream_stall, not AUTH_REQUIRED', async () => {
      const { s, errors } = makeTurnSession()
      s._appendToOutputTail(HISTORY_WITH_BANNERS) // a --resume re-rendered this before the user sent anything
      await s.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.equal(errors[0].code, 'stream_stall')
      assert.match(errors[0].message, /No response from claude TUI within/)
      assert.equal(errors[0].timeoutMs, 150)
    })

    it('a banner printed AFTER the turn started + a first-output timeout is AUTH_REQUIRED', async () => {
      const { s, errors, duringTurn } = makeTurnSession()
      duringTurn(() => s._appendToOutputTail(BANNER_EXPIRED_120COL))
      await s.sendMessage('hi')
      assert.deepEqual(errors.map((e) => e.code), ['AUTH_REQUIRED'])
      assert.equal(errors[0].message, AUTH_REQUIRED_MESSAGE)
    })

    it('...including the 10-column wrapped form, and with history already in the tail', async () => {
      const { s, errors, duringTurn } = makeTurnSession()
      s._appendToOutputTail(HISTORY_WITH_BANNERS)
      duringTurn(() => s._appendToOutputTail(BANNER_EXPIRED_10COL))
      await s.sendMessage('hi')
      assert.deepEqual(errors.map((e) => e.code), ['AUTH_REQUIRED'])
    })

    it('...and a wrapped "Please run /login · API Error: 401" banner with no "Login expired" prefix (only `pleaserun/login` matches it)', async () => {
      const { s, errors, duringTurn } = makeTurnSession()
      duringTurn(() => s._appendToOutputTail(
        ['⏺ Please', '\x1b[2Crun', '\x1b[2C/login ·', '\x1b[2CAPI Error:', '\x1b[2C401 OAuth', '\x1b[2Caccess token', '\x1b[2Cis invalid.'].join('\r\x1b[1B'),
      ))
      await s.sendMessage('hi')
      assert.deepEqual(errors.map((e) => e.code), ['AUTH_REQUIRED'])
    })

    it('a mid-turn stall behaves the same way: history before the turn does not upgrade it', () => {
      const { s, errors } = makeTurnSession()
      s._appendToOutputTail(HISTORY_WITH_BANNERS)
      s._markTurnOutputStart()
      s._isBusy = true
      s._currentMessageId = 'msg-stall'
      s._activeTurn = { startedAt: s._nowMonotonic() - 10, synthSeq: 0 }
      s._handleStreamStall()
      assert.deepEqual(errors.map((e) => e.code), ['stream_stall'])
    })

    describe('_outputSinceTurnStart', () => {
      it('is empty when the turn has produced nothing, however much history is in the tail', () => {
        const { s } = makeTurnSession()
        s._appendToOutputTail(HISTORY_WITH_BANNERS)
        s._markTurnOutputStart()
        assert.equal(s._outputSinceTurnStart(), '')
        assert.equal(s._scanTurnOutputForAuthFailure(), false)
      })

      it('is exactly this turn\'s output, ANSI-stripped like the tail', () => {
        const { s } = makeTurnSession()
        s._appendToOutputTail('history line\r\n')
        s._markTurnOutputStart()
        s._appendToOutputTail('\x1b[38;5;220mthis turn\x1b[39m')
        assert.equal(s._outputSinceTurnStart(), 'this turn')
      })

      it('falls back to the whole tail when more bytes arrived than the capped tail holds', () => {
        const { s } = makeTurnSession()
        s._markTurnOutputStart()
        const big = 'x'.repeat(ClaudeTuiSession.PTY_TAIL_BYTES * 2)
        s._appendToOutputTail(big + BANNER_EXPIRED_120COL)
        assert.equal(s._scanTurnOutputForAuthFailure(), true)
        assert.ok(s._outputSinceTurnStart().length <= ClaudeTuiSession.PTY_TAIL_BYTES)
      })

      it('survives a respawn mid-turn: the tail is emptied but the byte counter keeps counting', () => {
        const { s } = makeTurnSession()
        s._appendToOutputTail(HISTORY_WITH_BANNERS)
        s._markTurnOutputStart()
        s._appendToOutputTail('before respawn ')
        s._outputTail = ''
        s._outputTailRaw = Buffer.alloc(0) // what _spawnPty does for the new PTY
        assert.equal(s._outputSinceTurnStart(), '')
        s._appendToOutputTail(BANNER_EXPIRED_120COL)
        assert.equal(s._scanTurnOutputForAuthFailure(), true)
      })
    })
  })
})
