import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, isUserShellEnabled } from '../src/config.js'

/**
 * #5985 (epic #5982) — `userShell: { enabled: boolean }` gates the embedded
 * user-shell terminal. Validate the schema accepts a well-formed block, warns on
 * the wrong shapes/types, flags unknown sub-keys, and does NOT emit an "Unknown
 * config key" for `userShell`. Also pin `isUserShellEnabled` as the fail-closed
 * single source of truth.
 */
describe('config.userShell (#5985)', () => {
  it('accepts a well-formed { enabled: true } block', () => {
    const result = validateConfig({ userShell: { enabled: true } })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('accepts an empty userShell block (gate off)', () => {
    const result = validateConfig({ userShell: {} })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('warns when enabled is not a boolean', () => {
    const result = validateConfig({ userShell: { enabled: 'yes' } })
    assert.equal(result.valid, false)
    assert.ok(
      result.warnings.some((w) => w.includes('userShell.enabled') && w.includes('boolean')),
      `expected a type warning for userShell.enabled, got: ${JSON.stringify(result.warnings)}`,
    )
  })

  it('warns when userShell is an array (wrong shape)', () => {
    const result = validateConfig({ userShell: [] })
    assert.equal(result.valid, false)
    assert.ok(
      result.warnings.some((w) => w.includes('userShell') && w.includes('object')),
      `expected a shape warning for userShell, got: ${JSON.stringify(result.warnings)}`,
    )
  })

  it('warns on an unknown sub-key', () => {
    const result = validateConfig({ userShell: { enabled: true, sudo: true } })
    assert.ok(
      result.warnings.some((w) => w.includes('userShell') && w.toLowerCase().includes('unknown')),
      `expected an unknown-key warning for userShell.sudo, got: ${JSON.stringify(result.warnings)}`,
    )
  })

  it('does not flag userShell as an unknown config key', () => {
    const result = validateConfig({ userShell: { enabled: false } })
    const unknown = result.warnings.find((w) => w.includes('Unknown config key') && w.includes('userShell'))
    assert.equal(unknown, undefined)
  })
})

describe('isUserShellEnabled (#5985) — fail-closed', () => {
  it('is true ONLY for an explicit enabled:true', () => {
    assert.equal(isUserShellEnabled({ userShell: { enabled: true } }), true)
  })

  it('is false for enabled:false, missing block, or missing config', () => {
    assert.equal(isUserShellEnabled({ userShell: { enabled: false } }), false)
    assert.equal(isUserShellEnabled({ userShell: {} }), false)
    assert.equal(isUserShellEnabled({}), false)
    assert.equal(isUserShellEnabled(undefined), false)
    assert.equal(isUserShellEnabled(null), false)
  })

  it('is false for truthy-but-not-true enabled values (no coercion)', () => {
    assert.equal(isUserShellEnabled({ userShell: { enabled: 'true' } }), false)
    assert.equal(isUserShellEnabled({ userShell: { enabled: 1 } }), false)
  })
})
