import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'
import { readBackgroundTaskSnapshot, composeReadyNotificationBody, DEFAULT_READY_BODY } from '../src/notifications/ready-body.js'

/**
 * #8052 — `getBackgroundTaskSnapshot()` does two things on EVERY call: it
 * advances `_lastBackgroundTaskKey` (the idle poll's change-detection
 * baseline) and runs `_refreshBackgroundTaskPoll(snapshot)`, which STOPS the
 * poll when the snapshot is empty. Only a caller that actually BROADCASTS
 * what it read (event-normalizer's `ready` handler via `backgroundTaskFields`,
 * and the poll tick itself) may trigger those side effects — a caller that
 * merely reads the snapshot for its own purposes (composing a push
 * notification body; #8048's turn-end model refresh) must not silently
 * commit the baseline or stop the poll, or a client holding a non-empty
 * `transcriptBackgroundTasks` indicator is stranded: `ws-history.js`
 * `sendSessionInfo` replays a bare `claude_ready`, and an absent field means
 * "keep state" — the drained task never gets announced.
 *
 * `peekBackgroundTaskSnapshot()` is the side-effect-free counterpart these
 * tests pin: same underlying `_scanTranscript()` data as
 * `getBackgroundTaskSnapshot()`, but it must NEVER touch
 * `_lastBackgroundTaskKey` / `_refreshBackgroundTaskPoll` / `_adoptObservedModel`.
 * `readBackgroundTaskSnapshot()` (packages/server/src/notifications/ready-body.js,
 * the helper `PushNotificationHandler` calls to compose the idle-push body)
 * must read through THAT method, not `getBackgroundTaskSnapshot()`.
 *
 * Fixture pattern mirrors `claude-tui-session-observed-model.test.js` (#7327):
 * a fixture per-PID session file + transcript under a temp HOME, driving the
 * real `ClaudeTuiSession`. A dedicated file rather than adding to the
 * already-huge claude-tui-session.test.js, matching that file's own
 * split-file precedent.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('ClaudeTuiSession — read-only background-task snapshot reads must not commit (#8052)', () => {
  let fakeHome
  let origHome
  let origUserProfile
  let fakePid
  let fakeCwd
  let session
  let skillsDir
  let origPollMsDescriptor

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-bgtask-ro-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    fakePid = 2 ** 30
    fakeCwd = join(tmpdir(), 'chroxy-8052-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-bgtask-ro-skills-'))

    // BACKGROUND_TASK_POLL_MS is a getter-only static — override it for a
    // fast, deterministic poll tick instead of waiting out the real 15s.
    origPollMsDescriptor = Object.getOwnPropertyDescriptor(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS')
    Object.defineProperty(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS', { value: 20, configurable: true })
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
    Object.defineProperty(ClaudeTuiSession, 'BACKGROUND_TASK_POLL_MS', origPollMsDescriptor)
  })

  function writeSessFile(pid, sessionId, cwd = fakeCwd) {
    const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
    writeFileSync(path, JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() }))
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

  function makeSession(ctorOpts = {}) {
    const s = new ClaudeTuiSession({ cwd: fakeCwd, skillsDir, repoSkillsDir: null, ...ctorOpts })
    s.on('error', () => {})
    session = s
    return s
  }

  function attachLivePty(s, pid) {
    s._term = { pid, write: () => {}, kill: () => {} }
    s._processReady = true
  }

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

  async function tickPoll() {
    // The (shortened) idle poll ticks every 20ms — give it room to fire.
    await new Promise((resolve) => setTimeout(resolve, 80))
  }

  describe('peekBackgroundTaskSnapshot() itself is side-effect-free', () => {
    it('reads outstanding work without moving the baseline or arming the poll', () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-peek-fresh'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      writeJournal(sessFile, [launchLine('toolu_peek_fresh')])

      assert.equal(s._lastBackgroundTaskKey, null, 'precondition: never read yet')
      assert.equal(s._backgroundTaskPollTimer, null, 'precondition: poll not armed')

      const snap = s.peekBackgroundTaskSnapshot()

      assert.equal(snap.backgroundTasks.length, 1, 'the read itself returns real data')
      assert.equal(snap.backgroundTasks[0].toolUseId, 'toolu_peek_fresh')
      assert.equal(s._lastBackgroundTaskKey, null, 'a read-only peek must never set the dedup baseline')
      assert.equal(s._backgroundTaskPollTimer, null, 'a read-only peek must never arm the poll')
    })

    it('does not stop an already-armed poll when the underlying snapshot has since drained', () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-peek-drain'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      const transcriptPath = writeJournal(sessFile, [launchLine('toolu_peek_drain')])

      // Establish the baseline + arm the poll via the broadcasting-equivalent
      // call (mirrors the real `ready` emission's `backgroundTaskFields`).
      const snap1 = s.getBackgroundTaskSnapshot()
      assert.equal(snap1.backgroundTasks.length, 1, 'precondition: task outstanding')
      assert.ok(s._backgroundTaskPollTimer, 'precondition: poll armed')
      const baselineAfterArm = s._lastBackgroundTaskKey

      appendJournal(transcriptPath, [completionLine('toolu_peek_drain')])

      const peeked = s.peekBackgroundTaskSnapshot()

      assert.equal(peeked.backgroundTasks.length, 0, 'the peek itself sees the drain')
      assert.equal(s._lastBackgroundTaskKey, baselineAfterArm, 'a read-only peek must not move the baseline')
      assert.ok(s._backgroundTaskPollTimer, 'a read-only peek must not stop the poll — only a broadcasting call may')
    })
  })

  describe('the push-notification path does not strand the poll (session-level drain-mid-turn)', () => {
    it('a task that drains during a busy turn, read by the push path with no active viewers, is still broadcast by the next poll tick', async () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-push-drain'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      const transcriptPath = writeJournal(sessFile, [launchLine('toolu_push_drain')])

      // Arm the poll (the real `ready` broadcast's baseline).
      const snap1 = s.getBackgroundTaskSnapshot()
      assert.equal(snap1.backgroundTasks.length, 1, 'precondition: task outstanding, poll armed')
      assert.ok(s._backgroundTaskPollTimer)

      // The task finishes mid-turn.
      appendJournal(transcriptPath, [completionLine('toolu_push_drain')])

      // The push path's read at turn end with no active viewers — the exact
      // helper PushNotificationHandler._onSessionEvent calls to compose the
      // idle-push body.
      const pushSnapshot = readBackgroundTaskSnapshot(s)
      assert.equal(pushSnapshot.backgroundTasks.length, 0, 'the push read itself sees the drain')
      assert.equal(composeReadyNotificationBody(pushSnapshot), DEFAULT_READY_BODY,
        'nothing outstanding — the idle push body is the plain one')

      // The push read must not have stranded the poll.
      assert.ok(s._backgroundTaskPollTimer, 'the poll must still be running after a non-broadcasting read')

      const broadcasts = []
      s.on('background_tasks_changed', (d) => broadcasts.push(d))
      await tickPoll()

      assert.ok(broadcasts.length >= 1, 'the next poll tick must still broadcast the drain — not silently swallowed by the push read')
      assert.deepEqual(broadcasts[broadcasts.length - 1].backgroundTasks, [], 'the client is told the task is done')
    })
  })

  describe('the #8048 turn-end model-refresh read does not strand the poll (regression guard)', () => {
    it('a task drained mid-turn is still broadcast after _clearTurnEndState (the model-refresh read) runs, and the poll stays live', async () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-refresh-drain'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      const transcriptPath = writeJournal(sessFile, [launchLine('toolu_refresh_drain')])

      const snap1 = s.getBackgroundTaskSnapshot()
      assert.equal(snap1.backgroundTasks.length, 1, 'precondition: task outstanding, poll armed')
      assert.ok(s._backgroundTaskPollTimer)

      appendJournal(transcriptPath, [completionLine('toolu_refresh_drain')])

      const broadcasts = []
      s.on('background_tasks_changed', (d) => broadcasts.push(d))

      // Turn ends — #8048's model-refresh read must not silently consume
      // the completion.
      s._clearTurnEndState()

      assert.ok(s._backgroundTaskPollTimer, 'the model-refresh read must not strand the poll either')

      await tickPoll()

      assert.ok(broadcasts.length >= 1, 'the completion was still broadcast — not stranded by the turn-end model refresh')
      assert.deepEqual(broadcasts[broadcasts.length - 1].backgroundTasks, [])
    })
  })

  describe('a broadcasting path still advances the baseline (positive control — no double emits)', () => {
    it('getBackgroundTaskSnapshot() (the ready path) still commits the baseline and arms the poll as before', () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-broadcast-commits'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      writeJournal(sessFile, [launchLine('toolu_broadcast')])

      assert.equal(s._lastBackgroundTaskKey, null)
      assert.equal(s._backgroundTaskPollTimer, null)

      const snap = s.getBackgroundTaskSnapshot()

      assert.equal(snap.backgroundTasks.length, 1)
      assert.notEqual(s._lastBackgroundTaskKey, null, 'the broadcasting path still commits the baseline')
      assert.ok(s._backgroundTaskPollTimer, 'the broadcasting path still arms the poll')
    })

    it('a subsequent peek after a broadcasting commit does not re-trigger a poll tick emit by itself (no double-emit)', async () => {
      const s = makeSession()
      attachLivePty(s, fakePid)
      s._sessionId = 'uuid-no-double-emit'
      const sessFile = writeSessFile(fakePid, s._sessionId)
      writeJournal(sessFile, [launchLine('toolu_no_double')])

      s.getBackgroundTaskSnapshot() // commits the baseline, arms the poll

      const broadcasts = []
      s.on('background_tasks_changed', (d) => broadcasts.push(d))

      // A read-only peek of the SAME (unchanged) outstanding state.
      s.peekBackgroundTaskSnapshot()
      await tickPoll()

      assert.equal(broadcasts.length, 0, 'nothing changed, so the poll tick must not emit — the peek did not perturb the key')
    })
  })
})
