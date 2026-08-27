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
import { dirname, join, relative, sep } from 'node:path'

import {
  installAssertMatchPayloadGuard,
  DEFAULT_SUBJECT_LIMIT,
  FULL_PAYLOAD_ENV,
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
    // Pin the PAYLOAD too, not just the verdict. Without this line, removing
    // 'doesNotMatch' from the patch loop leaves the whole suite green: stock
    // assert.doesNotMatch also throws with operator 'doesNotMatch', so every
    // other assertion here is satisfied by the unguarded function. That mutant
    // survived review, and this is what kills it.
    assert.ok(
      !String(err.actual).includes(BIG),
      'doesNotMatch must withhold the subject too — not just match',
    )
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

  // Copilot suggested preserving a caller-supplied '' verbatim (i.e. `message
  // !== undefined` rather than `message ||`). Measured against stock
  // node:assert/strict on Node 22, that would DIVERGE: stock treats every
  // falsy message as absent and generates one, with generatedMessage=true.
  // The guard's contract is to be indistinguishable from stock except for
  // payload size, so it matches stock and this pins that.
  it('treats every falsy message as absent, exactly as stock assert does', () => {
    for (const falsy of ['', 0, false, null, undefined]) {
      const err = thrown(() => assert.match(BIG, /NEEDLE/, falsy))
      assert.ok(err, `precondition: falsy message ${JSON.stringify(falsy)} still fails`)
      assert.ok(
        err.generatedMessage === true && err.message.includes('#7401'),
        `falsy message ${JSON.stringify(falsy)} should fall back to the generated message`,
      )
    }
  })

  it('throws a caller-supplied Error verbatim, as stock does', () => {
    const boom = new Error('boom')
    const err = thrown(() => assert.match(BIG, /NEEDLE/, boom))
    assert.equal(err, boom, "an Error message is stock's throw-it-verbatim path")
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

  it('delegates AT the limit and truncates one char above it', () => {
    // Pins DEFAULT_SUBJECT_LIMIT's boundary. Nothing else does, so `<=` could
    // become `<` unnoticed. Verdicts are identical either side; what changes is
    // whether the subject survives, so assert on that.
    const atLimit = 'x'.repeat(DEFAULT_SUBJECT_LIMIT)
    const overLimit = 'x'.repeat(DEFAULT_SUBJECT_LIMIT + 1)
    assert.equal(thrown(() => assert.match(atLimit, /NEEDLE/)).actual, atLimit)
    assert.ok(!String(thrown(() => assert.match(overLimit, /NEEDLE/)).actual).includes(overLimit))
  })

  it('honours the full-payload escape hatch, and only on an affirmative value', () => {
    assert.equal(installAssertMatchPayloadGuard({ env: { [FULL_PAYLOAD_ENV]: '1' } }).skipped, true)
    // `FOO=0` must NOT disarm it — the #7400 lesson.
    assert.equal(installAssertMatchPayloadGuard({ env: { [FULL_PAYLOAD_ENV]: '0' } }).skipped, false)
    assert.equal(installAssertMatchPayloadGuard({ env: {} }).skipped, false)
  })

  it('matches stock for a regex with an overridden exec', () => {
    // `regexp.test()` reads `exec` off the object; `assert.match` uses the
    // primordial one. A guard using `.test()` would report this failing
    // assertion as a PASS.
    const liar = Object.assign(new RegExp('NEEDLE'), { exec: () => ['x'] })
    assert.ok(thrown(() => assert.match(BIG, liar)), 'must still fail despite a lying exec')
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
function walkTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkTestFiles(full, out)
    else if (/\.(m?js)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * A named or namespace import of `node:assert`, tolerant of the statement
 * being split across lines (`[^'"]*` crosses newlines).
 *
 * Anchored to the start of a line with the `m` flag, which is what keeps it
 * off PROSE: this file and the guard module both mention
 * `import { match } from 'node:assert'` inside comments, and those lines begin
 * with `//` or ` *`. An unanchored search matches them and the test fails
 * against itself — which is exactly how the first version of this regex
 * behaved.
 */
const NON_DEFAULT_ASSERT_IMPORT =
  /^[ \t]*import\s+[^'"]*?(?:\{|\*)[^'"]*?from\s*['"]node:assert(?:\/strict)?['"]/gm

describe('assert.match payload guard — coverage is enforced (#7401)', () => {
  it('scans every server test file, subdirectories included', () => {
    // Positive control for the scan itself. The first version of this test
    // used a flat `readdirSync(TESTS_DIR)` and silently skipped the 50 test
    // files under tests/security, tests/handlers, tests/cli and friends — a
    // guard covering 91% of what it claimed to cover, which is the defect
    // class this whole PR is about. Pin the traversal, not just its verdict.
    const files = walkTestFiles(TESTS_DIR)
    // `dirname(f) !== TESTS_DIR`, NOT a '/' search on the relative path: on
    // Windows `join` emits backslashes, so `includes('/')` finds nothing and
    // this control fails for a reason that has nothing to do with the walk.
    // It did exactly that on the Windows CI job — the control working as
    // intended (it refused to certify a scan it could not verify) via an
    // implementation that was POSIX-only.
    const nested = files.filter((f) => dirname(f) !== TESTS_DIR)
    assert.ok(
      nested.length > 0,
      'the walk must descend into subdirectories; found none, so the scan below proves nothing',
    )
    assert.ok(files.length > 500, `expected the full server test corpus, got ${files.length} files`)
  })

  it('no server test imports assert by a binding form the guard cannot patch', () => {
    const offenders = []
    for (const file of walkTestFiles(TESTS_DIR)) {
      const src = readFileSync(file, 'utf8')
      NON_DEFAULT_ASSERT_IMPORT.lastIndex = 0
      for (const m of src.matchAll(NON_DEFAULT_ASSERT_IMPORT)) {
        const rel = relative(TESTS_DIR, file).split(sep).join('/')
        offenders.push(`${rel}: ${m[0].replace(/\s+/g, ' ').trim()}`)
      }
    }
    assert.ok(
      offenders.length === 0,
      'these use a non-default assert import, which the payload guard cannot patch — ' +
        'switch them to `import assert from \'node:assert/strict\'` or widen the guard:\n' +
        offenders.join('\n'),
    )
  })

  it('the offender regex actually detects both bypassing forms, incl. multi-line', () => {
    // Positive control for the DETECTOR. Without this, the test above passes
    // just as well with a regex that matches nothing at all.
    const bypasses = [
      "import { match } from 'node:assert'",
      "import * as assert from 'node:assert'",
      "import assert, { match } from 'node:assert/strict'",
      'import {\n  match,\n  doesNotMatch,\n} from \'node:assert\'',
    ]
    for (const sample of bypasses) {
      NON_DEFAULT_ASSERT_IMPORT.lastIndex = 0
      assert.ok(
        NON_DEFAULT_ASSERT_IMPORT.test(sample),
        `should have flagged a bypassing import: ${JSON.stringify(sample)}`,
      )
    }
    // ...and must NOT flag the default form, or every file becomes an offender.
    for (const ok of ["import assert from 'node:assert/strict'", "import assert from 'node:assert'"]) {
      NON_DEFAULT_ASSERT_IMPORT.lastIndex = 0
      assert.ok(!NON_DEFAULT_ASSERT_IMPORT.test(ok), `should not have flagged: ${ok}`)
    }
    // ...nor a mention inside a comment, which is why it is line-anchored.
    for (const prose of [
      "// A NAMED import (`import { match } from 'node:assert'`) would bypass it.",
      " * `import * as assert from 'node:assert'` binds differently.",
    ]) {
      NON_DEFAULT_ASSERT_IMPORT.lastIndex = 0
      assert.ok(!NON_DEFAULT_ASSERT_IMPORT.test(prose), `should not have flagged prose: ${prose}`)
    }
  })
})
