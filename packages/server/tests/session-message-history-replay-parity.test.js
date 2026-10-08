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
import { buildMessageWire, buildErrorWire, redactAndClip, ERROR_REDACT_SCAN_MAX, ERROR_TEXT_MAX } from '../src/message-wire.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { sendHistoryEntry, CAPABILITY_HISTORY_ERROR_REPLAY, CAPABILITY_HISTORY_THINKING_REPLAY } from '../src/ws-history.js'
import { ClaudeByokSession } from '../src/byok-session.js'

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

    it('records the token count the live stream_end carries, bounded like the live frame', () => {
      reason('t1-thinking-0', { thinkingDurationMs: 800, thinkingTokens: 128 })
      reason('t1-thinking-1', { thinkingTokens: -4 })
      const [a, b] = history.getHistory(S)
      assert.equal(a.thinkingTokens, 128)
      assert.equal(b.thinkingTokens, undefined)
      const frames = []
      sendHistoryEntry((_ws, p) => frames.push(p), null, S, a, { clientCapabilities: new Set() })
      assert.equal(frames[0].thinkingTokens, 128)
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
      const client = { clientCapabilities: new Set([CAPABILITY_HISTORY_THINKING_REPLAY]) }
      for (const entry of history.getHistory(S)) sendHistoryEntry((_ws, p) => frames.push(p), null, S, entry, client)
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
    assert.ok(entry.content.length <= ERROR_TEXT_MAX, `held ${entry.content.length} characters`)
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

// ---------------------------------------------------------------------------
// Review round 2
// ---------------------------------------------------------------------------

// Synthetic keys (the shapes redaction.js masks), never real ones.
const ANT_KEY = `sk-ant-api03-${'A1b2C3d4E5'.repeat(5)}`
const GOOGLE_KEY = `AIza${'Zy9Xw8Vu7T'.repeat(3)}Abcde` // AIza + 35

describe('error `code` is a bounded identifier or it is dropped (#6630 round 2)', () => {
  it('keeps an identifier-shaped string', () => {
    for (const code of ['stream_stall', 'HTTP_429', 'ECONNRESET', 'invalid_api_key', 'a.b:c-d']) {
      assert.equal(buildErrorWire({ message: 'm', code }).code, code)
    }
  })

  it('drops an object, a number, a long string and a string that is not an identifier', () => {
    for (const code of [
      { details: { api_key: ANT_KEY } },
      429,
      'x'.repeat(65),
      `key ${ANT_KEY}`,
      'has space',
      '',
      null,
      ['a'],
    ]) {
      const wire = buildErrorWire({ message: 'm', code })
      assert.ok(!('code' in wire), `kept ${JSON.stringify(code)?.slice(0, 40)}`)
    }
  })

  it('the code-gated fields follow the validated code, not the raw one', () => {
    const wire = buildErrorWire({ message: 'm', code: { toString: () => 'stream_stall' }, timeoutMs: 90000 })
    assert.ok(!('timeoutMs' in wire))
  })

  describe('through the real BYOK error path', () => {
    let tmpHome
    let originalHome
    let originalApiKey
    const sandboxConfigDir = process.env.CHROXY_CONFIG_DIR
    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-code-'))
      originalHome = process.env.HOME
      originalApiKey = process.env.ANTHROPIC_API_KEY
      process.env.HOME = tmpHome
      process.env.CHROXY_CONFIG_DIR = join(tmpHome, '.chroxy')
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
    })
    afterEach(() => {
      if (originalHome) process.env.HOME = originalHome
      else delete process.env.HOME
      process.env.CHROXY_CONFIG_DIR = sandboxConfigDir
      if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
      else delete process.env.ANTHROPIC_API_KEY
      rmSync(tmpHome, { recursive: true, force: true })
    })

    it('an SDK error whose `code` is an object holding a key persists no code and no key', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // What an OpenAI-compatible SSE error looks like once the SDK has parsed it:
      // `code` is whatever the upstream put in the error body, with no HTTP status.
      const upstream = Object.assign(new Error('upstream rejected the request'), {
        code: { details: { api_key: ANT_KEY } },
      })
      session._client = { messages: { stream: () => { throw upstream } } }
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.start()
      await session.sendMessage('hi')
      assert.equal(errors.length, 1, 'the real error path emitted one error')
      assert.equal(typeof errors[0].code, 'object', 'precondition: BYOK forwards the raw code')

      const history = new SessionMessageHistory()
      history.recordHistory(S, 'error', errors[0])
      const [entry] = history.getHistory(S)
      assert.ok(!('code' in entry))
      assert.ok(!JSON.stringify(history.truncateEntry(entry)).includes(ANT_KEY))
      const live = new EventNormalizer().normalize('error', errors[0], { sessionId: S }).messages[0].msg
      assert.ok(!('code' in live), 'nor on the live frame')
      await session.destroy()
    })
  })
})

