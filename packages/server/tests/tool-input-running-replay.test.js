import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager } from '../src/session-manager.js'
import { SdkSession } from '../src/sdk-session.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { buildToolStartData } from '../src/claude-stream-parser.js'

/**
 * #8371 -- a claude-sdk tool that is STILL RUNNING when the dashboard switches
 * session or reloads showed no INPUT on replay until its `tool_result` landed.
 *
 * The live `tool_start` carries `input: null`; the sanitised input is only
 * known later (`_handleToolUseBlock` -> `_recordToolInput`), and the history
 * entry for the `tool_start` used to be backfilled only at result time (#7346).
 * A full-rebuild replay in between therefore replayed a `tool_start` with no
 * input and no result.
 *
 * These drive a REAL SessionManager wired to a REAL SdkSession and replay
 * through the real `sendHistoryEntry`, so the wiring between the two (the
 * `tool_input_recorded` event) is what is under test.
 */

let tmpRoot
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'tool-input-replay-')) })
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

function build() {
  // #4633: temp stateFilePath, always.
  const manager = new SessionManager({
    skipPreflight: true,
    maxSessions: 5,
    stateFilePath: join(tmpRoot, 'state.json'),
  })
  const session = new SdkSession({ cwd: '/tmp', stateFilePath: join(tmpRoot, 'sdk-state.json') })
  manager._sessions.set('s1', { session, name: 'Work', cwd: '/tmp', createdAt: Date.now() })
  manager._wireSessionEvents('s1', session)
  return { manager, session }
}

/** What the SDK stream does at content_block_start: emit tool_start, then track. */
function startTool(session, { id = 'toolu_1', name = 'Bash' } = {}) {
  const data = buildToolStartData('msg-1', { type: 'tool_use', id, name })
  session.emit('tool_start', data)
  session._trackToolStart(data.toolUseId, name)
  return data
}

/** A full-rebuild replay: every history entry through the real frame builder. */
function replayFrames(manager) {
  const sent = []
  for (const entry of manager._history.getHistory('s1')) {
    sendHistoryEntry((_ws, payload) => sent.push(payload), null, 's1', entry)
  }
  return sent
}

describe('a running claude-sdk tool keeps its INPUT across a replay (#8371)', () => {
  it('precondition: the live tool_start has no input', () => {
    const { session } = build()
    const seen = []
    session.on('tool_start', (d) => seen.push(d))
    startTool(session)
    assert.equal(seen[0].input, null)
  })

  it('a replay BEFORE the result carries the sanitised input on the tool_start frame', () => {
    const { manager, session } = build()
    startTool(session)
    // Before the input is known: still null, as before the fix.
    assert.equal(replayFrames(manager).find((f) => f.type === 'tool_start').input, null)

    session._handleToolUseBlock('msg-1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 20' } })

    const frames = replayFrames(manager)
    const start = frames.find((f) => f.type === 'tool_start')
    assert.deepEqual(start.input, { command: 'sleep 20' })
    assert.equal(frames.some((f) => f.type === 'tool_result'), false, 'no result yet: this is a replay DURING the tool')
  })

  it('history stores the SANITISED input: a secret under a sensitive key is masked, and the raw value is nowhere', () => {
    const { manager, session } = build()
    startTool(session, { id: 'toolu_2', name: 'Bash' })
    const secret = 'sk-ant-api03-' + 'a'.repeat(48)
    session._handleToolUseBlock('msg-1', {
      type: 'tool_use',
      id: 'toolu_2',
      name: 'Bash',
      input: { command: `export TOKEN=${secret}; ls`, password: 'hunter2-not-secret-shaped' },
    })

    const entry = manager._history.getHistory('s1').find((e) => e.type === 'tool_start')
    assert.equal(entry.input.password, '[REDACTED]')
    const serialized = JSON.stringify(manager._history.getHistory('s1'))
    assert.ok(!serialized.includes(secret), 'the raw key must not reach history')
    assert.ok(!serialized.includes('hunter2'), 'the raw password must not reach history')
    const wire = JSON.stringify(replayFrames(manager))
    assert.ok(!wire.includes(secret) && !wire.includes('hunter2'), 'nor the replay frames')
  })

  it('an oversized input keeps the existing cap: the backfilled history entry is the { _truncated } fallback', () => {
    const { manager, session } = build()
    startTool(session, { id: 'toolu_3', name: 'Write' })
    session._handleToolUseBlock('msg-1', {
      type: 'tool_use',
      id: 'toolu_3',
      name: 'Write',
      input: { file_path: '/tmp/x', content: 'x'.repeat(40 * 1024) },
    })
    const entry = manager._history.getHistory('s1').find((e) => e.type === 'tool_start')
    assert.equal(entry.input._truncated, true)
    assert.ok(JSON.stringify(entry.input).length < 12 * 1024, 'the stored input stays within the ~10KB broadcast cap')
  })

  it('the later tool_result still wins: its input replaces the early backfill, and the entry count is unchanged', () => {
    const { manager, session } = build()
    startTool(session)
    session._handleToolUseBlock('msg-1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'early' } })
    const before = manager._history.getHistory('s1').length

    session.emit('tool_result', { toolUseId: 'toolu_1', result: 'done', truncated: false, input: { command: 'final' } })

    const history = manager._history.getHistory('s1')
    assert.equal(history.length, before + 1, 'only the tool_result entry is added')
    assert.deepEqual(history.find((e) => e.type === 'tool_start').input, { command: 'final' })
  })

  it('a tool with no tracked entry (not started through the tracker) is left alone', () => {
    const { manager, session } = build()
    // tool_start recorded but never tracked: _recordToolInput has no entry, so no event.
    const data = buildToolStartData('msg-1', { type: 'tool_use', id: 'toolu_9', name: 'Bash' })
    session.emit('tool_start', data)
    session._recordToolInput('toolu_9', { command: 'ls' })
    assert.equal(manager._history.getHistory('s1').find((e) => e.type === 'tool_start').input, null)
  })

  it('the backfill is history only: no tool_input_recorded frame reaches clients', () => {
    const { manager, session } = build()
    const sessionEvents = []
    manager.on('session_event', (e) => sessionEvents.push(e.event))
    startTool(session)
    session._handleToolUseBlock('msg-1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } })
    assert.ok(sessionEvents.includes('tool_input_delta'), 'positive control: the live delta still goes out')
    assert.ok(!sessionEvents.includes('tool_input_recorded'))
  })
})

describe('SessionMessageHistory.backfillToolInput (#8371)', () => {
  it('updates the most recent matching tool_start, ignores undefined, and reports whether it matched', () => {
    const h = new SessionMessageHistory({})
    h.recordHistory('s1', 'tool_start', { messageId: 'm', toolUseId: 'a', tool: 'Bash', input: null })
    assert.equal(h.backfillToolInput('s1', 'a', undefined), false)
    assert.equal(h.backfillToolInput('s1', 'nope', { x: 1 }), false)
    assert.equal(h.backfillToolInput('nosession', 'a', { x: 1 }), false)
    assert.equal(h.backfillToolInput('s1', 'a', { x: 1 }), true)
    assert.deepEqual(h.getHistory('s1')[0].input, { x: 1 })
  })
})
