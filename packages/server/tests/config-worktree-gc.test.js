import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'

/**
 * #5158 — `worktreeGc: { autoReap: boolean }` config block gates the opt-in
 * worktree auto-reaper. Validate the schema accepts a well-formed block and
 * warns on the wrong shapes/types, without emitting an "Unknown config key".
 */
describe('config.worktreeGc (#5158)', () => {
  it('accepts a well-formed { autoReap: true } block', () => {
    const result = validateConfig({ worktreeGc: { autoReap: true } })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('accepts an empty worktreeGc block (auto-reaper off)', () => {
    const result = validateConfig({ worktreeGc: {} })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('warns when autoReap is not a boolean', () => {
    const result = validateConfig({ worktreeGc: { autoReap: 'yes' } })
    assert.equal(result.valid, false)
    assert.ok(
      result.warnings.some((w) => w.includes('worktreeGc.autoReap') && w.includes('boolean')),
      `expected a type warning for worktreeGc.autoReap, got: ${JSON.stringify(result.warnings)}`,
    )
  })

  it('warns when worktreeGc is an array (wrong shape)', () => {
    const result = validateConfig({ worktreeGc: [] })
    assert.equal(result.valid, false)
    assert.ok(
      result.warnings.some((w) => w.includes('worktreeGc') && w.includes('object')),
      `expected a shape warning for worktreeGc, got: ${JSON.stringify(result.warnings)}`,
    )
  })

  // #5706 — maxLockAgeMs absolute-age fallback: non-negative number, 0 disables.
  it('accepts a non-negative maxLockAgeMs (incl. 0 to disable)', () => {
    assert.equal(validateConfig({ worktreeGc: { maxLockAgeMs: 1209600000 } }).warnings.length, 0)
    assert.equal(validateConfig({ worktreeGc: { maxLockAgeMs: 0 } }).warnings.length, 0)
  })

  it('warns when maxLockAgeMs is negative or non-numeric', () => {
    for (const bad of [-1, 'soon', NaN]) {
      const result = validateConfig({ worktreeGc: { maxLockAgeMs: bad } })
      assert.ok(
        result.warnings.some((w) => w.includes('worktreeGc.maxLockAgeMs')),
        `expected a warning for maxLockAgeMs=${String(bad)}, got: ${JSON.stringify(result.warnings)}`,
      )
    }
  })

  it('does not flag worktreeGc as an unknown key', () => {
    const result = validateConfig({ worktreeGc: { autoReap: false } })
    const unknown = result.warnings.find((w) => w.includes('Unknown config key') && w.includes('worktreeGc'))
    assert.equal(unknown, undefined)
  })
})
