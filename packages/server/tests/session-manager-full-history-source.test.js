import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'node:events'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { encodeProjectPath, MAX_MESSAGES } from '../src/jsonl-reader.js'

/**
 * #7484 — the PRODUCER contract for `getFullHistoryAsync`'s descriptor.
 *
 * Every test on the consumer side (`conversation-full-history-replay.test.js`)
 * stubs the session manager, so none of them can witness what the real one
 * actually returns — and the two decisions that hang off the descriptor
 * (whether to heal a zombie tool chip, and which collection `truncated`
 * describes) are silently wrong if it drifts. `source: 'ring'` hardcoded into
 * the manager would leave every consumer test green while the fix stopped
 * working in production. So the shape is pinned HERE, against a real
 * SessionManager reading a real transcript off disk.
 *
 * CRITICAL: every SessionManager instance uses a temp stateFilePath (#4633).
 * `HOME` is redirected for the same reason — `resolveJsonlPath` builds
 * `~/.claude/projects/<encoded cwd>/<id>.jsonl`, and the fixture transcript
 * must land in a temp tree, never the developer's real one.
 */

let tmpRoot
let fakeHome
let emptySkillsDir
let realHome
let realUserProfile

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sm-full-history-source-'))
  fakeHome = join(tmpRoot, 'home')
  mkdirSync(fakeHome, { recursive: true })
  // #7507 needs a REAL BaseSession, which loads skills from a directory.
  emptySkillsDir = join(tmpRoot, 'skills')
  mkdirSync(emptySkillsDir, { recursive: true })
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows.
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
})

after(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  rmSync(tmpRoot, { recursive: true, force: true })
})

function tmpStateFile() {
  return join(tmpRoot, `state-${Math.random().toString(36).slice(2)}.json`)
}

function newManager(opts = {}) {
  return new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile(), ...opts })
}

function fakeSession({ resumeSessionId = null, isRunning = false } = {}) {
  const session = new EventEmitter()
  session.isRunning = isRunning
  session.model = 'claude-sonnet-4-6'
  session.permissionMode = 'approve'
  session.destroy = () => {}
  Object.defineProperty(session, 'resumeSessionId', { get: () => resumeSessionId })
  return session
}

/**
 * Write a transcript exactly where `resolveJsonlPath` will look for it.
 * `cwd` is never touched on disk — it is only string-encoded into the path.
 */
function writeTranscript(cwd, conversationId, entries) {
  const dir = join(fakeHome, '.claude', 'projects', encodeProjectPath(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${conversationId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n'))
}

function userTurns(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'user',
    uuid: `u-${offset + i}`,
    timestamp: '2026-01-15T00:00:00.000Z',
    message: { content: [{ type: 'text', text: `message ${offset + i}` }] },
  }))
}

