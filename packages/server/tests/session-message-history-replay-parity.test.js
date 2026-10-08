/**
 * #6630 -- what the history records, so a replay can rebuild what the live
 * stream showed. The end-to-end proof (live frames vs replayed frames through the
 * real clients) is replay-parity-wire.test.js plus the dashboard's and the app's
 * replay-parity suites; these pin the recorder's own rules.
 */
import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { SdkSession } from '../src/sdk-session.js'
import { SessionMessageHistory, streamKindOf } from '../src/session-message-history.js'
import { buildMessageWire, buildErrorWire } from '../src/message-wire.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { sendHistoryEntry, CAPABILITY_HISTORY_ERROR_REPLAY } from '../src/ws-history.js'

const S = 's1'

describe('SessionMessageHistory: replay parity (#6630)', () => {
  let history

  beforeEach(() => {
    history = new SessionMessageHistory({ maxHistory: 50 })
  })

  describe('error events', () => {
    it('records an error as the same message envelope the live frame carries (code, resume id, timeout)', () => {
      history.recordHistory(S, 'error', { message: 'No response for 90 seconds', code: 'stream_stall', timeoutMs: 90000 })
      history.recordHistory(S, 'error', { message: 'resume failed', code: 'resume_unknown', attemptedResumeId: ' conv-1 ' })
      const [stall, resume] = history.getHistory(S)
      assert.equal(stall.type, 'message')
      assert.equal(stall.messageType, 'error')
      assert.equal(stall.content, 'No response for 90 seconds')
      assert.equal(stall.code, 'stream_stall')
      assert.equal(stall.timeoutMs, 90000)
      assert.equal(resume.code, 'resume_unknown')
      assert.equal(resume.attemptedResumeId, 'conv-1', 'trimmed exactly as the live frame trims it')
    })

    it('asks for a persist, like every other recorded message', () => {
      const { persistNeeded } = history.recordHistory(S, 'error', { message: 'boom' })
      assert.equal(persistNeeded, true)
    })

    it('does not record an error with no message text (it is not a bubble live either)', () => {
      history.recordHistory(S, 'error', { code: 'stream_stall' })
      history.recordHistory(S, 'error', { message: 42 })
      history.recordHistory(S, 'error', undefined)
      assert.equal(history.getHistory(S).length, 0)
    })

    it('builds the live frame and the entry from ONE builder: they cannot disagree on a field', () => {
      const data = { message: 'x', code: 'post_create_command_failed', stdout: 'out', stderr: 'err' }
      const normalizer = new EventNormalizer()
      const live = normalizer.normalize('error', data, { sessionId: S }).messages[0].msg
      history.recordHistory(S, 'error', data)
      const { _seq, timestamp, ...entry } = history.getHistory(S)[0]
      const { timestamp: liveTimestamp, ...liveRest } = live
      assert.ok(_seq > 0 && typeof timestamp === 'number' && typeof liveTimestamp === 'number')
      assert.deepStrictEqual(JSON.parse(JSON.stringify(entry)), JSON.parse(JSON.stringify(liveRest)))
    })
  })

  describe('structured system messages', () => {
    it('keeps the compaction marker on the recorded entry', () => {
      history.recordHistory(S, 'message', {
        type: 'system', content: 'Context compacted', subtype: 'compact_boundary', timestamp: 5,
        compactMetadata: { trigger: 'manual', preTokens: 10, postTokens: 5, durationMs: 7 },
      })
      const [entry] = history.getHistory(S)
      assert.equal(entry.subtype, 'compact_boundary')
      assert.deepStrictEqual(entry.compactMetadata, { trigger: 'manual', preTokens: 10, postTokens: 5, durationMs: 7 })
    })

    it('keeps the MCP prompt expansion marker, bounded the way the live frame bounds it', () => {
      history.recordHistory(S, 'message', {
        type: 'system', content: 'x', subtype: 'mcp_prompt_expansion', timestamp: 5,
        mcpPromptExpansion: { server: 'docs', prompt: 'p', text: 'a'.repeat(9000), truncated: false },
      })
      const [entry] = history.getHistory(S)
      assert.equal(entry.subtype, 'mcp_prompt_expansion')
      assert.equal(entry.mcpPromptExpansion.text.length, 8192)
      assert.equal(entry.mcpPromptExpansion.truncated, true)
    })

    it('still carries a user input message id and the daemon source (#2902, #8301)', () => {
      history.recordUserInput(S, 'hello', undefined, 'u-1', 'daemon')
      const [entry] = history.getHistory(S)
      assert.equal(entry.messageType, 'user_input')
      assert.equal(entry.messageId, 'u-1')
      assert.equal(entry.source, 'daemon')
    })
  })

  describe('reasoning streams', () => {
    const reason = (id, extra = {}) => {
      history.recordHistory(S, 'stream_start', { messageId: id, thinking: true })
      history.recordHistory(S, 'stream_delta', { messageId: id, delta: 'thinking hard', thinking: true })
      history.recordHistory(S, 'stream_end', { messageId: id, thinking: true, ...extra })
    }

    it('tags a reasoning stream kind:thinking and keeps its duration', () => {
      reason('t1-thinking-0', { thinkingDurationMs: 1500 })
      const [entry] = history.getHistory(S)
      assert.equal(entry.messageType, 'response')
      assert.equal(entry.kind, 'thinking')
      assert.equal(entry.thinkingDurationMs, 1500)
    })

    it('does not tag a reply, and a reply never carries a duration', () => {
      history.recordHistory(S, 'stream_start', { messageId: 'm1' })
      history.recordHistory(S, 'stream_delta', { messageId: 'm1', delta: 'hi' })
      history.recordHistory(S, 'stream_end', { messageId: 'm1', thinkingDurationMs: 9 })
      const [entry] = history.getHistory(S)
      assert.equal(entry.kind, undefined)
      assert.equal(entry.thinkingDurationMs, undefined)
    })

    it('drops a duration the live frame would drop (negative, absurd)', () => {
      reason('t1-thinking-0', { thinkingDurationMs: -5 })
      reason('t1-thinking-1', { thinkingDurationMs: Number.MAX_SAFE_INTEGER })
      const [a, b] = history.getHistory(S)
      assert.equal(a.thinkingDurationMs, undefined)
      assert.equal(b.thinkingDurationMs, undefined)
    })

    it('records a reasoning stream that carried no text (the block arrived with only its signature)', () => {
      history.recordHistory(S, 'stream_start', { messageId: 't1-thinking-0', thinking: true })
      history.recordHistory(S, 'stream_end', { messageId: 't1-thinking-0', thinking: true, thinkingDurationMs: 1000 })
      const [entry] = history.getHistory(S)
      assert.equal(entry.kind, 'thinking')
      assert.equal(entry.content, '')
      assert.equal(entry.thinkingDurationMs, 1000)
    })

    it('still records nothing for an empty reply, or for a thinking stream_end whose start it never saw', () => {
      history.recordHistory(S, 'stream_start', { messageId: 'm1' })
      history.recordHistory(S, 'stream_end', { messageId: 'm1' })
      history.recordHistory(S, 'stream_end', { messageId: 'orphan-thinking-0', thinking: true, thinkingDurationMs: 5 })
      assert.equal(history.getHistory(S).length, 0)
    })

    it('records what a real SdkSession emits for a signature-only thinking block, then replays it as a thinking frame', async () => {
      const session = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile() })
      session._fetchSupportedModels = () => {}
      session.on('error', () => {})
      const events = []
      for (const name of ['stream_start', 'stream_delta', 'stream_end']) {
        session.on(name, (d) => { events.push({ name, ...d }); history.recordHistory(S, name, d) })
      }
      // The Agent SDK's partial stream for a current model's thinking block: the
      // block opens, a signature_delta (not reasoning text) arrives, the block
      // closes. No thinking_delta at all.
      async function* stream() {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } }
        await new Promise((r) => setTimeout(r, 12))
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } } }
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } }
        yield { type: 'result', session_id: 'sdk-1', total_cost_usd: 0.01, duration_ms: 10, usage: {} }
      }
      session._callQuery = () => stream()
      await session.sendMessage('hi')

      const thinking = events.filter((e) => e.thinking === true)
      assert.deepEqual(thinking.map((e) => e.name), ['stream_start', 'stream_end'], 'no thinking delta was emitted')
      const frames = []
      for (const entry of history.getHistory(S)) sendHistoryEntry((_ws, p) => frames.push(p), null, S, entry, null)
      const replayed = frames.find((f) => f.kind === 'thinking')
      assert.ok(replayed, 'the reasoning bubble is replayed')
      assert.equal(replayed.content, '')
      assert.ok(replayed.thinkingDurationMs > 0)
    })

    it('tags a reasoning stream whose stream_start was missed, from the stream_end flag', () => {
      history.recordHistory(S, 'stream_delta', { messageId: 't9-thinking-0', delta: 'x' })
      // no pending stream: nothing recorded, as before
      assert.equal(history.getHistory(S).length, 0)
      history.recordHistory(S, 'stream_start', { messageId: 't9-thinking-1' })
      history.recordHistory(S, 'stream_delta', { messageId: 't9-thinking-1', delta: 'x' })
      history.recordHistory(S, 'stream_end', { messageId: 't9-thinking-1', thinking: true })
      assert.equal(history.getHistory(S)[0].kind, 'thinking')
    })

    it('releases the per-stream kind with the stream (cleanup, close)', () => {
      history.recordHistory(S, 'stream_start', { messageId: 'a-thinking-0', thinking: true })
      history.recordHistory(S, 'stream_start', { messageId: 'b-thinking-0', thinking: true })
      history.closePendingStreams(S)
      assert.equal(history._streamKinds.size, 0)
      history.recordHistory(S, 'stream_start', { messageId: 'c-thinking-0', thinking: true })
      history.cleanupSession(S)
      assert.equal(history._streamKinds.size, 0)
    })

    it('streamKindOf: the recorded field wins; an older entry is classified by its id; a reply and other types are not', () => {
      assert.equal(streamKindOf({ type: 'message', messageType: 'response', kind: 'thinking', messageId: 'x' }), 'thinking')
      assert.equal(streamKindOf({ type: 'message', messageType: 'response', messageId: 'turn-1-thinking-0' }), 'thinking')
      assert.equal(streamKindOf({ type: 'message', messageType: 'response', messageId: 'turn-1' }), undefined)
      assert.equal(streamKindOf({ type: 'message', messageType: 'response', messageId: 'turn-1-thinking-x' }), undefined)
      // ACP's reasoning id has no counter (acp-session.js)
      assert.equal(streamKindOf({ type: 'message', messageType: 'response', messageId: 'turn-1-thinking' }), 'thinking')
      assert.equal(streamKindOf({ type: 'message', messageType: 'response', messageId: 'turn-1-thinking-12' }), 'thinking')
      assert.equal(streamKindOf({ type: 'message', messageType: 'response', messageId: 'thinking' }), undefined)
      assert.equal(streamKindOf({ type: 'message', messageType: 'error', messageId: 'a-thinking-0' }), undefined)
      assert.equal(streamKindOf({ type: 'tool_start', messageId: 'a-thinking-0' }), undefined)
      assert.equal(streamKindOf(null), undefined)
    })

    it('the kind survives the persisted copy (truncateEntry)', () => {
      reason('t1-thinking-0', { thinkingDurationMs: 800 })
      const persisted = history.truncateEntry(history.getHistory(S)[0])
      assert.equal(persisted.kind, 'thinking')
      assert.equal(persisted.thinkingDurationMs, 800)
    })

    it('sendHistoryEntry puts the kind on the wire frame for a recorded and for an older entry', () => {
      reason('t1-thinking-0', { thinkingDurationMs: 800 })
      history.setHistory('old', [{ type: 'message', messageType: 'response', content: 'old', messageId: 'z-thinking-3', timestamp: 1 }])
      const frames = []
      const send = (_ws, p) => frames.push(p)
      sendHistoryEntry(send, null, S, history.getHistory(S)[0], null)
      sendHistoryEntry(send, null, 'old', history.getHistory('old')[0], null)
      assert.equal(frames[0].kind, 'thinking')
      assert.equal(frames[0].thinkingDurationMs, 800)
      assert.equal(frames[1].kind, 'thinking')
    })
  })

  describe('tool labels', () => {
    it('records the MCP server name on tool_start', () => {
      history.recordHistory(S, 'tool_start', { messageId: 'tu1', toolUseId: 'tu1', tool: 'mcp__docs__search', input: null, serverName: 'docs' })
      history.recordHistory(S, 'tool_start', { messageId: 'tu2', toolUseId: 'tu2', tool: 'Bash', input: null })
      const [mcp, bash] = history.getHistory(S)
      assert.equal(mcp.serverName, 'docs')
      assert.ok(!('serverName' in bash), 'a built-in tool carries no label')
    })
  })
})

