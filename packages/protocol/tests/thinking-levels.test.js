import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// #7730 — the level vocabulary, its bounded syntactic guard, and the per-model
// roster resolver. Every literal roster in this FILE is written by hand on
// purpose: deriving the expectation from LEGACY_THINKING_LEVELS would make the
// test unable to go red for a change to the thing it is checking (#7424), and
// the roster lint deliberately exempts tests for exactly this reason.

describe('@chroxy/protocol thinking levels — the legacy fallback roster (#7730)', () => {
  it('is the Claude triple, in picker order', async () => {
    const { LEGACY_THINKING_LEVELS } = await import('../src/thinking-levels.ts')
    assert.deepEqual([...LEGACY_THINKING_LEVELS], ['default', 'high', 'max'])
  })

  it('the legacy default is a member of the legacy roster', async () => {
    const { LEGACY_THINKING_LEVELS, LEGACY_DEFAULT_THINKING_LEVEL } = await import('../src/thinking-levels.ts')
    assert.equal(LEGACY_DEFAULT_THINKING_LEVEL, 'default')
    assert.ok(LEGACY_THINKING_LEVELS.includes(LEGACY_DEFAULT_THINKING_LEVEL))
  })
})

describe('@chroxy/protocol isWellFormedThinkingLevel (#7730)', () => {
  // One ACCEPT and one REJECT in the same block, deliberately (#7273): a check
  // that denies nothing and a check that denies everything both satisfy a
  // negative-only test, so neither half is meaningful without the other.
  it('ACCEPTS the legacy levels and the codex efforts observed in the wild', async () => {
    const { isWellFormedThinkingLevel } = await import('../src/thinking-levels.ts')
    for (const ok of ['default', 'high', 'max', 'low', 'medium', 'xhigh', 'ultra', 'zzz', 'a_b-c', 'X9']) {
      assert.equal(isWellFormedThinkingLevel(ok), true, `${ok} must be accepted`)
    }
  })

  it('REJECTS path traversal, whitespace, metacharacters, empty and over-long values', async () => {
    const { isWellFormedThinkingLevel, THINKING_LEVEL_MAX_LENGTH } = await import('../src/thinking-levels.ts')
    const tooLong = 'a'.repeat(200)
    assert.equal(tooLong.length, 200, 'the over-long case must actually be 200 chars')
    assert.ok(tooLong.length > THINKING_LEVEL_MAX_LENGTH, 'and must actually exceed the cap')
    for (const bad of ['../../etc', tooLong, '', ' ', 'high max', 'high;rm -rf /', '../high', 'hi/gh', 'hi.gh', "hi'gh"]) {
      assert.equal(isWellFormedThinkingLevel(bad), false, `${JSON.stringify(bad)} must be rejected`)
    }
  })

  it('REJECTS non-strings without throwing', async () => {
    const { isWellFormedThinkingLevel } = await import('../src/thinking-levels.ts')
    for (const bad of [null, undefined, 7, {}, ['high'], true]) {
      assert.equal(isWellFormedThinkingLevel(bad), false)
    }
  })

  it('accepts a value at exactly the cap and rejects one character more', async () => {
    const { isWellFormedThinkingLevel, THINKING_LEVEL_MAX_LENGTH } = await import('../src/thinking-levels.ts')
    assert.equal(isWellFormedThinkingLevel('a'.repeat(THINKING_LEVEL_MAX_LENGTH)), true)
    assert.equal(isWellFormedThinkingLevel('a'.repeat(THINKING_LEVEL_MAX_LENGTH + 1)), false)
  })
})

