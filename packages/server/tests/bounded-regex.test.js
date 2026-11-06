import { describe, it, after } from 'node:test'
import { addLogListener, removeLogListener } from '../src/logger.js'
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

  it('text longer than maxInput is not tested at all and counts as no match (no prefix match)', async () => {
    const m = createBoundedRegexMatcher({ maxInput: 10 })
    try {
      assert.equal(await m.test('^x{10}$', 'x'.repeat(50)), false, 'an anchored pattern does not match a long text by its prefix')
      assert.equal(await m.test('^[a-z ]+$', 'abc '.repeat(10)), false)
      assert.equal(await m.test('end$', 'x'.repeat(50) + 'end'), false)
      assert.equal(await m.test('^x{10}$', 'x'.repeat(10)), true, 'text at the cap is tested')
    } finally { m.close() }
    assert.equal(DEFAULT_MAX_INPUT, 1000)
    assert.equal(DEFAULT_TIMEOUT_MS, 50)
  })

  it('bounds queued jobs per caller key and overall; refused jobs count as no match', async () => {
    const m = createBoundedRegexMatcher({ maxQueuedPerKey: 2, maxQueued: 3 })
    try {
      // The first job occupies the chain for its whole deadline.
      const slow = [0, 1, 2, 3].map(() => m.test(CORPUS[0].source, CORPUS[0].text, 'greedy'))
      const results = await Promise.all(slow)
      assert.deepEqual(results, [false, false, false, false])
      assert.equal(m.stats().refused, 2, 'two of the four from one key were refused outright')
      assert.ok(m.stats().timeouts <= 2, 'and only two ran to their deadline')
      // Another caller is not starved by the first, and everything drains.
      const other = await m.test('^fine$', 'fine', 'polite')
      assert.equal(other, true)
      assert.equal(m.stats().queued, 0)
      // The overall bound: three keys fill it, a fourth is refused while they wait.
      const jobs = ['a', 'b', 'c'].map((k) => m.test(CORPUS[0].source, CORPUS[0].text, k))
      const fourth = await m.test('^fine$', 'fine', 'd')
      assert.equal(fourth, false, 'refused: the overall queue is full')
      await Promise.all(jobs)
    } finally { m.close() }
  })

  it('reports a run of timeouts once per interval, not once per timeout', async () => {
    const lines = []
    const listener = (e) => { if (e.component === 'bounded-regex' && e.level === 'warn') lines.push(e.message) }
    addLogListener(listener)
    const m = createBoundedRegexMatcher({ warnIntervalMs: 60_000 })
    try {
      for (let i = 0; i < 3; i++) await m.test(CORPUS[0].source, CORPUS[0].text)
    } finally { m.close(); removeLogListener(listener) }
    assert.ok(m.stats().timeouts >= 3)
    assert.equal(lines.length, 1)
  })

  it('the prompt evaluator evaluates normally (no skip) when a custom pattern runs out its deadline', async () => {
    _resetSkipPatternCache()
    const text = 'a'.repeat(250) + ' please review the change'
    assert.equal(await shouldSkipEvaluatorAsync(text, { promptEvaluatorSkipPattern: '.*a.*a.*b' }, matcher), false)
    // And a normal custom pattern still skips.
    assert.equal(await shouldSkipEvaluatorAsync('please proceed when ready', { promptEvaluatorSkipPattern: '^please proceed' }, matcher), true)
  })
})
