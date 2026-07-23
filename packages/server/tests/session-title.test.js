import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  truncateTitle,
  sanitizeModelTitle,
  buildTitlePrompt,
  generateSessionTitle,
  TITLE_MAX_LEN,
  DEFAULT_SEMANTIC_TITLE_MODEL,
} from '../src/session-title.js'

/**
 * #6764 — unit tests for the pure semantic-title logic: the truncation fallback,
 * model-reply sanitising, prompt assembly, and the gated/fail-open orchestration.
 * The model call is injected (`runOneShot`) so no provider is needed.
 */

describe('truncateTitle', () => {
  it('passes short text through unchanged', () => {
    assert.equal(truncateTitle('Fix the bug'), 'Fix the bug')
  })

  it('trims surrounding whitespace', () => {
    assert.equal(truncateTitle('   Fix the bug   '), 'Fix the bug')
  })

  it('truncates long text at a word boundary with an ellipsis', () => {
    const label = truncateTitle('Help me fix the authentication bug in login.ts right now')
    assert.ok(label.length <= TITLE_MAX_LEN + 3, `expected <= ${TITLE_MAX_LEN + 3}, got ${label.length}`)
    assert.ok(label.endsWith('...'))
    assert.ok(!label.includes('...login'), 'should break before a partial word')
  })

  it('returns empty string for empty / non-string input', () => {
    assert.equal(truncateTitle(''), '')
    assert.equal(truncateTitle('   '), '')
    assert.equal(truncateTitle(null), '')
    assert.equal(truncateTitle(undefined), '')
    assert.equal(truncateTitle(42), '')
  })

  it('matches the historical _autoLabelSession output (byte-for-byte fallback)', () => {
    // The exact case asserted in auto-label.test.js.
    assert.equal(
      truncateTitle('Help me fix the authentication bug in login.ts'),
      'Help me fix the authentication bug in...',
    )
  })
})

describe('sanitizeModelTitle', () => {
  it('returns a clean title unchanged', () => {
    assert.equal(sanitizeModelTitle('Fix flaky WebSocket reconnect test'), 'Fix flaky WebSocket reconnect test')
  })

  it('strips surrounding straight and curly quotes and backticks', () => {
    assert.equal(sanitizeModelTitle('"Fix reconnect test"'), 'Fix reconnect test')
    assert.equal(sanitizeModelTitle("'Fix reconnect test'"), 'Fix reconnect test')
    assert.equal(sanitizeModelTitle('`Fix reconnect test`'), 'Fix reconnect test')
    assert.equal(sanitizeModelTitle('“Fix reconnect test”'), 'Fix reconnect test')
  })

  it('drops a single trailing period but preserves a real ellipsis', () => {
    assert.equal(sanitizeModelTitle('Refactor the auth middleware.'), 'Refactor the auth middleware')
    assert.equal(sanitizeModelTitle('Refactor the auth...'), 'Refactor the auth...')
  })

  it('takes only the first non-empty line', () => {
    assert.equal(sanitizeModelTitle('\n\nAdd retry to the tunnel\nHere is why: ...'), 'Add retry to the tunnel')
  })

  it('collapses internal whitespace runs', () => {
    assert.equal(sanitizeModelTitle('Add   retry\tto  tunnel'), 'Add retry to tunnel')
  })

  it('word-boundary caps an over-long reply', () => {
    const long = 'This is a rambling model reply that ignored the eight word instruction and just kept going forever'
    const out = sanitizeModelTitle(long)
    assert.ok(out.length <= 63, `expected <= 63, got ${out.length}`)
    assert.ok(out.endsWith('...'))
  })

  it('returns empty string for unusable input', () => {
    assert.equal(sanitizeModelTitle(''), '')
    assert.equal(sanitizeModelTitle('   \n  '), '')
    assert.equal(sanitizeModelTitle('""'), '')
    assert.equal(sanitizeModelTitle(null), '')
    assert.equal(sanitizeModelTitle(undefined), '')
    assert.equal(sanitizeModelTitle(42), '')
  })
})

describe('buildTitlePrompt', () => {
  it('includes the first user message', () => {
    const prompt = buildTitlePrompt({ firstUserMessage: 'refactor the auth middleware' })
    assert.match(prompt, /refactor the auth middleware/)
    assert.match(prompt, /Title:/)
  })

  it('includes the assistant response only when provided', () => {
    const without = buildTitlePrompt({ firstUserMessage: 'hi' })
    assert.ok(!without.includes('First assistant response'))
    const withResp = buildTitlePrompt({ firstUserMessage: 'hi', firstAssistantResponse: 'planning the work' })
    assert.match(withResp, /First assistant response/)
    assert.match(withResp, /planning the work/)
  })

  it('caps a huge first message so the call stays cheap', () => {
    const huge = 'x'.repeat(20000)
    const prompt = buildTitlePrompt({ firstUserMessage: huge })
    // The message segment is sliced to 4000 chars; the prompt is far under 20k.
    assert.ok(prompt.length < 6000, `prompt should be capped, got ${prompt.length}`)
  })

  it('tolerates missing / non-string message', () => {
    assert.doesNotThrow(() => buildTitlePrompt({}))
    assert.doesNotThrow(() => buildTitlePrompt({ firstUserMessage: null }))
  })
})

