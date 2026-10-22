import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { streamKindOf } from '../src/session-message-history.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * Issue 8282 -- the stream kind a history entry records survives the state file:
 * written by `serializeState` (through `truncateEntry`), read by `restoreState`,
 * and a state file from before the field existed still classifies its
 * `-thinking-<n>` entries as reasoning. Every SessionManager has a temp
 * `stateFilePath`.
 */
class StubProvider extends EventEmitter {
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = opts.resumeSessionId || null
    this._messageCounter = 0
  }
  static get capabilities() { return {} }
  async start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(StubProvider)
registerProvider('test-stream-kind-8282', StubProvider)

const SID = 'b'.repeat(32)
const BIG = 50 * 1024 + 10

describe('the history stream kind survives persist and restore (issue 8282)', () => {
  let dir, stateFile, mgrs
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8282-'))
    stateFile = join(dir, 'session-state.json')
    mgrs = []
  })
  afterEach(() => {
    for (const m of mgrs) { try { m.destroyAll() } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true })
  })
  const newMgr = () => {
    const m = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    mgrs.push(m)
    return m
  }
  const writeState = (history) => writeFileSync(stateFile, JSON.stringify({
    version: 1,
    timestamp: Date.now(),
    sessions: [{
      id: SID, name: 'S', cwd: '/tmp', model: null, permissionMode: 'approve',
      provider: 'test-stream-kind-8282', sdkSessionId: null, history,
    }],
  }))
  const reasoningFrames = (mgr, id) => {
    const frames = []
    for (const e of mgr.getHistory(id)) sendHistoryEntry((_ws, p) => frames.push(p), null, id, e, null)
    return frames
  }

  it('a recorded reasoning stream (also one past the per-entry size cap) keeps its kind; a reply never gets one', () => {
    const first = newMgr()
    const id = first.createSession({ name: 'R', cwd: '/tmp', provider: 'test-stream-kind-8282' })
    const h = first._history
    h.recordHistory(id, 'stream_start', { messageId: 't1-thinking-0', thinking: true })
    h.recordHistory(id, 'stream_delta', { messageId: 't1-thinking-0', delta: 'x'.repeat(BIG), thinking: true })
    h.recordHistory(id, 'stream_end', { messageId: 't1-thinking-0', thinking: true, thinkingDurationMs: 900 })
    h.recordHistory(id, 'stream_start', { messageId: 't1' })
    h.recordHistory(id, 'stream_delta', { messageId: 't1', delta: 'y'.repeat(BIG) })
    h.recordHistory(id, 'stream_end', { messageId: 't1' })
    first.serializeState()
    first.destroyAll()

    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8')).sessions[0].history
    assert.equal(onDisk[0].kind, 'thinking', 'written with the kind')
    assert.ok(onDisk[0].content.endsWith('[truncated]'), 'the truncation path ran on the reasoning entry')
    assert.ok(!('kind' in onDisk[1]), 'a reply is written without one')

    const second = newMgr()
    assert.ok(second.restoreState(), 'restored')
    const [reasoning, reply] = second.getHistory(id)
    assert.equal(reasoning.kind, 'thinking')
    assert.equal(reasoning.thinkingDurationMs, 900)
    assert.equal(streamKindOf(reasoning), 'thinking')
    assert.ok(!('kind' in reply))
    assert.equal(streamKindOf(reply), undefined)
    const frames = reasoningFrames(second, id)
    assert.equal(frames[0].kind, 'thinking')
    assert.ok(!('kind' in frames[1]), 'replay frame of a reply carries no kind')
  })

  it('a state file written before the field existed classifies its -thinking- entries as reasoning and leaves replies alone', () => {
    const entry = (messageId, content) => ({ type: 'message', messageType: 'response', content, messageId, timestamp: 1 })
    writeState([
      entry('turn-1-thinking-0', 'old reasoning'),
      entry('turn-1-thinking-12', 'older reasoning'),
      entry('turn-1', 'old reply'),
      entry('turn-1-thinking-x', 'a reply that merely looks similar'),
    ])
    const mgr = newMgr()
    assert.ok(mgr.restoreState(), 'restored')
    const kinds = mgr.getHistory(SID).map(streamKindOf)
    assert.deepEqual(kinds, ['thinking', 'thinking', undefined, undefined])
    const frames = reasoningFrames(mgr, SID)
    assert.deepEqual(frames.map((f) => f.kind), ['thinking', 'thinking', undefined, undefined])
  })
})
