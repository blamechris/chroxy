import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_BINARY_CANDIDATES, resolveClaudeBinary } from '../src/utils/claude-binary.js'

/**
 * Unit tests for the ONE shared `claude` binary candidate list + resolver
 * (#7986). Every claude-family provider's `preflight.binary.candidates`
 * references this exact array (see the parity test in providers.test.js) —
 * these tests cover the module in isolation.
 */

describe('CLAUDE_BINARY_CANDIDATES', () => {
  it('is a non-empty array of absolute-looking path strings', () => {
    assert.ok(Array.isArray(CLAUDE_BINARY_CANDIDATES))
    assert.ok(CLAUDE_BINARY_CANDIDATES.length > 0)
    for (const c of CLAUDE_BINARY_CANDIDATES) {
      assert.equal(typeof c, 'string')
      assert.ok(c.length > 0)
    }
  })

  // #7986 review N9 — frozen so one consumer mutating the array in place
  // (`.push()`, `.sort()`, …) can't silently corrupt every OTHER provider
  // sharing the same reference. A regression here throws a TypeError in
  // strict mode instead of quietly succeeding.
  it('is frozen — a mutation attempt throws rather than silently succeeding', () => {
    assert.ok(Object.isFrozen(CLAUDE_BINARY_CANDIDATES))
    assert.throws(() => { CLAUDE_BINARY_CANDIDATES.push('/tmp/not-allowed') }, TypeError)
  })
})

describe('resolveClaudeBinary', () => {
  it('resolves to a string (bare "claude" when nothing on PATH/candidates matches)', () => {
    const resolved = resolveClaudeBinary()
    assert.equal(typeof resolved, 'string')
    assert.ok(resolved.length > 0)
  })
})
