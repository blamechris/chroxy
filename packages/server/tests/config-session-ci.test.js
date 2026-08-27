import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'

/**
 * #7424 — `sessionCi: { watch, wakeAgent, intervalMs, discoveryIntervalMs }`
 * gates the CI-completion watcher. The block is ON by default, so the shapes
 * that must warn are the ones that would otherwise silently produce a daemon
 * that either makes background GitHub calls the operator meant to switch off,
 * or spins a sweep on a zero interval.
 *
 * The wiring side (a bad interval falling back to the module default rather
 * than being honoured) is covered in session-ci-watcher.test.js; this file
 * covers the warnings the operator actually sees at startup.
 */
describe('config.sessionCi (#7424)', () => {
  it('accepts a well-formed block, and an empty one', () => {
    for (const sessionCi of [
      { watch: true, wakeAgent: false, intervalMs: 30_000, discoveryIntervalMs: 600_000 },
      { watch: false },
      {},
    ]) {
      const result = validateConfig({ sessionCi })
      assert.equal(result.valid, true, `expected ${JSON.stringify(sessionCi)} to validate`)
      assert.deepEqual(result.warnings, [])
    }
  })

  it('accepts an absent block (the default: watching on)', () => {
    assert.deepEqual(validateConfig({}).warnings, [])
  })

  for (const key of ['watch', 'wakeAgent']) {
    it(`warns when ${key} is not a boolean`, () => {
      const result = validateConfig({ sessionCi: { [key]: 'yes' } })
      assert.equal(result.valid, false)
      assert.ok(
        result.warnings.some(w => w.includes(`sessionCi.${key}`) && w.includes('boolean')),
        `expected a type warning for sessionCi.${key}, got: ${JSON.stringify(result.warnings)}`,
      )
    })
  }

  for (const key of ['intervalMs', 'discoveryIntervalMs']) {
    it(`warns on a non-positive or non-numeric ${key}`, () => {
      // 0 and negatives matter specifically: the sweep spawns git + gh, so an
      // interval of 0 is a subprocess spin, not a "run often" setting.
      for (const bad of [0, -1, 'soon']) {
        const result = validateConfig({ sessionCi: { [key]: bad } })
        assert.equal(result.valid, false, `${key}: ${String(bad)} should not validate`)
        assert.ok(
          result.warnings.some(w => w.includes(`sessionCi.${key}`) && w.includes('positive')),
          `expected a positive-number warning for sessionCi.${key}=${String(bad)}, got: ${JSON.stringify(result.warnings)}`,
        )
      }
    })
  }

  it('warns when sessionCi is an array (wrong shape)', () => {
    const result = validateConfig({ sessionCi: [] })
    assert.equal(result.valid, false)
    assert.ok(
      result.warnings.some(w => w.includes('sessionCi') && w.includes('object')),
      `expected a shape warning for sessionCi, got: ${JSON.stringify(result.warnings)}`,
    )
  })

  it('warns on an unknown sub-key rather than dropping it silently', () => {
    // #5878's typo-catch: `wakeAgents` is the plausible slip, and without this
    // it would read as "wake disabled" to nobody and "wake enabled" to the code.
    const result = validateConfig({ sessionCi: { wakeAgents: false } })
    assert.ok(
      result.warnings.some(w => w.includes('sessionCi.wakeAgents') && w.includes('unknown key')),
      `expected an unknown-key warning, got: ${JSON.stringify(result.warnings)}`,
    )
    assert.ok(
      result.warnings.some(w => w.includes('wakeAgent')),
      'the warning must list the supported keys so the typo is fixable from it',
    )
  })
})