describe('message-wire builders (#6630)', () => {
  it('buildMessageWire gates the structured markers on a system message', () => {
    const forged = buildMessageWire({
      type: 'response', content: 'x', timestamp: 1,
      subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' },
    })
    assert.ok(!('subtype' in forged) && !('compactMetadata' in forged))
  })

  it('buildMessageWire drops an MCP expansion with no text rather than send a half-formed marker', () => {
    const wire = buildMessageWire({ type: 'system', content: 'x', timestamp: 1, subtype: 'mcp_prompt_expansion', mcpPromptExpansion: { server: 's' } })
    assert.ok(!('subtype' in wire) && !('mcpPromptExpansion' in wire))
  })

  it('buildErrorWire carries stdout/stderr only for the post-create failure code, capped', () => {
    const big = 'line of setup output '.repeat(500)
    const failed = buildErrorWire({ message: 'm', code: 'post_create_command_failed', stdout: big, stderr: '' })
    assert.ok(failed.stdout.length > 0 && failed.stdout.length <= 8192)
    assert.ok(!('stderr' in failed), 'an empty stream is absent, not present-but-empty')
    const other = buildErrorWire({ message: 'm', code: 'stream_stall', stdout: 'leak' })
    assert.ok(!('stdout' in other))
  })

  it('buildErrorWire takes the stall window only as a positive integer', () => {
    assert.equal(buildErrorWire({ message: 'm', code: 'stream_stall', timeoutMs: 90000 }).timeoutMs, 90000)
    assert.ok(!('timeoutMs' in buildErrorWire({ message: 'm', code: 'stream_stall', timeoutMs: -1 })))
    assert.ok(!('timeoutMs' in buildErrorWire({ message: 'm', code: 'other', timeoutMs: 5 })))
  })
})

