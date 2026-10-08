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
})
