import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedRegexMatcher, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_INPUT } from '../src/utils/bounded-regex.js'
import { shouldSkipEvaluatorAsync, _resetSkipPatternCache } from '../src/prompt-evaluator.js'

// The reviewer's corpus: each of these ran for seconds on the event loop.
const CORPUS = [
  { source: '.*a.*a.*b', text: 'a'.repeat(250) },
  { source: 'a{0,99}a{0,99}a{0,99}!', text: 'a'.repeat(300) },
  { source: '(?:a*)(?:a*)(?:a*)!', text: 'a'.repeat(300) },
  { source: '^(a+)+$', text: 'a'.repeat(40) + '!' },
  { source: '^(a?a)+$', text: 'a'.repeat(40) + '!' },
]

describe('bounded regex matching', () => {
  const matcher = createBoundedRegexMatcher()
  after(() => matcher.close())

  it('matches and rejects ordinary patterns, case-insensitively', async () => {
    assert.equal(await matcher.test('^proceed$', 'PROCEED'), true)
    assert.equal(await matcher.test('^proceed$', 'stop'), false)
    assert.equal(await matcher.test('[unclosed', 'anything'), false, 'a malformed pattern never matches')
  })

  it('stops each catastrophic pattern at the deadline, counts it as no match, and the daemon stays responsive', async () => {
    for (const { source, text } of CORPUS) {
      // A heartbeat on THIS thread: the matcher must not block it.
      let worstGap = 0
      let last = Date.now()
      const beat = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now }, 5)
      const started = Date.now()
      const matched = await matcher.test(source, text)
      const took = Date.now() - started
      clearInterval(beat)
      assert.equal(matched, false, source)
      assert.ok(took < 1000, `${source} took ${took}ms`)
      assert.ok(worstGap < 250, `${source}: event loop was held for ${worstGap}ms`)
    }
    assert.ok(matcher.stats().timeouts >= CORPUS.length)
  })

  it('serves a harmless match immediately after a timeout (the worker is replaced)', async () => {
    await matcher.test(CORPUS[0].source, CORPUS[0].text)
    const started = Date.now()
    assert.equal(await matcher.test('^ok$', 'ok'), true)
    assert.ok(Date.now() - started < 2000)
  })

  it('a harmless match queued behind a runaway one is not charged for it', async () => {
    const [runaway, harmless] = await Promise.all([
      matcher.test(CORPUS[0].source, CORPUS[0].text),
      matcher.test('^fine$', 'fine'),
    ])
    assert.equal(runaway, false)
    assert.equal(harmless, true)
  })

  it('tests only the first maxInput characters', async () => {
    const m = createBoundedRegexMatcher({ maxInput: 10 })
    try {
      assert.equal(await m.test('end$', 'x'.repeat(50) + 'end'), false, 'the tail was never tested')
      assert.equal(await m.test('^x{10}$', 'x'.repeat(50)), true, 'the head was')
    } finally { m.close() }
    assert.equal(DEFAULT_MAX_INPUT, 1000)
    assert.equal(DEFAULT_TIMEOUT_MS, 50)
  })

  it('the prompt evaluator evaluates normally (no skip) when a custom pattern runs out its deadline', async () => {
    _resetSkipPatternCache()
    const text = 'a'.repeat(250) + ' please review the change'
    assert.equal(await shouldSkipEvaluatorAsync(text, { promptEvaluatorSkipPattern: '.*a.*a.*b' }, matcher), false)
    // And a normal custom pattern still skips.
    assert.equal(await shouldSkipEvaluatorAsync('please proceed when ready', { promptEvaluatorSkipPattern: '^please proceed' }, matcher), true)
  })
})
