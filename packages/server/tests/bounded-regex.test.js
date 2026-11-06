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
  // For tests that are NOT about the 50 ms deadline: a harmless match must not be
  // able to miss it on a busy runner (a cold worker can take longer than 50 ms).
  const generous = createBoundedRegexMatcher({ timeoutMs: 10_000 })
  // The deadline for tests that need a runaway to time out AND a harmless match
  // after it to succeed: far above any scheduling jitter, short enough to wait out.
  const REPLACEMENT_TIMEOUT_MS = 1500
  const RUNAWAY = { source: '^(a+)+$', text: 'a'.repeat(40) + '!' } // does not finish in any real time
  after(() => { matcher.close(); generous.close() })

  it('matches and rejects ordinary patterns, case-insensitively', async () => {
    assert.equal(await generous.test('^proceed$', 'PROCEED'), true)
    assert.equal(await generous.test('^proceed$', 'stop'), false)
    assert.equal(await generous.test('[unclosed', 'anything'), false, 'a malformed pattern never matches')
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
    // Tests replacement, not speed: the deadline is generous so the harmless match
    // cannot time out on a slow runner, and a timeout is what it would take to fail.
    const m = createBoundedRegexMatcher({ timeoutMs: REPLACEMENT_TIMEOUT_MS })
    try {
      assert.equal(await m.test(RUNAWAY.source, RUNAWAY.text), false)
      assert.equal(m.stats().timeouts, 1, 'the runaway ran out its deadline')
      assert.equal(await m.test('^ok$', 'ok'), true)
      assert.equal(m.stats().timeouts, 1, 'and the harmless match did not')
    } finally { m.close() }
  })

  it('a harmless match queued behind a runaway one is not charged for it', async () => {
    const m = createBoundedRegexMatcher({ timeoutMs: REPLACEMENT_TIMEOUT_MS })
    try {
      const [runaway, harmless] = await Promise.all([
        m.test(RUNAWAY.source, RUNAWAY.text),
        m.test('^fine$', 'fine'),
      ])
      assert.equal(runaway, false)
      assert.equal(harmless, true)
      assert.equal(m.stats().timeouts, 1, 'only the runaway timed out')
    } finally { m.close() }
  })

  it('text longer than maxInput is not tested at all and counts as no match (no prefix match)', async () => {
    // The cap is under test, not the deadline: the match at the cap must not be able to miss 50 ms on a busy runner
    // (a timeout counts as no match, which is what a real match would then be mistaken for).
    const m = createBoundedRegexMatcher({ maxInput: 10, timeoutMs: 5000 })
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
    const m = createBoundedRegexMatcher({ maxQueuedPerKey: 2, maxQueued: 3, timeoutMs: 400 })
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
    assert.equal(await shouldSkipEvaluatorAsync('please proceed when ready', { promptEvaluatorSkipPattern: '^please proceed' }, generous), true)
  })
})