// Every SessionManager here uses a temp stateFilePath (#4633).
let tmpDir
function tmpStateFile() {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'replay-parity-'))
  return join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

describe('SessionManager: an error is stamped once (#6630)', () => {
  let mgr
  afterEach(() => {
    mock.restoreAll()
    mgr?.destroyAll?.()
  })

  it('the live frame and the recorded entry carry the SAME time, so a cursor replay can dedup the bubble the client already holds', () => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set(S, { session, name: S, cwd: '/tmp' })
    mgr._wireSessionEvents(S, session)

    const seen = []
    mgr.on('session_event', (e) => { if (e.event === 'error') seen.push(e) })
    // A clock that moves on every read: two independent stamps cannot agree.
    let t = 1_700_000_000_000
    mock.method(Date, 'now', () => ++t)

    session.emit('error', { message: 'No response for 90 seconds', code: 'stream_stall', timeoutMs: 90000 })

    assert.equal(seen.length, 1)
    const frame = new EventNormalizer().normalize('error', seen[0].data, { sessionId: S }).messages[0].msg
    const entry = mgr.getHistory(S).find((e) => e.messageType === 'error')
    assert.ok(entry, 'the error is in the history')
    assert.equal(typeof frame.timestamp, 'number')
    assert.equal(entry.timestamp, frame.timestamp)
  })

  it('keeps a timestamp the session supplied, and does not alter the object the session emitted', () => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set(S, { session, name: S, cwd: '/tmp' })
    mgr._wireSessionEvents(S, session)

    const emitted = { message: 'boom' }
    session.emit('error', emitted)
    assert.ok(!('timestamp' in emitted), 'the emitter\'s own object is untouched')

    session.emit('error', { message: 'again', timestamp: 1234 })
    const [, second] = mgr.getHistory(S).filter((e) => e.messageType === 'error')
    assert.equal(second.timestamp, 1234)
  })
})