describe('generateSessionTitle', () => {
  const good = async () => 'Fix flaky reconnect test'

  it('returns the truncation fallback when disabled (no model call)', async () => {
    let called = false
    const runOneShot = async () => { called = true; return 'Model Title' }
    const res = await generateSessionTitle({
      firstUserMessage: 'please help me fix the flaky reconnect test in ws-server',
      enabled: false,
      runOneShot,
    })
    assert.equal(res.source, 'truncation')
    assert.equal(called, false, 'model must not be called when disabled')
    assert.equal(res.title, truncateTitle('please help me fix the flaky reconnect test in ws-server'))
  })

  it('returns the truncation fallback when no runner is provided', async () => {
    const res = await generateSessionTitle({ firstUserMessage: 'fix the bug', enabled: true })
    assert.equal(res.source, 'truncation')
    assert.equal(res.title, 'fix the bug')
  })

  it('returns a sanitised model title on success', async () => {
    const res = await generateSessionTitle({
      firstUserMessage: 'help me fix the flaky reconnect test',
      enabled: true,
      runOneShot: async () => '"Fix flaky reconnect test."',
    })
    assert.equal(res.source, 'model')
    assert.equal(res.title, 'Fix flaky reconnect test')
  })

  it('falls back to truncation when the model returns nothing usable', async () => {
    const res = await generateSessionTitle({
      firstUserMessage: 'help me fix the flaky reconnect test',
      enabled: true,
      runOneShot: async () => '   \n  ',
    })
    assert.equal(res.source, 'truncation')
    assert.equal(res.title, truncateTitle('help me fix the flaky reconnect test'))
  })

  it('fails open to truncation when the model call throws', async () => {
    const res = await generateSessionTitle({
      firstUserMessage: 'help me fix the flaky reconnect test',
      enabled: true,
      runOneShot: async () => { throw new Error('provider exploded') },
    })
    assert.equal(res.source, 'truncation')
    assert.equal(res.title, truncateTitle('help me fix the flaky reconnect test'))
  })

  it('fails open to truncation when the runner never resolves and the signal aborts (#6881)', async () => {
    // Regression for the #6881 blocking finding: a stalled provider stream must
    // not leave the call pending forever. The runner RESPECTS the injected signal
    // — it only settles by rejecting on abort, never on its own — so determinism
    // comes from the abort, not from racing a wall clock. Aborting the signal is
    // exactly what production's AbortSignal.timeout(...) does when it fires; here
    // we drive it synchronously so the test has no wall-clock dependence.
    const msg = 'help me fix the flaky reconnect test in ws-server.js'
    const controller = new AbortController()
    const runOneShot = ({ signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    // The runner is invoked synchronously inside generateSessionTitle (before its
    // first await suspends), so the abort listener is registered by the time this
    // returns the pending promise — aborting now deterministically rejects it.
    const pending = generateSessionTitle({
      firstUserMessage: msg,
      enabled: true,
      runOneShot,
      signal: controller.signal,
    })
    controller.abort()
    const res = await pending
    assert.equal(res.source, 'truncation')
    assert.equal(res.title, truncateTitle(msg))
  })

  it('threads the signal through to the runner (#6881)', async () => {
    let seen = 'UNSET'
    const { signal } = new AbortController()
    await generateSessionTitle({
      firstUserMessage: 'do a thing',
      enabled: true,
      runOneShot: async (args) => { seen = args.signal; return 'A Title' },
      signal,
    })
    assert.ok(seen instanceof AbortSignal, 'the injected signal reaches the runner')
  })

  it('uses the provided fallback label verbatim', async () => {
    const res = await generateSessionTitle({
      firstUserMessage: 'anything',
      enabled: false,
      fallback: 'Prebuilt Truncation',
      runOneShot: good,
    })
    assert.equal(res.title, 'Prebuilt Truncation')
    assert.equal(res.source, 'truncation')
  })

  it('falls back when the first message is blank even if enabled', async () => {
    let called = false
    const res = await generateSessionTitle({
      firstUserMessage: '   ',
      enabled: true,
      fallback: 'the fallback',
      runOneShot: async () => { called = true; return 'x' },
    })
    assert.equal(called, false)
    assert.equal(res.source, 'truncation')
    assert.equal(res.title, 'the fallback')
  })

  it('threads model + cwd through to the runner', async () => {
    let seen = null
    await generateSessionTitle({
      firstUserMessage: 'do a thing',
      enabled: true,
      model: 'haiku',
      cwd: '/tmp/work',
      runOneShot: async (args) => { seen = args; return 'A Title' },
    })
    assert.equal(seen.model, 'haiku')
    assert.equal(seen.cwd, '/tmp/work')
    assert.ok(typeof seen.prompt === 'string' && seen.prompt.includes('do a thing'))
  })

  it('exposes a cheap default model constant', () => {
    assert.equal(DEFAULT_SEMANTIC_TITLE_MODEL, 'haiku')
  })
})
