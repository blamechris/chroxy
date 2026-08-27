/**
 * Cap the FAILURE PAYLOAD of `assert.match` / `assert.doesNotMatch` (#7401).
 *
 * A failing `assert.match(subject, re)` carries the ENTIRE subject as the
 * error's `actual`. Where the subject is file text that means serialising the
 * whole file into the TAP YAML block for a one-line assertion — measured at
 * 124 KB of TAP output for a single assertion, and in-tree it was observed
 * wedging `node --test` outright (`docs/false-safety-guards.md` entry 17,
 * which carries both that measurement and the hang).
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
 * WHY A RUNTIME CAP RATHER THAN A LINT. Statically deciding "is this subject
 * large file text?" means inferring where an identifier was bound, and that
 * inference proved unreliable in BOTH directions while sweeping for #7401:
 *
 *   - Too tight and it misses real sites. A regex over `readFileSync` missed
 *     `ws-file-ops-cache.test.js` (a multi-line `await readFile()` from
 *     `fs/promises`), `permission-hook-floor.test.js` (subject derived via
 *     `.split().filter().join()`, never bound from a read directly), and
 *     `scheduled-task-health-parity.test.js` (the CALL spans lines, so the
 *     subject is not on the same line as `assert.match(`).
 *   - Too loose and it drowns in false positives. Widening the same sweep to
 *     follow derived bindings took it from 26 hits to 61, most of them small
 *     in-test strings.
 *
 * At runtime the subject's real size is simply known, and no binding style can
 * hide it. The argument is not that static analysis is bad — it is that this
 * particular predicate is not soundly decidable from the syntax.
 *
 * A purely SYNTACTIC lint ("always pass a message", or "ban these two methods
 * in tests/") has no such false negatives and would be a fine complement. It
 * is deliberately not what this does: it would churn the ~10 legitimate
 * small-subject sites and still not bound the payload of anything that slipped
 * through.
 *
 * WHAT THIS DOES NOT DO. It never changes whether an assertion passes or
 * fails, and it does not reshape any error assert would otherwise raise — only
 * how much of the subject rides along on a failure. The regex is evaluated
 * exactly once, through the same primordial `RegExp.prototype.exec` that
 * `assert.match` uses, so `/g` and `/y` lastIndex behaviour, and any
 * overridden `exec`/`test` on the regex object, behave identically to the
 * unguarded call.
 *
 * WHERE THIS IS INSTALLED, AND ITS LIMITS. Four packages run `node --test`
 * (`server`, `claude-hooks`, `protocol`, `design-tokens`). This installs from
 * `packages/server/tests/_setup.mjs` ONLY — server is where every large-subject
 * assertion lives; the other three were swept and have none. Extending it is a
 * `--import` flag away (see `no-test-force-exit-hook.mjs` for the
 * side-effecting-entry-point pattern the two `_setup`-less packages use), and
 * is tracked rather than done here. As with every guard installed this way, a
 * run that skips `--import` altogether — a bare `node --test tests/foo.test.js`
 * — is out of reach; such a run also has no fs write sandbox, which is the
 * larger reason not to do it.
 *
 * COVERAGE, AND THE BINDING-FORM RULE IT INHERITS. Patching the CJS
 * `module.exports` object covers DEFAULT importers (`import assert from
 * 'node:assert/strict'`) unconditionally, because a default import resolves to
 * that live object.
 *
 * NAMED and NAMESPACE importers are covered too, but for the more fragile
 * reason `_setup.mjs` documents at length for `node:fs`: Node builds the
 * synthetic ESM module for `node:assert` LAZILY, snapshotting its named exports
 * off `module.exports` the first time some ESM module imports it. As long as
 * that first link happens AFTER this install runs, the snapshot is taken from
 * the already-patched object. Measured on Node 22: with the install ordered
 * first, a named importer sees a 258-char `actual`; put a bare
 * `import _ from 'node:assert/strict'` ahead of it and the same importer sees
 * the full 5000.
 *
 * So this module inherits the #7262 obligation, transposed: NOTHING EVALUATED
 * BEFORE `_setup.mjs`'s BODY MAY ESM-IMPORT `node:assert`. This file reaches it
 * through `createRequire` for exactly that reason, and imports nothing else.
 *
 * That fragility is why the ban on non-default assert imports is kept as a
 * belt-and-braces posture rather than relied on either way:
 * `tests/assert-match-payload-guard.test.js` fails if a named or namespace
 * import lands, so the guard never quietly depends on link order alone.
 */