describe('error text is redacted and bounded before it is recorded (#6630 review)', () => {
  // A synthetic provider key (the shape redaction.js masks), never a real one.
  const KEY = `sk-ant-api03-${'A1b2C3d4E5'.repeat(5)}`
  let mgr
  afterEach(() => {
    mock.restoreAll()
    mgr?.destroyAll?.()
  })

  it('masks a key in the message live, in the history entry, and in the serialized state file', () => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    mgr._sessions.set(S, { session, name: S, cwd: '/tmp' })
    mgr._wireSessionEvents(S, session)
    const seen = []
    mgr.on('session_event', (e) => { if (e.event === 'error') seen.push(e) })

    session.emit('error', { message: `401 from the API for key ${KEY}: invalid x-api-key` })

    const live = new EventNormalizer().normalize('error', seen[0].data, { sessionId: S }).messages[0].msg
    const entry = mgr.getHistory(S).find((e) => e.messageType === 'error')
    assert.ok(!live.content.includes(KEY), 'masked on the live frame')
    assert.ok(live.content.includes('[REDACTED]'))
    assert.equal(entry.content, live.content, 'the recorded entry is the live text')
    assert.ok(!JSON.stringify(mgr.serializeState()).includes(KEY), 'masked in the serialized state')
  })

  it('masks a token in post-create stdout and stderr on the live frame, the entry and the saved copy', () => {
    const history = new SessionMessageHistory()
    const data = {
      message: 'postCreateCommand failed',
      code: 'post_create_command_failed',
      stdout: `exporting\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nauthorization: Bearer abcdefgh12345678\n`,
      stderr: `curl: key ${KEY} rejected`,
    }
    const live = new EventNormalizer().normalize('error', data, { sessionId: S }).messages[0].msg
    history.recordHistory(S, 'error', data)
    const saved = history.truncateEntry(history.getHistory(S)[0])
    for (const frame of [live, history.getHistory(S)[0], saved]) {
      assert.ok(!frame.stdout.includes('ghp_abcdefghij'), 'the token value is masked')
      assert.ok(frame.stdout.includes('GITHUB_TOKEN= [REDACTED]'), 'the key name is kept, the value is not')
      assert.ok(!frame.stdout.includes('abcdefgh12345678'), 'the bearer value is masked')
      assert.ok(!frame.stderr.includes(KEY))
    }
  })

  it('bounds one error at admission: the in-memory entry is clipped, not only the saved copy', () => {
    const history = new SessionMessageHistory()
    history.recordHistory(S, 'error', { message: 'boom '.repeat(100_000) })
    const [entry] = history.getHistory(S)
    assert.ok(entry.content.length < 51 * 1024 + 20, `held ${entry.content.length} characters`)
    assert.ok(entry.content.endsWith('[truncated]'), 'says it was cut')
  })

  it('masks a key in the part of an oversized error that is kept', () => {
    const history = new SessionMessageHistory()
    history.recordHistory(S, 'error', { message: `request failed for ${KEY} ${'filler '.repeat(20_000)}` })
    const [entry] = history.getHistory(S)
    assert.ok(entry.content.endsWith('[truncated]'))
    assert.ok(!entry.content.includes(KEY))
    assert.ok(entry.content.includes('[REDACTED]'))
  })

  it('a short error is stored verbatim', () => {
    const history = new SessionMessageHistory()
    history.recordHistory(S, 'error', { message: 'Something went wrong' })
    assert.equal(history.getHistory(S)[0].content, 'Something went wrong')
  })
})