describe('quoted JSON keys are redacted in recorded errors (#6630 round 2, #8416)', () => {
  const secret = 'abcdefgh12345678'
  const cases = [
    ['a JSON token', `{"token":"${secret}"}`],
    ['a JSON password with spaces', `{ "password" : "${secret}" }`],
    ['a nested access token', `{"data":{"access_token":"${secret}"}}`],
    ['an api_key', `{"api_key":"${secret}"}`],
    ['single quotes', `{'secret': '${secret}'}`],
    ['JSON inside a string (backslash-escaped quotes)', String.raw`request body: {\"token\":\"${secret}\"}`],
    ['an unquoted assignment (unchanged)', `TOKEN=${secret}`],
  ]
  for (const [label, text] of cases) {
    it(`masks ${label} in the message, stdout and stderr`, () => {
      const wire = buildErrorWire({ message: text, code: 'post_create_command_failed', stdout: text, stderr: text })
      for (const field of ['content', 'stdout', 'stderr']) {
        assert.ok(!wire[field].includes(secret), `${field} kept the secret: ${wire[field]}`)
        assert.ok(wire[field].includes('[REDACTED]'), `${field}: ${wire[field]}`)
      }
    })
  }

  it('leaves text that merely mentions the word alone', () => {
    assert.equal(buildErrorWire({ message: 'the token is invalid' }).content, 'the token is invalid')
    assert.equal(buildErrorWire({ message: '{"note":"password rules apply"}' }).content, '{"note":"password rules apply"}')
  })
})

