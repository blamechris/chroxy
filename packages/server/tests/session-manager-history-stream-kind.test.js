import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
import { streamKindOf } from '../src/session-message-history.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8282 acceptance, end to end through the real persist / restore path:
 * the stream kind survives a restart, and a state file written before the
 * field existed still classifies its `-thinking-<n>` entries as reasoning.
 *
 * Every SessionManager here has a temp `stateFilePath` (CLAUDE.md #4633).
 */

let created
class StreamingProvider extends EventEmitter {
  constructor(opts) {
    super()
    created.push(this)
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
  }
  static get capabilities() { return {} }
  async start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(StreamingProvider)
registerProvider('test-stream-kind-8282', StreamingProvider)

const SID = 'b'.repeat(32)

describe('history stream kind survives a restart (#8282)', () => {
  let dir, stateFile, mgrs
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8282-'))
    stateFile = join(dir, 'session-state.json')
    created = []
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
  const replayFrames = (mgr, sid) => {
    const frames = []
    for (const entry of mgr.getHistory(sid)) {
      sendHistoryEntry((_ws, payload) => frames.push(payload), null, sid, entry)
    }
    return frames
  }

  it('a state file written before the field existed restores, and its -thinking- entries are reasoning', () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{
        id: SID, name: 'legacy', cwd: '/tmp', model: null, permissionMode: 'approve',
        provider: 'test-stream-kind-8282', sdkSessionId: null,
        history: [
          { type: 'message', messageType: 'response', messageId: 'turn-1-thinking-1', content: 'pondering', timestamp: 1 },
          { type: 'message', messageType: 'response', messageId: 'turn-1', content: 'the answer', timestamp: 2 },
        ],
      }],
    }))
    const mgr = newMgr()
    assert.ok(mgr.restoreState(), 'restored')
    const restored = mgr.getHistory(SID)
    assert.equal(restored.length, 2)
    assert.equal(Object.prototype.hasOwnProperty.call(restored[0], 'kind'), false, 'premise: the legacy entry carries no kind')
    assert.equal(streamKindOf(restored[0]), 'thinking')
    assert.equal(streamKindOf(restored[1]), undefined)
    const frames = replayFrames(mgr, SID)
    assert.equal(frames.find((f) => f.messageId === 'turn-1-thinking-1').kind, 'thinking')
    assert.equal(frames.find((f) => f.messageId === 'turn-1').kind, undefined)
  })

  it('round trip: kind written by the recorder is persisted and comes back on the restored entry', () => {
    const first = newMgr()
    const id = first.createSession({ name: 'R', cwd: '/tmp', provider: 'test-stream-kind-8282' })
    first._history.recordHistory(id, 'stream_start', { messageId: 'turn-2-thinking-0', thinking: true })
    first._history.recordHistory(id, 'stream_delta', { messageId: 'turn-2-thinking-0', delta: 'hmm' })
    first._history.recordHistory(id, 'stream_end', { messageId: 'turn-2-thinking-0', thinking: true })
    first._history.recordHistory(id, 'stream_start', { messageId: 'turn-2' })
    first._history.recordHistory(id, 'stream_delta', { messageId: 'turn-2', delta: 'ok' })
    first._history.recordHistory(id, 'stream_end', { messageId: 'turn-2' })
    first.serializeState()
    first.destroyAll()

    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8')).sessions[0].history
    const diskThinking = onDisk.find((e) => e.messageId === 'turn-2-thinking-0')
    assert.equal(diskThinking.kind, 'thinking', 'persisted to disk')
    assert.equal(onDisk.find((e) => e.messageId === 'turn-2').kind, undefined)

    const second = newMgr()
    assert.ok(second.restoreState(), 'restored')
    const [restoredId] = second.listSessions().map((s) => s.sessionId)
    const restored = second.getHistory(restoredId)
    assert.equal(restored.find((e) => e.messageId === 'turn-2-thinking-0').kind, 'thinking')
    assert.equal(restored.find((e) => e.messageId === 'turn-2').kind, undefined)
  })
})
