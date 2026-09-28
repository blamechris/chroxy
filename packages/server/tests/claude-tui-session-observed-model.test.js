import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'

/**
 * #7327 — claude-tui (the default provider) never populated `bootedModel`,
 * so the dashboard's model badge/header stayed blank for every session that
 * didn't specify an explicit `model` override. Unlike cli-session/sdk-session
 * (which learn their booted model from the CLI/SDK's own structured init
 * event), claude-tui is a PTY-driven TUI with no such event — the ONLY place
 * the running model appears at all is `message.model` on the session's own
 * transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`).
 *
 * These tests drive the real `getBackgroundTaskSnapshot` / `_adoptObservedModel`
 * / `_refreshObservedModel` / `_clearTurnEndState` wiring against a fixture
 * per-PID session file + transcript under a temp HOME, mirroring the pattern
 * `claude-tui-session.test.js`'s "readiness probe" describe block uses for
 * `~/.claude/sessions/<pid>.json`.
 *
 * A dedicated file rather than adding to the already-huge
 * claude-tui-session.test.js, matching claude-tui-session-spawn-gate.test.js
 * / claude-tui-session-paste-heuristic.test.js's precedent.
 */

// Snapshot BEFORE any test touches it (mirrors claude-tui-session.test.js's
// own __sandboxConfigDir capture) so it can be restored exactly.
const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('ClaudeTuiSession — observed model from the transcript (#7327)', () => {
  let fakeHome
  let origHome
  let origUserProfile
  let fakePid
  let fakeCwd
  let session
  let skillsDir

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-model-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows —
    // both must point at the fixture, or the Windows leg falls through to
    // the real user profile and trips the test-fs sandbox guard (#4633).
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    // A pid that cannot name a real process (matches
    // claude-tui-session.test.js's `pid: 2 ** 30` precedent) — destroy() in
    // afterEach arms a real SIGKILL escalation against `_term.pid` if the
    // fixture pid happens to collide with a live process (review S1).
    fakePid = 2 ** 30
    // Never touched as a real path — only encoded into the fixture
    // transcript's directory slug (both by the fixture writer below and by
    // the code under test, via the SAME transcriptPathForSessionFile call),
    // so it need not exist. join()/tmpdir() keeps it Windows-safe.
    fakeCwd = join(tmpdir(), 'chroxy-7327-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-model-skills-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true })
  })

  /** Write the per-PID session file the readiness probe (and this feature) resolve the transcript from. */
  function writeSessFile(pid, sessionId, cwd = fakeCwd) {
    const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
    writeFileSync(path, JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() }))
    return path
  }

  /** Write (or append to) the fixture transcript derived from a session file, creating its directory. */
  function writeJournal(sessFile, lines) {
    const transcriptPath = transcriptPathForSessionFile(sessFile)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
    return transcriptPath
  }

  function appendJournal(transcriptPath, lines) {
    appendFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
  }

  function assistantLine(model, { text = 'ok', ts = '2026-06-10T02:39:05.423Z' } = {}) {
    const message = { role: 'assistant', content: [{ type: 'text', text }] }
    if (model !== undefined) message.model = model
    return JSON.stringify({ type: 'assistant', timestamp: ts, message })
  }

  function makeSession(ctorOpts = {}) {
    const s = new ClaudeTuiSession({ cwd: fakeCwd, skillsDir, repoSkillsDir: null, ...ctorOpts })
    s.on('error', () => {})
    session = s
    return s
  }

  /**
   * Attach a stand-in PTY AND mark the session live (`_processReady = true`)
   * — the state a real session is in by the time any turn can end. Review
   * C2 added a `!this._processReady` guard to `_refreshObservedModel()`'s
   * `ready` re-emit (never announce a session that hasn't finished its own
   * boot handshake as ready); `start()` is the only production path that
   * sets it, so a fixture session that skips `start()` (all of these do —
   * driving the real PTY is claude-tui-session.test.js's job, exempted from
   * Windows CI for exactly that reason) must set it by hand to represent
   * "already booted, now ending a turn" rather than "never booted".
   */
  function attachLivePty(s, pid) {
    s._term = { pid, write: () => {}, kill: () => {} }
    s._processReady = true
  }

  it('sets bootedModel from an assistant entry and re-emits ready (the CliSession/SdkSession event path)', () => {
    const s = makeSession()
    attachLivePty(s, fakePid)
    s._sessionId = 'uuid-observed-1'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    assert.equal(s.bootedModel, null, 'precondition: unobserved')
    s._clearTurnEndState()

    assert.equal(s.bootedModel, 'claude-sonnet-5', 'bootedModel set from the transcript observation')
    assert.equal(readyEvents.length, 1, 'a fresh ready was emitted so event-normalizer recomputes model_changed')
    assert.equal(readyEvents[0].sessionId, 'uuid-observed-1')
  })

  it('updates bootedModel and re-emits ready when a later entry reports a different model (/model mid-session)', () => {
    const s = makeSession()
    attachLivePty(s, fakePid)
    s._sessionId = 'uuid-observed-2'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    const transcriptPath = writeJournal(sessFile, [assistantLine('claude-sonnet-5', { ts: '2026-06-10T02:39:00.000Z' })])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    s._clearTurnEndState()
    assert.equal(s.bootedModel, 'claude-sonnet-5')
    assert.equal(readyEvents.length, 1)

    appendJournal(transcriptPath, [assistantLine('claude-opus-5', { ts: '2026-06-10T02:40:00.000Z' })])
    s._clearTurnEndState()

    assert.equal(s.bootedModel, 'claude-opus-5', 'bootedModel follows the newer observation')
    assert.equal(readyEvents.length, 2, 'the change re-emitted ready a second time')
  })

  it('a turn ending with no new observation does not re-broadcast ready (no spurious traffic)', () => {
    const s = makeSession()
    attachLivePty(s, fakePid)
    s._sessionId = 'uuid-stable'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    s._clearTurnEndState()
    s._clearTurnEndState()
    s._clearTurnEndState()

    assert.equal(s.bootedModel, 'claude-sonnet-5')
    assert.equal(readyEvents.length, 1, 'only the FIRST turn-end actually changed bootedModel')
  })

  it('ignores the synthetic placeholder — bootedModel stays null, nothing is emitted', () => {
    const s = makeSession()
    attachLivePty(s, fakePid)
    s._sessionId = 'uuid-synthetic'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('<synthetic>', { text: 'API Error: 529 Overloaded' })])

    const readyEvents = []
    s.on('ready', (d) => readyEvents.push(d))

    s._clearTurnEndState()

    assert.equal(s.bootedModel, null, 'a synthetic entry must never be reported as an observation')
    assert.equal(readyEvents.length, 0, 'no observation landed, so no ready was emitted')
  })

  it('ignores a missing model field', () => {
    const s = makeSession()
    attachLivePty(s, fakePid)
    s._sessionId = 'uuid-missing-model'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine(undefined)])

    s._clearTurnEndState()

    assert.equal(s.bootedModel, null)
  })

  it('a configured model option does NOT populate bootedModel before an observation (never dress up the request as an observation)', () => {
    // The session was created with an explicit model override, but the
    // transcript has nothing yet (no journal file at all — e.g. the very
    // first turn hasn't finished). bootedModel must stay null: only a real
    // transcript observation may set it, never `this.model`.
    const s = makeSession({ model: 'claude-opus-5' })
    attachLivePty(s, fakePid)
    s._sessionId = 'uuid-configured'
    writeSessFile(fakePid, s._sessionId) // session file exists; no journal written

    assert.equal(s.model, 'claude-opus-5', 'precondition: configured model is set')
    s._clearTurnEndState()

    assert.equal(s.bootedModel, null, 'bootedModel must never be derived from this.model')
  })

  it('degrades silently (no throw, bootedModel unchanged) when there is no PTY pid yet', () => {
    const s = makeSession()
    // No s._term set at all — matches a session that hasn't spawned.
    assert.doesNotThrow(() => s._clearTurnEndState())
    assert.equal(s.bootedModel, null)
  })

  it('feeds the same model||bootedModel fallback session-manager/event-normalizer read (#3691 chain)', () => {
    // #3691 (session-info-booted-model.test.js) already pins the generic
    // `session.model || session.bootedModel || null` fallback used by
    // session-manager's listSessions and ws-history's sendSessionInfo. This
    // test only confirms claude-tui actually populates the field that chain
    // reads — the fallback logic itself is not re-tested here.
    const s = makeSession()
    attachLivePty(s, fakePid)
    s._sessionId = 'uuid-list'
    const sessFile = writeSessFile(fakePid, s._sessionId)
    writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

    s._clearTurnEndState()

    const reported = s.model || s.bootedModel || null
    assert.equal(reported, 'claude-sonnet-5')
  })

  // #7327 review C1 — the turn-end model refresh must never disturb the
  // #5431 background-task-poll bookkeeping. Reproduces the reviewer's probe:
  // a run_in_background task outstanding when the poll is armed, completed
  // mid-turn (its completion lands in the transcript before turn-end), then
  // a normal `_clearTurnEndState()`. At HEAD (the bug) the turn-end model
  // scan went through `getBackgroundTaskSnapshot()`, which silently moved
  // the poll's dedup baseline to the post-completion (empty) snapshot and
  // — because nothing was outstanding any more — STOPPED the poll, all
  // without ever broadcasting `background_tasks_changed`. The client would
  // show that task running forever.
  describe('does not strand the background-task poll (#7327 review C1)', () => {
    let origPollMsDescriptor

    beforeEach(() => {
      // BACKGROUND_TASK_POLL_MS is a getter-only static — override it for a
      // fast, deterministic poll tick instead of waiting out the real 15s.
      origPollMsDescriptor = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS')
      Object.defineProperty(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS', { value: 20, configurable: true })
    })

    afterEach(() => {
      Object.defineProperty(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS', origPollMsDescriptor)
    })

    function launchLine(id) {
      return JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-10T02:39:05.423Z',
        message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { description: 'long build', run_in_background: true } }] },
      })
    }

    function completionLine(id) {
      const content = `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`
      return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-10T02:39:40.000Z', sessionId: 's-1', content })
    }

    it('a task completed mid-turn is still broadcast after the turn-end refresh, and the poll stays live', async () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-strand'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      const transcriptPath = writeJournal(sessFile, [launchLine('toolu_strand')])

      // The normal path a real `ready` emission (event-normalizer's
      // backgroundTaskFields) takes: establish the outstanding-task
      // baseline and arm the poll.
      const snap1 = s.getBackgroundTaskSnapshot()
      assert.equal(snap1.backgroundTasks.length, 1, 'precondition: task outstanding')
      assert.ok(s._backgroundTaskPollTimer, 'precondition: poll armed')

      // The task finishes mid-turn.
      appendJournal(transcriptPath, [completionLine('toolu_strand')])

      const broadcasts = []
      s.on('background_tasks_changed', (d) => broadcasts.push(d))

      // Turn ends — must not silently consume the completion via the model
      // refresh's own scan.
      s._clearTurnEndState()

      // Let the (shortened) idle poll tick.
      await new Promise((resolve) => setTimeout(resolve, 80))

      assert.ok(broadcasts.length >= 1,
        'the completion was broadcast — not stranded by the turn-end model refresh')
      assert.deepEqual(broadcasts[broadcasts.length - 1].backgroundTasks, [],
        'the client is told the task is done')
    })

    it('a task launched mid-turn (poll not yet armed) is still visible on the next real snapshot read', () => {
      // Companion shape: nothing outstanding yet when the turn starts, so
      // the poll was never armed. The bug's other face was the baseline
      // silently including a brand-new task before any broadcast pass ever
      // saw it as newly-outstanding. Assert the scanner's own state (what
      // the NEXT real getBackgroundTaskSnapshot() call — e.g. a respawn's
      // `ready` — will see) is accurate after a turn-end refresh.
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-new-task'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      writeJournal(sessFile, [launchLine('toolu_new')])

      s._clearTurnEndState() // model refresh scans past the launch line

      const snap = s.getBackgroundTaskSnapshot()
      assert.equal(snap.backgroundTasks.length, 1, 'the task is still visible — the turn-end scan did not silently swallow it')
      assert.equal(snap.backgroundTasks[0].toolUseId, 'toolu_new')
    })
  })

  // #7327 review C2 — `ready` must never be announced for a dead or
  // tearing-down PTY (the #5316/#8043 contract: `ready` means a live,
  // respondable session). `_onPtyGone` does not null `_term`, so the
  // transcript stays resolvable after a crash — the observation is still
  // worth adopting (a respawn's own `ready` will pick it up), but nothing
  // should be emitted for a session nothing can talk to.
  describe('does not emit ready for a dead/tearing-down PTY (#7327 review C2)', () => {
    it('adopts the observation but does not emit ready when the PTY has exited', () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-dead-pty'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

      // Simulate the state a mid-turn crash leaves (_onPtyGone), which
      // _finishTurnError -> _clearTurnEndState can run through.
      s._ptyExited = true
      s._processReady = false

      const readyEvents = []
      s.on('ready', (d) => readyEvents.push(d))

      s._clearTurnEndState()

      assert.equal(s.bootedModel, 'claude-sonnet-5',
        'still adopted — useful for the NEXT boot/respawn ready')
      assert.equal(readyEvents.length, 0, 'no ready for a PTY that is already gone')
    })

    it('adopts the observation but does not emit ready while destroying', () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-destroying'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

      s._destroying = true

      const readyEvents = []
      s.on('ready', (d) => readyEvents.push(d))

      s._clearTurnEndState()

      assert.equal(s.bootedModel, 'claude-sonnet-5')
      assert.equal(readyEvents.length, 0, 'no ready while the session is tearing down')
    })

    it('POSITIVE CONTROL: still emits ready for a live, processReady PTY (not over-gated)', () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-alive'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      writeJournal(sessFile, [assistantLine('claude-sonnet-5')])

      const readyEvents = []
      s.on('ready', (d) => readyEvents.push(d))

      s._clearTurnEndState()

      assert.equal(readyEvents.length, 1, 'a live session still gets its ready re-emit')
    })
  })
})
