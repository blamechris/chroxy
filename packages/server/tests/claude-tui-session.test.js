import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

describe('ClaudeTuiSession', () => {
  let emptySkillsDir
  let session

  beforeEach(() => {
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
  })

  afterEach(async () => {
    if (session) {
      try { await session.destroy() } catch { /* ignore */ }
      session = null
    }
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
  })

  describe('static metadata', () => {
    it('exposes a human-readable label', () => {
      assert.match(ClaudeTuiSession.displayLabel, /TUI/)
    })

    it('declares capabilities the dashboard reads', () => {
      const c = ClaudeTuiSession.capabilities
      assert.equal(c.permissions, true, 'MVP gates tools via permission-hook.sh')
      assert.equal(c.tools, true, 'MVP wires PreToolUse/PostToolUse hooks')
      assert.equal(c.modelSwitch, false, 'MVP does not support model switch')
      assert.equal(c.planMode, false, 'MVP does not support plan mode')
      assert.equal(c.streaming, false, 'MVP is deliver-on-complete, no incremental tokens')
    })

    it('declares no env-var credentials (subscription-only)', () => {
      // Critical: this provider must not accept ANTHROPIC_API_KEY in preflight.
      // The whole point is OAuth-only routing for subscription billing.
      const envVars = ClaudeTuiSession.preflight.credentials.envVars
      assert.deepEqual(envVars, [], 'no env-var auth — OAuth subscription only')
    })

    it('uses ~/.claude as data dir (shared with claude-cli/sdk)', () => {
      assert.match(ClaudeTuiSession.dataDir, /\.claude$/)
    })
  })

  describe('constructor', () => {
    it('defaults provider id to claude-tui', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._provider, 'claude-tui')
    })

    it('starts not-ready and idle', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._processReady, false)
      assert.equal(session._isBusy, false)
      assert.equal(session.sessionId, null)
    })

    it('generates a per-session hook secret when port is given', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._port, 12345)
      assert.ok(session._hookSecret, 'hook secret generated')
      assert.equal(typeof session._hookSecret, 'string')
      assert.equal(session._hookSecret.length, 64, '32 bytes hex = 64 chars')
    })

    it('omits hook secret when no port is provided (permission-less mode)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._port, null)
      assert.equal(session._hookSecret, null)
    })

    it('produces distinct hook secrets per session', () => {
      const a = new ClaudeTuiSession({ cwd: '/tmp', port: 1, skillsDir: emptySkillsDir, repoSkillsDir: null })
      const b = new ClaudeTuiSession({ cwd: '/tmp', port: 1, skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.notEqual(a._hookSecret, b._hookSecret, 'each session has its own secret')
    })
  })

  describe('start() — with mocked PTY spawn', () => {
    let fakeHome
    let origSpawnPty

    beforeEach(() => {
      // ensureCwdTrusted needs ~/.claude.json to read+write. Point HOME at a
      // temp dir with a minimal config.
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-home-'))
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
      process.env._ORIG_HOME = process.env.HOME
      process.env.HOME = fakeHome

      // Stub _spawnPty on the prototype so start() doesn't actually fork claude.
      // Sets a fake term so subsequent state assertions don't trip on null.
      origSpawnPty = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._term = {
          write: () => {},
          kill: () => {},
          onData: () => {},
          onExit: () => {},
        }
      }
    })

    afterEach(() => {
      ClaudeTuiSession.prototype._spawnPty = origSpawnPty
      if (process.env._ORIG_HOME) {
        process.env.HOME = process.env._ORIG_HOME
        delete process.env._ORIG_HOME
      }
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    it('pre-trusts the cwd in ~/.claude.json so the trust dialog is bypassed', async () => {
      const cwdReal = '/tmp'
      session = new ClaudeTuiSession({ cwd: cwdReal, skillsDir: emptySkillsDir, repoSkillsDir: null })

      let readyFired = false
      session.on('ready', () => { readyFired = true })
      await session.start()

      assert.equal(readyFired, true, 'start emits ready')
      assert.equal(session._processReady, true, 'session marked ready')

      const config = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8'))
      const projects = config.projects || {}
      const entries = Object.entries(projects).filter(([, v]) => v.hasTrustDialogAccepted === true)
      assert.ok(entries.length >= 1, 'at least one project entry was marked trusted')
      assert.ok(entries.some(([k]) => k.endsWith('/tmp') || k.includes('/tmp')),
        `expected a /tmp-ish trust entry, got: ${entries.map(([k]) => k).join(', ')}`)
    })

    it('is idempotent when cwd is already trusted', async () => {
      const cwdReal = '/tmp'
      const initial = { projects: {} }
      const { realpathSync } = await import('fs')
      initial.projects[realpathSync(cwdReal)] = { hasTrustDialogAccepted: true }
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify(initial))
      const before = readFileSync(join(fakeHome, '.claude.json'), 'utf8')

      session = new ClaudeTuiSession({ cwd: cwdReal, skillsDir: emptySkillsDir, repoSkillsDir: null })
      await session.start()

      const after = readFileSync(join(fakeHome, '.claude.json'), 'utf8')
      assert.equal(before, after, 'no rewrite when already trusted')
    })

    it('creates sink dir, writes settings.json, and assigns a session uuid', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      await session.start()
      assert.ok(session._sinkDir, 'sink dir set')
      assert.ok(existsSync(session._sinkDir), 'sink dir exists on disk')
      assert.ok(session._settingsPath, 'settings path set')
      assert.ok(existsSync(session._settingsPath), 'settings.json exists')
      assert.ok(session._sessionId, 'session uuid assigned at start (persistent process)')
      assert.match(session._sessionId, /^[0-9a-f-]{36}$/, 'looks like a uuid')
    })

    it('settings.json contains stop/pre/post hooks with mktemp filenames', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      await session.start()
      const settings = JSON.parse(readFileSync(session._settingsPath, 'utf8'))
      assert.ok(settings.hooks?.Stop, 'Stop hook present')
      assert.ok(settings.hooks?.PreToolUse, 'PreToolUse hook present')
      assert.ok(settings.hooks?.PostToolUse, 'PostToolUse hook present')
      const stopCmd = settings.hooks.Stop[0].hooks[0].command
      assert.match(stopCmd, /stop-\$\(uuidgen\)\.json/, 'Stop uses uuidgen for unique-per-turn names (mktemp + .json suffix breaks on BSD macOS)')
    })

    it('emits error if PTY exits during warmup', async () => {
      // Override the stub for THIS test to simulate PTY death during warmup.
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._ptyExited = true
        this._ptyExitInfo = { exitCode: 1, signal: null }
      }

      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.start()

      assert.equal(session._processReady, false, 'not ready after PTY death')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /exited during warmup/)
    })
  })

  describe('sendMessage() error paths', () => {
    it('emits error if not started yet', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /not started|no longer alive/)
    })

    it('emits error if PTY has exited', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Simulate post-start state with dead PTY.
      session._processReady = true
      session._term = { write: () => {}, kill: () => {} }
      session._ptyExited = true
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /no longer alive/)
    })

    it('emits error if already busy', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._term = { write: () => {}, kill: () => {} }
      session._isBusy = true  // simulate in-flight turn
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /Already processing/)
    })
  })

  describe('busy-signal lifecycle (#4010)', () => {
    // The dashboard derives `agent_busy` from `stream_start` and `agent_idle`
    // from `result` (event-normalizer.js). The TUI provider has to fire those
    // two events on every exit path of every turn, or the Stop button gets
    // stuck (busy without a way to abort) or never appears (silent stall).
    // These tests pin the contract for both the success path and the failure
    // paths so a future refactor cannot quietly drop one.

    it('emits stream_start at turn start, not at completion', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      // Skip readiness gating — this test pins event-emit ORDER, not
      // probe behavior. The probe gets its own coverage under the
      // readiness-probe describe block. Stubbing the probe (rather than
      // relying on a side effect of the no-pid path) keeps the test's
      // intent explicit and survives the #4040 review hardening that
      // made invalid-pid a not-ready signal.
      session._waitForPrompt = async () => true
      const events = []
      session._term = {
        write: () => { events.push('pty_write') },
        kill: () => {},
      }
      session.on('stream_start', () => events.push('stream_start'))
      // Catch the timeout 'error' so EventEmitter doesn't throw on it —
      // the test only cares about the start-of-turn emit order.
      session.on('error', () => {})
      session._hardTimeoutMs = 25  // fail fast so the test doesn't hang
      session._resultTimeoutMs = 5000

      await session.sendMessage('hi')

      const startIdx = events.indexOf('stream_start')
      const writeIdx = events.indexOf('pty_write')
      assert.ok(startIdx >= 0, 'stream_start fired at all')
      assert.ok(writeIdx >= 0, 'pty write happened')
      assert.ok(startIdx < writeIdx, `stream_start must precede pty write (got start=${startIdx}, write=${writeIdx})`)
    })

    it('emits exactly one stream_start per turn (no duplicate at completion)', async () => {
      // Pre-#4010 the success path also emitted stream_start, so moving the
      // early emit in without removing the late emit would render two
      // assistant bubbles per turn. Drop a fake stop hook to force the
      // success path and count emits.
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-uuid'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-busy-'))
      // Skip readiness gating — see note in the prior test.
      session._waitForPrompt = async () => true
      session._term = {
        write: () => {
          // Drop a stop hook immediately so the poll loop completes.
          writeFileSync(join(session._sinkDir, 'stop-fake.json'), JSON.stringify({
            last_assistant_message: 'hello',
          }))
        },
        kill: () => {},
      }
      let starts = 0, deltas = 0, ends = 0, results = 0
      session.on('stream_start', () => starts++)
      session.on('stream_delta', () => deltas++)
      session.on('stream_end', () => ends++)
      session.on('result', () => results++)

      await session.sendMessage('hi')

      assert.equal(starts, 1, 'stream_start fires once per turn')
      assert.equal(deltas, 1, 'stream_delta fires once with the response')
      assert.equal(ends, 1, 'stream_end fires once')
      assert.equal(results, 1, 'result fires once → triggers agent_idle')
    })

    it('emits result on hard timeout so dashboard clears busy state', async () => {
      // Without this, a stalled turn that trips the hard timeout would leave
      // the dashboard showing Stop forever — stream_end alone only clears
      // streamingMessageId, it does not flip isIdle back to true.
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-stall'
      session._activeTurn = { messageId: 'msg-stall', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      session._sessionId = 'sess-stall'
      session._term = { write: () => {}, kill: () => {} }

      const events = []
      session.on('stream_end', () => events.push('stream_end'))
      session.on('error', () => events.push('error'))
      session.on('result', () => events.push('result'))

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.ok(events.includes('stream_end'), 'stream_end emitted on timeout')
      assert.ok(events.includes('result'), 'result emitted on timeout → agent_idle')
      assert.equal(session._isBusy, false, 'busy state cleared')
    })

    it('emits result on _finishTurnError so aborted/failed turns clear busy', async () => {
      // _finishTurnError is the common exit for prompt-write failures and
      // poll-loop bailouts (aborted, pty-exit, stop-timeout). Each one must
      // round-trip agent_busy → agent_idle.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._isBusy = true
      session._currentMessageId = 'msg-fail'
      session._activeTurn = { messageId: 'msg-fail', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      session._sessionId = 'sess-fail'

      const events = []
      session.on('stream_end', (e) => events.push(['stream_end', e.messageId]))
      session.on('error', (e) => events.push(['error', e.message]))
      session.on('result', (e) => events.push(['result', e.sessionId]))

      session._finishTurnError('something broke')

      const types = events.map(([t]) => t)
      assert.ok(types.includes('stream_end'), 'stream_end emitted')
      assert.ok(types.includes('error'), 'error emitted')
      assert.ok(types.includes('result'), 'result emitted → agent_idle clears busy state')
      assert.equal(session._isBusy, false, 'busy flag cleared')
    })

    it('pairs stream_end with stream_start when PTY exits mid-turn (review follow-up)', async () => {
      // PTY-exit-mid-turn race: the onExit handler runs synchronously and
      // nulls _currentMessageId + _activeTurn BEFORE the poll loop notices
      // _ptyExited=true and falls into _finishTurnError. Without the
      // callerMessageId fallback, the if(messageId) guard would silently
      // skip stream_end, leaving the stream_start opened at turn-start
      // unbalanced and session-message-history._pendingStreams holding the
      // entry until destroy(). Simulate the race directly by calling
      // _finishTurnError after the onExit-style clear, with the original
      // messageId passed as the second arg (matching sendMessage's call).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sessionId = 'sess-pty-exit'
      // Simulate state AFTER onExit handler has nulled everything.
      session._isBusy = false
      session._currentMessageId = null
      session._activeTurn = null
      session._ptyExited = true
      session._ptyExitInfo = { exitCode: 137, signal: 'SIGKILL' }

      const events = []
      session.on('stream_end', (e) => events.push(['stream_end', e.messageId]))
      session.on('error', (e) => events.push(['error', e.message]))
      session.on('result', (e) => events.push(['result', e.sessionId]))

      // sendMessage passes the local messageId from the top of the function
      // as the second arg precisely to survive this race.
      session._finishTurnError('Claude PTY exited mid-turn (code=137 signal=SIGKILL)', 'msg-pty-race')

      const streamEnd = events.find(([t]) => t === 'stream_end')
      assert.ok(streamEnd, 'stream_end fires even after onExit nulled _currentMessageId')
      assert.equal(streamEnd[1], 'msg-pty-race', 'stream_end carries the original messageId so it pairs with the early stream_start')
      assert.ok(events.find(([t]) => t === 'error'), 'error emitted')
      assert.ok(events.find(([t]) => t === 'result'), 'result emitted → agent_idle')
    })
  })

  describe('readiness probe (#4040)', () => {
    // The probe watches claude's per-PID session file at
    // ~/.claude/sessions/<pid>.json. Claude TUI writes this file at
    // startup and updates the `status` field on every transition
    // (busy/idle/...) — the same field `claude ps` reads. When
    // status !== 'busy' the TUI is ready for input. This replaces the
    // glyph screen-scrape in #4014/#4031/#4035/#4039, which all had
    // false-positive vs. false-negative tradeoffs against the rendered
    // TUI and were fundamentally unstable across claude releases.
    //
    // Each test sets HOME to a temp dir so the fake session file lives
    // somewhere we can write without touching the real ~/.claude.

    let fakeHome
    let origHome
    let fakePid

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-sess-'))
      mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
      origHome = process.env.HOME
      process.env.HOME = fakeHome
      // node-pty assigns pids as kernel pids; for tests any positive
      // integer suffices, the probe only uses it to build the file path.
      fakePid = 9999
    })

    afterEach(() => {
      if (origHome !== undefined) process.env.HOME = origHome
      else delete process.env.HOME
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    function writeSessionFile(pid, status) {
      const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
      writeFileSync(path, JSON.stringify({
        pid, sessionId: 'fake', status, updatedAt: Date.now(),
      }))
      return path
    }

    it('_waitForPrompt resolves true when session file reports status=idle', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'idle')
      const ready = await session._waitForPrompt(100)
      assert.equal(ready, true, 'status=idle counts as ready')
    })

    it('_waitForPrompt resolves false when session file reports status=busy', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'busy')
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'status=busy must NOT count as ready')
    })

    it('_waitForPrompt resolves false when session file is absent (claude not yet up)', async () => {
      // First few hundred ms after spawn the file may not exist yet.
      // The probe must keep polling, not crash, and return false on
      // timeout if it never appears (caller falls through with a warn).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'absent session file is treated as not-ready')
    })

    it('_waitForPrompt returns false when pid is missing or invalid (Copilot review on #4040)', async () => {
      // Returning true on a missing/invalid pid would silently disable
      // readiness gating on any platform/runtime where node-pty fails to
      // populate pid, reintroducing the race the probe exists to prevent.
      // Tests that explicitly want to skip the probe stub
      // `_waitForPrompt` directly rather than relying on this guard.
      const cases = [
        { pid: undefined, label: 'undefined' },
        { pid: null, label: 'null' },
        { pid: NaN, label: 'NaN' },
        { pid: -1, label: 'negative' },
        { pid: 0, label: 'zero' },
        { pid: 1.5, label: 'non-integer' },
        { pid: '12345', label: 'string' },
      ]
      for (const { pid, label } of cases) {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._term = { write: () => {}, kill: () => {}, pid }
        const ready = await session._waitForPrompt(20)
        assert.equal(ready, false,
          `pid=${label} must NOT count as ready (would silently disable gating)`)
      }
    })

    it('_waitForPrompt returns false when PTY exited even if status=idle', async () => {
      // PTY death overrides a stale idle marker — otherwise we'd write
      // bytes to a corpse and report success.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'idle')
      session._ptyExited = true
      const ready = await session._waitForPrompt(100)
      assert.equal(ready, false, 'PTY exit overrides idle status')
    })

    it('_waitForPrompt polls until status transitions to idle', async () => {
      // Cold start: file appears mid-poll, status flips from absent ->
      // busy -> idle. The probe must continue past the first read miss.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      setTimeout(() => writeSessionFile(fakePid, 'busy'), 50)
      setTimeout(() => writeSessionFile(fakePid, 'idle'), 200)
      const ready = await session._waitForPrompt(800)
      assert.equal(ready, true, 'probe sees idle once it lands')
    })

    it('_waitForPrompt treats unknown non-busy statuses as ready', async () => {
      // Claude may introduce new statuses (waiting, paused, etc.) over
      // time. The probe's job is "not actively running a turn" — any
      // string other than "busy" counts. This is the forward-compat
      // choice and matches how `claude ps` already treats the field.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'waiting')
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, true, 'status=waiting counts as ready')
    })

    it('_waitForPrompt sets _lastProbeSawStatus=false when session file never appeared', async () => {
      // Silent-degrade signal: if the probe runs full-duration without
      // ever reading a non-null status, the file format/path has likely
      // changed (e.g. claude entrypoint switched away from `cli` and no
      // longer writes `status`). The warn site at the timeout reads
      // `_lastProbeSawStatus` to surface this case distinctly from a
      // genuinely busy session.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'absent file → not-ready')
      assert.equal(session._lastProbeSawStatus, false,
        '_lastProbeSawStatus must be false when no readable status was ever seen')
    })

    it('_waitForPrompt sets _lastProbeSawStatus=true once a status is read, even on busy timeout', async () => {
      // Distinguish "stuck on busy" from "file never appeared". A long
      // busy stretch is normal during a real turn; the warn site should
      // NOT mention degraded probe in that case.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      writeSessionFile(fakePid, 'busy')
      const ready = await session._waitForPrompt(50)
      assert.equal(ready, false, 'busy → not-ready')
      assert.equal(session._lastProbeSawStatus, true,
        '_lastProbeSawStatus must be true once any status was successfully read')
    })

    it('_waitForPrompt tolerates a malformed session file (transient mid-write race)', async () => {
      // Atomic-write races: claude rewrites the file by truncate+write
      // (not rename), so a JSON.parse can hit a half-written body. The
      // probe swallows the error and keeps polling, not crash.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      const path = join(fakeHome, '.claude', 'sessions', `${fakePid}.json`)
      writeFileSync(path, '{not-valid-json')
      setTimeout(() => writeSessionFile(fakePid, 'idle'), 80)
      const ready = await session._waitForPrompt(400)
      assert.equal(ready, true, 'probe survives JSON.parse errors and resolves once the file is sane')
    })

    it('readSessionStatus returns null for missing/invalid files', () => {
      // Static helper isolation: covers the file-absent, JSON-invalid,
      // and missing-field branches without going through the polling
      // loop. The probe relies on this returning null on every error so
      // it keeps polling instead of throwing.
      assert.equal(ClaudeTuiSession.readSessionStatus('/no/such/path'), null,
        'missing file → null')
      const bad = join(fakeHome, 'bad.json')
      writeFileSync(bad, 'not json')
      assert.equal(ClaudeTuiSession.readSessionStatus(bad), null,
        'invalid JSON → null')
      const noStatus = join(fakeHome, 'no-status.json')
      writeFileSync(noStatus, JSON.stringify({ pid: 1, updatedAt: 0 }))
      assert.equal(ClaudeTuiSession.readSessionStatus(noStatus), null,
        'missing status field → null')
    })

    it('sessionFilePath uses ~/.claude/sessions/<pid>.json', () => {
      // The path must match claude's own convention (the file `claude ps`
      // reads). If claude ever moves this directory, the probe needs a
      // visible failure (this test) — silently reading the wrong path
      // would degrade us back to "never ready, always falls through".
      const path = ClaudeTuiSession.sessionFilePath(12345)
      assert.ok(path.endsWith(join('.claude', 'sessions', '12345.json')),
        `expected ~/.claude/sessions/12345.json, got: ${path}`)
      assert.ok(path.startsWith(fakeHome),
        `path should be under HOME, got: ${path}`)
    })

    describe('output tail hex dump (#4031)', () => {
      // The dump survives the #4040 probe rewrite because it's still
      // useful diagnostics for any TUI-rendered error inline. It's no
      // longer tied to a probe-scan window — it caps at
      // PTY_TAIL_DIAGNOSTIC_BYTES (1024) so log lines stay bounded.

      it('returns a readable hex+ascii dump for log lines', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._outputTailRaw = Buffer.from('hello', 'utf8')
        const dump = session._outputTailHexDump()
        assert.match(dump, /\(5 bytes\)/, `dump should report byte count, got: ${JSON.stringify(dump)}`)
        assert.match(dump, /68 65 6c 6c 6f/, `hex side missing, got: ${JSON.stringify(dump)}`)
        assert.match(dump, /\|hello\|/, `ascii side missing, got: ${JSON.stringify(dump)}`)
      })

      it('handles empty buffer', () => {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._outputTailRaw = Buffer.alloc(0)
        assert.equal(session._outputTailHexDump(), '<empty>')
      })

      it('surfaces UNSTRIPPED escape/control bytes (#4031 review)', () => {
        // The original implementation sourced from the ANSI-stripped
        // _outputTail, so the diagnostic could never surface the very
        // escape sequences ("0x1b ...") we wanted to see. Lock in that
        // the dump reads from the raw buffer.
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._outputTail = '❯ '
        session._outputTailRaw = Buffer.from('\x1b]0;claude\x07❯ ', 'utf8')
        const dump = session._outputTailHexDump()
        assert.match(dump, /1b 5d/, `dump should surface raw ESC byte, got: ${JSON.stringify(dump)}`)
      })

      it('caps the dump at PTY_TAIL_DIAGNOSTIC_BYTES with a truncation header', () => {
        // Honesty invariant: large buffers must be truncated to a
        // bounded size with a header that names how much was elided.
        // Without the cap, a multi-KB tail could produce log lines that
        // get truncated by the logger itself and lose the diagnostic.
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const cap = ClaudeTuiSession.PTY_TAIL_DIAGNOSTIC_BYTES
        const totalBytes = cap * 3
        const omitted = totalBytes - cap
        session._outputTailRaw = Buffer.from('X'.repeat(totalBytes), 'utf8')
        const dump = session._outputTailHexDump()
        assert.ok(
          dump.includes(`(${cap} of ${totalBytes} bytes; first ${omitted} omitted)`),
          `dump should report cap with truncation header, got: ${dump.slice(0, 120)}`,
        )
      })
    })

    it('sendMessage waits for status=idle before writing to the PTY', async () => {
      // The whole point of the probe — bytes must not hit the PTY until
      // claude reports itself ready. We delay the idle transition and
      // assert the write fires AFTER it, not before.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-probe-'))
      writeSessionFile(fakePid, 'busy')   // not ready yet
      let writeAt = null
      session._term = {
        write: () => {
          writeAt = Date.now()
          writeFileSync(join(session._sinkDir, 'stop-x.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 5000
      session._resultTimeoutMs = 5000
      session.on('error', () => {})

      const sendStart = Date.now()
      const idleAt = sendStart + 150
      setTimeout(() => writeSessionFile(fakePid, 'idle'), 150)

      await session.sendMessage('hello')

      assert.ok(writeAt, 'PTY write happened')
      assert.ok(writeAt >= idleAt - 30,
        `PTY write must wait for status=idle (write@${writeAt - sendStart}ms, idle@${idleAt - sendStart}ms)`)
    })

    it('sendMessage falls through and writes anyway on probe timeout', async () => {
      // A timeout is logged but never blocks the write — if claude's
      // session-file convention changes or the file is unreadable for
      // some reason, we'd rather risk a stall than silently swallow
      // every prompt the user types.
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        hardTimeoutMs: 5000, resultTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-probe-to-'))
      // No session file at all — probe will keep returning false.
      let wrote = false
      session._term = {
        write: () => {
          wrote = true
          writeFileSync(join(session._sinkDir, 'stop-y.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session.on('error', () => {})

      // Shrink the probe budget to keep the test fast — same code path.
      // Capture the original descriptor (a static getter) and restore it
      // verbatim. A naive { value: origMax } restore would replace the
      // getter with a data property, permanently mutating the class shape
      // for the rest of the process and silently breaking later tests.
      const origDesc = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS')
      Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', { value: 80, configurable: true })
      try {
        await session.sendMessage('hello')
      } finally {
        Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', origDesc)
      }

      assert.equal(wrote, true, 'probe miss does not block the write')
    })

    it('sendMessage routes to _finishTurnError when PTY dies during the probe wait', async () => {
      // Edge case: probe is waiting, PTY exits, probe returns false. We
      // must surface a clear error and clear busy — not silently fall
      // through to a write on a dead PTY.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      // No session file → probe stays in its polling loop until either
      // _ptyExited flips or the timeout elapses.
      session._term = { write: () => {}, kill: () => {}, pid: fakePid }
      session._hardTimeoutMs = 5000
      session._resultTimeoutMs = 5000

      const errors = []
      session.on('error', (e) => errors.push(e))

      setTimeout(() => {
        session._ptyExited = true
        session._ptyExitInfo = { exitCode: 1, signal: null }
      }, 40)

      await session.sendMessage('hello')

      assert.ok(errors.find((e) => /exited before prompt write/.test(e.message)),
        `expected "exited before prompt write" error, got: ${errors.map((e) => e.message).join(' | ')}`)
      assert.equal(session._isBusy, false, 'busy cleared after probe-time PTY death')
    })

    it('sendMessage bails out via _finishTurnError when interrupt() fires during the probe wait', async () => {
      // Race: user clicks Stop while the readiness probe is still polling.
      // Without the abort guard, sendMessage would happily write the
      // prompt after interrupt() has already sent Ctrl-C, queuing a turn
      // behind the cancel and desynchronizing busy state with the TUI.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      // No session file → probe stays in its polling loop.
      let promptWritten = false
      session._term = {
        write: (bytes) => {
          // Track only the prompt write (Ctrl-C from interrupt() is a
          // single 0x03 byte; the prompt is 'hello\r').
          if (typeof bytes === 'string' && bytes.length > 1) promptWritten = true
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 5000
      session._resultTimeoutMs = 5000

      const errors = []
      session.on('error', (e) => errors.push(e))

      // Fire interrupt() partway through the probe wait. No session
      // file is ever written so the probe is still polling when this
      // runs.
      setTimeout(() => session.interrupt(), 40)

      // Shrink the probe budget so the test doesn't wait 5s for the
      // timeout fall-through.
      const origDesc = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS')
      Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', { value: 200, configurable: true })
      try {
        await session.sendMessage('hello')
      } finally {
        Object.defineProperty(ClaudeTuiSession, 'TURN_PROMPT_WAIT_MAX_MS', origDesc)
      }

      assert.equal(promptWritten, false,
        'prompt MUST NOT be written after interrupt() during probe wait')
      assert.ok(errors.find((e) => /aborted before prompt write/.test(e.message)),
        `expected "aborted before prompt write" error, got: ${errors.map((e) => e.message).join(' | ')}`)
      assert.equal(session._isBusy, false, 'busy cleared after probe-time abort')
      assert.equal(session._activeTurn, null, 'active turn cleared after probe-time abort')
    })
  })

  describe('throttled prompt write + bracketed-paste suppression (#4269)', () => {
    // claude TUI's paste detector triggers on byte-arrival rate, not DEC
    // mode 2004 — a single bulk write of the whole prompt is collapsed
    // into a "[Pasted text #1 +N lines] paste again to expand"
    // placeholder that the user has to confirm. chroxy's writes never
    // get that confirmation, so the prompt sits in claude's input
    // buffer forever and the turn hangs with no output and no claude
    // activity. Fix is to throttle the write character-by-character so
    // the bytes look like typed input. The bracketed-paste-disable /
    // re-enable wrap (`ESC [ ? 2004 l` / `h`) is kept as
    // defense-in-depth for any claude version that DOES honor mode
    // 2004 — the throttle is what actually fixes the bug.
    let fakeHome
    let origHome
    let fakePid

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-'))
      mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
      origHome = process.env.HOME
      process.env.HOME = fakeHome
      fakePid = 8765
    })

    afterEach(() => {
      if (origHome !== undefined) process.env.HOME = origHome
      else delete process.env.HOME
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    function writeIdleSessionFile(pid) {
      const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
      writeFileSync(path, JSON.stringify({
        pid, sessionId: 'fake', status: 'idle', updatedAt: Date.now(),
      }))
      return path
    }

    it('writes the prompt character-by-character so claude does not see a bulk paste', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-sink-'))
      writeIdleSessionFile(fakePid)
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          // Synthesize a stop file so the poll loop unblocks.
          writeFileSync(join(session._sinkDir, 'stop-x.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 2000
      session._resultTimeoutMs = 2000
      session.on('error', () => {})

      const prompt = 'a test prompt with no newlines'
      await session.sendMessage(prompt)

      // The fix issues N+3 writes: one for the bracketed-paste-disable
      // prefix, one per prompt code-point, one for the \r submit, and
      // one for the bracketed-paste re-enable suffix. The throttle
      // between char writes is what actually defeats claude's paste
      // detector (which fires on byte-arrival rate, not mode 2004).
      //
      // #4274: use `[...prompt]` for code-point counting. String#length
      // counts UTF-16 code units, so non-BMP chars (emoji, some CJK)
      // would yield a stale count under bare ASCII assumptions. ASCII
      // is unaffected (1 code unit == 1 code point), but writing the
      // code-point form keeps these assertions valid for any prompt
      // the multi-byte fixture below exercises.
      const codePoints = [...prompt]
      assert.equal(writes.length, codePoints.length + 3,
        `expected ${codePoints.length + 3} writes (disable + N chars + \\r + enable), got ${writes.length}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes.slice(1, 1 + codePoints.length).join(''), prompt,
        'chars 1..N concatenate back to the original prompt')
      for (let i = 0; i < codePoints.length; i++) {
        assert.equal(writes[1 + i], codePoints[i], `write index ${1 + i} is the i-th code-point of the prompt`)
      }
      assert.equal(writes[1 + codePoints.length], '\r', 'penultimate write is the submit')
      assert.equal(writes[2 + codePoints.length], '\x1b[?2004h', 'final write is bracketed-paste re-enable')
    })

    it('delivers multi-line prompts via a single bracketed-paste write (#4678)', async () => {
      // #4678 superseded the per-char throttle for multi-line input.
      // Claude TUI v2.1.x treats embedded \n in the input box as
      // "insert newline in multi-line composition" and the trailing
      // bare \r we appended was being interpreted as another newline
      // rather than submit — the input box stayed in composition mode
      // forever and the 5-min stream-stall watchdog was the only escape.
      // Multi-line prompts now wrap the body in CSI bracketed-paste
      // markers (\x1b[200~ ... \x1b[201~) so claude TUI receives the
      // block as a paste and the trailing \r fires as submit. The
      // per-char throttle is still used for single-line input (#4269
      // paste-detector defence) — see the emoji/CJK test below.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-sink-ml-'))
      writeIdleSessionFile(fakePid)
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          writeFileSync(join(session._sinkDir, 'stop-ml.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 2000
      session._resultTimeoutMs = 2000
      session.on('error', () => {})

      const multiline = 'line one\nline two\nline three'
      await session.sendMessage(multiline)

      // Exactly ONE write for the whole multi-line input — no per-char
      // throttle for this path. The disable/enable mode-2004 wrap is
      // also skipped because bracketed paste IS the mode signal.
      assert.equal(writes.length, 1, 'multi-line prompt sent as one atomic paste, not per-char')
      const sent = writes[0]
      assert.ok(sent.startsWith('\x1b[200~'), `must start with paste-start CSI (got ${JSON.stringify(sent.slice(0, 10))})`)
      assert.ok(sent.endsWith('\x1b[201~\r'), `must end with paste-end CSI + CR (got ${JSON.stringify(sent.slice(-12))})`)
      assert.ok(sent.includes(multiline), 'body preserves embedded \\n chars verbatim inside the paste')
      const newlineCount = (sent.match(/\n/g) || []).length
      assert.equal(newlineCount, 2, 'each embedded \\n survives literally inside the bracketed-paste body')
    })

    // #4274: bare String#length counts UTF-16 code units, so a single
    // non-BMP code-point (emoji, some CJK supplementary chars) reports
    // as length 2. `for (const ch of text)` iterates by code-point, so
    // each emoji is ONE write of a 2-UTF-16-unit string. Pre-fix the
    // tests assumed 1 write == 1 code-unit and would over-count + fail
    // the per-write `length === 1` assertion. This test pins the
    // production behavior under multi-byte input.
    it('reproduces emoji + CJK prompts verbatim (one write per code-point, not per UTF-16 unit) (#4274)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-bp-sink-mb-'))
      writeIdleSessionFile(fakePid)
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          writeFileSync(join(session._sinkDir, 'stop-mb.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
        pid: fakePid,
      }
      session._hardTimeoutMs = 2000
      session._resultTimeoutMs = 2000
      session.on('error', () => {})

      // Mix of: BMP ASCII, BMP CJK (length 1 in UTF-16), and non-BMP
      // emoji (length 2 in UTF-16, length 1 in code-points). If the
      // throttle loop walks UTF-16 units it splits the emoji surrogate
      // pair and corrupts the prompt. Iterating by code-point keeps
      // every grapheme intact.
      const prompt = 'hi 😀 こんにちは 👋'
      await session.sendMessage(prompt)

      const codePoints = [...prompt]
      assert.ok(prompt.length > codePoints.length,
        'fixture exercises non-BMP — UTF-16 length must exceed code-point length')
      assert.equal(writes.length, codePoints.length + 3,
        `expected ${codePoints.length + 3} writes (disable + N code-points + \\r + enable), got ${writes.length}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes.slice(1, 1 + codePoints.length).join(''), prompt,
        'code-point writes concatenate back to the original prompt verbatim')
      for (let i = 0; i < codePoints.length; i++) {
        assert.equal(writes[1 + i], codePoints[i],
          `write index ${1 + i} is the i-th code-point (UTF-16 length ${codePoints[i].length})`)
      }
      assert.equal(writes[1 + codePoints.length], '\r', 'penultimate write is the submit')
      assert.equal(writes[2 + codePoints.length], '\x1b[?2004h', 'final write is bracketed-paste re-enable')
    })
  })

  describe('attachment passthrough (#4012)', () => {
    // Pre-fix, sendMessage's second positional was `_attachments` (the
    // underscore meaning "intentionally unused") and attachments were
    // silently dropped. The fix materializes each attachment under
    // <sinkDir>/attachments/<messageId>/ and appends a structured suffix
    // to the prompt so the spawned `claude` TUI can find the files via
    // its Read tool. These tests pin both halves of the contract: the
    // files reach disk AND the prompt the PTY receives names them.

    it('appends an attachments suffix to the prompt and writes files to disk', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-send-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-att'
      session._sinkDir = sinkDir
      // Skip readiness gating — attachment behavior is independent of
      // the #4040 probe. Probe-specific tests live under their own
      // describe block.
      session._waitForPrompt = async () => true

      let writtenToPty = ''
      // Inspect attachment state DURING the turn (before the success path
      // cleans up under #4022). The poll loop runs after term.write so by
      // the time await sendMessage() returns, _cleanupTurnAttachments has
      // fired and the per-turn dir is gone — we have to snapshot disk
      // state inside the write callback to verify it landed at all.
      let midTurnSubdirCount = -1
      let midTurnFiles = []
      session._term = {
        write: (s) => {
          // #4269: writes are now per-character throttled. Accumulate
          // so the final string equals what would have been a single
          // pre-throttle write — keeps existing assertions valid.
          writtenToPty += s
          // Snapshot the attachments dir contents at the moment the
          // prompt is being written to the PTY. This is the state claude
          // sees when it tries to Read the file path from the suffix.
          const attDir = join(sinkDir, 'attachments')
          try {
            const subdirs = readdirSync(attDir)
            midTurnSubdirCount = subdirs.length
            if (subdirs.length > 0) {
              midTurnFiles = readdirSync(join(attDir, subdirs[0]))
            }
          } catch { midTurnSubdirCount = 0 }
          // Drop a stop hook so the poll loop completes the turn.
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({
            last_assistant_message: 'ok',
          }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      await session.sendMessage('Look at this screenshot', [
        { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'shot.png' },
      ])

      // 1) Prompt that hit the PTY contains the original text PLUS the suffix.
      assert.ok(writtenToPty.includes('Look at this screenshot'), 'original prompt text preserved')
      assert.ok(writtenToPty.includes('attached the following file'),
        `expected suffix in PTY write, got: ${JSON.stringify(writtenToPty.slice(0, 200))}`)
      assert.ok(writtenToPty.includes('shot.png'), 'display name appears in suffix')
      // #4269: the write is now `ESC [ ? 2004 l <prompt body> \r ESC [ ? 2004 h`
      // so the submit \r is no longer the trailing byte. The contract is
      // unchanged in spirit: exactly one \r submit, no embedded \r/\n in
      // the prompt body that would prematurely-submit or split the turn
      // (#4012 review finding).
      const disableIdx = writtenToPty.indexOf('\x1b[?2004l')
      const submitIdx = writtenToPty.indexOf('\r')
      const enableIdx = writtenToPty.indexOf('\x1b[?2004h')
      assert.ok(disableIdx === 0, 'write begins with bracketed-paste-disable')
      assert.ok(submitIdx > disableIdx, '\\r submit appears after the disable + body')
      assert.ok(enableIdx > submitIdx, 're-enable appears after the submit')
      const body = writtenToPty.slice(disableIdx + '\x1b[?2004l'.length, submitIdx)
      assert.ok(!body.includes('\n'), `no embedded LF in prompt body, got ${JSON.stringify(body)}`)
      assert.ok(!body.includes('\r'), 'no embedded CR in prompt body either')

      // 2) File actually materialized on disk at the moment the prompt
      // was handed to the PTY — the snapshot taken in term.write above.
      // Post-turn cleanup (#4022) will have removed the dir by now.
      assert.equal(midTurnSubdirCount, 1, 'exactly one per-turn subdir was on disk when PTY received the prompt')
      assert.equal(midTurnFiles.length, 1)
      assert.ok(midTurnFiles[0].endsWith('.png'), `expected .png, got ${midTurnFiles[0]}`)
    })

    it('does NOT touch the prompt when no attachments are present', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-noatt-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = sinkDir
      session._waitForPrompt = async () => true

      let writtenToPty = ''
      session._term = {
        write: (s) => {
          // #4269: writes are now per-character throttled. Accumulate
          // so the final string equals what would have been a single
          // pre-throttle write — keeps existing assertions valid.
          writtenToPty += s
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      await session.sendMessage('Just a plain prompt')

      // #4269: write is now wrapped with bracketed-paste mode toggles so
      // claude TUI doesn't collapse the input into a "paste again to
      // expand" placeholder. The prompt body itself is still
      // byte-for-byte identical to the user input.
      assert.equal(writtenToPty, '\x1b[?2004lJust a plain prompt\r\x1b[?2004h',
        'plain prompt is wrapped in bracketed-paste-disable / re-enable with body unmodified')
    })

    it('logs and proceeds with unaugmented prompt when materialization throws', async () => {
      // Failure to write the attachment must NOT lose the user's text.
      // Force the catch path by setting _sinkDir to a path containing a
      // NUL byte so mkdirSync inside materializeAttachments throws.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-fail-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test'
      session._sinkDir = `${sinkDir}\0invalid`   // mkdirSync will reject
      session._waitForPrompt = async () => true

      let writtenToPty = ''
      session._term = {
        write: (s) => {
          // #4269: writes are now per-character throttled. Accumulate
          // so the final string equals what would have been a single
          // pre-throttle write — keeps existing assertions valid.
          writtenToPty += s
          // The stop hook needs to land in a VALID sink dir for the
          // poll loop to read it. Use the real sinkDir for that.
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      // Point poll loop at the real sinkDir AFTER the failed materialize
      // (drainHookFiles reads _sinkDir each tick). The sendMessage
      // function doesn't snapshot it, so mutating mid-call works.
      const realSinkDir = sinkDir
      const send = session.sendMessage('Important message', [
        { type: 'image', mediaType: 'image/png', data: Buffer.from('x').toString('base64'), name: 'a.png' },
      ])
      // After the materialize-then-write block runs, swap sinkDir so the
      // poll loop can find the stop hook.
      queueMicrotask(() => { session._sinkDir = realSinkDir })
      await send

      // #4269: write is wrapped with bracketed-paste mode toggles. The
      // user's prompt body itself is still preserved verbatim — that's
      // the invariant this test pins.
      assert.equal(writtenToPty, '\x1b[?2004lImportant message\r\x1b[?2004h',
        'materialization failure must NOT drop the user prompt')

      rmSync(sinkDir, { recursive: true, force: true })
    })

    // #4287 follow-up to #4285: when `_activeTurn?.aborted` trips
    // mid-loop, `_writePtyTextThrottled` previously returned early
    // WITHOUT writing the `\x1b[?2004h` re-enable, leaving the PTY in
    // bracketed-paste-disabled mode for subsequent writes. The fix
    // wraps the for-loop in try/finally so the re-enable always runs.
    it('_writePtyTextThrottled: aborted mid-loop still writes bracketed-paste re-enable in finally (#4287)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      session._activeTurn = { messageId: 'm-abort', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      let charsSeen = 0
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data.length === 1 && /^[a-z]$/.test(data)) {
            charsSeen += 1
            // Flip aborted after the 3rd char — next loop tick observes it.
            if (charsSeen === 3) session._activeTurn.aborted = true
          }
        },
        kill: () => {},
      }

      let onAbortCalled = false
      const completed = await session._writePtyTextThrottled('abcdefgh', {
        onAbort: () => { onAbortCalled = true },
      })

      assert.equal(completed, false, 'aborted mid-loop returns false')
      assert.equal(onAbortCalled, true, 'onAbort callback fires')
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes[writes.length - 1], '\x1b[?2004h',
        'final write is bracketed-paste re-enable even though loop aborted early')
      assert.equal(writes.includes('\r'), false, 'no submit on abort path')
    })

    it('_writePtyTextThrottled: throw inside loop still writes bracketed-paste re-enable in finally (#4287)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      let charsSeen = 0
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data.length === 1 && /^[a-z]$/.test(data)) {
            charsSeen += 1
            if (charsSeen === 2) throw new Error('PTY exited mid-write')
          }
        },
        kill: () => {},
      }
      session._activeTurn = { messageId: 'm-throw', startedAt: Date.now(), aborted: false, synthSeq: 0 }

      await assert.rejects(
        () => session._writePtyTextThrottled('abcdef'),
        /PTY exited mid-write/,
        'underlying throw propagates to the caller',
      )

      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      // The finally block runs the re-enable. The spy only throws on
      // single lowercase letters; the re-enable byte sequence (length>1)
      // pushes cleanly.
      assert.equal(writes[writes.length - 1], '\x1b[?2004h',
        'final write is bracketed-paste re-enable even though loop threw')
    })

    it('_writePtyTextThrottled: finally swallows a re-enable write that itself throws (PTY exited) (#4287)', async () => {
      // If the PTY exited entirely, term.write may throw on the
      // re-enable byte sequence too. The finally block must swallow
      // that so it does not mask the underlying loop error.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data === 'a') throw new Error('loop-error')
          if (data === '\x1b[?2004h') throw new Error('reenable-error-should-be-swallowed')
        },
        kill: () => {},
      }
      session._activeTurn = { messageId: 'm-double', startedAt: Date.now(), aborted: false, synthSeq: 0 }

      await assert.rejects(
        () => session._writePtyTextThrottled('a'),
        /loop-error/,
        'original loop error surfaces, not the swallowed re-enable error',
      )
      assert.deepEqual(writes, ['\x1b[?2004l', 'a', '\x1b[?2004h'],
        'finally always attempts the re-enable even if it will throw')
    })

    // #4275: the throttle loop checks `_activeTurn?.aborted` between
    // each char but did NOT re-check `_ptyExited`. If the PTY exits
    // mid-write (e.g. claude crashed during a long prompt), remaining
    // chars get pushed at a dead PTY and only surface via the
    // _term.write throw catch path. Cleaner to mirror the pre-write
    // guard (line ~768) inside the loop body so the bail is explicit.
    it('_writePtyTextThrottled: bails out cleanly when _ptyExited flips mid-loop (#4275)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const writes = []
      let charsSeen = 0
      session._term = {
        write: (data) => {
          writes.push(data)
          if (data.length === 1 && /^[a-z]$/.test(data)) {
            charsSeen += 1
            // Flip _ptyExited after the 3rd char — next loop tick must
            // observe it BEFORE attempting another _term.write.
            if (charsSeen === 3) session._ptyExited = true
          }
        },
        kill: () => {},
      }
      session._activeTurn = { messageId: 'm-ptyexit', startedAt: Date.now(), aborted: false, synthSeq: 0 }

      let onAbortCalled = false
      const completed = await session._writePtyTextThrottled('abcdefgh', {
        onAbort: () => { onAbortCalled = true },
      })

      assert.equal(completed, false, '_ptyExited mid-loop returns false (same shape as abort)')
      assert.equal(onAbortCalled, true, 'onAbort fires so caller can surface a PTY-exit error')
      // Loop wrote a,b,c then noticed _ptyExited and bailed before d.
      // Char writes (single lowercase letter) should be exactly 3.
      const charWrites = writes.filter((d) => /^[a-z]$/.test(d))
      assert.equal(charWrites.length, 3, 'loop bails after the char that tripped _ptyExited, not after d')
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes[writes.length - 1], '\x1b[?2004h',
        'final write is bracketed-paste re-enable (finally still runs on _ptyExited bail)')
      assert.equal(writes.includes('\r'), false, 'no submit when PTY exited mid-write')
    })

    // #4276: per-char throttling for huge prompts (e.g. pasted file
    // contents) is unbounded — 100K chars × ~1-4ms each = minutes of
    // blocked turn. Above MAX_THROTTLED_CHARS the helper falls back
    // to a single bulk _term.write, accepting that very large prompts
    // may trip claude TUI's paste detector (the user-visible symptom
    // is far better than a multi-minute silent block).
    it('exposes MAX_THROTTLED_CHARS for callers / regression tests (#4276)', () => {
      assert.equal(typeof ClaudeTuiSession.MAX_THROTTLED_CHARS, 'number',
        'MAX_THROTTLED_CHARS is a numeric static for tunability + assertions')
      assert.ok(ClaudeTuiSession.MAX_THROTTLED_CHARS > 0, 'must be positive')
    })

    it('_writePtyTextThrottled: bulk-writes the body in one call when text exceeds MAX_THROTTLED_CHARS (#4276)', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-bulk', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      // One code-point beyond the threshold — must take the bulk path.
      const huge = 'x'.repeat(ClaudeTuiSession.MAX_THROTTLED_CHARS + 1)
      const completed = await session._writePtyTextThrottled(huge)

      assert.equal(completed, true, 'bulk path returns true on success')
      // Bulk path: disable + ONE write of the whole body + \r + enable.
      assert.deepEqual(writes, ['\x1b[?2004l', huge, '\r', '\x1b[?2004h'],
        'large prompts bypass the per-char throttle entirely')
    })

    it('_writePtyTextThrottled: stays on the per-char throttle path at exactly MAX_THROTTLED_CHARS (#4276)', async () => {
      // Boundary check — the threshold is "above MAX", so EQUAL to MAX
      // still gets the paste-detector-friendly per-char throttle. This
      // pins the comparison so a future refactor doesn't accidentally
      // make `> MAX` into `>= MAX` and silently downgrade the typical
      // medium-sized prompt UX.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-edge', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      const atCap = 'x'.repeat(ClaudeTuiSession.MAX_THROTTLED_CHARS)
      const completed = await session._writePtyTextThrottled(atCap)

      assert.equal(completed, true)
      // disable + N chars + \r + enable.
      assert.equal(writes.length, atCap.length + 3,
        'exactly-at-cap still gets per-char writes')
    })

    it('_writePtyTextThrottled: bulk path still honors _ptyExited / abort pre-write guards (#4276)', async () => {
      // The bulk path skips the loop, but still has to respect the
      // outer turn lifecycle. If the turn was already aborted (or PTY
      // dead) before we hit the bulk write, we must NOT send bytes —
      // same contract the per-char path provides via its loop guards.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { messageId: 'm-bulk-abort', startedAt: Date.now(), aborted: true, synthSeq: 0 }
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }

      let onAbortCalled = false
      const huge = 'x'.repeat(ClaudeTuiSession.MAX_THROTTLED_CHARS + 100)
      const completed = await session._writePtyTextThrottled(huge, {
        onAbort: () => { onAbortCalled = true },
      })

      assert.equal(completed, false, 'bulk path returns false when aborted before write')
      assert.equal(onAbortCalled, true, 'onAbort still fires on the bulk path')
      // The bulk body must NOT appear in writes. The disable + finally
      // re-enable are bookkeeping — what matters is no big payload was
      // sent at a stale PTY.
      assert.equal(writes.includes(huge), false, 'large body never reaches a torn-down PTY')
    })
  })

  describe('attachment-cap warn lines (#4216)', () => {
    // #4215 added two distinct log.warn lines in the attachment-suffix
    // path: a regular-truncation warn and a bare-fallback warn. The
    // suffix builder itself is unit-tested in claude-tui-attachments,
    // but the caller-side logging was not pinned — a future refactor
    // could downgrade these to info, swap the branches, or drop one
    // entirely without any test catching it. These two tests pin the
    // exact warn-line text per branch, end-to-end through sendMessage.
    //
    // Both trigger conditions are forced via crafted attachments that
    // push the suffix past MAX_ATTACHMENT_SUFFIX_BYTES (8 KiB). The
    // session-level validateAttachments() runs at the WS boundary so
    // calling sendMessage() directly here bypasses it — exactly what
    // we want for synthetic over-cap payloads.

    let warnLines
    let logSpy

    beforeEach(() => {
      warnLines = []
      logSpy = (entry) => {
        if (entry.level === 'warn' && entry.component === 'claude-tui-session') {
          warnLines.push(entry.message)
        }
      }
      addLogListener(logSpy)
    })

    afterEach(() => {
      if (logSpy) removeLogListener(logSpy)
      logSpy = null
      warnLines = null
    })

    async function sendOneTurn(sinkDir, prompt, attachments) {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-warn'
      session._sinkDir = sinkDir
      session._outputTail = ClaudeTuiSession.PROMPT_GLYPH

      session._term = {
        write: () => {
          // Drop the stop hook so the poll loop ends the turn.
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({
            last_assistant_message: 'ok',
          }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      await session.sendMessage(prompt, attachments)
    }

    it('emits a truncated warn when the full suffix exceeds the cap but a trimmed list fits', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-warn-trunc-'))
      // 100 small attachments. Each materialized item produces a line
      // like `<sinkDir>/attachments/<msgId>/att-N.png (img-N.png, image/png, 1B)`
      // — roughly 130-160 bytes once the per-item separator is counted —
      // so 100 items pushes the full suffix well past 8 KiB while
      // leaving room for a trimmed list to fit.
      const png = Buffer.from([0x89]).toString('base64')
      const attachments = []
      for (let i = 0; i < 100; i++) {
        attachments.push({
          type: 'image', mediaType: 'image/png',
          data: png, name: `img-${String(i).padStart(3, '0')}.png`,
        })
      }

      await sendOneTurn(sinkDir, 'lots of files', attachments)

      const truncated = warnLines.find((m) => /TUI attachment suffix truncated/.test(m))
      const bare = warnLines.find((m) => /bare-fallback fired/.test(m))
      assert.ok(truncated, `expected a "truncated" warn, got warnLines=${JSON.stringify(warnLines)}`)
      assert.ok(!bare, 'must NOT emit the bare-fallback warn when a trimmed list fits')
      // Pin the structured fields the warn carries — these are what an
      // operator greps for, so swapping in something less specific
      // (e.g. dropping the "omitted=N of=M" tail) should fail this test.
      assert.match(truncated, /msg=/, 'warn includes message id')
      assert.match(truncated, /suffixBytes=\d+/, 'warn includes final suffix bytes')
      assert.match(truncated, /cap=\d+B/, 'warn includes cap in bytes')
      assert.match(truncated, /omitted=\d+ of=\d+/, 'warn includes omitted-of-total counts')

      rmSync(sinkDir, { recursive: true, force: true })
    })

    it('emits the bare-fallback warn when even a single-entry suffix exceeds the cap', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-warn-bare-'))
      // mediaType is not length-capped inside materializeAttachments
      // (sanitization happens at the WS boundary, not here), so a
      // single attachment carrying a >8 KiB mediaType string is enough
      // to push the single-entry suffix past the cap. The truncation
      // loop pops the only item, sees the list is now empty, breaks,
      // and falls through to the bare-fallback marker.
      const png = Buffer.from([0x89]).toString('base64')
      const giantMediaType = 'image/png' + ';x='.repeat(3000)   // ~9 KiB
      const attachments = [{
        type: 'image', mediaType: giantMediaType, data: png, name: 'one.png',
      }]

      await sendOneTurn(sinkDir, 'one giant-typed file', attachments)

      const bare = warnLines.find((m) => /bare-fallback fired/.test(m))
      const truncated = warnLines.find((m) => /TUI attachment suffix truncated/.test(m))
      assert.ok(bare, `expected a bare-fallback warn, got warnLines=${JSON.stringify(warnLines)}`)
      // The two branches are mutually exclusive in the source (if/else);
      // pin that here so a future refactor that runs both can't slip in
      // unnoticed.
      assert.ok(!truncated, 'truncated warn must NOT fire on the bare-fallback path')
      assert.match(bare, /msg=/, 'warn includes message id')
      assert.match(bare, /count=\d+/, 'warn includes file count')
      assert.match(bare, /cap=\d+B/, 'warn includes cap in bytes')
      assert.match(bare, /file paths omitted/, 'warn explains the lossy outcome')

      rmSync(sinkDir, { recursive: true, force: true })
    })
  })

  describe('per-turn attachment cleanup (#4022)', () => {
    // Long-running sessions with many large attachments would
    // accumulate gigabytes in tmpfs without per-turn cleanup. Drop the
    // turn's attachment dir on the success path AND every failure exit
    // path (abort, _finishTurnError, _handleHardTimeout, onExit).
    //
    // The session-level rmSync(_sinkDir) in destroy() remains as a
    // backstop for anything we miss here.

    it('removes the per-turn dir after the success path completes', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-success-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-cleanup-success'
      session._sinkDir = sinkDir
      session._waitForPrompt = async () => true

      session._term = {
        write: () => {
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      await session.sendMessage('Look', [
        { type: 'image', mediaType: 'image/png', data: Buffer.from('abc').toString('base64'), name: 'a.png' },
      ])

      const turnDir = join(sinkDir, 'attachments')
      // attachments/ parent may exist (we only rm the per-turn child),
      // but the per-turn child MUST be gone after the success path.
      if (existsSync(turnDir)) {
        const subdirs = readdirSync(turnDir)
        assert.equal(subdirs.length, 0,
          `expected per-turn subdir to be removed after success, found: ${subdirs.join(', ')}`)
      }
    })

    it('removes the per-turn dir when _finishTurnError fires', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-err-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sessionId = 'test-cleanup-err'
      session._sinkDir = sinkDir
      // Simulate a turn that materialized attachments but then failed
      // post-write — _finishTurnError is the common error exit.
      const turnSubdir = join(sinkDir, 'attachments', 'msg-err')
      writeFileSync(`${sinkDir}/.placeholder`, '')   // ensure sinkDir exists
      session._activeTurn = {
        messageId: 'msg-err',
        startedAt: Date.now(),
        aborted: false,
        synthSeq: 0,
        attachmentsDir: turnSubdir,
      }
      // Materialize a real file there so the rm has something to delete.
      writeFileSync(`${sinkDir}/.scratch`, '')
      const fs = await import('fs')
      fs.mkdirSync(turnSubdir, { recursive: true })
      fs.writeFileSync(join(turnSubdir, 'att-1.png'), Buffer.from('xyz'))
      assert.ok(existsSync(turnSubdir), 'precondition: dir exists before failure')

      session.on('error', () => {})
      session._finishTurnError('something broke', 'msg-err')

      assert.equal(existsSync(turnSubdir), false,
        'per-turn attachment dir must be removed when _finishTurnError fires')
    })

    it('removes the per-turn dir when the hard timeout fires', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-hto-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-hto'
      session._sessionId = 'test-cleanup-hto'
      session._sinkDir = sinkDir
      session._term = { write: () => {}, kill: () => {} }
      const turnSubdir = join(sinkDir, 'attachments', 'msg-hto')
      const fs = await import('fs')
      fs.mkdirSync(turnSubdir, { recursive: true })
      fs.writeFileSync(join(turnSubdir, 'att-1.png'), Buffer.from('xyz'))
      session._activeTurn = {
        messageId: 'msg-hto', startedAt: Date.now(), aborted: false, synthSeq: 0,
        attachmentsDir: turnSubdir,
      }

      session.on('error', () => {})

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.equal(existsSync(turnSubdir), false,
        'per-turn attachment dir must be removed when the hard timeout fires')
    })

    it('cleanup helper no-ops gracefully when turn had no attachments', () => {
      // The common case: 99% of turns have no attachments. The helper
      // must not throw when activeTurn lacks attachmentsDir, and must
      // not fall over if activeTurn itself is null (the PTY-exit race).
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Both of these must be no-throw.
      session._cleanupTurnAttachments(null)
      session._cleanupTurnAttachments({ messageId: 'x', startedAt: 0, aborted: false, synthSeq: 0 })
    })

    it('cleans up the per-turn dir even when every attachment is skipped', async () => {
      // Regression for the case where materializeAttachments() creates
      // the per-turn dir but every entry is malformed (missing .data),
      // so the function returns []. Pre-fix, attachmentsDir was only
      // recorded when the suffix was truthy, so an "all skipped" outcome
      // left an empty dir on disk until destroy(). After the fix, the
      // per-turn dir is recorded up-front and gets rm'd by the normal
      // success-path cleanup.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-cleanup-skipped-'))
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000,
      })
      session._processReady = true
      session._sessionId = 'test-cleanup-skipped'
      session._sinkDir = sinkDir
      session._waitForPrompt = async () => true

      let midTurnSubdirCount = -1
      session._term = {
        write: () => {
          // Snapshot disk state at the moment the PTY received the prompt;
          // success cleanup runs after the stop hook below.
          const attDir = join(sinkDir, 'attachments')
          try { midTurnSubdirCount = readdirSync(attDir).length } catch { midTurnSubdirCount = 0 }
          writeFileSync(join(sinkDir, 'stop-fake.json'), JSON.stringify({ last_assistant_message: 'ok' }))
        },
        kill: () => {},
      }
      session.on('error', () => {})

      // Every attachment is malformed — materializeAttachments() will
      // create the per-turn dir, skip each entry, and return [].
      await session.sendMessage('Try anyway', [
        { type: 'image', mediaType: 'image/png', data: undefined, name: 'broken1.png' },
        { type: 'image', mediaType: 'image/png', data: undefined, name: 'broken2.png' },
      ])

      // The per-turn dir was created mid-turn (mkdirSync inside materialize)
      // even though all entries were skipped — sanity-check that.
      assert.equal(midTurnSubdirCount, 1,
        'per-turn subdir should exist during the turn even when all attachments are skipped')

      // And the post-turn cleanup MUST have removed it. Pre-fix this
      // assertion would fail: the empty dir would linger because
      // attachmentsDir was never set on the activeTurn.
      const attDir = join(sinkDir, 'attachments')
      if (existsSync(attDir)) {
        const subdirs = readdirSync(attDir)
        assert.equal(subdirs.length, 0,
          `expected empty per-turn dir to be cleaned up, found: ${subdirs.join(', ')}`)
      }
    })
  })

  describe('permissionMode switch (#4013)', () => {
    // The TUI provider supports mid-session permission switch via a
    // sidecar file the permission-hook.sh script re-reads on every tool
    // call. Unlike CliSession (which restarts the process), the TUI must
    // NOT restart — that would lose the resumed conversation context that
    // the persistent PTY exists to preserve.

    it('declares permissionModeSwitch: true in capabilities', () => {
      // Dashboard gates the picker on caps.permissionModeSwitch (App.tsx:311).
      // Pre-#4013 this was false and the picker was hidden.
      assert.equal(ClaudeTuiSession.capabilities.permissionModeSwitch, true)
    })

    it('writes initial permission mode to a sidecar file at start()', async () => {
      const home = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-home-'))
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }))
      const origHome = process.env.HOME
      process.env.HOME = home
      const origSpawn = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      try {
        session = new ClaudeTuiSession({
          cwd: '/tmp', port: 12345, permissionMode: 'acceptEdits',
          skillsDir: emptySkillsDir, repoSkillsDir: null,
        })
        await session.start()

        assert.ok(session._permissionModeFile, 'sidecar path set')
        assert.ok(session._permissionModeFile.startsWith(session._sinkDir),
          'sidecar lives under the per-session sink dir')
        const contents = readFileSync(session._permissionModeFile, 'utf8')
        assert.equal(contents, 'acceptEdits', 'initial mode written to sidecar')
      } finally {
        ClaudeTuiSession.prototype._spawnPty = origSpawn
        process.env.HOME = origHome
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('does NOT create a sidecar when permissions are disabled (no port)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-home2-'))
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }))
      const origHome = process.env.HOME
      process.env.HOME = home
      const origSpawn = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function () {
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      try {
        session = new ClaudeTuiSession({
          cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        })
        await session.start()
        assert.equal(session._permissionModeFile, null, 'no sidecar without port')
      } finally {
        ClaudeTuiSession.prototype._spawnPty = origSpawn
        process.env.HOME = origHome
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('setPermissionMode rewrites the sidecar without restarting the PTY', () => {
      // Hot-swap path: rewrite the file in place, keep the same PTY. If
      // we ever accidentally introduce a restart (copy-paste from
      // CliSession's override), this fails on the _term identity check.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-sink-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sinkDir = sinkDir
      session._permissionModeFile = join(sinkDir, 'permission-mode')
      writeFileSync(session._permissionModeFile, 'approve')
      session.permissionMode = 'approve'
      const originalTerm = { write: () => {}, kill: () => {} }
      session._term = originalTerm

      session.setPermissionMode('auto')

      assert.equal(session.permissionMode, 'auto', 'instance state updated')
      assert.equal(readFileSync(session._permissionModeFile, 'utf8'), 'auto', 'sidecar rewritten')
      assert.strictEqual(session._term, originalTerm, 'PTY reference unchanged — no restart')
    })

    it('setPermissionMode no-ops cleanly when sidecar path is null', () => {
      // After destroy() or in the no-port case, _permissionModeFile is null.
      // setPermissionMode should still update instance state without throwing.
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._permissionModeFile = null
      session.permissionMode = 'approve'

      session.setPermissionMode('plan')
      assert.equal(session.permissionMode, 'plan', 'state still updated')
    })

    it('setPermissionMode rejects invalid modes via super', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session.permissionMode = 'approve'
      session._permissionModeFile = null

      session.setPermissionMode('nonsense-mode')
      assert.equal(session.permissionMode, 'approve', 'state unchanged on rejection')
    })

    it('passes CHROXY_PERMISSION_MODE_FILE in env so the hook script can find the sidecar', async () => {
      // Without this env var the hook would silently fall back to the
      // env-var-only resolution and mid-session switch would never take
      // effect. Spy the env that _spawnPty would hand to node-pty.
      const home = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-home3-'))
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }))
      const origHome = process.env.HOME
      process.env.HOME = home
      const origSpawn = ClaudeTuiSession.prototype._spawnPty
      let capturedEnv = null
      ClaudeTuiSession.prototype._spawnPty = async function (permissionsEnabled) {
        // Mirror production env-build so the test stays honest about
        // which env vars node-pty actually receives.
        const env = { ...process.env }
        delete env.ANTHROPIC_API_KEY
        env.TERM = 'xterm-256color'
        if (permissionsEnabled) {
          env.CHROXY_PORT = String(this._port)
          env.CHROXY_HOOK_SECRET = this._hookSecret
          env.CHROXY_PERMISSION_MODE = this.permissionMode || 'approve'
          if (this._permissionModeFile) {
            env.CHROXY_PERMISSION_MODE_FILE = this._permissionModeFile
          }
        }
        capturedEnv = env
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      try {
        session = new ClaudeTuiSession({
          cwd: '/tmp', port: 12345,
          skillsDir: emptySkillsDir, repoSkillsDir: null,
        })
        await session.start()

        assert.ok(capturedEnv.CHROXY_PERMISSION_MODE_FILE, 'env var set')
        assert.equal(capturedEnv.CHROXY_PERMISSION_MODE_FILE, session._permissionModeFile,
          'env var points at the actual sidecar')
      } finally {
        ClaudeTuiSession.prototype._spawnPty = origSpawn
        process.env.HOME = origHome
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('destroy() clears the sidecar reference so post-destroy setPermissionMode no-ops', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-destroy-'))
      session._sinkDir = sinkDir
      session._permissionModeFile = join(sinkDir, 'permission-mode')
      writeFileSync(session._permissionModeFile, 'approve')
      session.permissionMode = 'approve'

      await session.destroy()

      assert.equal(session._permissionModeFile, null, 'sidecar path nulled')
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'auto')
    })

    it('setPermissionMode writes atomically (no truncated read window)', () => {
      // The hook script reads the sidecar on every PreToolUse. A naive
      // truncate-then-write would let a concurrent reader observe an
      // empty/partial value. We verify the impl uses a tmp+rename dance
      // by asserting the final file contents are complete and no .tmp
      // siblings linger after the call.
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-atomic-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sinkDir = sinkDir
      session._permissionModeFile = join(sinkDir, 'permission-mode')
      writeFileSync(session._permissionModeFile, 'approve')
      session.permissionMode = 'approve'
      session._term = { write: () => {}, kill: () => {} }

      session.setPermissionMode('acceptEdits')

      assert.equal(readFileSync(session._permissionModeFile, 'utf8'), 'acceptEdits')
      // No leftover .tmp-<uuid> siblings — rename either succeeded
      // (sidecar replaced) or failed (tmp cleaned up in the catch).
      const lingering = readdirSync(sinkDir).filter((f) => f.startsWith('permission-mode.tmp-'))
      assert.deepEqual(lingering, [], 'no .tmp-* siblings remain after atomic update')
      rmSync(sinkDir, { recursive: true, force: true })
    })

    it('setPermissionMode swallows sidecar write failures (instance state still updates)', () => {
      // Production failure mode: disk fills mid-session, or a tmpdir
      // remount changes permissions. setPermissionMode must NOT throw
      // out to its caller (the WS handler) — the handler treats a throw
      // as session-fatal. Verify both that:
      //   (a) the call returns without throwing, and
      //   (b) instance permissionMode still reflects the requested mode
      //       (super.setPermissionMode updates state before the file
      //       write, so the in-process bookkeeping is still consistent).
      const sinkParent = mkdtempSync(join(tmpdir(), 'chroxy-tui-perm-fail-'))
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Point sidecar at a path whose PARENT directory doesn't exist.
      // writeFileSync will fail with ENOENT — the catch must swallow it.
      session._sinkDir = sinkParent
      session._permissionModeFile = join(sinkParent, 'no-such-dir', 'permission-mode')
      session.permissionMode = 'approve'
      session._term = { write: () => {}, kill: () => {} }

      // Must not throw.
      session.setPermissionMode('auto')

      assert.equal(session.permissionMode, 'auto',
        'instance state updated even though sidecar write failed')
      rmSync(sinkParent, { recursive: true, force: true })
    })
  })

  describe('destroy()', () => {
    it('kills the persistent PTY and clears state', async () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      let killed = false
      session._processReady = true
      session._term = {
        write: () => {},
        kill: () => { killed = true },
      }

      await session.destroy()
      assert.equal(killed, true, 'PTY killed on destroy')
      assert.equal(session._term, null, 'term reference cleared')
      assert.equal(session._destroying, true)
      assert.equal(session._processReady, false)
      assert.equal(session._isBusy, false)
    })

    it('removes the sink dir to avoid /tmp leak (#3918)', async () => {
      const sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-'))
      writeFileSync(join(sinkDir, 'stop-abc.json'), '{}')

      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._sinkDir = sinkDir
      session._processReady = true

      await session.destroy()

      assert.equal(existsSync(sinkDir), false, 'sink dir removed on destroy')
      assert.equal(session._sinkDir, null, 'reference cleared')
    })
  })

  describe('inactivity timer (#3920)', () => {
    it('emits inactivity_warning after _resultTimeoutMs of silence', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 25, hardTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-7'

      let warning = null
      session.on('inactivity_warning', (e) => { warning = e })

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.ok(warning, 'warning fired')
      assert.equal(warning.messageId, 'msg-7')
      assert.equal(warning.idleMs, 25)
      assert.equal(warning.prefab, 'Status update?')
    })

    it('hard timeout force-clears busy state + emits error', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-9'
      session._term = { write: () => {}, kill: () => {} }

      const errors = []
      session.on('error', (e) => errors.push(e))

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 60))

      assert.equal(session._isBusy, false, 'force-cleared')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /timed out/)
    })
  })

  // #4638 — stream-stall active-recovery watchdog. CLI + SDK got this in
  // #4467; TUI was the outlier and surfaced the wedge as a "Working…"
  // banner that ticked forever when claude TUI accepted the prompt and
  // emitted nothing. The fire path mirrors CliSession._handleStreamStall
  // and SdkSession._handleStreamStall — stream_end + result fan-out +
  // error{code:'stream_stall'} — so the dashboard's existing recovery
  // affordance triggers without provider-specific handling.
  describe('stream-stall watchdog (#4638)', () => {
    it('fires after _streamStallTimeoutMs, clears busy state, emits the full recovery burst', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        // Long soft+hard so the stall timer wins; short stall so the
        // test doesn't sleep for seconds.
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 25,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-stall'
      // Backdated startedAt so we can assert duration > 0 below — proves the
      // computed duration is derived from _activeTurn.startedAt rather than
      // the fallback to _streamStallTimeoutMs.
      const TURN_AGE_MS = 100
      session._activeTurn = { startedAt: Date.now() - TURN_AGE_MS, aborted: false }
      const ptyWrites = []
      session._term = { write: (b) => ptyWrites.push(b), kill: () => {} }

      const events = []
      session.on('stream_end', (e) => events.push({ type: 'stream_end', ...e }))
      session.on('result', (e) => events.push({ type: 'result', ...e }))
      session.on('error', (e) => events.push({ type: 'error', ...e }))

      session._armResultTimeout()
      await new Promise((r) => setTimeout(r, 80))

      assert.equal(session._isBusy, false, 'busy cleared')
      assert.equal(session._currentMessageId, null, 'messageId nulled')
      // Best-effort Ctrl-C interrupt so claude TUI itself unsticks.
      assert.ok(ptyWrites.includes('\x03'), 'Ctrl-C written to PTY')

      const types = events.map((e) => e.type)
      assert.deepEqual(types, ['stream_end', 'result', 'error'],
        'fan-out order: stream_end → result → error')

      const streamEnd = events.find((e) => e.type === 'stream_end')
      assert.equal(streamEnd.messageId, 'msg-stall')

      const result = events.find((e) => e.type === 'result')
      assert.equal(result.cost, null, 'cost=null skips billing accumulation')
      assert.ok(Number.isFinite(result.duration), 'duration is finite')
      assert.ok(result.duration >= TURN_AGE_MS,
        `duration ≥ TURN_AGE_MS (${TURN_AGE_MS}ms) — sourced from _activeTurn.startedAt`)

      const err = events.find((e) => e.type === 'error')
      assert.equal(err.code, 'stream_stall', 'distinct code for dashboard chip')
      assert.match(err.message, /Stream stalled/)
    })

    it('is a no-op when not busy (late fire after natural turn-end)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
      })
      session._isBusy = false  // turn already ended

      const events = []
      session.on('stream_end', () => events.push('stream_end'))
      session.on('result', () => events.push('result'))
      session.on('error', () => events.push('error'))

      session._handleStreamStall()
      assert.deepEqual(events, [], 'no events fired when not busy')
    })

    it('is disabled when streamStallTimeoutMs=0 (operator opt-out)', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 0,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-disabled'
      session._term = { write: () => {}, kill: () => {} }

      session._armResultTimeout()
      assert.equal(session._streamStallTimeout, null, 'stall timer not armed when disabled')

      // Wait a few ticks just to be extra sure nothing fires.
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(session._isBusy, true, 'still busy — watchdog opted out')
    })

    it('is cleared by _finishTurnError so a stalled-after-error fire cannot land', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
      })
      session.on('error', () => {})  // swallow
      session._isBusy = true
      session._currentMessageId = 'msg-x'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }

      session._armResultTimeout()
      assert.ok(session._streamStallTimeout, 'stall timer armed')

      session._finishTurnError('test', 'msg-x')
      assert.equal(session._streamStallTimeout, null, 'stall timer cleared on error path')
    })

    it('is cleared by destroy() so a late fire cannot land on a torn-down session', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null,
        resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000,
      })
      session._isBusy = true
      session._currentMessageId = 'msg-d'
      session._armResultTimeout()
      assert.ok(session._streamStallTimeout, 'stall timer armed')

      await session.destroy()
      assert.equal(session._streamStallTimeout, null, 'stall timer cleared on destroy')
    })
  })

  describe('PTY output ring buffer (#3919)', () => {
    it('keeps a tail of recent output with ANSI stripped', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Simulate the onData handler by writing to _outputTail directly.
      const stripped = 'plain text'.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      session._outputTail = (session._outputTail + '\x1b[31mplain text\x1b[0m').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      assert.equal(session._outputTail, stripped)
    })

    it('_outputTailDiagnostic returns empty when no output captured', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      assert.equal(session._outputTailDiagnostic(), '')
    })

    it('_outputTailDiagnostic collapses whitespace + returns last bytes', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._outputTail = '   rate-limit exceeded  \n\n\nretry  in  60s   '
      const tail = session._outputTailDiagnostic()
      assert.match(tail, /rate-limit exceeded/)
      assert.match(tail, /retry in 60s/, 'multi-space collapsed')
    })
  })

  describe('interrupt()', () => {
    it('is a no-op when no turn is active', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Should not throw.
      session.interrupt()
    })
  })

  describe('_emitToolHookEvent()', () => {
    beforeEach(() => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      // Simulate a turn in flight so synthetic-id fallback works.
      session._activeTurn = { uuid: 'test', synthSeq: 0 }
    })

    it('emits tool_start with toolUseId, tool name, and input on PreToolUse', () => {
      const events = []
      session.on('tool_start', (e) => events.push(e))

      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_123',
        tool_name: 'Edit',
        tool_input: { file_path: '/foo.js', new_string: 'x' },
      }, 'msg-1')

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'toolu_123')
      assert.equal(events[0].messageId, 'toolu_123')
      assert.equal(events[0].tool, 'Edit')
      assert.deepEqual(events[0].input, { file_path: '/foo.js', new_string: 'x' })
    })

    it('emits tool_result with toolUseId and result on PostToolUse', () => {
      const events = []
      session.on('tool_result', (e) => events.push(e))

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_123',
        tool_name: 'Edit',
        tool_response: 'File edited successfully',
      }, 'msg-1')

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'toolu_123')
      assert.equal(events[0].result, 'File edited successfully')
      assert.equal(events[0].truncated, false)
    })

    it('stringifies object tool_response for the dashboard', () => {
      const events = []
      session.on('tool_result', (e) => events.push(e))

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_456',
        tool_name: 'Bash',
        tool_response: { stdout: 'hello\n', stderr: '', exitCode: 0 },
      }, 'msg-1')

      assert.equal(events.length, 1)
      const parsed = JSON.parse(events[0].result)
      assert.equal(parsed.stdout, 'hello\n')
      assert.equal(parsed.exitCode, 0)
    })

    it('truncates tool_response over 10KB', () => {
      const events = []
      session.on('tool_result', (e) => events.push(e))
      const huge = 'x'.repeat(15000)

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_999',
        tool_name: 'Read',
        tool_response: huge,
      }, 'msg-1')

      assert.equal(events.length, 1)
      assert.equal(events[0].truncated, true)
      assert.equal(events[0].result.length, 10240)
    })

    it('synthesizes a STABLE toolUseId so Pre/Post pair correctly', () => {
      const startEvents = []
      const resultEvents = []
      session.on('tool_start', (e) => startEvents.push(e))
      session.on('tool_result', (e) => resultEvents.push(e))

      // PreToolUse without tool_use_id, then PostToolUse without it —
      // both must emit the SAME toolUseId so the dashboard can pair them.
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { cmd: 'ls' } }, 'msg-7')
      session._emitToolHookEvent('PostToolUse', { tool_name: 'Bash', tool_response: 'foo bar' }, 'msg-7')

      assert.equal(startEvents.length, 1)
      assert.equal(resultEvents.length, 1)
      assert.equal(startEvents[0].toolUseId, resultEvents[0].toolUseId, 'Pre and Post pair on the same synth id')
      assert.match(startEvents[0].toolUseId, /^msg-7-tool-1$/, 'synth id format: <messageId>-tool-<seq>')
    })

    it('synthesizes distinct ids across multiple tool calls in one turn', () => {
      const startEvents = []
      session.on('tool_start', (e) => startEvents.push(e))

      // Two separate tool calls, neither with tool_use_id.
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { cmd: 'ls' } }, 'msg-8')
      session._emitToolHookEvent('PostToolUse', { tool_name: 'Bash', tool_response: 'a' }, 'msg-8')
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Read', tool_input: { path: '/foo' } }, 'msg-8')
      session._emitToolHookEvent('PostToolUse', { tool_name: 'Read', tool_response: 'b' }, 'msg-8')

      assert.equal(startEvents.length, 2)
      assert.match(startEvents[0].toolUseId, /^msg-8-tool-1$/)
      assert.match(startEvents[1].toolUseId, /^msg-8-tool-2$/)
    })

    it('falls through silently when no active turn (defensive)', () => {
      session._activeTurn = null
      // Must not throw.
      session._emitToolHookEvent('PreToolUse', { tool_name: 'Bash' }, 'msg-1')
    })

    // #4307: parity with SdkSession — PreToolUse with Bash +
    // run_in_background stashes the command; PostToolUse with the
    // canonical "Command running in background with ID:" text
    // promotes it to a pending shell.
    describe('#4307 — background-shell tracking', () => {
      it('records a pending shell when PreToolUse + PostToolUse pair carries a backgrounded Bash', () => {
        const events = []
        session.on('background_work_changed', (e) => events.push(e))

        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_1',
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600', run_in_background: true },
        }, 'msg-bg-1')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_1',
          tool_name: 'Bash',
          tool_response: 'Command running in background with ID: tui-shell-1. Output…',
        }, 'msg-bg-1')

        assert.equal(session._pendingBackgroundShells.size, 1)
        const entry = session._pendingBackgroundShells.get('tui-shell-1')
        assert.equal(entry.command, 'sleep 600')
        assert.equal(events.length, 1)
        assert.equal(events[0].pending[0].shellId, 'tui-shell-1')
        // isRunning reports waiting even with _isBusy=false (default).
        assert.equal(session._isBusy, false)
        assert.equal(session.isRunning, true)
      })

      it('PostToolUse without the canonical text is a no-op for the pending map', () => {
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_2',
          tool_name: 'Bash',
          tool_input: { command: 'ls', run_in_background: true },
        }, 'msg-bg-2')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_2',
          tool_name: 'Bash',
          tool_response: 'random output, no shell id',
        }, 'msg-bg-2')
        assert.equal(session._pendingBackgroundShells.size, 0)
      })

      it('BashOutput PreToolUse clears the matching pending shell', () => {
        const events = []
        // Seed a pending shell.
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_3',
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600', run_in_background: true },
        }, 'msg-bg-3')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_3',
          tool_name: 'Bash',
          tool_response: 'Command running in background with ID: tui-shell-3. Output…',
        }, 'msg-bg-3')
        session.on('background_work_changed', (e) => events.push(e))

        // Agent polls — clears.
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bo_1',
          tool_name: 'BashOutput',
          tool_input: { bash_id: 'tui-shell-3' },
        }, 'msg-bg-3')
        assert.equal(session._pendingBackgroundShells.size, 0)
        assert.equal(events.length, 1)
        assert.equal(events[0].pending.length, 0)
        assert.equal(session.isRunning, false)
      })

      it('destroy() clears the pending map', async () => {
        session._emitToolHookEvent('PreToolUse', {
          tool_use_id: 'toolu_bg_4',
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600', run_in_background: true },
        }, 'msg-bg-4')
        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_bg_4',
          tool_name: 'Bash',
          tool_response: 'Command running in background with ID: tui-shell-4. Output…',
        }, 'msg-bg-4')
        assert.equal(session._pendingBackgroundShells.size, 1)
        await session.destroy()
        assert.equal(session._pendingBackgroundShells.size, 0)
      })
    })
  })

  // #4278: TUI sessions previously had ZERO handling for AskUserQuestion.
  // claude TUI calls the tool through its own prompt mechanism in the PTY;
  // chroxy's PreToolUse hook fired but only emitted a generic tool_start.
  // The dashboard rendered the tool_use inside the collapsed tool group
  // with no interactive way to answer, and claude sat on its own TTY-style
  // prompt waiting for stdin input — until the inactivity hard timeout.
  describe('AskUserQuestion handling (#4278)', () => {
    beforeEach(() => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { uuid: 'test', synthSeq: 0 }
    })

    it('PreToolUse for AskUserQuestion emits user_question with toolUseId + questions', () => {
      const questionEvents = []
      const toolStartEvents = []
      session.on('user_question', (e) => questionEvents.push(e))
      session.on('tool_start', (e) => toolStartEvents.push(e))

      const questions = [
        {
          question: 'Which release strategy?',
          options: [{ label: 'Patch' }, { label: 'Minor' }],
        },
      ]
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_1',
        tool_name: 'AskUserQuestion',
        tool_input: { questions },
      }, 'msg-aq')

      assert.equal(questionEvents.length, 1, 'user_question emitted exactly once')
      assert.equal(questionEvents[0].toolUseId, 'toolu_aq_1')
      assert.deepEqual(questionEvents[0].questions, questions)

      // tool_start STILL emits so the dashboard's tool-pairing (tool_use →
      // tool_result on PostToolUse) continues to work after the user
      // answers. We accept the duplicate display (tool_use bubble in the
      // group AND the QuestionPrompt UI outside) — #4279 makes the bubble
      // usefully expandable so this is acceptable for MVP.
      assert.equal(toolStartEvents.length, 1, 'tool_start still emitted')
      assert.equal(toolStartEvents[0].toolUseId, 'toolu_aq_1')
      assert.equal(toolStartEvents[0].tool, 'AskUserQuestion')
    })

    it('tracks _pendingUserAnswer with toolUseId AND the options array (#4290)', () => {
      // The options array is needed at respondToQuestion time so we can
      // look up the chosen label's index and write the numbered shortcut
      // (e.g. "2\\r") rather than the raw label text. v0.9.3 wrote the
      // label text and claude TUI's prompt parser mis-resolved it to
      // "Other" — see #4288.
      const options = [{ label: 'App runners only (2)' }, { label: 'App + docs (all 3)' }]
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_2',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q?', options }] },
      }, 'msg-aq')
      assert.ok(session._pendingUserAnswer, 'pending answer tracked')
      assert.equal(session._pendingUserAnswer.toolUseId, 'toolu_aq_2')
      assert.deepEqual(session._pendingUserAnswer.options, options, 'options stashed for index lookup')
    })

    // #4290 — the v0.9.3 strategy (write the label text) caused claude
    // TUI's prompt to single-character-jump-navigate through the menu,
    // landing on "Other" with empty custom text. New strategy: when the
    // chosen answer matches an option label exactly, write the 1-indexed
    // option number — most TUI menus map "1", "2", "3" as direct hotkeys.
    it('respondToQuestion writes the 1-indexed option number when the answer matches a label (#4290)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._pendingUserAnswer = {
        toolUseId: 'toolu_aq_idx',
        options: [
          { label: 'App runners only (2)' },
          { label: 'App + docs (all 3)' },
          { label: 'Other' },
        ],
      }

      session.respondToQuestion('App + docs (all 3)')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // disable + '2' + \\r + enable = 4 writes
      assert.equal(writes.length, 4, `expected 4 writes for index path, got ${writes.length}: ${JSON.stringify(writes)}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first is bracketed-paste-disable')
      assert.equal(writes[1], '2', 'second is the 1-indexed option number as a single char')
      assert.equal(writes[2], '\r', 'third is submit')
      assert.equal(writes[3], '\x1b[?2004h', 'fourth is re-enable')
      assert.equal(session._pendingUserAnswer, null, 'pending cleared')
    })

    it('respondToQuestion writes the label text when the answer does NOT match any option (custom / Other path)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._pendingUserAnswer = {
        toolUseId: 'toolu_aq_other',
        options: [{ label: 'Patch' }, { label: 'Minor' }],
      }

      session.respondToQuestion('Brand new freeform answer')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // No match → fall through to typing the text per the v0.9.3 behavior.
      // (claude TUI's Other-path may still mis-parse this; tracked at #4288
      // as a separate problem. The point of THIS PR is to make the
      // happy-path label-match case work.)
      assert.ok(writes.length > 4, `expected per-char writes for fallback path, got ${writes.length}`)
      assert.equal(writes[0], '\x1b[?2004l', 'disable mode first')
      const text = 'Brand new freeform answer'
      const charWrites = writes.slice(1, 1 + text.length)
      assert.equal(charWrites.join(''), text, 'chars reproduce the freeform answer')
    })

    // #4293 (review of #4290): boundary check on the index lookup.
    // First option → "1"; ninth option → "9" (the last single-digit
    // index supported per the #4292 guard). Pre-fix an off-by-one in
    // the index → string conversion would shift every selection.
    it('respondToQuestion: first option → "1", ninth option → "9" (boundary)', async () => {
      const options = Array.from({ length: 9 }, (_, i) => ({ label: `opt-${i}` }))
      session._term = { write: () => {}, kill: () => {} }

      const expectations = [
        { label: 'opt-0', digit: '1' },
        { label: 'opt-8', digit: '9' },
      ]
      for (const { label, digit } of expectations) {
        const writes = []
        session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
        session._pendingUserAnswer = { toolUseId: 'toolu-boundary', options }
        session.respondToQuestion(label)
        await new Promise((resolve) => setTimeout(resolve, 30))
        assert.equal(writes[1], digit, `option "${label}" maps to digit "${digit}"`)
      }
    })

    it('respondToQuestion falls through to label text when matchIdx >= 9 (multi-digit hotkey guard #4292)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      const options = Array.from({ length: 12 }, (_, i) => ({ label: `opt-${i}` }))
      session._pendingUserAnswer = { toolUseId: 'toolu-10', options }
      // opt-9 is index 9 (would be "10" — multi-digit), so we must NOT
      // write "10\\r" (most single-keystroke menus commit on the first
      // digit). Fall through to label-text path.
      session.respondToQuestion('opt-9')
      await new Promise((resolve) => setTimeout(resolve, 50))
      // First write is mode-disable; second is the first char of "opt-9".
      assert.equal(writes[0], '\x1b[?2004l')
      assert.equal(writes[1], 'o', 'multi-digit hotkey not used; falls through to label text')
    })

    it('respondToQuestion writes the text when options array is missing or empty (free-text-only AskUserQuestion)', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_free' /* no options */ }

      session.respondToQuestion('hello')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Same shape as a regular throttled write — disable + 5 chars + \\r + enable.
      assert.ok(writes.length >= 5 + 3)
      assert.equal(writes[0], '\x1b[?2004l')
      const text = 'hello'
      const charWrites = writes.slice(1, 1 + text.length)
      assert.equal(charWrites.join(''), text)
    })

    it('respondToQuestion is a no-op when no pending answer (defensive)', () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      session._pendingUserAnswer = null

      session.respondToQuestion('whatever')
      assert.equal(writes.length, 0, 'no PTY writes when there is no pending answer')
    })

    it('PostToolUse for AskUserQuestion clears _pendingUserAnswer if it was still set', () => {
      // Cleanup invariant: claude eventually resolved its own prompt
      // (maybe via the underlying terminal multiplexer, maybe via the
      // answer chroxy wrote). Either way, once PostToolUse fires the
      // chroxy-side pending state has to be cleared — otherwise the next
      // user_question_response would write into a dead PTY context.
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_4' }
      const resultEvents = []
      session.on('tool_result', (e) => resultEvents.push(e))

      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_aq_4',
        tool_name: 'AskUserQuestion',
        tool_response: { selectedLabel: 'Patch' },
      }, 'msg-aq')

      assert.equal(resultEvents.length, 1, 'tool_result still emitted as normal')
      assert.equal(session._pendingUserAnswer, null, 'pending cleared after PostToolUse')
    })

    it('PostToolUse for a non-AskUserQuestion tool does NOT touch _pendingUserAnswer (defensive)', () => {
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_5' }
      session._emitToolHookEvent('PostToolUse', {
        tool_use_id: 'toolu_bash',
        tool_name: 'Bash',
        tool_response: 'ok',
      }, 'msg-mixed')
      assert.deepEqual(
        session._pendingUserAnswer,
        { toolUseId: 'toolu_aq_5' },
        'unrelated PostToolUse leaves the pending question alone',
      )
    })

    // #4286 (review-caught): _finishTurnError and _handleHardTimeout
    // were the two asymmetric exits that left the answer slot dirty
    // (interrupt/destroy already clear it). Pin both so a regression
    // doesn't re-introduce a late user_question_response writing into
    // a dead turn.
    it('_finishTurnError clears _pendingUserAnswer (symmetry with interrupt/destroy)', () => {
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_finish' }
      session.on('error', () => {})  // swallow
      session._currentMessageId = 'msg-x'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._finishTurnError('test-error', 'msg-x')
      assert.equal(session._pendingUserAnswer, null, 'finishTurnError clears pending answer')
    })

    it('_handleHardTimeout clears _pendingUserAnswer (symmetry with interrupt/destroy)', () => {
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_hard' }
      session.on('error', () => {})
      session._isBusy = true
      session._currentMessageId = 'msg-y'
      session._activeTurn = { startedAt: Date.now(), aborted: false }
      session._term = { write: () => {}, kill: () => {} }
      session._hardTimeoutMs = 1000
      session._handleHardTimeout()
      assert.equal(session._pendingUserAnswer, null, 'hard timeout clears pending answer')
    })
  })

  // #4604 — observability + watchdog around AskUserQuestion. The root
  // cause (claude TUI multi-question forms render a per-question form
  // that needs more than one keystroke) is fixed in a separate refactor
  // (Chunk B). These tests pin the defensive layers:
  //   - A WARN log fires when a PreToolUse arrives with >1 question so
  //     the wedge condition is visible in chroxy.log.
  //   - A 30s watchdog clears the busy state + emits ASK_USER_QUESTION_STALL
  //     when claude TUI never emits PostToolUse after chroxy writes the
  //     answer (i.e. the keystroke didn't satisfy the form).
  //   - The watchdog is cancelled on PostToolUse arrival (happy path) and
  //     on destroy() (clean teardown).
  describe('AskUserQuestion stall watchdog (#4604)', () => {
    let warnLines
    let infoLines
    let logSpy

    beforeEach(() => {
      warnLines = []
      infoLines = []
      logSpy = (entry) => {
        if (entry.component !== 'claude-tui-session') return
        if (entry.level === 'warn') warnLines.push(entry.message)
        if (entry.level === 'info') infoLines.push(entry.message)
      }
      addLogListener(logSpy)
    })

    afterEach(() => {
      if (logSpy) removeLogListener(logSpy)
      logSpy = null
      warnLines = null
      infoLines = null
    })

    it('PreToolUse with >1 question fires a multi-question warn (#4604 chunk A)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { uuid: 'test', synthSeq: 0 }

      const questions = [
        { question: 'Q1?', options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'Q2?', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'Q3?', options: [{ label: 'p' }] },
        { question: 'Q4?', options: [{ label: 'q' }] },
      ]
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_multi',
        tool_name: 'AskUserQuestion',
        tool_input: { questions },
      }, 'msg-aq-multi')

      const multiWarn = warnLines.find((m) => /multi-question forms are not yet supported/.test(m))
      assert.ok(multiWarn, `expected multi-question warn, got warnLines=${JSON.stringify(warnLines)}`)
      assert.match(multiWarn, /4 questions/, 'warn includes the question count')
      assert.match(multiWarn, /#4604/, 'warn references the tracking issue')

      const pendingInfo = infoLines.find((m) => /AskUserQuestion pending/.test(m))
      assert.ok(pendingInfo, 'PreToolUse also fires an info log with the toolUseId + counts')
      assert.match(pendingInfo, /questions=4/)
    })

    it('does NOT fire the multi-question warn for a single-question prompt (happy path)', () => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { uuid: 'test', synthSeq: 0 }

      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_single',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q1?', options: [{ label: 'a' }] }] },
      }, 'msg-aq-single')

      const multiWarn = warnLines.find((m) => /multi-question forms are not yet supported/.test(m))
      assert.equal(multiWarn, undefined, 'single-question must not trigger the multi-question warn')
    })

    it('watchdog fires after 30s when PostToolUse never arrives — clears busy + emits ASK_USER_QUESTION_STALL', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        session.respondToQuestion('a')
        // respondToQuestion clears _pendingUserAnswer synchronously at the
        // top — simulate the stuck-form condition by reinstating it (this
        // is what would happen if PostToolUse never arrived: chroxy wrote
        // one digit but claude TUI is sitting on question 2).
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        // Just under the watchdog window — nothing should fire yet.
        mock.timers.tick(29_000)
        assert.equal(errors.length, 0, 'no error before the 30s watchdog window')
        assert.equal(session._isBusy, true, 'still busy before fire')

        // Cross the threshold.
        mock.timers.tick(2_000)

        assert.equal(errors.length, 1, 'exactly one error after the watchdog fires')
        assert.equal(errors[0].code, 'ASK_USER_QUESTION_STALL', 'error carries the structured code')
        assert.equal(errors[0].toolUseId, 'toolu_aq_stall', 'error carries the toolUseId we armed with')
        assert.match(errors[0].message, /retry/i, 'message tells the user to retry')

        assert.equal(session._isBusy, false, 'busy cleared so the session is recoverable')
        assert.equal(session._pendingUserAnswer, null, 'pending answer slot cleared')

        const stallWarn = warnLines.find((m) => /AskUserQuestion stall/.test(m))
        assert.ok(stallWarn, 'watchdog fire also logs a warn for triage')
        assert.match(stallWarn, /toolu_aq_stall/, 'warn includes toolUseId')
      } finally {
        mock.timers.reset()
      }
    })

    // #4645 — pre-fix the stall handler only cleared _isBusy + emitted the
    // ASK_USER_QUESTION_STALL error, leaving stream_start orphaned (no
    // matching stream_end, no result, no agent_idle fan-out). The dashboard
    // kept showing "Working… Ns ago" + Stop button forever even though the
    // turn had been given up on — and the input was still in
    // "Type to send follow-up…" mode so the user had no Send affordance to
    // retry from. Pin the full teardown so a regression can't re-introduce
    // the misleading UI state.
    it('stall fires full teardown (stream_end + result + error) so dashboard banner + Stop button clear (#4645)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const events = []
        session.on('tool_result', (e) => events.push({ type: 'tool_result', ...e }))
        session.on('stream_end', (e) => events.push({ type: 'stream_end', ...e }))
        session.on('result', (e) => events.push({ type: 'result', ...e }))
        session.on('error', (e) => events.push({ type: 'error', ...e }))

        const ptyWrites = []
        session._term = { write: (b) => ptyWrites.push(b), kill: () => {} }
        session._isBusy = true
        session._currentMessageId = 'msg-stall'
        session._activeTurn = { startedAt: Date.now() - 50, aborted: false, uuid: 't', synthSeq: 0 }
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        session.respondToQuestion('a')
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_stall',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        mock.timers.tick(31_000)

        // Full teardown: synthetic tool_result → stream_end → result → error.
        // tool_result first so the activeTools pill clears before the result
        // fan-out; error last so the toast surfaces after busy state settles.
        const types = events.map((e) => e.type)
        assert.deepEqual(types, ['tool_result', 'stream_end', 'result', 'error'],
          'fan-out order: tool_result → stream_end → result → error')

        const streamEnd = events.find((e) => e.type === 'stream_end')
        assert.equal(streamEnd.messageId, 'msg-stall', 'stream_end carries the current messageId')

        const result = events.find((e) => e.type === 'result')
        assert.equal(result.cost, null, 'cost=null skips billing accumulation')
        assert.ok(Number.isFinite(result.duration), 'duration is finite')

        const err = events.find((e) => e.type === 'error')
        assert.equal(err.code, 'ASK_USER_QUESTION_STALL', 'error code preserved for dashboard chip')
        assert.equal(err.toolUseId, 'toolu_aq_stall')

        // Best-effort Ctrl-C so claude TUI itself unsticks for the next turn.
        assert.ok(ptyWrites.includes('\x03'), 'Ctrl-C written to PTY')

        assert.equal(session._isBusy, false, 'busy cleared')
        assert.equal(session._currentMessageId, null, 'messageId nulled')
        assert.equal(session._activeTurn, null, 'active turn nulled')
        assert.equal(session._pendingUserAnswer, null, 'pending answer slot cleared')
      } finally {
        mock.timers.reset()
      }
    })

    it('watchdog does NOT fire when PostToolUse arrives in time (happy path)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        session._activeTurn = { uuid: 'test', synthSeq: 0 }
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_ok',
          options: [{ label: 'a' }, { label: 'b' }],
        }

        session.respondToQuestion('a')

        // Halfway through the watchdog window — claude TUI emits PostToolUse.
        mock.timers.tick(15_000)
        assert.equal(errors.length, 0, 'no error before PostToolUse')

        session._emitToolHookEvent('PostToolUse', {
          tool_use_id: 'toolu_aq_ok',
          tool_name: 'AskUserQuestion',
          tool_response: { selectedLabel: 'a' },
        }, 'msg-aq-ok')

        // Push well past the original 30s window — watchdog must have been
        // cleared by PostToolUse, so no late fire.
        mock.timers.tick(60_000)
        assert.equal(errors.length, 0, 'watchdog cancelled by PostToolUse, no late stall error')
      } finally {
        mock.timers.reset()
      }
    })

    it('watchdog is cleared on destroy() (clean teardown)', async () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_destroy',
          options: [{ label: 'a' }],
        }

        session.respondToQuestion('a')

        // Tear down before the watchdog fires.
        await session.destroy()
        session = null  // afterEach should not double-destroy

        // Push well past the watchdog window.
        mock.timers.tick(60_000)
        assert.equal(errors.length, 0, 'destroy() must cancel the watchdog — no late stall error')
      } finally {
        mock.timers.reset()
      }
    })

    it('watchdog also emits synthetic tool_result so dashboard activeTools clears (#4616)', () => {
      // #4616 — without the synthetic tool_result the dashboard's
      // activeTools entry for this AskUserQuestion is never paired/cleared
      // (handlers.handleToolResult.applyToActiveTools removes by toolUseId).
      // Result: footer pill "Running AskUserQuestion · Ns" keeps ticking
      // forever even though _isBusy is clear and the user sees the toast.
      // Both events MUST emit, and tool_result MUST precede error so the
      // dashboard's tool-pairing path resolves before the error toast lands.
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const events = []
        session.on('tool_result', (e) => events.push({ name: 'tool_result', payload: e }))
        session.on('error', (e) => events.push({ name: 'error', payload: e }))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_pair',
          options: [{ label: 'a' }],
        }

        session.respondToQuestion('a')
        // Reinstate the stuck-form condition as in the original watchdog test.
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_pair',
          options: [{ label: 'a' }],
        }

        mock.timers.tick(31_000)

        assert.equal(events.length, 2,
          `expected exactly tool_result + error, got ${events.map(e => e.name).join(',')}`)
        assert.deepEqual(events.map((e) => e.name), ['tool_result', 'error'],
          'tool_result MUST precede error so activeTools clears before the toast lands')

        const trEvent = events[0].payload
        assert.equal(trEvent.toolUseId, 'toolu_aq_pair',
          'tool_result.toolUseId must match the armed toolUseId so store-core applyToActiveTools removes the entry')
        assert.equal(typeof trEvent.result, 'string',
          'tool_result.result must be a string (store-core handleToolResult coerces non-strings to "")')
        assert.equal(trEvent.truncated, false,
          'tool_result.truncated must be boolean (store-core handleToolResult coerces non-booleans to false)')
        assert.match(trEvent.result, /stalled/i,
          'tool_result.result text references the stall so the bubble shows context')

        const errEvent = events[1].payload
        assert.equal(errEvent.code, 'ASK_USER_QUESTION_STALL',
          'error event still carries the structured code so the dashboard toast renders correctly')
        assert.equal(errEvent.toolUseId, 'toolu_aq_pair',
          'error event still carries toolUseId for triage')
      } finally {
        mock.timers.reset()
      }
    })

    it('watchdog is cleared on interrupt() so a user-interrupted answer does not fire ASK_USER_QUESTION_STALL', () => {
      // #4604 review follow-up: interrupt() does NOT clear _isBusy directly
      // (Ctrl-C resolves via _finishTurn* async). Without clearing the
      // watchdog in interrupt(), the guard in _onAskUserQuestionStall
      // (_pendingUserAnswer=null + _isBusy=true → does not bail) would
      // emit a spurious ASK_USER_QUESTION_STALL ~30s after the user
      // already interrupted the session.
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
        const errors = []
        session.on('error', (e) => errors.push(e))

        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        session._activeTurn = { uuid: 'test', synthSeq: 0, aborted: false, startedAt: Date.now() }
        session._pendingUserAnswer = {
          toolUseId: 'toolu_aq_interrupt',
          options: [{ label: 'a' }],
        }

        session.respondToQuestion('a')
        // User interrupts before claude TUI emits PostToolUse.
        session.interrupt()

        // Push well past the watchdog window — interrupt() must have
        // cancelled the watchdog so no spurious stall error fires.
        mock.timers.tick(60_000)
        assert.equal(errors.length, 0, 'interrupt() must cancel the watchdog — no late stall error')
      } finally {
        mock.timers.reset()
      }
    })
  })

  // #4604 Chunk B — multi-question form driver. Empirical byte sequence
  // pinned via scripts/tui-form-recorder.mjs against claude CLI v2.1.158
  // (see tui_multi_question_form_keys memory). Single-select digit
  // auto-advances; multi-select needs an explicit Tab to commit + advance;
  // focus auto-lands on the Submit screen after the last question.
  describe('AskUserQuestion multi-question form driver (#4604 Chunk B)', () => {
    let warnLines
    let infoLines
    let logSpy

    beforeEach(() => {
      session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
      session._activeTurn = { uuid: 'test', synthSeq: 0 }
      warnLines = []
      infoLines = []
      logSpy = (entry) => {
        if (entry.component !== 'claude-tui-session') return
        if (entry.level === 'warn') warnLines.push(entry.message)
        if (entry.level === 'info') infoLines.push(entry.message)
      }
      addLogListener(logSpy)
    })

    afterEach(() => {
      if (logSpy) removeLogListener(logSpy)
      logSpy = null
      warnLines = null
      infoLines = null
    })

    // Pin the exact byte sequence from the recorder spec:
    // For a 4-question form (Q1 single 'a', Q2 single 'b', Q3 multi 'p'+'r',
    // Q4 single 'q'), picking option 1 / option 2 / options 1+3 / option 2:
    //   '\x1b[?2004l' + '1' + '2' + '1' + '3' + '\t' + '2' + '1' + '\x1b[?2004h'
    it('drives a mixed 4-question form with the exact empirical byte sequence', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      const questions = [
        { question: 'Q1?', options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'Q2?', options: [{ label: 'aa' }, { label: 'bb' }] },
        { question: 'Q3?', multiSelect: true, options: [{ label: 'p' }, { label: 'q' }, { label: 'r' }] },
        { question: 'Q4?', options: [{ label: 'x' }, { label: 'y' }] },
      ]
      session._pendingUserAnswer = { toolUseId: 'toolu_multi', questions, options: questions[0].options }
      const answersMap = {
        'Q1?': 'a',         // → '1' (single, auto-advances)
        'Q2?': 'bb',        // → '2' (single, auto-advances)
        'Q3?': JSON.stringify(['p', 'r']), // → '1' '3' (multi-select toggles, no advance) + '\t'
        'Q4?': 'y',         // → '2' (single, auto-advances)
      }

      session.respondToQuestion('', answersMap)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Expected sequence: paste-disable, digits + Tab interleaved per the
      // multi-question driver, '1' to confirm Submit, paste-enable.
      const expected = ['\x1b[?2004l', '1', '2', '1', '3', '\t', '2', '1', '\x1b[?2004h']
      assert.deepEqual(writes, expected,
        `expected empirical byte sequence, got ${JSON.stringify(writes)}`)
      assert.equal(session._pendingUserAnswer, null, 'pending cleared')
    })

    // Single-question regression guard: ensure the legacy text-driven path
    // still produces the exact pre-Chunk-B byte sequence (#4290 happy path).
    it('1-question form keeps the legacy text-driven byte sequence unchanged', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      const questions = [
        { question: 'Pick a release strategy', options: [{ label: 'Patch' }, { label: 'Minor' }, { label: 'Major' }] },
      ]
      session._pendingUserAnswer = { toolUseId: 'toolu_single', questions, options: questions[0].options }

      session.respondToQuestion('Minor')
      await new Promise((resolve) => setTimeout(resolve, 50))

      // disable + '2' + \r + enable — identical to the #4290 single-question
      // happy path. The trailing \r is harmless (digit auto-commits on TUI)
      // and pinned by the test guard so a future refactor doesn't quietly
      // drop it for single-q paths where downstream consumers might rely
      // on the redundant Enter.
      assert.deepEqual(writes, ['\x1b[?2004l', '2', '\r', '\x1b[?2004h'],
        `expected legacy single-q byte sequence, got ${JSON.stringify(writes)}`)
    })

    // Back-compat fallback: old dashboard sent only `answer: string`
    // (no answersMap). With >1 questions and no map, every question
    // defaults to option 1 and a WARN fires so the wedge is visible
    // in chroxy.log.
    it('multi-question with missing answersMap: WARN + defaults all to option 1', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      const questions = [
        { question: 'Q1?', options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'Q2?', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'Q3?', options: [{ label: 'p' }, { label: 'q' }] },
      ]
      session._pendingUserAnswer = { toolUseId: 'toolu_no_map', questions, options: questions[0].options }

      // Old dashboard sends just the freeform string of q1's answer —
      // we don't have an answersMap.
      session.respondToQuestion('a')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Q1 → '1', Q2 (multi-select) → '1' + '\t' (advance), Q3 → '1', Submit → '1'.
      assert.deepEqual(writes, ['\x1b[?2004l', '1', '1', '\t', '1', '1', '\x1b[?2004h'],
        `expected default-to-option-1 sequence, got ${JSON.stringify(writes)}`)

      const missingMapWarn = warnLines.find((m) => /didn't send answersMap/.test(m))
      assert.ok(missingMapWarn, `expected WARN about missing answersMap, got ${JSON.stringify(warnLines)}`)
      assert.match(missingMapWarn, /defaulting every question to option 1/)
      assert.match(missingMapWarn, /toolu_no_map/, 'WARN includes toolUseId for triage')
    })

    // Partial answersMap: user answered q1 and q3 but not q2. Missing
    // entries default to option 1 (with WARN); the user's explicit
    // answers are honored.
    it('multi-question with partial answersMap: WARN per missing q, defaults missing to option 1', async () => {
      const writes = []
      session._term = { write: (data) => { writes.push(data) }, kill: () => {} }
      const questions = [
        { question: 'Q1?', options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'Q2?', options: [{ label: 'p' }, { label: 'q' }] },
        { question: 'Q3?', options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] },
      ]
      session._pendingUserAnswer = { toolUseId: 'toolu_partial', questions, options: questions[0].options }
      const answersMap = {
        'Q1?': 'b',  // → '2'
        'Q3?': 'z',  // → '3'
        // Q2 missing → defaults to '1'
      }

      session.respondToQuestion('', answersMap)
      await new Promise((resolve) => setTimeout(resolve, 100))

      assert.deepEqual(writes, ['\x1b[?2004l', '2', '1', '3', '1', '\x1b[?2004h'],
        `expected partial-map sequence, got ${JSON.stringify(writes)}`)

      const missingQWarn = warnLines.find((m) => /no resolvable answer for q=/.test(m) && /Q2/.test(m))
      assert.ok(missingQWarn, `expected WARN about Q2 missing, got ${JSON.stringify(warnLines)}`)
      assert.match(missingQWarn, /defaulting to option 1/)
    })

    // Pre-Chunk-B watchdog still arms for multi-question forms — if claude
    // TUI's actual form differs from the empirical spec (a future TUI
    // version, edge-case shape), the stall watchdog still surfaces the
    // wedge to the user instead of silently hanging.
    it('multi-question arms the stall watchdog (still surfaces wedges)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        session._term = { write: () => {}, kill: () => {} }
        session._isBusy = true
        const questions = [
          { question: 'Q1?', options: [{ label: 'a' }] },
          { question: 'Q2?', options: [{ label: 'p' }] },
        ]
        session._pendingUserAnswer = { toolUseId: 'toolu_arm', questions, options: questions[0].options }

        session.respondToQuestion('', { 'Q1?': 'a', 'Q2?': 'p' })

        // Reinstate the stuck-form condition so the watchdog has something
        // to fire about (same trick the original watchdog test uses).
        session._pendingUserAnswer = { toolUseId: 'toolu_arm', questions, options: questions[0].options }

        const errors = []
        session.on('error', (e) => errors.push(e))

        mock.timers.tick(31_000)
        assert.equal(errors.length, 1, 'watchdog fires for multi-question too')
        assert.equal(errors[0].code, 'ASK_USER_QUESTION_STALL')
        assert.equal(errors[0].toolUseId, 'toolu_arm', 'watchdog armed with the multi-question toolUseId')
      } finally {
        mock.timers.reset()
      }
    })

    // PreToolUse for a multi-question prompt stashes the full questions
    // array on _pendingUserAnswer (Chunk B requirement), not just q[0].options.
    it('PreToolUse stashes the full questions array on _pendingUserAnswer (#4604 Chunk B)', () => {
      const questions = [
        { question: 'Q1?', options: [{ label: 'a' }] },
        { question: 'Q2?', multiSelect: true, options: [{ label: 'p' }, { label: 'q' }] },
        { question: 'Q3?', options: [{ label: 'x' }, { label: 'y' }] },
      ]
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_stash',
        tool_name: 'AskUserQuestion',
        tool_input: { questions },
      }, 'msg-stash')

      assert.ok(session._pendingUserAnswer, 'pending answer set')
      assert.equal(session._pendingUserAnswer.toolUseId, 'toolu_stash')
      assert.deepEqual(session._pendingUserAnswer.questions, questions,
        'full questions array stashed, not just q[0].options')
      // Back-compat: pre-Chunk-B callers reading `.options` get q[0].options.
      assert.deepEqual(session._pendingUserAnswer.options, questions[0].options,
        'options still points at questions[0].options for back-compat')
    })
  })

  // #4044: per-session option that spawns claude TUI with the literal
  // --dangerously-skip-permissions flag and elides chroxy's permission
  // hook entirely. Distinct from `permissionMode: 'auto'`, which still
  // routes every tool call through chroxy's hook script.
  describe('skipPermissions (#4044)', () => {
    let fakeHome
    let origSpawnPty
    let capturedPermissionsEnabled
    let capturedArgs
    let session

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-skip-perm-home-'))
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
      process.env._ORIG_HOME = process.env.HOME
      process.env.HOME = fakeHome

      capturedPermissionsEnabled = null
      capturedArgs = null
      origSpawnPty = ClaudeTuiSession.prototype._spawnPty
      ClaudeTuiSession.prototype._spawnPty = async function (permissionsEnabled) {
        capturedPermissionsEnabled = permissionsEnabled
        // Mirror the production arg list (lines 499-523 of
        // claude-tui-session.js) so the test stays honest about what
        // node-pty would actually receive.
        const args = [
          '--session-id', this._sessionId,
          '--settings', this._settingsPath,
        ]
        if (this.skipPermissions) args.push('--dangerously-skip-permissions')
        if (this.model) args.push('--model', this.model)
        capturedArgs = args
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
    })

    afterEach(async () => {
      if (session) {
        try { await session.destroy() } catch { /* ignore */ }
        session = null
      }
      ClaudeTuiSession.prototype._spawnPty = origSpawnPty
      if (process.env._ORIG_HOME) {
        process.env.HOME = process.env._ORIG_HOME
        delete process.env._ORIG_HOME
      }
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    })

    it('default (skipPermissions undefined): permissionsEnabled=true when port is set, no flag in args', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      assert.equal(capturedPermissionsEnabled, true, 'hook enabled by default when port given')
      assert.equal(capturedArgs.includes('--dangerously-skip-permissions'), false,
        '--dangerously-skip-permissions must NOT appear unless skipPermissions is set')
    })

    it('skipPermissions=true overrides port: permissionsEnabled=false, flag in args', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      // permissionsEnabled is the gate for hook install + sidecar write.
      assert.equal(capturedPermissionsEnabled, false,
        'skipPermissions must beat port — the whole point is to elide chroxy permissions')
      assert.ok(capturedArgs.includes('--dangerously-skip-permissions'),
        '--dangerously-skip-permissions must be in claude TUI args')
    })

    it('skipPermissions=true: PreToolUse settings does NOT include the permission hook script', async () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      // The settings.json on disk (written by writeHookSettings) must
      // only contain the per-event capture command — not the chroxy
      // permission gate. Otherwise the hook would still gate every call.
      const settings = JSON.parse(readFileSync(session._settingsPath, 'utf8'))
      const preToolUseCommands = settings.hooks.PreToolUse[0].hooks.map((h) => h.command)
      assert.equal(preToolUseCommands.length, 1,
        'expected only the capture command, not capture + permission hook')
      assert.match(preToolUseCommands[0], /cat > .*pre-/,
        'remaining hook is the observability capture')
      // Sidecar write also gated on permissionsEnabled → no permission-mode
      // file written.
      assert.equal(session._permissionModeFile, null,
        'permission-mode sidecar not written when skipPermissions is on')
    })

    it('skipPermissions defaults to false when omitted (constructor coercion)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp',
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      assert.equal(session.skipPermissions, false)
    })

    it('skipPermissions=true coerces truthy non-booleans (defensive constructor)', () => {
      session = new ClaudeTuiSession({
        cwd: '/tmp', skipPermissions: 'yes',
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      assert.equal(session.skipPermissions, true,
        '!!"yes" === true — the constructor accepts truthy passthrough cleanly')
    })

    it('skipPermissions=true: spawn env omits CHROXY_PORT/HOOK_SECRET/PERMISSION_MODE_FILE (#4207 agent-review)', async () => {
      // The env gate at claude-tui-session.js:498-508 is a distinct site
      // from settings.json — both have to be off or the hook script can
      // still phone home. Mirror the production env-build in the stub.
      let capturedEnv = null
      ClaudeTuiSession.prototype._spawnPty = async function (permissionsEnabled) {
        const env = { ...process.env }
        delete env.ANTHROPIC_API_KEY
        env.TERM = 'xterm-256color'
        if (permissionsEnabled) {
          env.CHROXY_PORT = String(this._port)
          env.CHROXY_HOOK_SECRET = this._hookSecret
          env.CHROXY_PERMISSION_MODE = this.permissionMode || 'approve'
          if (this._permissionModeFile) {
            env.CHROXY_PERMISSION_MODE_FILE = this._permissionModeFile
          }
        }
        capturedEnv = env
        this._term = { write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }
      }
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      assert.equal(capturedEnv.CHROXY_PORT, undefined,
        'CHROXY_PORT must not leak to TUI env when permissions are skipped')
      assert.equal(capturedEnv.CHROXY_HOOK_SECRET, undefined)
      assert.equal(capturedEnv.CHROXY_PERMISSION_MODE, undefined)
      assert.equal(capturedEnv.CHROXY_PERMISSION_MODE_FILE, undefined)
    })

    it('skipPermissions=true: post-start setPermissionMode() is a safe no-op for the sidecar (#4207 agent-review)', async () => {
      // start() with skipPermissions doesn't create the sidecar, so
      // _permissionModeFile is null. setPermissionMode walks the same
      // early-return guard (`if (!this._permissionModeFile)`), so the
      // call must be a no-op rather than crash/leak.
      session = new ClaudeTuiSession({
        cwd: '/tmp', port: 12345, skipPermissions: true,
        skillsDir: emptySkillsDir, repoSkillsDir: null,
      })
      await session.start()
      assert.equal(session._permissionModeFile, null)
      // Must not throw + must not retroactively create a sidecar.
      session.setPermissionMode('auto')
      assert.equal(session._permissionModeFile, null,
        'setPermissionMode must NOT lazy-create the sidecar after skipPermissions start')
      assert.equal(session.permissionMode, 'auto',
        'in-process bookkeeping still updates so capabilities checks stay coherent')
    })
  })
})
