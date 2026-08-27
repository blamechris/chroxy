/**
 * Cap the FAILURE PAYLOAD of `assert.match` / `assert.doesNotMatch` (#7401).
 *
 * A failing `assert.match(subject, re)` carries the ENTIRE subject as the
 * error's `actual`. Where the subject is file text that means serialising the
 * whole file into the TAP YAML block for a one-line assertion — measured at
 * 124 KB of TAP output for a single assertion, and in-tree it was observed
 * wedging `node --test` outright (catalogue entry 18, and the hang mode of
 * entry 17).
 *
 * The per-call-site fix is to collapse to a boolean before asserting:
 *
 *     assert.match(src, /pattern/)              // fail → the whole file as `actual`
 *     assert.ok(/pattern/.test(src), message)   // fail → `false`, plus a real message
 *
 * #7401 converted every site whose subject was a large checked-in source file.
 * This module exists because that conversion is a LIST, and a list beside a
 * growing set is the first recurring cause in `docs/false-safety-guards.md`
 * (#7192, #7197, #7267, #7270). The list will regrow.
 *
 * WHY A RUNTIME CAP RATHER THAN A LINT. The obvious guard is a static check
 * for `assert.match(<ident>` where `<ident>` is bound from a file read. That
 * check has a demonstrated false-negative class: while sweeping for #7401 a
 * regex over `readFileSync` missed `ws-file-ops-cache.test.js` outright,
 * because the binding was a multi-line `await readFile(...)` from
 * `fs/promises` — a site the issue itself named. A guard that silently misses
 * the cases it was written for is the exact defect class this repo catalogues,
 * so the check moved to where the value actually is: runtime, where the
 * subject's real size is known and no binding style can hide it.
 *
 * WHAT THIS DOES NOT DO. It never changes whether an assertion passes or
 * fails — only how much of the subject rides along on a failure. The regex is
 * evaluated exactly once, the same way `assert.match` evaluates it, so a
 * stateful `/g` regex behaves identically to the unguarded call.
 *
 * COVERAGE AND ITS ONE HOLE. Every server test imports assert as a DEFAULT
 * import (`import assert from 'node:assert/strict'`, 567 sites; plain
 * `node:assert`, 5). A default import resolves to the live CJS
 * `module.exports` object, so patching that object's properties is seen by
 * every one of them regardless of link order — unlike the `node:fs` case in
 * `_setup.mjs`, this does not depend on a lazy-snapshot race. A NAMED or
 * NAMESPACE import (`import { match } from 'node:assert'`) WOULD bypass it.
 * There are currently none, and that is enforced rather than asserted:
 * `tests/assert-match-payload-guard.test.js` fails if one appears.
 */

import { createRequire } from 'node:module'

/**
 * Subjects at or below this many characters are passed through untouched — a
 * few KB of `actual` is genuinely useful in a failure and costs nothing. The
 * smallest subject #7401 converted was ~14 KB; the largest small subject left
 * alone (a test-written log or wrapper script) is a few hundred bytes, so the
 * boundary is not close to either class.
 */
export const DEFAULT_SUBJECT_LIMIT = 4096

/** How much of an over-limit subject to show in the failure message. */
const PREVIEW_CHARS = 200

function preview(subject) {
  const head = subject.slice(0, PREVIEW_CHARS).replace(/\n/g, '\\n')
  return `${head}… [${subject.length} chars total, truncated by the #7401 payload guard]`
}

/**
 * Patch `match` / `doesNotMatch` on one assert-like object. Idempotent: a
 * second install on the same object is a no-op, so importing this from more
 * than one setup file cannot double-wrap.
 */
function patchOne(target, limit, AssertionError) {
  if (!target || target.__chroxyMatchPayloadGuard) return false
  for (const name of ['match', 'doesNotMatch']) {
    const original = target[name]
    if (typeof original !== 'function') continue
    const wantMatch = name === 'match'
    target[name] = function chroxyGuardedAssert(subject, regexp, message) {
      // Delegate anything we are not certain about, so every argument-
      // validation error assert raises today is raised identically.
      if (typeof subject !== 'string' || !(regexp instanceof RegExp) || subject.length <= limit) {
        return original.call(this, subject, regexp, message)
      }
      // Evaluate ONCE, exactly as assert.match does, so a /g regex's lastIndex
      // advances the same way it would have unguarded.
      const matched = regexp.test(subject)
      if (matched === wantMatch) return
      throw new AssertionError({
        message:
          message ||
          `The ${wantMatch ? 'input did not match' : 'input was expected not to match'} the regular expression ${regexp}. ` +
            `Subject withheld: ${subject.length} chars. ` +
            `Use assert.ok(${wantMatch ? '' : '!'}${regexp}.test(subject), 'message') at this call site (#7401).`,
        actual: preview(subject),
        expected: regexp,
        operator: name,
        stackStartFn: chroxyGuardedAssert,
      })
    }
  }
  Object.defineProperty(target, '__chroxyMatchPayloadGuard', {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return true
}

/**
 * Install the guard on both `node:assert` and `node:assert/strict`.
 *
 * Reached through `createRequire` rather than an ESM import for the same
 * reason `_setup.mjs` does it for `node:fs`: we need the live CJS
 * `module.exports` object that default importers resolve to, not a module
 * namespace object whose properties cannot be reassigned.
 *
 * @returns {{ patched: string[], limit: number }}
 */
export function installAssertMatchPayloadGuard({ limit = DEFAULT_SUBJECT_LIMIT } = {}) {
  const require = createRequire(import.meta.url)
  const assert = require('node:assert')
  const strict = require('node:assert/strict')
  const { AssertionError } = assert

  const patched = []
  if (patchOne(assert, limit, AssertionError)) patched.push('node:assert')
  // `assert.strict` and `node:assert/strict` are the same object in Node, but
  // patch by both handles so this stays correct if that ever stops holding.
  if (patchOne(strict, limit, AssertionError)) patched.push('node:assert/strict')
  if (patchOne(assert.strict, limit, AssertionError)) patched.push('node:assert.strict')

  return { patched, limit }
}