describe('#7484 — getFullHistoryAsync labels the source it actually read', () => {
  it('reads the JSONL transcript and says so', async () => {
    const mgr = newManager()
    const cwd = '/repo/jsonl-source'
    writeTranscript(cwd, 'conv-jsonl-1', userTurns(3))
    mgr._sessions.set('s1', { session: fakeSession({ resumeSessionId: 'conv-jsonl-1' }), name: 'S', cwd })
    // Ring content that must NOT win — the transcript is the preferred source.
    mgr.recordUserInput('s1', 'ring-only entry')

    const result = await mgr.getFullHistoryAsync('s1')

    assert.equal(result.source, 'jsonl',
      'the ONLY thing that tells a caller it is holding transcript entries rather than ring entries')
    assert.equal(result.entries.length, 3)
    assert.equal(result.entries[0].content, 'message 0')
    assert.equal(result.truncated, false, 'a 3-message transcript dropped nothing')
    assert.ok(result.entries.every(e => !('_seq' in e)), 'transcript entries carry no ring cursor')
  })

  it('falls back to the ring buffer and says THAT', async () => {
    const mgr = newManager()
    // No resumeSessionId → no transcript is even looked for.
    mgr._sessions.set('s1', { session: fakeSession(), name: 'S', cwd: '/repo/ring-source' })
    mgr.recordUserInput('s1', 'hello from the ring')

    const result = await mgr.getFullHistoryAsync('s1')

    assert.equal(result.source, 'ring')
    assert.equal(result.entries.length, 1)
    assert.equal(result.truncated, false)
  })

  it('reports the TRANSCRIPT\'s 500-message cap on the JSONL path', async () => {
    // The cap is jsonl-reader's, not the ring buffer's, and it is the truncation
    // a client on this path is actually subject to.
    const mgr = newManager()
    const cwd = '/repo/jsonl-truncated'
    writeTranscript(cwd, 'conv-jsonl-2', userTurns(MAX_MESSAGES + 40))
    mgr._sessions.set('s1', { session: fakeSession({ resumeSessionId: 'conv-jsonl-2' }), name: 'S', cwd })

    const result = await mgr.getFullHistoryAsync('s1')

    assert.equal(result.source, 'jsonl')
    assert.equal(result.entries.length, MAX_MESSAGES)
    assert.equal(result.truncated, true,
      'the 40 dropped messages are invisible in the returned array — 500 back is also what a complete 500-message transcript looks like')
    assert.equal(result.entries[0].content, 'message 40', 'and the retained slice is the most recent')
  })

  it('does NOT report a ring overflow next to a complete transcript', async () => {
    // The mutation this kills: `truncated: this.isHistoryTruncated(sessionId)`
    // on the JSONL branch. The ring HAS overflowed here; the client is still
    // receiving a complete transcript, so the honest answer is false.
    const mgr = newManager({ maxMessages: 2 })
    const cwd = '/repo/jsonl-vs-ring'
    writeTranscript(cwd, 'conv-jsonl-3', userTurns(3))
    mgr._sessions.set('s1', { session: fakeSession({ resumeSessionId: 'conv-jsonl-3' }), name: 'S', cwd })
    mgr.recordUserInput('s1', 'one')
    mgr.recordUserInput('s1', 'two')
    mgr.recordUserInput('s1', 'three')
    assert.equal(mgr.isHistoryTruncated('s1'), true, 'precondition: the RING really did overflow')

    const result = await mgr.getFullHistoryAsync('s1')

    assert.equal(result.source, 'jsonl')
    assert.equal(result.truncated, false,
      'the ring buffer\'s overflow is not a statement about the transcript the client just received')
  })

  it('reports the RING\'s overflow on the ring path', async () => {
    // The same wiring in the other direction: on the fallback path the ring IS
    // the collection sent, so its flag is the right one.
    const mgr = newManager({ maxMessages: 2 })
    mgr._sessions.set('s1', { session: fakeSession(), name: 'S', cwd: '/repo/ring-truncated' })
    mgr.recordUserInput('s1', 'one')
    mgr.recordUserInput('s1', 'two')
    mgr.recordUserInput('s1', 'three')

    const result = await mgr.getFullHistoryAsync('s1')

    assert.equal(result.source, 'ring')
    assert.equal(result.truncated, true)
  })

  it('an unreadable transcript falls back to the ring rather than reporting an empty JSONL slice', async () => {
    const mgr = newManager()
    mgr._sessions.set('s1', {
      session: fakeSession({ resumeSessionId: 'conv-does-not-exist' }),
      name: 'S',
      cwd: '/repo/missing-transcript',
    })
    mgr.recordUserInput('s1', 'ring survives')

    const result = await mgr.getFullHistoryAsync('s1')

    assert.equal(result.source, 'ring')
    assert.equal(result.entries.length, 1)
    assert.equal(result.truncated, false)
  })
})

describe('#7484 — isSessionBusy gates the JSONL heal', () => {
  it('is true while the provider is mid-turn', () => {
    const mgr = newManager()
    mgr._sessions.set('s1', { session: fakeSession({ isRunning: true }), name: 'S', cwd: '/repo/busy' })
    assert.equal(mgr.isSessionBusy('s1'), true)
  })

  it('is false at rest', () => {
    const mgr = newManager()
    mgr._sessions.set('s1', { session: fakeSession({ isRunning: false }), name: 'S', cwd: '/repo/idle' })
    assert.equal(mgr.isSessionBusy('s1'), false)
  })

  it('is false — never a throw — for an unknown session', () => {
    assert.equal(newManager().isSessionBusy('nope'), false)
  })
})

