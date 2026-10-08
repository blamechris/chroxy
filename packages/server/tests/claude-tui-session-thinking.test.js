import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { writeHookSettings } from '../src/claude-tui/pty-driver.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'
import { SessionMessageHistory, streamKindOf } from '../src/session-message-history.js'
import {
  thinkingEntry, redactedThinkingEntry, textEntry, toolUseEntry, userEntry,
} from './fixtures/claude-transcript-thinking.js'

/**
 * #7393 — claude-tui (the default provider) showed nothing while the model
 * reasoned. The TUI is deliver-on-complete: the answer arrives in the Stop
 * hook's `last_assistant_message`, and the reasoning exists only as `thinking`
 * blocks in the session transcript JSONL. While a turn is busy the hook-poll
 * loop now reads those blocks and emits them as `thinking: true` streams on
 * their own `<turnId>-thinking-<n>` id, ahead of the response text.
 *
 * Every test drives the real `sendMessage` poll loop against a fixture per-PID
 * session file + transcript under a temp HOME, in the shape Claude Code 2.1.294
 * writes (fixtures/claude-transcript-thinking.js). No claude, PTY or `~/.claude`
 * is touched.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('ClaudeTuiSession — thinking blocks from the transcript (#7393)', () => {
  let fakeHome
  let origHome
  let origUserProfile
  let origThinkingEnv
  let fakePid
  let fakeCwd
  let session
  let skillsDir
  let sinkBase

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-thinking-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    origThinkingEnv = process.env.CHROXY_TUI_THINKING
    delete process.env.CHROXY_TUI_THINKING
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    fakePid = 2 ** 30
    fakeCwd = join(tmpdir(), 'chroxy-7393-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-thinking-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-thinking-sink-base-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    if (origThinkingEnv !== undefined) process.env.CHROXY_TUI_THINKING = origThinkingEnv
    else delete process.env.CHROXY_TUI_THINKING
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    for (const d of [fakeHome, skillsDir, sinkBase]) if (d) rmSync(d, { recursive: true, force: true })
  })

  // --- fixtures -------------------------------------------------------------

  function writeSessFile(pid = fakePid, sessionId = 'sess-7393') {
    const path = join(fakeHome, '.claude', 'sessions', `${pid}.json`)
    writeFileSync(path, JSON.stringify({ pid, sessionId, cwd: fakeCwd, startedAt: Date.now() }))
    return path
  }

  function writeJournal(sessFile, lines) {
    const transcriptPath = transcriptPathForSessionFile(sessFile)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
    return transcriptPath
  }
  const appendJournal = (transcriptPath, lines) => appendFileSync(transcriptPath, lines.map((l) => l + '\n').join(''))
  // A timestamp that is certainly at-or-after the turn start (the turn started a moment ago).
  const now = (plusMs = 0) => new Date(Date.now() + plusMs).toISOString()

  /** A session wired for a real `sendMessage` poll loop. Records every wire-relevant event in order. */
  function makeTurnSession(ctorOpts = {}) {
    const s = new ClaudeTuiSession({
      cwd: fakeCwd, skillsDir, repoSkillsDir: null,
      resultTimeoutMs: 8000, hardTimeoutMs: 8000, streamStallTimeoutMs: 8000, firstOutputTimeoutMs: 5000,
      ...ctorOpts,
    })
    session = s
    s._processReady = true
    s._sessionId = 'test-7393'
    const sinkDir = join(sinkBase, `s-${Math.random().toString(36).slice(2)}`)
    mkdirSync(sinkDir, { recursive: true, mode: 0o700 })
    s._sinkDir = sinkDir
    s._waitForPrompt = async () => true
    s._authTranscriptScanMs = 0
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    const frames = []
    const events = { frames, errors: [], results: [] }
    for (const name of ['stream_start', 'stream_delta', 'stream_end']) {
      s.on(name, (d) => frames.push({ name, ...d }))
    }
    s.on('error', (e) => events.errors.push(e))
    s.on('result', (e) => events.results.push(e))
    return { s, events, sinkDir }
  }

  async function waitFor(predicate, what, { timeoutMs = 3000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`)
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  const turnPolling = (s) => s._isBusy && s._authFailureBaseline !== null
  const stop = (sinkDir, answer = 'The answer is 42.', name = `stop-${Math.random().toString(36).slice(2)}.json`) =>
    writeFileSync(join(sinkDir, name), JSON.stringify({ last_assistant_message: answer }))
  const thinkingFrames = (frames) => frames.filter((f) => f.thinking === true)
  const responseFrames = (frames) => frames.filter((f) => f.thinking !== true)

  // --- wire frames ----------------------------------------------------------

  it('emits a thinking stream on a distinct id, tagged thinking:true, ahead of the response text', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userEntry('earlier')])
    const { s, events, sinkDir } = makeTurnSession()

    const turn = s.sendMessage('what is 6 x 7?')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [
      thinkingEntry({ text: 'Six times seven is forty-two.', durationMs: 1236, ts: now() }),
      textEntry('The answer is 42.', { ts: now(1) }),
    ])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'the thinking stream to close')
    stop(sinkDir)
    await turn

    const turnId = events.frames[0].messageId
    assert.deepEqual(events.frames[0], { name: 'stream_start', messageId: turnId }, 'the early response stream_start is untouched (#4010)')

    const thinking = thinkingFrames(events.frames)
    assert.deepEqual(thinking, [
      { name: 'stream_start', messageId: `${turnId}-thinking-0`, thinking: true },
      { name: 'stream_delta', messageId: `${turnId}-thinking-0`, delta: 'Six times seven is forty-two.', thinking: true },
      { name: 'stream_end', messageId: `${turnId}-thinking-0`, thinking: true, thinkingDurationMs: 1236 },
    ])

    const response = responseFrames(events.frames).filter((f) => f.name !== 'stream_start')
    assert.deepEqual(response, [
      { name: 'stream_delta', messageId: turnId, delta: 'The answer is 42.' },
      { name: 'stream_end', messageId: turnId },
    ])
    const lastThinking = events.frames.lastIndexOf(thinking[2])
    const firstResponseDelta = events.frames.findIndex((f) => f.name === 'stream_delta' && f.thinking !== true)
    assert.ok(lastThinking < firstResponseDelta, 'thinking is on the wire before the response text')
  })

  it('emits thinking while the turn is still running, not only at the Stop hook', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')

    appendJournal(transcript, [thinkingEntry({ text: 'still working on it', ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'live thinking')
    assert.equal(s._isBusy, true, 'the turn has not finished: this was shown live')
    assert.equal(events.results.length, 0)

    stop(sinkDir)
    await turn
  })

  it('numbers several thinking blocks of one turn -0, -1, in transcript order, each its own stream', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [
      thinkingEntry({ text: 'first', durationMs: 100, ts: now() }),
      toolUseEntry({ ts: now(1) }),
      thinkingEntry({ text: 'second', durationMs: 200, ts: now(2) }),
    ])
    await waitFor(() => thinkingFrames(events.frames).filter((f) => f.name === 'stream_end').length === 2, 'both thinking streams')
    stop(sinkDir)
    await turn

    const turnId = events.frames[0].messageId
    const starts = thinkingFrames(events.frames).filter((f) => f.name === 'stream_start').map((f) => f.messageId)
    assert.deepEqual(starts, [`${turnId}-thinking-0`, `${turnId}-thinking-1`])
    const deltas = thinkingFrames(events.frames).filter((f) => f.name === 'stream_delta').map((f) => f.delta)
    assert.deepEqual(deltas, ['first', 'second'])
  })

  it('a block with no summary text (the API default) is a "thought for Ns" stream with no delta', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: '', durationMs: 900, ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'the thinking stream')
    stop(sinkDir)
    await turn

    const t = thinkingFrames(events.frames)
    assert.deepEqual(t.map((f) => f.name), ['stream_start', 'stream_end'])
    assert.equal(t[1].thinkingDurationMs, 900)
  })

  it('a redacted_thinking block shows the marker and never the encrypted payload', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [redactedThinkingEntry({ ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'the thinking stream')
    stop(sinkDir)
    await turn
    const delta = thinkingFrames(events.frames).find((f) => f.name === 'stream_delta')
    assert.equal(delta.delta, '[redacted thinking]')
    assert.ok(!JSON.stringify(events.frames).includes('ENCRYPTED-PAYLOAD'))
  })

  // --- positive controls ----------------------------------------------------

  it('a turn with no thinking block produces no thinking frames at all', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [textEntry('plain answer', { ts: now() })])
    await new Promise((r) => setTimeout(r, 60))
    stop(sinkDir, 'plain answer')
    await turn
    assert.deepEqual(thinkingFrames(events.frames), [])
    assert.deepEqual(responseFrames(events.frames).map((f) => f.name), ['stream_start', 'stream_delta', 'stream_end'])
  })

  it('thinking text never appears in the visible response, and the result is the same as without thinking', async () => {
    async function run(withThinking) {
      const sessFile = writeSessFile()
      const transcript = writeJournal(sessFile, [])
      const { s, events, sinkDir } = makeTurnSession()
      const turn = s.sendMessage('hi')
      await waitFor(() => turnPolling(s), 'the turn to be polling')
      if (withThinking) {
        appendJournal(transcript, [thinkingEntry({ text: 'SECRET-REASONING-TEXT', ts: now() })])
        await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'thinking')
      }
      stop(sinkDir, 'Final answer.')
      await turn
      await s.destroy()
      session = null
      return events
    }
    const without = await run(false)
    const withT = await run(true)

    const respText = responseFrames(withT.frames).filter((f) => f.name === 'stream_delta').map((f) => f.delta).join('')
    assert.equal(respText, 'Final answer.')
    assert.ok(!respText.includes('SECRET-REASONING-TEXT'))

    assert.equal(withT.results.length, 1)
    assert.equal(without.results.length, 1)
    const strip = ({ duration: _duration, ...rest }) => rest
    assert.deepEqual(strip(withT.results[0]), strip(without.results[0]), 'the turn outcome carries the same fields either way')
    assert.deepEqual(withT.errors, [])
  })

  it('does not replay the previous turn\'s reasoning into the next turn', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()

    let turn = s.sendMessage('one')
    await waitFor(() => turnPolling(s), 'turn one polling')
    appendJournal(transcript, [thinkingEntry({ text: 'turn one reasoning', ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'turn one thinking')
    stop(sinkDir, 'one done', 'stop-1.json')
    await turn
    const afterOne = events.frames.length

    await new Promise((r) => setTimeout(r, 30))
    turn = s.sendMessage('two')
    await waitFor(() => turnPolling(s), 'turn two polling')
    appendJournal(transcript, [thinkingEntry({ text: 'turn two reasoning', ts: now() })])
    await waitFor(() => events.frames.slice(afterOne).some((f) => f.thinking && f.name === 'stream_end'), 'turn two thinking')
    stop(sinkDir, 'two done', 'stop-2.json')
    await turn

    const second = thinkingFrames(events.frames.slice(afterOne)).filter((f) => f.name === 'stream_delta').map((f) => f.delta)
    assert.deepEqual(second, ['turn two reasoning'])
    const ids = thinkingFrames(events.frames).filter((f) => f.name === 'stream_start').map((f) => f.messageId)
    assert.equal(new Set(ids).size, 2, 'each turn\'s reasoning has its own id')
  })

  it('ignores reasoning already in the transcript when the turn starts (a resumed conversation)', async () => {
    const sessFile = writeSessFile()
    writeJournal(sessFile, [
      userEntry('old'),
      thinkingEntry({ text: 'old turn reasoning', ts: '2026-01-01T00:00:00.000Z' }),
    ])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('new')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    await new Promise((r) => setTimeout(r, 60))
    stop(sinkDir)
    await turn
    assert.deepEqual(thinkingFrames(events.frames), [])
  })

  it('does not show subagent (sidechain) reasoning in the main conversation', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: 'subagent thinking', sidechain: true, ts: now() })])
    await new Promise((r) => setTimeout(r, 60))
    stop(sinkDir)
    await turn
    assert.deepEqual(thinkingFrames(events.frames), [])
  })

  it('does not show a block twice when the transcript is rewritten shorter and re-read from the start', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [userEntry('x'.repeat(2000))])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    const blockA = thinkingEntry({ text: 'block A', durationMs: 10, ts: now() }) // after the turn start
    appendJournal(transcript, [blockA])
    await waitFor(() => thinkingFrames(events.frames).filter((f) => f.name === 'stream_end').length === 1, 'block A shown')
    // The file now holds LESS than the scanner has read: it resets and re-reads
    // from byte 0, so block A comes round again, followed by a genuinely new B.
    writeJournal(sessFile, [blockA, thinkingEntry({ text: 'block B', durationMs: 20, ts: now(5) })])
    await waitFor(() => thinkingFrames(events.frames).filter((f) => f.name === 'stream_end').length >= 2, 'block B shown')
    stop(sinkDir)
    await turn
    const texts = thinkingFrames(events.frames).filter((f) => f.name === 'stream_delta').map((f) => f.delta)
    assert.deepEqual(texts, ['block A', 'block B'])
  })

  it('shows a thinking block before the tool_start that follows it, even when both are found in one poll pass', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, sinkDir } = makeTurnSession()
    const order = []
    s.on('stream_end', (d) => { if (d.thinking) order.push('thinking_end') })
    s.on('tool_start', () => order.push('tool_start'))
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    // The transcript entry and the PreToolUse hook file appear together: claude
    // writes the thinking block, then the tool_use, and the hook fires for it.
    // At the PRODUCTION cadence (the 250 ms throttle is NOT zeroed for this
    // session): a periodic drain has just run, so the next pass's unforced drain
    // is throttled, and the hook files in this pass must still not overtake the
    // block. (#8513 review: the throttle let tool_start through first.)
    s._lastThinkingScanMs = s._nowMonotonic()
    appendJournal(transcript, [thinkingEntry({ text: 'I should list the directory.', ts: now() }), toolUseEntry({ ts: now(1) })])
    writeFileSync(join(sinkDir, 'pre-aaa.json'), JSON.stringify({
      tool_use_id: 'toolu_a', tool_name: 'Bash', tool_input: { command: 'ls' },
    }))
    await waitFor(() => order.includes('tool_start') && order.includes('thinking_end'), 'both events')
    stop(sinkDir)
    await turn
    assert.deepEqual(order, ['thinking_end', 'tool_start'])
  })

  it('picks up reasoning that lands while a hook batch is being consumed, still ahead of the response', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    // The batch is a PreToolUse file then the Stop file. The reasoning that
    // precedes the Stop is written while the first file's unlink is in flight,
    // i.e. after the batch-start drain and before the Stop is processed.
    let injected = false
    const realFs = s._boundedHookFs.bind(s)
    s._boundedHookFs = async (op, ...args) => {
      const out = await realFs(op, ...args)
      if (op === 'unlink' && !injected) {
        injected = true
        appendJournal(transcript, [thinkingEntry({ text: 'written mid-batch', durationMs: 5, ts: now() })])
      }
      return out
    }
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    writeFileSync(join(sinkDir, 'pre-aaa.json'), JSON.stringify({
      tool_use_id: 'toolu_a', tool_name: 'Bash', tool_input: { command: 'ls' },
    }))
    writeFileSync(join(sinkDir, 'stop-zzz.json'), JSON.stringify({ last_assistant_message: 'done' }))
    await turn
    assert.equal(injected, true, 'precondition: the entry landed mid-batch')
    const t = thinkingFrames(events.frames)
    assert.deepEqual(t.map((f) => f.name), ['stream_start', 'stream_delta', 'stream_end'])
    const respDelta = events.frames.findIndex((f) => f.name === 'stream_delta' && f.thinking !== true)
    assert.ok(events.frames.lastIndexOf(t[2]) < respDelta, 'thinking precedes the response')
  })

  it('picks up reasoning that lands in the same instant as the Stop hook (final drain before the response)', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    s._thinkingScanMs = 60_000 // the periodic drain cannot be what finds it
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: 'written just before Stop', durationMs: 50, ts: now() })])
    stop(sinkDir)
    await turn
    const t = thinkingFrames(events.frames)
    assert.deepEqual(t.map((f) => f.name), ['stream_start', 'stream_delta', 'stream_end'])
    const lastThinking = events.frames.lastIndexOf(t[2])
    const respDelta = events.frames.findIndex((f) => f.name === 'stream_delta' && f.thinking !== true)
    assert.ok(lastThinking < respDelta)
  })

  // --- redaction ------------------------------------------------------------

  it('redacts secrets in the reasoning text before it reaches the wire', async () => {
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({
      text: `The file sets ANTHROPIC_API_KEY=${secret}; I should not echo that.`,
      ts: now(),
    })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'thinking')
    stop(sinkDir)
    await turn
    const wire = JSON.stringify(events.frames)
    assert.ok(!wire.includes(secret))
    assert.ok(wire.includes('should not echo that'), 'the rest of the reasoning is kept')
  })

  // --- history / replay -----------------------------------------------------

  it('records the reasoning in message history exactly as the SDK path does, so replay shows it', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: 'weighing the options', durationMs: 2500, ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'thinking')
    stop(sinkDir, 'Chose option A.')
    await turn

    const tuiHistory = new SessionMessageHistory({ maxHistory: 50 })
    for (const { name, ...data } of events.frames) tuiHistory.recordHistory('s1', name, data)
    const entries = tuiHistory.getHistory('s1')
    const thinkingEntries = entries.filter((e) => streamKindOf(e) === 'thinking')
    assert.equal(thinkingEntries.length, 1)
    assert.equal(thinkingEntries[0].content, 'weighing the options')
    assert.equal(thinkingEntries[0].kind, 'thinking')
    assert.equal(thinkingEntries[0].thinkingDurationMs, 2500)
    assert.match(thinkingEntries[0].messageId, /-thinking-0$/)
    assert.equal(entries.filter((e) => streamKindOf(e) !== 'thinking' && e.messageType === 'response')[0].content, 'Chose option A.')

    // The SDK path's frames for the same content record to the same entry shape.
    const sdkHistory = new SessionMessageHistory({ maxHistory: 50 })
    sdkHistory.recordHistory('s1', 'stream_start', { messageId: 't-thinking-0', thinking: true })
    sdkHistory.recordHistory('s1', 'stream_delta', { messageId: 't-thinking-0', delta: 'weighing the options', thinking: true })
    sdkHistory.recordHistory('s1', 'stream_end', { messageId: 't-thinking-0', thinking: true, thinkingDurationMs: 2500 })
    const shape = (e) => Object.keys(e).filter((k) => k !== 'timestamp' && k !== 'messageId').sort()
    assert.deepEqual(shape(thinkingEntries[0]), shape(sdkHistory.getHistory('s1')[0]))
  })

  it('a signature-only block is still recorded for replay (the "thought for Ns" line survives a reconnect)', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: '', durationMs: 700, ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'thinking')
    stop(sinkDir)
    await turn
    const h = new SessionMessageHistory({ maxHistory: 50 })
    for (const { name, ...data } of events.frames) h.recordHistory('s1', name, data)
    const t = h.getHistory('s1').filter((e) => streamKindOf(e) === 'thinking')
    assert.equal(t.length, 1)
    assert.equal(t[0].content, '')
    assert.equal(t[0].thinkingDurationMs, 700)
  })

  // --- capture lifetime (#8513 review) ----------------------------------------

  const captureOff = (s) => s._transcriptTaskScanner?._thinkingSinceMs === null

  it('stops collecting once the turn is answered, so idle scans queue nothing', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: 'during', ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'thinking')
    stop(sinkDir)
    await turn
    assert.ok(s._transcriptTaskScanner, 'precondition: the scanner exists')
    assert.equal(captureOff(s), true, 'capture is off after the answer')
    appendJournal(transcript, [thinkingEntry({ text: 'between turns', ts: now(50) })])
    s._scanTranscript() // what the idle background-task poll does
    assert.deepEqual(s._transcriptTaskScanner.drainThinking(), [], 'nothing is retained while idle')
  })

  it('stops collecting when the turn is stopped by the user (the error/abort path, not the Stop hook)', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: 'before the stop', ts: now() })])
    await waitFor(() => thinkingFrames(events.frames).some((f) => f.name === 'stream_end'), 'thinking')
    assert.equal(captureOff(s), false, 'precondition: capturing mid-turn')
    s.interrupt()
    await turn
    assert.equal(s._isBusy, false)
    assert.equal(captureOff(s), true, 'capture is off after an aborted turn')
    appendJournal(transcript, [thinkingEntry({ text: 'after the abort', ts: now(50) })])
    s._scanTranscript()
    assert.deepEqual(s._transcriptTaskScanner.drainThinking(), [])
  })

  it('stops collecting when the turn dies on the hard timeout', async () => {
    const sessFile = writeSessFile()
    writeJournal(sessFile, [])
    const { s, events } = makeTurnSession()
    s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    s._drainTurnThinking({ force: true }) // make sure the scanner is capturing
    assert.equal(captureOff(s), false, 'precondition')
    s._handleHardTimeout()
    await waitFor(() => !s._isBusy, 'the turn to end')
    assert.equal(captureOff(s), true)
    assert.ok(events.errors.length >= 1)
  })

  it('shows no reasoning for a turn that has been aborted', async () => {
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: 'written after the user pressed Stop', ts: now() })])
    s._activeTurn.aborted = true
    s._drainTurnThinking({ force: true })
    assert.deepEqual(thinkingFrames(events.frames), [])
    s._activeTurn.aborted = false
    stop(sinkDir)
    await turn
  })

  // --- opt-out, capability, settings ---------------------------------------

  it('CHROXY_TUI_THINKING=0 turns the whole feature off: no frames, and no summaries requested', async () => {
    process.env.CHROXY_TUI_THINKING = '0'
    const sessFile = writeSessFile()
    const transcript = writeJournal(sessFile, [])
    const { s, events, sinkDir } = makeTurnSession()
    assert.equal(s._thinkingEnabled, false)
    const optedOut = JSON.parse(readFileSync(s._writeHookSettings({ permissionsEnabled: false }), 'utf8'))
    assert.equal('showThinkingSummaries' in optedOut, false, 'opted out: claude is not asked for summaries')
    const turn = s.sendMessage('hi')
    await waitFor(() => turnPolling(s), 'the turn to be polling')
    appendJournal(transcript, [thinkingEntry({ text: 'ignored', ts: now() })])
    await new Promise((r) => setTimeout(r, 60))
    stop(sinkDir)
    await turn
    assert.deepEqual(thinkingFrames(events.frames), [])
  })

  it('is on by default, and the session asks claude for summaries in its own --settings file', () => {
    const { s } = makeTurnSession()
    assert.equal(s._thinkingEnabled, true)
    const settings = JSON.parse(readFileSync(s._writeHookSettings({ permissionsEnabled: false }), 'utf8'))
    assert.equal(settings.showThinkingSummaries, true)
    const native = JSON.parse(readFileSync(s._writeHookSettings({ permissionsEnabled: false, nativeRouteNonce: 'abc123' }), 'utf8'))
    assert.equal(native.showThinkingSummaries, true, 'the native-route rewrite keeps it')
  })

  it('leaves thinkingLevel false: Chroxy does not control the TUI\'s thinking budget', () => {
    assert.equal(ClaudeTuiSession.capabilities.thinkingLevel, false)
  })

  it('writeHookSettings asks claude for thinking summaries only when told to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-tui-thinking-settings-'))
    try {
      const off = JSON.parse(readFileSync(writeHookSettings(dir, { permissionsEnabled: false }), 'utf8'))
      assert.equal('showThinkingSummaries' in off, false, 'default: the settings file is unchanged')
      const on = JSON.parse(readFileSync(writeHookSettings(dir, { permissionsEnabled: false, thinkingSummaries: true }), 'utf8'))
      assert.equal(on.showThinkingSummaries, true)
      assert.ok(on.hooks.Stop, 'hooks are untouched')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