describe('a secret crossing the clip bound is gone, not half-kept (#6630 round 2)', () => {
  // Place `key` so it STRADDLES `bound`: it starts before it and ends after it.
  const straddle = (key, bound, filler) => filler.repeat(Math.ceil((bound - 12) / filler.length)).slice(0, bound - 12) + key + filler.repeat(50)
  const KEYS = [['sk-ant', ANT_KEY], ['AIza', GOOGLE_KEY]]

  for (const [name, key] of KEYS) {
    it(`${name} key across the message bound, with no whitespace anywhere`, () => {
      const wire = buildErrorWire({ message: straddle(key, ERROR_TEXT_MAX, 'x') })
      assert.ok(!wire.content.includes(key.slice(0, 14)), 'no prefix of the key survives')
      assert.ok(wire.content.length <= ERROR_TEXT_MAX)
    })
    it(`${name} key across the message bound, in whitespace-separated text`, () => {
      const wire = buildErrorWire({ message: straddle(key, ERROR_TEXT_MAX, 'word ') })
      assert.ok(!wire.content.includes(key.slice(0, 14)))
    })
    it(`${name} key across the 8 KiB bound of stdout and stderr`, () => {
      const wire = buildErrorWire({
        message: 'm', code: 'post_create_command_failed',
        stdout: straddle(key, 8192, 'x'), stderr: straddle(key, 8192, 'x'),
      })
      for (const field of ['stdout', 'stderr']) {
        assert.ok(!wire[field].includes(key.slice(0, 14)), field)
        assert.ok(wire[field].length <= 8192, field)
      }
    })
  }

  it('a message is redacted whole before it is cut, so a key crossing the budget is gone', () => {
    const filler = 'y'.repeat(ERROR_TEXT_MAX - 20)
    const wire = buildErrorWire({ message: `${filler} ${ANT_KEY} ${'z'.repeat(100)}` })
    assert.ok(!wire.content.includes('sk-ant'))
    assert.ok(wire.content.length <= ERROR_TEXT_MAX)
    assert.ok(wire.content.endsWith('[truncated]'))
  })

  it('a key that would end up past the budget is redacted whole, whatever budget the caller asks for', () => {
    const text = `${'y'.repeat(ERROR_REDACT_SCAN_MAX - 20)} ${ANT_KEY} tail`
    const out = redactAndClip(text, ERROR_REDACT_SCAN_MAX * 2, '[cut]')
    assert.ok(!out.includes('sk-ant'))
    assert.ok(out.endsWith('[REDACTED] tail'))
  })

  it('still slices (rather than drops) a whitespace-free output stream longer than its cap that holds no secret', () => {
    // 20,000 characters: past the scan bound, but the 8 KiB kept is far enough below it that the cut is harmless.
    const wire = buildErrorWire({ message: 'm', code: 'post_create_command_failed', stdout: 'b'.repeat(20_000), stderr: 'c'.repeat(8_193) })
    assert.equal(wire.stdout.length, 8192)
    assert.equal(wire.stderr.length, 8192)
  })

  it('keeps a whitespace-free message that fits, and the beginning of one that does not', () => {
    assert.equal(buildErrorWire({ message: 'a'.repeat(ERROR_TEXT_MAX) }).content.length, ERROR_TEXT_MAX)
    const long = buildErrorWire({ message: 'a'.repeat(ERROR_TEXT_MAX + 1) }).content
    assert.equal(long.length, ERROR_TEXT_MAX)
    assert.ok(long.startsWith('aaaa'))
    assert.ok(long.endsWith('\n[truncated]'))
  })
})

