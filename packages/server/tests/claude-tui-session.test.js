import { describe, it, beforeEach, afterEach } from 'node:test'
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
      // prefix, one per prompt character, one for the \r submit, and
      // one for the bracketed-paste re-enable suffix. The throttle
      // between char writes is what actually defeats claude's paste
      // detector (which fires on byte-arrival rate, not mode 2004).
      assert.equal(writes.length, prompt.length + 3,
        `expected ${prompt.length + 3} writes (disable + N chars + \\r + enable), got ${writes.length}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      assert.equal(writes.slice(1, 1 + prompt.length).join(''), prompt,
        'chars 1..N concatenate back to the original prompt')
      for (let i = 0; i < prompt.length; i++) {
        assert.equal(writes[1 + i].length, 1, `write index ${1 + i} is a single character`)
      }
      assert.equal(writes[1 + prompt.length], '\r', 'penultimate write is the submit')
      assert.equal(writes[2 + prompt.length], '\x1b[?2004h', 'final write is bracketed-paste re-enable')
    })

    it('throttles multi-line prompts too — embedded \\n passes through as a single-char write', async () => {
      // The original symptom was triggered by multi-line input — claude
      // sees an embedded \n in a bulk write and shows "+1 lines paste
      // again to expand". With per-char throttling the \n arrives at
      // typing speed, the same way a human typing Enter mid-prompt
      // would. We do not strip or rewrite the prompt — that would
      // silently mangle the user's text.
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

      assert.equal(writes.length, multiline.length + 3)
      // Char writes must reproduce the multi-line content verbatim,
      // including the embedded \n bytes as their own single-char writes.
      const charWrites = writes.slice(1, 1 + multiline.length)
      assert.equal(charWrites.join(''), multiline, 'multi-line prompt body reproduced verbatim')
      const newlineWrites = charWrites.filter((c) => c === '\n')
      assert.equal(newlineWrites.length, 2, 'each embedded \\n is its own single-char write')
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

    it('tracks _pendingUserAnswer so respondToQuestion knows the pending toolUseId', () => {
      session._emitToolHookEvent('PreToolUse', {
        tool_use_id: 'toolu_aq_2',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
      }, 'msg-aq')
      assert.ok(session._pendingUserAnswer, 'pending answer tracked')
      assert.equal(session._pendingUserAnswer.toolUseId, 'toolu_aq_2')
    })

    it('respondToQuestion writes the answer character-by-character to the PTY then \\r, and clears pending', async () => {
      const writes = []
      session._term = {
        write: (data) => { writes.push(data) },
        kill: () => {},
      }
      session._pendingUserAnswer = { toolUseId: 'toolu_aq_3' }

      session.respondToQuestion('Patch')
      // Drain the throttled write loop. PROMPT_CHAR_DELAY_MS = 1, so wait
      // 'Patch'.length + a little extra for the trailing \r + mode toggle.
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Same shape as the prompt-write tests in this file: disable + N chars
      // + \r + enable. The throttle is what defeats claude's paste detector
      // (#4269) — reusing it for the answer write too.
      assert.ok(writes.length >= 5 + 3, `expected per-char writes, got ${writes.length}: ${JSON.stringify(writes)}`)
      assert.equal(writes[0], '\x1b[?2004l', 'first write is bracketed-paste-disable')
      // Find the chars 'P','a','t','c','h' in order
      const expectChars = 'Patch'.split('')
      const charWrites = writes.slice(1, 1 + expectChars.length)
      assert.equal(charWrites.join(''), 'Patch', 'chars reproduce the answer text')
      assert.equal(writes[1 + expectChars.length], '\r', 'submit comes after the answer')
      assert.equal(writes[2 + expectChars.length], '\x1b[?2004h', 're-enable comes last')

      // _pendingUserAnswer cleared so a second response is a no-op.
      assert.equal(session._pendingUserAnswer, null)
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
