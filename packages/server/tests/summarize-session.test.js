import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  flattenHistory,
  windowTranscript,
  buildSummaryPrompt,
  summarizeSession,
  MAX_SUMMARIZE_CHARS,
  HEAD_SAMPLE_CHARS,
} from '../src/summarize-session.js'

/**
 * #5547 — unit tests for the one-shot session summarizer's pure logic:
 * history flattening (reusing extractSearchableText), windowing/truncation,
 * prompt assembly, and the orchestration's error paths. The model call is
 * injected so no provider is needed.
 */

describe('flattenHistory', () => {
  it('flattens chroxy ring-buffer entries with role labels', () => {
    const history = [
      { type: 'user_input', content: 'add a feature' },
      { type: 'response', content: 'sure, here is the plan' },
      { type: 'tool_use', tool: 'Edit', content: 'editing file.js' },
    ]
    const out = flattenHistory(history)
    assert.match(out, /User: add a feature/)
    assert.match(out, /Assistant: sure, here is the plan/)
    assert.match(out, /Tool: \[Edit\] editing file\.js/)
  })

  it('reuses extractSearchableText for message-shaped (JSONL) entries', () => {
    // extractSearchableText reads entry.message.content — these come from the
    // JSONL enrichment path. flattenHistory must not re-derive this.
    const history = [
      { type: 'user', message: { content: 'hello from jsonl' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply block' }] } },
    ]
    const out = flattenHistory(history)
    assert.match(out, /hello from jsonl/)
    assert.match(out, /reply block/)
  })

  it('skips entries that flatten to empty text', () => {
    const history = [
      { type: 'user_input', content: 'kept' },
      { type: 'tool_use', tool: 'Read' }, // no content text -> still has [Read] label
      { type: 'response' },               // truly empty -> skipped
      null,
      'not an object',
    ]
    const out = flattenHistory(history)
    const lines = out.split('\n')
    assert.ok(lines.some(l => l.includes('kept')))
    // The empty 'response' and the non-objects produce no lines.
    assert.ok(!lines.some(l => l === 'Assistant: '))
  })

  it('returns empty string for non-array input', () => {
    assert.equal(flattenHistory(null), '')
    assert.equal(flattenHistory(undefined), '')
    assert.equal(flattenHistory({}), '')
  })
})

describe('windowTranscript', () => {
  it('passes short transcripts through untouched', () => {
    const text = 'a short transcript'
    const { text: out, truncated } = windowTranscript(text)
    assert.equal(out, text)
    assert.equal(truncated, false)
  })

  it('windows long transcripts to a head sample + recent tail', () => {
    // Build a transcript well over the cap with a distinctive head and tail.
    const head = 'HEAD_MARKER ' + 'x'.repeat(HEAD_SAMPLE_CHARS)
    const middle = 'm'.repeat(MAX_SUMMARIZE_CHARS)
    const tail = 'y'.repeat(5000) + ' TAIL_MARKER'
    const text = head + middle + tail
    const { text: out, truncated } = windowTranscript(text)
    assert.equal(truncated, true)
    assert.ok(out.length <= MAX_SUMMARIZE_CHARS, `windowed length ${out.length} must be <= ${MAX_SUMMARIZE_CHARS}`)
    assert.match(out, /HEAD_MARKER/, 'head sample preserved')
    assert.match(out, /TAIL_MARKER/, 'recent tail preserved')
    assert.match(out, /earlier conversation omitted/, 'truncation marker present')
  })

  it('honours custom maxChars/headChars', () => {
    const text = 'z'.repeat(1000)
    const { text: out, truncated } = windowTranscript(text, { maxChars: 100, headChars: 20 })
    assert.equal(truncated, true)
    assert.ok(out.length <= 100)
  })
})

describe('buildSummaryPrompt', () => {
  it('frames a continuation brief for the next session, not human prose', () => {
    const prompt = buildSummaryPrompt({ transcript: 'T', truncated: false, sessionName: 'My Work' })
    assert.match(prompt, /CONTINUATION BRIEF/)
    assert.match(prompt, /My Work/)
    assert.match(prompt, /Key file paths/)
    assert.match(prompt, /TRANSCRIPT START/)
    assert.match(prompt, /TRANSCRIPT END/)
    assert.ok(!/windowed/i.test(prompt), 'no truncation note when not truncated')
  })

  it('adds a truncation caveat when windowed', () => {
    const prompt = buildSummaryPrompt({ transcript: 'T', truncated: true })
    assert.match(prompt, /WINDOWED/)
  })
})

describe('summarizeSession orchestration', () => {
  const history = [
    { type: 'user_input', content: 'do the thing' },
    { type: 'response', content: 'done the thing' },
  ]

  it('flattens, windows, prompts, and returns the injected runner output', async () => {
    let receivedPrompt = null
    let receivedModel = null
    const { summary, truncated } = await summarizeSession({
      history,
      model: 'claude-test-model',
      cwd: '/tmp/work',
      sessionName: 'Session A',
      runOneShot: async ({ prompt, model }) => {
        receivedPrompt = prompt
        receivedModel = model
        return '  ## Goal\nthe brief  '
      },
    })
    assert.equal(summary, '## Goal\nthe brief')
    assert.equal(truncated, false)
    assert.equal(receivedModel, 'claude-test-model')
    assert.match(receivedPrompt, /do the thing/)
    assert.match(receivedPrompt, /done the thing/)
  })

  it('throws empty-history when there is nothing readable', async () => {
    await assert.rejects(
      () => summarizeSession({ history: [], runOneShot: async () => 'unused' }),
      (err) => err.reason === 'empty-history',
    )
  })

  it('throws empty-summary when the runner returns blank', async () => {
    await assert.rejects(
      () => summarizeSession({ history, runOneShot: async () => '   ' }),
      (err) => err.reason === 'empty-summary',
    )
  })

  it('reports truncated:true for an over-cap history', async () => {
    const big = [{ type: 'user_input', content: 'q'.repeat(MAX_SUMMARIZE_CHARS + 50_000) }]
    const { truncated } = await summarizeSession({
      history: big,
      runOneShot: async () => 'brief',
    })
    assert.equal(truncated, true)
  })
})
