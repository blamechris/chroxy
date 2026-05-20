import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

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
      // Capture the write so we can assert stream_start fires BEFORE the
      // PTY write (i.e. before we hand the turn to claude). Pre-#4010 the
      // emit happened only after the Stop hook came back — for a stuck
      // turn that never returned, agent_busy never fired and the user had
      // no Stop button.
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
})
