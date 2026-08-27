/**
 * Proof for the `assert.match` payload guard (#7401).
 *
 * The guard's whole value is that it shrinks a FAILURE payload without ever
 * changing a pass/fail verdict. Both halves are load-bearing and both are
 * pinned here — a guard that turned a failing assertion into a silent pass
 * would be a far worse bug than the 124 KB TAP block it was written to stop.
 *
 * The guard is installed process-wide by `_setup.mjs`, so the `assert` this
 * file imports is already patched; the tests exercise it through the same
 * default-import surface every other server test uses.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  installAssertMatchPayloadGuard,
  DEFAULT_SUBJECT_LIMIT,
} from '../../../scripts/lib/assert-match-payload-guard.mjs'

const TESTS_DIR = import.meta.dirname
const BIG = 'x'.repeat(DEFAULT_SUBJECT_LIMIT * 3)
const SMALL = 'x'.repeat(32)

/** Run `fn`, returning the thrown error or null. */
function thrown(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err
  }
}

describe('assert.match payload guard — verdicts are unchanged (#7401)', () => {
  it('is actually installed on the assert this test imported', () => {
    // Positive control. Without this, every "does not throw" case below would
    // pass just as well with the guard absent, and the file would be testing
    // stock assert rather than the guard.
    assert.ok(
      assert.match.name === 'chroxyGuardedAssert',
      'the process-wide guard from _setup.mjs must be patched onto node:assert/strict',
    )
  })

  it('a large subject that MATCHES still passes', () => {
    assert.doesNotThrow(() => assert.match(`${BIG}NEEDLE`, /NEEDLE/))
  })

  // THE critical case. If the guard ever swallows this, it has converted a
  // real failure into a green test — the exact class docs/false-safety-guards.md
  // catalogues, introduced by the fix for one of its entries.
  it('a large subject that does NOT match still FAILS', () => {
    const err = thrown(() => assert.match(BIG, /NEEDLE/))
    assert.ok(err, 'an over-limit non-matching subject must still throw')
    assert.equal(err.operator, 'match')
  })

  it('a large subject that matches still FAILS doesNotMatch', () => {
    const err = thrown(() => assert.doesNotMatch(`${BIG}NEEDLE`, /NEEDLE/))
    assert.ok(err, 'an over-limit matching subject must still throw for doesNotMatch')
    assert.equal(err.operator, 'doesNotMatch')
  })

  it('a large subject that does not match PASSES doesNotMatch', () => {
    assert.doesNotThrow(() => assert.doesNotMatch(BIG, /NEEDLE/))
  })
})

describe('assert.match payload guard — the payload is actually capped (#7401)', () => {
  it('withholds the subject from a failing over-limit assertion', () => {
    const err = thrown(() => assert.match(BIG, /NEEDLE/))
    assert.ok(err, 'precondition: the assertion failed')
    // The harm being prevented is the SERIALISED size — that is what lands in
    // the TAP YAML block, so measure that rather than the message alone.
    const serialised = JSON.stringify({
      message: err.message,
      actual: err.actual,
      expected: String(err.expected),
    })
    assert.ok(
      serialised.length < 2000,
      `failure payload must stay bounded; got ${serialised.length} chars for a ${BIG.length}-char subject`,
    )
    assert.ok(
      !err.actual.includes(BIG),
      'the full subject must not ride along on the error',
    )
    assert.ok(
      String(err.actual).includes(`${BIG.length} chars total`),
      'the preview should still say how big the withheld subject was',
    )
  })

  it('preserves a caller-supplied message verbatim', () => {
    const err = thrown(() => assert.match(BIG, /NEEDLE/, 'my specific complaint'))
    assert.equal(err.message, 'my specific complaint')
  })

  it('points the reader at the per-site fix when no message was supplied', () => {
    const err = thrown(() => assert.match(BIG, /NEEDLE/))
    assert.ok(
      err.message.includes('assert.ok(') && err.message.includes('#7401'),
      'the default message should name the boolean-collapse fix',
    )
  })
})

describe('assert.match payload guard — small subjects are untouched (#7401)', () => {
  it('leaves a small failing subject fully intact in `actual`', () => {
    const err = thrown(() => assert.match(SMALL, /NEEDLE/))
    assert.ok(err, 'precondition: the assertion failed')
    assert.equal(err.actual, SMALL, 'under the limit, stock assert behaviour is preserved')
  })

  it('delegates non-string subjects and non-regexp patterns unchanged', () => {
    // The guard must not intercept argument-validation errors and reshape
    // them. These two codes are stock `node:assert/strict` behaviour, verified
    // against an unpatched assert — and note they DIFFER from each other, so a
    // guard that normalised both into one error would fail here.
    assert.throws(() => assert.match(123, /x/), { code: 'ERR_ASSERTION' })
    assert.throws(() => assert.match('abc', 'not-a-regexp'), { code: 'ERR_INVALID_ARG_TYPE' })
  })
})

describe('assert.match payload guard — mechanics (#7401)', () => {
  it('evaluates the regex exactly once, so a /g lastIndex advances as it would unguarded', () => {
    // A /g regex is stateful. Stock assert.match calls .test() once; if the
    // guard called it twice the second call would resume from lastIndex and
    // could report the opposite verdict.
    const re = /NEEDLE/g
    assert.match(`${BIG}NEEDLE`, re)
    assert.ok(re.lastIndex > 0, 'exactly one .test() call should have advanced lastIndex')
  })

  it('is idempotent — installing twice does not double-wrap', () => {
    const again = installAssertMatchPayloadGuard()
    assert.deepEqual(again.patched, [], 'a second install on already-patched objects is a no-op')
  })
})

// ---------------------------------------------------------------------------
// The guard's one coverage hole, enforced rather than asserted.
// ---------------------------------------------------------------------------
//
// The guard patches the `node:assert` / `node:assert/strict` CJS objects. A
// DEFAULT import resolves to that live object, so every current server test is
// covered. A NAMED or NAMESPACE import (`import { match } from 'node:assert'`,
// `import * as assert from 'node:assert'`) binds differently and would bypass
// it. There are none today. This fails the moment one lands, rather than the
// guard quietly covering less than it claims — the same "category enforced,
// not asserted" shape as tests/setup-sandbox-coverage.test.js.
describe('assert.match payload guard — coverage is enforced (#7401)', () => {
  it('no server test imports assert by a binding form the guard cannot patch', () => {
    const offenders = []
    for (const entry of readdirSync(TESTS_DIR)) {
      if (!entry.endsWith('.test.js')) continue
      const src = readFileSync(join(TESTS_DIR, entry), 'utf8')
      for (const line of src.split('\n')) {
        // `import { x } from 'node:assert'` or `import * as x from 'node:assert'`
        if (/^\s*import\s+(?:\{|\*)\s.*from\s+['"]node:assert(?:\/strict)?['"]/.test(line)) {
          offenders.push(`${entry}: ${line.trim()}`)
        }
      }
    }
    assert.ok(
      offenders.length === 0,
      'these use a non-default assert import, which the payload guard cannot patch — ' +
        'switch them to `import assert from \'node:assert/strict\'` or widen the guard:\n' +
        offenders.join('\n'),
    )
  })
})
