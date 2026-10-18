import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../src/session-manager.js'
import { sendHistoryEntry } from '../src/ws-history.js'

/**
 * Issue 8282 -- the stream kind on a history entry has to survive the real
 * persist -> state file -> restore path, including the per-entry truncation,
 * and an entry written before the field existed has to classify as reasoning
 * by its id. The recorder-level rules are pinned in
 * session-message-history-replay-parity.test.js; these go through the real
 * SessionManager (serializeState / restoreState), because the contract is how
 * the two halves agree on a field, which a hand-built setHistory cannot see.
 *
 * Every SessionManager here uses a temp stateFilePath.
 */

const dir = mkdtempSync(join(tmpdir(), 'chroxy-8282-'))
const managers = []
after(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => { for (const m of managers.splice(0)) m.destroyAll() })

let n = 0
/** Start a manager over a state file holding one session record built from `session`. */
function boot(session) {
  const stateFile = join(dir, `state-${++n}.json`)
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    timestamp: Date.now(),
    sessions: [{ name: 'S', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, ...session }],
  }))
  const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
  managers.push(mgr)
  const sid = mgr.restoreState()
  assert.ok(sid, 'a session was restored')
  return { mgr, sid }
}

/** The wire frame a replay sends for each restored history entry. */
function replayFrames(mgr, sid) {
  const frames = []
  for (const entry of mgr.getHistory(sid)) {
    sendHistoryEntry((_ws, payload) => frames.push(payload), null, sid, entry, null)
  }
  return frames
}

/**
 * Record a complete stream through the manager's own history, as a session's events would.
 * `mgr._history.recordHistory` stands in for the session event wiring.
 */
function recordStream(mgr, sid, messageId, text, { thinking }) {
  const flag = thinking ? { thinking: true } : {}
  mgr._history.recordHistory(sid, 'stream_start', { messageId, ...flag })
  mgr._history.recordHistory(sid, 'stream_delta', { messageId, delta: text, ...flag })
  mgr._history.recordHistory(sid, 'stream_end', { messageId, ...flag })
}

/** Serialize the live manager, then boot a fresh one from that state, as a daemon restart does. */
function restartFrom(mgr, sid) {
  const saved = mgr.serializeState().sessions.find((s) => s.id === sid)
  const { sdkSessionId, ...rest } = saved
  const restarted = boot({ ...JSON.parse(JSON.stringify(rest)), sdkSessionId })
  return { saved, ...restarted }
}

describe('history entry stream kind survives a restart (issue 8282)', () => {
  it('a state file written before the field existed restores, and its -thinking- entries replay as reasoning', () => {
    const { mgr, sid } = boot({
      history: [
        { type: 'message', messageType: 'user_input', content: 'go', timestamp: 1 },
        { type: 'message', messageType: 'response', content: 'sdk reasoning', messageId: 'turn-1-thinking-0', timestamp: 2 },
        { type: 'message', messageType: 'response', content: 'acp reasoning', messageId: 'turn-2-thinking', timestamp: 3 },
        { type: 'message', messageType: 'response', content: 'the reply', messageId: 'turn-1', timestamp: 4 },
      ],
    })
    const frames = replayFrames(mgr, sid)
    const byContent = Object.fromEntries(frames.map((f) => [f.content, f]))
    assert.equal(byContent['sdk reasoning'].kind, 'thinking', 'sdk/byok id suffix -thinking-<n>')
    assert.equal(byContent['acp reasoning'].kind, 'thinking', 'acp id suffix -thinking')
    assert.equal(byContent['the reply'].kind, undefined, 'a reply is not reasoning')
    assert.equal(byContent.go.kind, undefined, 'a user prompt is not reasoning')
  })

  it('a recorded reasoning stream is written to the state file with its kind, and a reply is not', () => {
    const { mgr, sid } = boot({ history: [] })
    recordStream(mgr, sid, 'turn-1-thinking-0', 'weighing options', { thinking: true })
    recordStream(mgr, sid, 'turn-1', 'the answer', { thinking: false })
    const persisted = mgr.serializeState().sessions.find((s) => s.id === sid).history
    const reasoning = persisted.find((e) => e.content === 'weighing options')
    const reply = persisted.find((e) => e.content === 'the answer')
    assert.equal(reasoning.kind, 'thinking')
    assert.ok(!('kind' in reply), 'a reply carries no kind key at all')
  })

  it('the kind survives persist and restore: the restored entry still carries it, and replays it, even under a non-legacy id', () => {
    const { mgr, sid } = boot({ history: [] })
    // An id the legacy suffix rule would NOT classify, so only the persisted field can.
    recordStream(mgr, sid, 'opaque-id-7', 'reasoning under an opaque id', { thinking: true })
    recordStream(mgr, sid, 'turn-1', 'the answer', { thinking: false })
    const { saved, mgr: restarted, sid: sid2 } = restartFrom(mgr, sid)
    assert.equal(saved.history.find((e) => e.messageId === 'opaque-id-7').kind, 'thinking')
    const restored = restarted.getHistory(sid2)
    assert.equal(restored.find((e) => e.messageId === 'opaque-id-7').kind, 'thinking')
    assert.ok(!('kind' in restored.find((e) => e.messageId === 'turn-1')))
    const frames = replayFrames(restarted, sid2)
    assert.equal(frames.find((f) => f.content === 'reasoning under an opaque id').kind, 'thinking')
    assert.equal(frames.find((f) => f.content === 'the answer').kind, undefined)
  })

  it('the kind survives the per-entry truncation path: an oversized reasoning entry is cut, not stripped of its kind', () => {
    const { mgr, sid } = boot({ history: [] })
    const huge = 'r'.repeat(60 * 1024)
    recordStream(mgr, sid, 'opaque-id-9', huge, { thinking: true })
    const { saved, mgr: restarted, sid: sid2 } = restartFrom(mgr, sid)
    const persisted = saved.history.find((e) => e.messageId === 'opaque-id-9')
    assert.ok(persisted.content.endsWith('[truncated]'), 'the entry went through the truncation path')
    assert.equal(persisted.kind, 'thinking', 'truncation keeps the kind')
    const restored = restarted.getHistory(sid2).find((e) => e.messageId === 'opaque-id-9')
    assert.ok(restored.content.endsWith('[truncated]'))
    assert.equal(restored.kind, 'thinking')
  })
})
