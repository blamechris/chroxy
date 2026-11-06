import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LEGACY_THINKING_LEVELS } from '@chroxy/protocol'
import { SdkSession } from '../src/sdk-session.js'

/**
 * #7785 — `SdkSession.THINKING_BUDGETS` is the one place a level roster hides
 * from `scripts/lint-thinking-level-roster.sh` (an object literal with
 * UNQUOTED keys), and that lint's header names it as a deliberate exemption.
 * This file is the coverage the exemption was promised, in BOTH directions:
 *
 *   - the values: the Claude level -> `maxThinkingTokens` mapping is pinned
 *     against a table written BY HAND here (#7730's acceptance: that mapping
 *     must not change). A test may legally write the triple out; deriving the
 *     expectation from the table under test is #7424 and cannot go red.
 *   - the keys vs the canonical roster `LEGACY_THINKING_LEVELS`: the two are
 *     produced by disjoint modules, so neither side is derived from the other.
 *     A level added to the roster with no budget row, or a budget row for a
 *     level the roster does not offer, goes red.
 *
 * Red-proofed (see the PR body): dropping a key, adding a key and changing a
 * value each fail here.
 */

describe('SdkSession.THINKING_BUDGETS (#7785)', () => {
  it('pins the level -> maxThinkingTokens mapping by hand', () => {
    assert.deepEqual(
      { ...SdkSession.THINKING_BUDGETS },
      { default: null, high: 32000, max: 128000 },
    )
  })

  it('has a budget row for every level the canonical roster offers', () => {
    const missing = LEGACY_THINKING_LEVELS.filter(
      (level) => !Object.prototype.hasOwnProperty.call(SdkSession.THINKING_BUDGETS, level),
    )
    assert.deepEqual(missing, [], 'roster levels with no THINKING_BUDGETS row')
  })

  it('has no budget row for a level the canonical roster does not offer', () => {
    const extra = Object.keys(SdkSession.THINKING_BUDGETS).filter(
      (key) => !LEGACY_THINKING_LEVELS.includes(key),
    )
    assert.deepEqual(extra, [], 'THINKING_BUDGETS rows outside the roster')
  })

  it('is not vacuous: both sides of the comparison are non-empty', () => {
    assert.ok(LEGACY_THINKING_LEVELS.length > 0)
    assert.ok(Object.keys(SdkSession.THINKING_BUDGETS).length > 0)
  })

  describe('the budget reaches the next turn through _thinkingOptions', () => {
    let tmp
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true })
      tmp = undefined
    })

    function make(level) {
      tmp = mkdtempSync(join(tmpdir(), 'sdk-budgets-'))
      const s = new SdkSession({ cwd: tmp, stateFilePath: join(tmp, 'state.json') })
      s._fetchSupportedModels = () => {}
      s._thinkingLevel = level
      return s
    }

    it('no level sends neither effort nor budget', () => {
      assert.deepEqual(make(null)._thinkingOptions(), {})
    })

    it('an unknown-support model gets the level as effort plus its hand-written budget', () => {
      const s = make('high')
      s._effortSupportFor = () => null
      assert.deepEqual(s._thinkingOptions(), { effort: 'high', maxThinkingTokens: 32000 })
      s._thinkingLevel = 'max'
      assert.deepEqual(s._thinkingOptions(), { effort: 'max', maxThinkingTokens: 128000 })
    })

    it('a budget-only model gets the budget alone', () => {
      const s = make('high')
      s._effortSupportFor = () => 'budget'
      assert.deepEqual(s._thinkingOptions(), { maxThinkingTokens: 32000 })
    })
  })
})