import { createRequire } from 'node:module'

/**
 * Subjects at or below this many characters pass through untouched — a few KB
 * of `actual` is genuinely useful in a failure and costs nothing.
 *
 * The number sits in a real gap in the observed population: the smallest
 * subject #7401 converted is ~14 KB (`ws-file-ops` index+common), and every
 * subject deliberately left as `assert.match` is a file the test itself just
 * wrote — a log, a 43-char secret, a ~1 KB generated wrapper script. Nothing
 * in the suite sits near 4096 in either direction.
 */
export const DEFAULT_SUBJECT_LIMIT = 4096

/** Set to an affirmative value to restore full subjects in failure output. */
export const FULL_PAYLOAD_ENV = 'CHROXY_ASSERT_MATCH_FULL_PAYLOAD'

/** Marks an already-patched assert object. */
export const PAYLOAD_GUARD_MARKER = Symbol.for('chroxy.assertMatchPayloadGuard')

/** How much of an over-limit subject to show in the failure message. */
const PREVIEW_CHARS = 200

/**
 * Affirmative-value check, matching `no-test-force-exit.mjs`. `FOO=0` under
 * plain truthiness would disarm the guard while reading, to whoever exported
 * it, as "guard on" (#7400).
 */
function envEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

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
  if (!target || target[PAYLOAD_GUARD_MARKER]) return false
  for (const name of ['match', 'doesNotMatch']) {
    const original = target[name]
    if (typeof original !== 'function') continue
    const wantMatch = name === 'match'
    target[name] = function chroxyGuardedAssert(subject, regexp, message) {
      // Delegate anything we are not certain about, so every argument-
      // validation error assert raises today is raised identically. An Error
      // passed as `message` is stock's "throw the caller's error verbatim"
      // path and must not be reshaped into an AssertionError either.
      if (
        typeof subject !== 'string' ||
        !(regexp instanceof RegExp) ||
        subject.length <= limit ||
        message instanceof Error
      ) {
        return original.call(this, subject, regexp, message)
      }
      // Evaluate ONCE, through the PRIMORDIAL exec — the same one
      // `assert.match` uses. `regexp.test(...)` would instead go through the
      // generic RegExpExec path, which reads `exec` off the object, so a regex
      // with an overridden `exec`/`test` could be judged differently here than
      // by stock assert — including a real failure reported as a pass.
      let matched
      try {
        matched = RegExp.prototype.exec.call(regexp, subject) !== null
      } catch {
        // A RegExp.prototype-derived object with no internal slot lands here;
        // stock raises its own ERR_INVALID_ARG_TYPE for it, so hand it back.
        return original.call(this, subject, regexp, message)
      }
      if (matched === wantMatch) return
      // `message ||`, matching Node's own `assert.match`, which treats EVERY
      // falsy message as absent and generates one (measured: '', 0, false and
      // null all produce the generated text with generatedMessage=true). A
      // `!== undefined` check reads more principled but diverges from stock for
      // exactly those callers.
      const generatedMessage = !message
      const err = new AssertionError({
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
      // AssertionError computes `generatedMessage` from whether a message was
      // passed to IT — and we always pass one. Restore what stock would have
      // reported, so a consumer reading this field cannot tell the guard apart.
      err.generatedMessage = generatedMessage
      throw err
    }
  }
  Object.defineProperty(target, PAYLOAD_GUARD_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return true
}

/**
 * Install the guard on both `node:assert` and `node:assert/strict`.
 *
 * Reached through `createRequire` rather than an ESM import for two reasons:
 * we need the live CJS `module.exports` object that default importers resolve
 * to, and an ESM `import` here would itself trigger the lazy synthetic-module
 * link described above, before the patch is applied.
 *
 * @returns {{ patched: string[], limit: number, skipped: boolean }}
 */
export function installAssertMatchPayloadGuard({
  limit = DEFAULT_SUBJECT_LIMIT,
  env = process.env,
} = {}) {
  if (envEnabled(env[FULL_PAYLOAD_ENV])) return { patched: [], limit, skipped: true }

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

  return { patched, limit, skipped: false }
}
