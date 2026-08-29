import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'node:events'
import { SessionManager } from '../src/session-manager.js'
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
let realHome
let realUserProfile

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sm-full-history-source-'))
  fakeHome = join(tmpRoot, 'home')
  mkdirSync(fakeHome, { recursive: true })
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
