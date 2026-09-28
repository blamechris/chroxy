/**
 * CALL-SITE coverage for the `assert.match` payload guard in this package
 * (#7413, extending #7401's server-only install to claude-hooks).
 *
 * `scripts/__tests__/assert-match-payload-guard-wiring.test.mjs` proves the
 * guard is textually wired into every package's test script.
 * `packages/server/tests/assert-match-payload-guard.test.js` proves the
 * MODULE's behaviour (verdicts unchanged, payload bounded, escape hatch,
 * binding-form coverage). Neither proves that THIS package's
 * `tests/_setup.mjs` actually installs it — the asymmetry #7413 exists to
 * close, and the same "a shared guard needs a test per entry point" reasoning
 * `setup-no-force-exit.test.js` documents for the force-exit refusal.
 *
 * This suite runs under `node --import ./tests/_setup.mjs --test`, per this
 * package's `package.json` — so if `_setup.mjs` installs the guard, the
 * `assert` this file imports is already patched by the time these cases run.
 * Deleting the `installAssertMatchPayloadGuard()` call from `_setup.mjs`
 * turns the first case red: `assert.match.name` reverts to stock's `'match'`.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('tests/_setup.mjs installs the assert.match payload guard (#7413)', () => {
  it('is actually installed on the assert this test imported', () => {
    // Positive control, mirroring the server suite's own first case: without
    // this, every "still behaves like stock" assertion below would pass just
    // as well with the guard absent, and the file would be testing stock
    // assert instead of the wiring.
    assert.ok(
      assert.match.name === 'chroxyGuardedAssert',
      'tests/_setup.mjs must call installAssertMatchPayloadGuard() so this package\'s ' +
        'assert.match/doesNotMatch are patched process-wide',
    )
  })

  it('still fails a large non-matching subject — the guard never flips a verdict', () => {
    const big = 'x'.repeat(5000)
    assert.throws(() => assert.match(big, /NEEDLE/), { operator: 'match' })
  })

  it('withholds the subject from the failure payload', () => {
    const big = 'x'.repeat(5000)
    let caught = null
    try {
      assert.match(big, /NEEDLE/)
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'precondition: the assertion failed')
    assert.ok(!String(caught.actual).includes(big), 'the full subject must not ride along on the error')
  })
})