describe('recorded errors are replayed only to a client that advertises history_error_replay_v1 (#6630 review)', () => {
  const entry = { type: 'message', messageType: 'error', content: 'Usage limit reached', timestamp: 1, _seq: 3 }
  const frames = (client, e = entry) => {
    const out = []
    sendHistoryEntry((_ws, p) => out.push(p), {}, S, e, client)
    return out
  }

  it('a client advertising it is sent the error, with its cursor stamp', () => {
    const [frame] = frames({ clientCapabilities: new Set([CAPABILITY_HISTORY_ERROR_REPLAY]) })
    assert.equal(frame.content, 'Usage limit reached')
    assert.equal(frame.historySeq, 3)
  })

  it('a client that does not (an older build), or has no record, is sent nothing for it', () => {
    for (const client of [{ clientCapabilities: new Set(['voice_input']) }, { clientCapabilities: new Set() }, {}, null, undefined]) {
      assert.deepEqual(frames(client), [])
    }
  })

  it('the capability on the raw socket is not consulted', () => {
    const out = []
    sendHistoryEntry((_ws, p) => out.push(p), { clientCapabilities: new Set([CAPABILITY_HISTORY_ERROR_REPLAY]) }, S, entry, null)
    assert.deepEqual(out, [])
  })

  it('CONTROL: every other entry type is sent to a client with no capabilities at all', () => {
    for (const e of [
      { type: 'message', messageType: 'response', content: 'hi', messageId: 'm', timestamp: 1, _seq: 1 },
      { type: 'message', messageType: 'system', content: 'note', timestamp: 1, _seq: 2 },
      { type: 'tool_start', toolUseId: 't', tool: 'Bash', timestamp: 1, _seq: 4 },
    ]) {
      assert.equal(frames({ clientCapabilities: new Set() }, e).length, 1, e.type + '/' + e.messageType)
    }
  })

  it('both stock clients advertise it', async () => {
    const { CLIENT_CAPABILITIES } = await import('@chroxy/protocol')
    assert.ok(CLIENT_CAPABILITIES.desktop.includes(CAPABILITY_HISTORY_ERROR_REPLAY))
    assert.ok(CLIENT_CAPABILITIES.mobile.includes(CAPABILITY_HISTORY_ERROR_REPLAY))
  })
})