/**
 * #7507 — the three tests above pin `isSessionBusy` against `fakeSession()`, a
 * plain object with an OWN `isRunning` property. That fixture cannot witness the
 * thing this method actually depends on: BaseSession's `isRunning` is a GETTER,
 * `_isBusy || _backgroundShellTracker.size > 0` (base-session.js), and the two
 * halves come apart. Mutating `isSessionBusy` to read `_isBusy` fails those
 * tests only on the fixture's SHAPE — a real session would let the mutant
 * survive, which is exactly what the #7500 review measured.
 *
 * So these drive a REAL `BaseSession`. The state under test is reachable and
 * potentially unbounded: `_clearMessageState` clears `_isBusy` at turn end and
 * deliberately PRESERVES the pending-shells map (#4307), so a session that ran
 * `Bash(run_in_background: true)` and has not been polled with `BashOutput` has
 * `isRunning === true` with no turn in flight. Release comes only from
 * `BashOutput`, `destroy()`, or the 4-hour `BACKGROUND_SHELL_HARD_QUIESCE_MS`
 * reap — the 60s advisory sweep explicitly does NOT flip liveness (#5247).
 *
 * The DECISION being pinned, rather than left incidental: that state counts as
 * BUSY, so the #7484 JSONL heal is suppressed in it. The reason is consistency
 * with the server's single busy authority — `listSessions()` publishes this same
 * `isRunning` as `isBusy`, and the dashboard re-derives `isIdle` from it on
 * every `session_list` / `session_activity` (#4639), so a narrower `_isBusy`
 * guard would emit an `agent_idle` the next broadcast reverts. The mobile
 * residual (no such resync there, so the suppression is a pure false negative)
 * is tracked in #7518, not papered over here.
 */
