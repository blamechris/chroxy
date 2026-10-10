import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TranscriptTaskScanner } from '../src/transcript-tasks.js'
import {
  thinkingEntry, redactedThinkingEntry, textEntry, toolUseEntry, userEntry,
} from './fixtures/claude-transcript-thinking.js'

/**
 * #7393 — claude-tui learns the model's reasoning from the session transcript,
 * the only place it is written. The scanner already tails that file
 * incrementally (background tasks, observed model, auth/usage-limit errors); it
 * now also collects the thinking blocks of the turn it is told about. Fixtures
 * match what Claude Code 2.1.294 writes (see fixtures/claude-transcript-thinking.js).
 */

const T0 = Date.parse('2026-10-08T12:00:00.000Z')

describe('TranscriptTaskScanner — thinking capture (#7393)', () => {
  let dir
  let path
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-thinking-scan-'))
    path = join(dir, 's.jsonl')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (...lines) => writeFileSync(path, lines.map((l) => l + '\n').join(''))
  const append = (...lines) => appendFileSync(path, lines.map((l) => l + '\n').join(''))

  it('returns the thinking blocks written after capture started, in order, with text and duration', () => {
    write(userEntry('hi'))
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(
      thinkingEntry({ text: 'First I will read the file.', durationMs: 1236, ts: '2026-10-08T12:00:05.000Z' }),
      textEntry('Reading it now.', { ts: '2026-10-08T12:00:06.000Z' }),
      toolUseEntry({ ts: '2026-10-08T12:00:07.000Z' }),
      thinkingEntry({ text: 'Now summarise.', durationMs: 640, ts: '2026-10-08T12:00:09.000Z' }),
    )
    scanner.scan()
    const blocks = scanner.drainThinking()
    assert.deepEqual(
      blocks.map(({ text, durationMs, redacted }) => ({ text, durationMs, redacted })),
      [
        { text: 'First I will read the file.', durationMs: 1236, redacted: false },
        { text: 'Now summarise.', durationMs: 640, redacted: false },
      ],
    )
    assert.ok(blocks.every((b) => typeof b.uuid === 'string' && b.uuid), 'each block carries its entry uuid (for de-duplication)')
    assert.deepEqual(scanner.drainThinking(), [], 'drain empties the queue')
  })

  it('an empty-text thinking block (no summaries requested) is still returned, carrying only its duration', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(thinkingEntry({ text: '', durationMs: 900, ts: '2026-10-08T12:00:05.000Z' }))
    scanner.scan()
    assert.deepEqual(
      scanner.drainThinking().map(({ text, durationMs }) => ({ text, durationMs })),
      [{ text: '', durationMs: 900 }],
    )
  })

  it('a thinking entry with no thinkingDurationMs yields durationMs undefined', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(thinkingEntry({ text: 'x', durationMs: null, ts: '2026-10-08T12:00:05.000Z' }))
    scanner.scan()
    assert.equal(scanner.drainThinking()[0].durationMs, undefined)
  })

  it('a redacted_thinking block is flagged and its encrypted payload is not kept', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(redactedThinkingEntry({ ts: '2026-10-08T12:00:05.000Z' }))
    scanner.scan()
    const [block] = scanner.drainThinking()
    assert.equal(block.redacted, true)
    assert.equal(block.text, '')
    assert.ok(!JSON.stringify(block).includes('ENCRYPTED-PAYLOAD'))
  })

  it('a turn with no thinking blocks yields nothing (no empty bubble)', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(textEntry('Just an answer.', { ts: '2026-10-08T12:00:05.000Z' }), toolUseEntry({ ts: '2026-10-08T12:00:06.000Z' }))
    scanner.scan()
    assert.deepEqual(scanner.drainThinking(), [])
  })

  it('does not collect before capture starts, and keeps nothing from the history it scans', () => {
    write(
      thinkingEntry({ text: 'an earlier turn', ts: '2026-10-08T11:00:00.000Z' }),
      thinkingEntry({ text: 'another earlier turn', ts: '2026-10-08T11:30:00.000Z' }),
    )
    const scanner = new TranscriptTaskScanner(path)
    scanner.scan()
    scanner.startThinkingCapture(T0)
    assert.deepEqual(scanner.drainThinking(), [], 'history read with capture off is never queued')
  })

  it('ignores thinking older than the turn start even when it is read after capture starts (rotated or re-read file)', () => {
    write(thinkingEntry({ text: 'previous turn', ts: '2026-10-08T11:59:59.000Z' }))
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    scanner.scan()
    assert.deepEqual(scanner.drainThinking(), [])
  })

  it('ignores subagent (sidechain) thinking: the user is watching the main conversation', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(thinkingEntry({ text: 'subagent reasoning', sidechain: true, ts: '2026-10-08T12:00:05.000Z' }))
    scanner.scan()
    assert.deepEqual(scanner.drainThinking(), [])
  })

  it('stopThinkingCapture clears the queue and stops collecting', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(thinkingEntry({ text: 'one', ts: '2026-10-08T12:00:05.000Z' }))
    scanner.scan()
    scanner.stopThinkingCapture()
    append(thinkingEntry({ text: 'two', ts: '2026-10-08T12:00:06.000Z' }))
    scanner.scan()
    assert.deepEqual(scanner.drainThinking(), [])
  })

  it('startThinkingCapture is idempotent: a second call mid-turn does not reset the queue or the cutoff', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(thinkingEntry({ text: 'one', ts: '2026-10-08T12:00:05.000Z' }))
    scanner.scan()
    scanner.startThinkingCapture(T0 + 60_000)
    assert.equal(scanner.drainThinking().length, 1)
  })

  it('a torn trailing line is completed by the next scan, not lost or parsed half-way', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    const line = thinkingEntry({ text: 'split across two reads', ts: '2026-10-08T12:00:05.000Z' })
    appendFileSync(path, line.slice(0, 60))
    scanner.scan()
    assert.deepEqual(scanner.drainThinking(), [])
    appendFileSync(path, line.slice(60) + '\n')
    scanner.scan()
    assert.equal(scanner.drainThinking()[0].text, 'split across two reads')
  })

  it('bounds the queue so a runaway transcript cannot grow it without limit', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    const lines = []
    for (let i = 0; i < 600; i++) lines.push(thinkingEntry({ text: `t${i}`, ts: '2026-10-08T12:00:05.000Z' }))
    append(...lines)
    scanner.scan()
    const blocks = scanner.drainThinking()
    assert.ok(blocks.length <= 256, `queue held ${blocks.length}`)
    assert.equal(blocks[blocks.length - 1].text, 't599', 'the newest survive')
  })

  it('a rotation reset keeps thinking capture and the pinned-agent set (state of the two features coexists)', () => {
    write(userEntry('x'.repeat(3000)))
    const scanner = new TranscriptTaskScanner(path)
    const pinned = new Set(['toolu_agent_1'])
    scanner.pinnedToolUseIds = pinned
    scanner.startThinkingCapture(T0)
    scanner.scan()
    write(thinkingEntry({ text: 'after the rewrite', ts: '2026-10-08T12:00:05.000Z' })) // shorter: forces _reset()
    const snap = scanner.scan()
    assert.equal(scanner.pinnedToolUseIds, pinned, 'the pin set survives the reset')
    assert.equal(scanner.readable, true)
    assert.deepEqual(scanner.drainThinking().map((b) => b.text), ['after the rewrite'], 'capture survived the reset')
    assert.ok(snap)
  })

  it('leaves the existing scan result untouched (capture is purely additive)', () => {
    write()
    const scanner = new TranscriptTaskScanner(path)
    scanner.startThinkingCapture(T0)
    append(thinkingEntry({ text: 'x', ts: '2026-10-08T12:00:05.000Z' }))
    const snap = scanner.scan()
    assert.equal(snap.observedModel, 'claude-haiku-5-5')
    assert.deepEqual(snap.backgroundTasks, [])
    assert.equal(snap.authFailureCount, 0)
  })
  // #8518 — Claude Code writes a late thinking block AFTER the tool_start (or the
  // answer) it belongs before. The transcript's own order says what that was: the
  // thinking entry and the entries that follow it share one API message id, and
  // that message's stop_reason says whether it ended in a tool call or in the answer.
  describe('ordering hint (#8518): what the thinking block precedes', () => {
    const TS = (n) => `2026-10-08T12:00:0${n}.000Z`

    it('a thinking entry whose message ended in a tool call precedes that message\'s tool_use', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(
        thinkingEntry({ text: 'I should list the files.', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }),
        toolUseEntry({ ts: TS(6), messageId: 'msg_A', id: 'toolu_LS', apiBlockIndex: 1 }),
      )
      scanner.scan()
      const [block] = scanner.drainThinking()
      assert.deepEqual(block.precedes, { kind: 'tool_use', toolUseId: 'toolu_LS' })
    })

    it('with several tool calls in the message the thinking precedes the FIRST one', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(
        thinkingEntry({ text: 'two reads', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }),
        toolUseEntry({ ts: TS(6), messageId: 'msg_A', id: 'toolu_ONE', apiBlockIndex: 1 }),
        toolUseEntry({ ts: TS(6), messageId: 'msg_A', id: 'toolu_TWO', apiBlockIndex: 2 }),
      )
      scanner.scan()
      assert.deepEqual(scanner.drainThinking()[0].precedes, { kind: 'tool_use', toolUseId: 'toolu_ONE' })
    })

    it('intermediate text between the thinking and the tool call does not change the answer (the text is not what the thinking precedes)', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(
        thinkingEntry({ text: 't', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }),
        textEntry('Let me look.', { ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use', apiBlockIndex: 1 }),
        toolUseEntry({ ts: TS(6), messageId: 'msg_A', id: 'toolu_LS', apiBlockIndex: 2 }),
      )
      scanner.scan()
      assert.deepEqual(scanner.drainThinking()[0].precedes, { kind: 'tool_use', toolUseId: 'toolu_LS' })
    })

    it('each thinking block of a multi-step turn pairs with ITS OWN message\'s tool call', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(
        thinkingEntry({ text: 'one', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }),
        toolUseEntry({ ts: TS(5), messageId: 'msg_A', id: 'toolu_A', apiBlockIndex: 1 }),
        thinkingEntry({ text: 'two', ts: TS(7), messageId: 'msg_B', stopReason: 'tool_use' }),
        toolUseEntry({ ts: TS(7), messageId: 'msg_B', id: 'toolu_B', apiBlockIndex: 1 }),
      )
      scanner.scan()
      assert.deepEqual(
        scanner.drainThinking().map((b) => b.precedes),
        [{ kind: 'tool_use', toolUseId: 'toolu_A' }, { kind: 'tool_use', toolUseId: 'toolu_B' }],
      )
    })

    it('a thinking entry whose message ended the turn precedes the response, with no follower needed', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(thinkingEntry({ text: 'just answer', ts: TS(5), messageId: 'msg_A', stopReason: 'end_turn' }))
      scanner.scan()
      assert.deepEqual(scanner.drainThinking()[0].precedes, { kind: 'response' })
    })

    it('the tool call can arrive in a LATER scan than the thinking, as long as the block has not been drained yet', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(thinkingEntry({ text: 't', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }))
      scanner.scan()
      append(toolUseEntry({ ts: TS(6), messageId: 'msg_A', id: 'toolu_LS', apiBlockIndex: 1 }))
      scanner.scan()
      assert.deepEqual(scanner.drainThinking()[0].precedes, { kind: 'tool_use', toolUseId: 'toolu_LS' })
    })

    it('no hint when the follower has not been written by the time the block is drained (best effort, never a wait)', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(thinkingEntry({ text: 't', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }))
      scanner.scan()
      const [block] = scanner.drainThinking()
      assert.equal(block.precedes, undefined)
      // and a tool call read afterwards does not reach back into a block already handed out
      append(toolUseEntry({ ts: TS(6), messageId: 'msg_A', id: 'toolu_LS', apiBlockIndex: 1 }))
      scanner.scan()
      assert.equal(block.precedes, undefined)
    })

    it('no hint when the entry has no stop reason yet and only text follows (cannot tell intermediate text from the answer)', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(
        thinkingEntry({ text: 't', ts: TS(5), messageId: 'msg_A', stopReason: null }),
        textEntry('maybe the answer', { ts: TS(5), messageId: 'msg_A', stopReason: null, apiBlockIndex: 1 }),
      )
      scanner.scan()
      assert.equal(scanner.drainThinking()[0].precedes, undefined)
    })

    it('a tool call from a DIFFERENT message does not claim the thinking', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(
        thinkingEntry({ text: 't', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }),
        toolUseEntry({ ts: TS(6), messageId: 'msg_OTHER', id: 'toolu_X', apiBlockIndex: 0 }),
      )
      scanner.scan()
      assert.equal(scanner.drainThinking()[0].precedes, undefined)
    })

    it('a SINGLE entry carrying both the thinking block and its tool_use still gets the hint (#8532 N1)', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      const entry = JSON.parse(thinkingEntry({ text: 'one entry', ts: TS(5), messageId: 'msg_A', stopReason: 'tool_use' }))
      entry.message.content.push({ type: 'tool_use', id: 'toolu_SAME', name: 'Bash', input: { command: 'ls' } })
      append(JSON.stringify(entry))
      scanner.scan()
      assert.deepEqual(scanner.drainThinking()[0].precedes, { kind: 'tool_use', toolUseId: 'toolu_SAME' })
    })

    it('a redacted_thinking block gets the same hint', () => {
      write()
      const scanner = new TranscriptTaskScanner(path)
      scanner.startThinkingCapture(T0)
      append(redactedThinkingEntry({ ts: TS(5) }))
      scanner.scan()
      assert.deepEqual(scanner.drainThinking()[0].precedes, { kind: 'response' })
    })
  })
})
