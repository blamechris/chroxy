/**
 * CALL-SITE coverage for the `assert.match` payload guard in this package
 * (#7413 review — C1).
 *
 * `scripts/__tests__/assert-match-payload-guard-wiring.test.mjs` walks every
 * package's `package.json` and checks each relative `--import` specifier's
 * target file for the TEXT `installAssertMatchPayloadGuard(`. That text
 * exists in two places: the hook's call site (what we want) and the
 * library's own `export function installAssertMatchPayloadGuard({`
 * definition (which installs nothing on import). Before this file existed,
 * swapping this package's `--import ../../scripts/lib/assert-match-payload-
 * guard-hook.mjs` for `--import ../../scripts/lib/assert-match-payload-guard.mjs`
 * — a one-token slip — left the walk green while this package's real suite
 * ran with stock, unguarded `assert.match`.
 *
 * `packages/server` and `packages/claude-hooks` catch that class of mistake
 * from inside their own `tests/_setup.mjs`-driven suites (see
 * `packages/claude-hooks/tests/setup-payload-guard.test.js`). This package has
 * no `tests/_setup.mjs`, but it needs none for a call-site pin: this file runs
 * under `package.json`'s own `test` script, so if that script's `--import`
 * ever points at the library instead of the hook, this process is never
 * patched and the first case below goes red.
 */

import { it } from 'node:test'
import assert from 'node:assert/strict'

it('the package test command installs the assert.match payload guard', () => {
  assert.ok(
    assert.match.name === 'chroxyGuardedAssert',
    "package.json's test script must --import assert-match-payload-guard-hook.mjs " +
      "(not the library it wraps) for this package's test process to be patched",
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