describe('a clipped error reads the same live and persisted (#6630 round 2)', () => {
  it('the content fits the persisted bound with its marker inside it, so truncateEntry leaves it alone', () => {
    const history = new SessionMessageHistory()
    history.recordHistory(S, 'error', { message: 'boom '.repeat(100_000) })
    const [entry] = history.getHistory(S)
    assert.ok(entry.content.length <= ERROR_TEXT_MAX, `${entry.content.length}`)
    assert.ok(entry.content.endsWith('\n[truncated]'))
    const saved = history.truncateEntry(entry)
    assert.equal(saved.content, entry.content)
    assert.ok(!/\[t\[truncated\]/.test(saved.content), 'no doubled marker')
    assert.equal((saved.content.match(/\[truncated\]/g) || []).length, 1)
  })

  it('a message just over the bound is clipped with the marker inside the budget', () => {
    const wire = buildErrorWire({ message: 'qq '.repeat(ERROR_TEXT_MAX / 3 + 10) })
    assert.ok(wire.content.length <= ERROR_TEXT_MAX)
    assert.ok(wire.content.endsWith('\n[truncated]'))
  })

  it('a message that fits is untouched', () => {
    const wire = buildErrorWire({ message: 'qq '.repeat(Math.floor(ERROR_TEXT_MAX / 3)) })
    assert.ok(wire.content.length <= ERROR_TEXT_MAX)
    assert.ok(!wire.content.includes('[truncated]'))
  })
})

describe('a text-less reasoning entry is replayed only to a client with history_thinking_replay_v1 (#6630 round 2)', () => {
  const empty = { type: 'message', messageType: 'response', kind: 'thinking', content: '', messageId: 't-thinking-0', thinkingDurationMs: 900, timestamp: 1, _seq: 5 }
  const withText = { ...empty, content: 'weighing it', messageId: 't-thinking-1', _seq: 6 }
  const legacyEmpty = { type: 'message', messageType: 'response', content: '', messageId: 't-thinking', timestamp: 1, _seq: 7 }
  const frames = (client, e) => {
    const out = []
    sendHistoryEntry((_ws, p) => out.push(p), {}, S, e, client)
    return out
  }

  it('a client advertising it is sent the empty entry, with its cursor stamp', () => {
    const [frame] = frames({ clientCapabilities: new Set([CAPABILITY_HISTORY_THINKING_REPLAY]) }, empty)
    assert.equal(frame.kind, 'thinking')
    assert.equal(frame.historySeq, 5)
  })

  it('a client that does not, or has no record, is sent nothing for it (also by legacy id)', () => {
    for (const client of [{ clientCapabilities: new Set([CAPABILITY_HISTORY_ERROR_REPLAY]) }, { clientCapabilities: new Set() }, {}, null, undefined]) {
      assert.deepEqual(frames(client, empty), [])
      assert.deepEqual(frames(client, legacyEmpty), [])
    }
  })

  it('CONTROL: a reasoning entry WITH text, and an empty reply, are sent to a client with no capabilities', () => {
    assert.equal(frames({ clientCapabilities: new Set() }, withText).length, 1)
    assert.equal(frames({ clientCapabilities: new Set() }, { ...empty, kind: undefined, messageId: 'm1' }).length, 1)
  })

  it('both stock clients advertise it', async () => {
    const { CLIENT_CAPABILITIES } = await import('@chroxy/protocol')
    assert.ok(CLIENT_CAPABILITIES.desktop.includes(CAPABILITY_HISTORY_THINKING_REPLAY))
    assert.ok(CLIENT_CAPABILITIES.mobile.includes(CAPABILITY_HISTORY_THINKING_REPLAY))
  })
})

describe('BYOK gives every thinking stream of a turn its own id (#6630 round 2)', () => {
  let tmpHome
  let originalHome
  let originalApiKey
  const sandboxConfigDir = process.env.CHROXY_CONFIG_DIR
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-rounds-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    process.env.CHROXY_CONFIG_DIR = join(tmpHome, '.chroxy')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })
  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    process.env.CHROXY_CONFIG_DIR = sandboxConfigDir
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
  })

  const fakeStream = (events, final) => ({
    async *[Symbol.asyncIterator]() { for (const e of events) yield e },
    async finalMessage() { return final },
  })
  const thinkingRound = (text, final) => fakeStream([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: final.stop_reason } },
  ], final)

  it('two tool rounds, each with a thought at block index 0: two ids, two recorded entries', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.setPermissionMode('auto')
    session._executeToolBlock = async ({ block }) => ({ type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false })
    let round = 0
    session._client = {
      messages: {
        stream: () => {
          round += 1
          if (round === 1) {
            return thinkingRound('First thought.', {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          }
          return thinkingRound('A completely different second-round thought.', {
            stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 },
          })
        },
      },
    }
    const history = new SessionMessageHistory()
    const starts = []
    for (const name of ['stream_start', 'stream_delta', 'stream_end']) {
      session.on(name, (d) => {
        if (name === 'stream_start' && d.thinking) starts.push(d.messageId)
        history.recordHistory(S, name, d)
      })
    }
    await session.start()
    await session.sendMessage('go')

    assert.equal(starts.length, 2)
    assert.notEqual(starts[0], starts[1], 'the two thoughts do not share an id')
    assert.ok(starts.every((id) => /-thinking-\d+$/.test(id)), 'still the legacy-classifiable shape')
    const entries = history.getHistory(S).filter((e) => e.kind === 'thinking')
    assert.deepEqual(entries.map((e) => e.content), ['First thought.', 'A completely different second-round thought.'])
    await session.destroy()
  })
})