describe('@chroxy/protocol resolveThinkingLevels (#7730)', () => {
  it("a model row's OWN levels win outright — including a level nobody has ever shipped", async () => {
    const { resolveThinkingLevels } = await import('../src/thinking-levels.ts')
    // THE anti-roster case: `zzz` is in no list anywhere in this repo, and the
    // resolver offers it because the MODEL said so.
    const got = resolveThinkingLevels({ reasoningLevels: ['low', 'zzz', 'ultra'], defaultReasoningLevel: 'zzz' })
    assert.deepEqual(got.levels, ['low', 'zzz', 'ultra'])
    assert.equal(got.defaultLevel, 'zzz')
    assert.equal(got.source, 'model')
  })

  it('preserves the provider\'s ORDER rather than sorting or normalising it', async () => {
    const { resolveThinkingLevels } = await import('../src/thinking-levels.ts')
    assert.deepEqual(resolveThinkingLevels({ reasoningLevels: ['xhigh', 'low', 'medium'] }).levels,
      ['xhigh', 'low', 'medium'])
  })

  it('falls back to the legacy triple for a row with no reasoning levels', async () => {
    const { resolveThinkingLevels } = await import('../src/thinking-levels.ts')
    for (const row of [null, undefined, {}, { reasoningLevels: [] }, { reasoningLevels: 'high' }, { reasoningLevels: ['', '  '] }]) {
      const got = resolveThinkingLevels(row)
      assert.deepEqual(got.levels, ['default', 'high', 'max'], `row ${JSON.stringify(row)} must fall back`)
      assert.equal(got.defaultLevel, 'default')
      assert.equal(got.source, 'legacy')
    }
  })

  it('drops malformed elements but keeps the well-formed ones', async () => {
    const { resolveThinkingLevels } = await import('../src/thinking-levels.ts')
    const got = resolveThinkingLevels({ reasoningLevels: ['low', 7, '../etc', null, 'xhigh'] })
    assert.deepEqual(got.levels, ['low', 'xhigh'])
    assert.equal(got.source, 'model')
  })

  it('never returns a defaultLevel outside the offered levels', async () => {
    const { resolveThinkingLevels } = await import('../src/thinking-levels.ts')
    // A row whose advertised default is not in its own list — observed shapes
    // drift, and a <select> whose value matches no <option> renders the FIRST
    // one, which would silently misreport the session's level.
    const got = resolveThinkingLevels({ reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'ultra' })
    assert.equal(got.defaultLevel, 'low')
    assert.ok(got.levels.includes(got.defaultLevel))
  })

  it('a `source` of legacy is distinguishable from a row that advertised exactly the triple', async () => {
    const { resolveThinkingLevels } = await import('../src/thinking-levels.ts')
    const advertised = resolveThinkingLevels({ reasoningLevels: ['default', 'high', 'max'] })
    assert.deepEqual(advertised.levels, ['default', 'high', 'max'])
    assert.equal(advertised.source, 'model', '"the model said so" must not read as "nothing was said"')
  })
})

describe('@chroxy/protocol thinkingLevelOptions / label (#7730)', () => {
  it('labels `default` as Auto and every other level as itself, capitalised', async () => {
    const { formatThinkingLevelLabel } = await import('../src/thinking-levels.ts')
    assert.equal(formatThinkingLevelLabel('default'), 'Auto')
    assert.equal(formatThinkingLevelLabel('high'), 'High')
    assert.equal(formatThinkingLevelLabel('xhigh'), 'Xhigh')
    // A level nobody has seen still renders legibly — there is no pretty-name
    // table to look it up in, and inventing one would be another frozen roster.
    assert.equal(formatThinkingLevelLabel('zzz'), 'Zzz')
  })

  it('turns a model row into {id,label} options', async () => {
    const { thinkingLevelOptions } = await import('../src/thinking-levels.ts')
    assert.deepEqual(thinkingLevelOptions({ reasoningLevels: ['low', 'zzz'] }),
      [{ id: 'low', label: 'Low' }, { id: 'zzz', label: 'Zzz' }])
    assert.deepEqual(thinkingLevelOptions(null),
      [{ id: 'default', label: 'Auto' }, { id: 'high', label: 'High' }, { id: 'max', label: 'Max' }])
  })
})

describe('SetThinkingLevelSchema — a BOUNDED string, not an enum (#7730)', () => {
  it('ACCEPTS a level no list in this repo contains', async () => {
    const { SetThinkingLevelSchema } = await import('../src/schemas/client.ts')
    const parsed = SetThinkingLevelSchema.safeParse({ type: 'set_thinking_level', level: 'zzz' })
    assert.equal(parsed.success, true, 'the wire schema must not hold the roster — membership is per-model, server-side')
    assert.equal(parsed.data.level, 'zzz')
  })

  it('ACCEPTS the legacy levels and the codex efforts', async () => {
    const { SetThinkingLevelSchema } = await import('../src/schemas/client.ts')
    for (const level of ['default', 'high', 'max', 'low', 'medium', 'xhigh', 'ultra']) {
      assert.equal(SetThinkingLevelSchema.safeParse({ type: 'set_thinking_level', level }).success, true, level)
    }
  })

  it('REJECTS `../../etc` and a 200-char level', async () => {
    const { SetThinkingLevelSchema } = await import('../src/schemas/client.ts')
    assert.equal(SetThinkingLevelSchema.safeParse({ type: 'set_thinking_level', level: '../../etc' }).success, false)
    assert.equal(SetThinkingLevelSchema.safeParse({ type: 'set_thinking_level', level: 'a'.repeat(200) }).success, false)
  })

  it('REJECTS an empty level and a non-string level', async () => {
    const { SetThinkingLevelSchema } = await import('../src/schemas/client.ts')
    assert.equal(SetThinkingLevelSchema.safeParse({ type: 'set_thinking_level', level: '' }).success, false)
    assert.equal(SetThinkingLevelSchema.safeParse({ type: 'set_thinking_level', level: 7 }).success, false)
    assert.equal(SetThinkingLevelSchema.safeParse({ type: 'set_thinking_level' }).success, false)
  })
})