describe('#7507 — isSessionBusy is LIVENESS (isRunning), not mid-turn (_isBusy)', () => {
  /** A REAL BaseSession — the point is the getter, which a stub cannot have. */
  function realSession() {
    return new BaseSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
  }

  it('is BUSY for a pending background shell with NO turn in flight', () => {
    const mgr = newManager()
    const session = realSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/repo/bg-shell' })
    try {
      assert.equal(session._isBusy, false, 'precondition: no turn is running')
      assert.equal(mgr.isSessionBusy('s1'), false, 'precondition: idle before any shell is tracked')

      session.trackBackgroundShell({ shellId: 'brk57kt6pm', command: 'npm run dev' })

      assert.equal(session._isBusy, false,
        'still no turn in flight — this is the whole gap between liveness and mid-turn')
      assert.equal(mgr.isSessionBusy('s1'), true,
        'the session is LIVE: an un-polled background shell holds liveness until BashOutput/destroy/hard-quiesce (#4307)')
    } finally {
      // Stop the #5177 sweep interval this armed, or the timer outlives the test.
      session._destroyPendingBackgroundShells()
    }
  })

  it('survives turn-end the way the real lifecycle does', () => {
    // The sequence that actually produces the state: a turn runs, backgrounds a
    // shell, then ENDS. `_clearMessageState` clears `_isBusy` and preserves the
    // pending map (#4307), so the session stays busy across the boundary.
    const mgr = newManager()
    const session = realSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/repo/turn-end' })
    try {
      session._isBusy = true
      session.trackBackgroundShell({ shellId: 'brk1', command: 'tail -f log' })
      assert.equal(mgr.isSessionBusy('s1'), true, 'busy mid-turn, trivially')

      session._clearMessageState()

      assert.equal(session._isBusy, false, 'the turn really did end')
      assert.equal(mgr.isSessionBusy('s1'), true, 'and the session is still live')
    } finally {
      session._destroyPendingBackgroundShells()
    }
  })

  it('POSITIVE CONTROL: mid-turn with an EMPTY pending map is busy too (the other arm)', () => {
    // Without this, an implementation that returned `_backgroundShellTracker.size > 0`
    // ALONE — dropping the mid-turn half — would pass the two tests above.
    const mgr = newManager()
    const session = realSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/repo/mid-turn' })
    session._isBusy = true
    assert.equal(session.getPendingBackgroundShells().length, 0, 'precondition: no background shells')
    assert.equal(mgr.isSessionBusy('s1'), true)
  })

  it('POSITIVE CONTROL: a real session at rest is NOT busy', () => {
    // And without this, `return true` passes everything above.
    const mgr = newManager()
    const session = realSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/repo/at-rest' })
    assert.equal(mgr.isSessionBusy('s1'), false)
  })

  it('goes idle once the shell is ACKNOWLEDGED (BashOutput), not merely quiesced', () => {
    const mgr = newManager()
    const session = realSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/repo/ack' })
    try {
      session.trackBackgroundShell({ shellId: 'brk1', command: 'x' })
      assert.equal(mgr.isSessionBusy('s1'), true)
      session.clearBackgroundShell('brk1')
      assert.equal(mgr.isSessionBusy('s1'), false,
        'liveness authority is BashOutput / destroy only (#5247)')
    } finally {
      session._destroyPendingBackgroundShells()
    }
  })

  it('agrees with listSessions().isBusy in EVERY state — they are the same authority', () => {
    // The load-bearing consistency claim in the guard's comment. If these two
    // ever disagree, the dashboard's `session_list` resync (#4639) reverts the
    // heal the guard just allowed.
    //
    // Asserted across all three states BaseSession's getter distinguishes rather
    // than spot-checked in one (#7521 review, nitpick 3): a single state kills
    // the obvious divergence but would not catch an INLINED copy of `isRunning`
    // inside `isSessionBusy` that later drifts from the getter — say a third arm
    // added to `BaseSession.isRunning` and reflected in only one of the two
    // readers. Agreement per state is the property; one state is a sample of it.
    const mgr = newManager()
    const session = realSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/repo/authority', createdAt: Date.now() })
    const listedIsBusy = () => mgr.listSessions().find(s => s.sessionId === 's1').isBusy
    const agree = (label, expected) => {
      assert.equal(listedIsBusy(), expected, `precondition: the broadcast reports ${expected} when ${label}`)
      assert.equal(mgr.isSessionBusy('s1'), listedIsBusy(),
        `isSessionBusy and listSessions().isBusy must not diverge when ${label}`)
    }
    try {
      agree('at rest', false)

      // Arm 1 — background shells only, no turn in flight.
      session.trackBackgroundShell({ shellId: 'brk1', command: 'x' })
      assert.equal(session._isBusy, false, 'precondition: shells-only, not mid-turn')
      agree('a background shell is pending', true)

      // Arm 2 — mid-turn only, empty pending map.
      session.clearBackgroundShell('brk1')
      session._isBusy = true
      assert.equal(session.getPendingBackgroundShells().length, 0, 'precondition: mid-turn, no shells')
      agree('mid-turn with no shells', true)

      // Both arms at once, then back to rest — the round trip, so a reader that
      // latched on first read is caught too.
      session.trackBackgroundShell({ shellId: 'brk2', command: 'y' })
      agree('both arms are live', true)
      session.clearBackgroundShell('brk2')
      session._isBusy = false
      agree('back at rest', false)
    } finally {
      session._destroyPendingBackgroundShells()
    }
  })

  it('skips a _destroying entry, like getSession() and listSessions() do', () => {
    // #7507 "also noticed" (N1): `isSessionBusy` read `this._sessions.get()` raw
    // while every sibling reader skips teardown. Unreachable from the current
    // call site — `handleRequestFullHistory` gates on `resolveSession` →
    // `getSession()`, which already returns null — but latent for the next
    // caller, and a session being torn down is not one to make claims about.
    const mgr = newManager()
    const session = realSession()
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/repo/destroying', _destroying: true })
    try {
      session._isBusy = true
      assert.equal(session.isRunning, true, 'precondition: the underlying session really does read busy')
      assert.equal(mgr.getSession('s1'), null, 'precondition: the sibling readers already hide it')
      assert.equal(mgr.listSessions().length, 0)

      assert.equal(mgr.isSessionBusy('s1'), false)
    } finally {
      session._destroyPendingBackgroundShells()
    }
  })
})