describe('quoted values are redacted to their closing quote (#6630 round 3)', () => {
  const rows = [
    ['a value with punctuation', String.raw`{"password":"Abcdefgh!Secret"}`, 'Abcdefgh!Secret'],
    ['a value that is all punctuation and digits', String.raw`{"password":"p@ssw0rd!2024xyz"}`, 'p@ssw0rd!2024xyz'],
    ['a short quoted value', String.raw`{"token":"ab"}`, 'ab'],
    ['a value with a space', String.raw`{"secret": "two words!"}`, 'two words!'],
    ['single quotes', String.raw`{'password': 'p@ss w0rd!'}`, 'p@ss w0rd!'],
    ['an escaped quote inside the value', String.raw`{"password":"a\"b!c-secret"}`, 'b!c-secret'],
    ['backslash-escaped quotes (JSON inside a string)', String.raw`log: {\"password\":\"x!y z-secret\"}`, 'x!y z-secret'],
    ['a nested key', String.raw`{"auth":{"api_key":"k3y!value#99"}}`, 'k3y!value#99'],
    ['a value with no closing quote (the text was cut)', String.raw`{"password":"unterminated12345`, 'unterminated12345'],
  ]
  for (const [label, text, secret] of rows) {
    it(`${label}: the secret is absent from the message, stdout and stderr`, () => {
      const wire = buildErrorWire({ message: text, code: 'post_create_command_failed', stdout: text, stderr: text })
      for (const field of ['content', 'stdout', 'stderr']) {
        assert.ok(!wire[field].includes(secret), `${field}: ${wire[field]}`)
        assert.ok(wire[field].includes('[REDACTED]'), `${field}: ${wire[field]}`)
      }
    })
  }

  it('the text around a redacted quoted value is kept', () => {
    const out = buildErrorWire({ message: String.raw`400 {"error":"bad","password":"Abcdefgh!Secret","id":7}` }).content
    assert.ok(out.includes('"error":"bad"'))
    assert.ok(out.includes('"id":7'))
  })
})

describe('the redaction scan is bounded (#6630 round 3)', () => {
  // Units whose repetition is the slowest to redact: cost grows faster than length.
  const HOSTILE_UNITS = ['eyJ-', '-eyJ', '--eyJ', 'eyJa', 'a-eyJ', 'eyJsk-', '-sk-eyJ']
  const hostile = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
  const time = (fn) => {
    const start = process.hrtime.bigint()
    fn()
    return Number(process.hrtime.bigint() - start) / 1e6
  }

  // Generous: the bounded scan costs tens of milliseconds here, and an unbounded one
  // of this size costs seconds, so the margin keeps the test steady on a slow runner.
  const LIMIT_MS = 500

  for (const unit of HOSTILE_UNITS) {
    it(`hostile input far past the bound (${JSON.stringify(unit)} x 256 KiB) is redacted in under ${LIMIT_MS} ms`, () => {
      const text = hostile(unit, 256 * 1024)
      // Each field on its own, so the bound is per redaction, not per frame.
      for (const field of [{ message: text }, { message: 'm', code: 'post_create_command_failed', stdout: text }, { message: 'm', code: 'post_create_command_failed', stderr: text }]) {
        const ms = time(() => buildErrorWire(field))
        assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`)
      }
    })
    it(`hostile input exactly at the bound (${JSON.stringify(unit)}) is redacted in under ${LIMIT_MS} ms`, () => {
      const text = hostile(unit, ERROR_REDACT_SCAN_MAX)
      const ms = time(() => buildErrorWire({ message: text }))
      assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`)
    })
  }

  it('the bound is small enough for that: 64 KiB or less', () => {
    assert.ok(ERROR_REDACT_SCAN_MAX <= 64 * 1024)
  })

  it('quoted values stay linear: 1 MB of hostile quoted-key input redacts in under 500 ms', async () => {
    const { redactValue } = await import('../src/redaction.js')
    for (const unit of ['token":"', 'password":"a', String.raw`secret\":\"`, `api_key':'`, `token":"${'a'.repeat(900)}`, 'authorization:"\\', 'token"']) {
      const text = hostile(unit, 1024 * 1024)
      const ms = time(() => redactValue(text))
      assert.ok(ms < LIMIT_MS, `${JSON.stringify(unit.slice(0, 20))}: ${ms.toFixed(0)} ms`)
    }
  })
})
