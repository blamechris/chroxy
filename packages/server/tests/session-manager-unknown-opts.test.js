import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
// DEFAULT_PROVIDER is single-sourced in @chroxy/protocol. Importing it from
// there (rather than ../src/providers.js) makes no difference to whether the
// Agent SDK loads in this suite: `../src/session-manager.js` above already
// imports ../src/providers.js, whose registry statically pulls in every
// provider session class including sdk-session.js's `@anthropic-ai/claude-agent-sdk`
// import — so the SDK is in the module graph the moment SessionManager is
// imported, regardless of where this test sources DEFAULT_PROVIDER from.
import { DEFAULT_PROVIDER } from '@chroxy/protocol'
import { getLogLevel, setLogLevel } from '../src/logger.js'

/**
 * #6944 — the SessionManager constructor used to silently swallow any option key
 * it didn't destructure. A caller passing `provider:` (the createSession() opt)
 * where the constructor expects `providerType:` was ignored, so createSession()
 * fell back to DEFAULT_PROVIDER (claude-tui) and spawned a REAL `claude` PTY —
 * the leaked handle that hung the #6933 CI run.
 *
 * These tests assert the guard surfaces the misuse (never silently ignores it),
 * and — critically — that they do NOT reach createSession(), so no provider is
 * ever spawned. Construction alone is enough to exercise the guard.
 *
 * CRITICAL: every SessionManager MUST use a temp stateFilePath (see #4633) or it
 * clobbers the real ~/.chroxy/session-state.json.
 */

let _tmpDir
function tmpStateFile() {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'sm-unknown-opts-'))
  return join(_tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_tmpDir) rmSync(_tmpDir, { recursive: true, force: true })
})

/** Spy console.warn (log.warn routes through it) and collect formatted lines. */
function captureWarnings(fn) {
  const warnings = []
  const orig = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    fn()
  } finally {
    console.warn = orig
  }
  return warnings
}

describe('SessionManager unknown/misnamed ctor opts (#6944)', () => {
  let _origLevel
  beforeEach(() => {
    // Pin the log level so `log.warn` reliably reaches console.warn regardless
    // of a globally-set LOG_LEVEL.
    _origLevel = getLogLevel()
    setLogLevel('debug')
  })
  afterEach(() => {
    setLogLevel(_origLevel)
  })

  it('maps a misnamed `provider` to `providerType` and warns (does not silently default to claude-tui)', () => {
    let mgr
    const warnings = captureWarnings(() => {
      mgr = new SessionManager({
        skipPreflight: true,
        provider: 'claude-cli', // WRONG key — the ctor opt is `providerType`
        stateFilePath: tmpStateFile(),
      })
    })

    // The misnamed key is recovered, not swallowed: the manager uses the
    // provider the caller intended, NOT the silent DEFAULT_PROVIDER fallback
    // (which is what spawned the real PTY in #6933).
    assert.equal(mgr._providerType, 'claude-cli')
    assert.notEqual(mgr._providerType, DEFAULT_PROVIDER)

    const surfaced = warnings.find((w) => w.includes("'provider'") && w.includes('providerType'))
    assert.ok(surfaced, `expected a warning naming both provider and providerType; got: ${JSON.stringify(warnings)}`)
  })

  it('keeps an explicit `providerType` and warns that `provider` is ignored when both are passed', () => {
    let mgr
    const warnings = captureWarnings(() => {
      mgr = new SessionManager({
        skipPreflight: true,
        provider: 'claude-cli',
        providerType: 'claude-sdk',
        stateFilePath: tmpStateFile(),
      })
    })

    // Explicit providerType wins; provider does not clobber it.
    assert.equal(mgr._providerType, 'claude-sdk')
    const surfaced = warnings.find((w) => w.includes("ignoring constructor option 'provider'"))
    assert.ok(surfaced, `expected an "ignoring provider" warning; got: ${JSON.stringify(warnings)}`)
  })

  it('keeps an explicit `providerType` that equals DEFAULT_PROVIDER — the alias does NOT win (#6952 review)', () => {
    // Regression guard: explicitness used to be inferred as
    // `providerType !== DEFAULT_PROVIDER`, so a caller passing BOTH `provider`
    // and a `providerType` that happened to equal the default value
    // (DEFAULT_PROVIDER === 'claude-tui') was indistinguishable from having
    // omitted providerType — the `provider` alias would incorrectly clobber
    // it. The fix reads explicitness off the original opts object
    // (`'providerType' in opts`) instead of comparing the resolved value.
    assert.equal(DEFAULT_PROVIDER, 'claude-tui', 'precondition: this test only proves the fix when providerType === DEFAULT_PROVIDER')
    let mgr
    const warnings = captureWarnings(() => {
      mgr = new SessionManager({
        skipPreflight: true,
        provider: 'x',
        providerType: 'claude-tui', // explicit, but == DEFAULT_PROVIDER
        stateFilePath: tmpStateFile(),
      })
    })

    assert.equal(mgr._providerType, 'claude-tui')
    const surfaced = warnings.find((w) => w.includes("ignoring constructor option 'provider'"))
    assert.ok(surfaced, `expected an "ignoring provider" warning; got: ${JSON.stringify(warnings)}`)
  })

  it('keeps the resolved providerType when `provider` is an empty string or null (no bogus map)', () => {
    for (const emptyAlias of ['', null]) {
      let mgr
      const warnings = captureWarnings(() => {
        mgr = new SessionManager({
          skipPreflight: true,
          provider: emptyAlias,
          stateFilePath: tmpStateFile(),
        })
      })

      // Falls back to the resolved default — never mapped to a falsy/bogus value.
      assert.equal(mgr._providerType, DEFAULT_PROVIDER, `provider=${JSON.stringify(emptyAlias)} must not clobber providerType`)
      const surfaced = warnings.find((w) => w.includes("ignoring constructor option 'provider'") && w.includes('not a usable provider id'))
      assert.ok(surfaced, `expected a "not a usable provider id" warning for provider=${JSON.stringify(emptyAlias)}; got: ${JSON.stringify(warnings)}`)
    }
  })

  it('warns on any other unrecognized key under the debug flag (persistenceDebounceMs typo)', () => {
    const prev = process.env.CHROXY_DEBUG_CTOR_OPTS
    process.env.CHROXY_DEBUG_CTOR_OPTS = '1'
    try {
      const warnings = captureWarnings(() => {
        // eslint-disable-next-line no-new
        new SessionManager({
          skipPreflight: true,
          persistenceDebounceMs: 0, // WRONG key — the ctor opt is `persistDebounceMs`
          stateFilePath: tmpStateFile(),
        })
      })
      const surfaced = warnings.find((w) => w.includes('persistenceDebounceMs') && w.includes('unrecognized'))
      assert.ok(surfaced, `expected an unrecognized-option warning naming the typo; got: ${JSON.stringify(warnings)}`)
    } finally {
      if (prev === undefined) delete process.env.CHROXY_DEBUG_CTOR_OPTS
      else process.env.CHROXY_DEBUG_CTOR_OPTS = prev
    }
  })

  it('does NOT warn about ctor opts when every option is recognized (no false positives)', () => {
    // Force the general check on so a stray unknown key WOULD warn — proving the
    // silence below is because all keys are legitimate, not because the check is
    // dormant.
    const prev = process.env.CHROXY_DEBUG_CTOR_OPTS
    process.env.CHROXY_DEBUG_CTOR_OPTS = '1'
    try {
      const warnings = captureWarnings(() => {
        // eslint-disable-next-line no-new
        new SessionManager({
          skipPreflight: true,
          maxSessions: 5,
          providerType: 'claude-cli',
          persistDebounceMs: 0,
          stateFilePath: tmpStateFile(),
        })
      })
      const ctorWarn = warnings.find((w) =>
        w.includes('unrecognized constructor option') ||
        w.includes("'provider' is not a constructor option") ||
        w.includes("ignoring constructor option 'provider'"))
      assert.equal(ctorWarn, undefined, `unexpected ctor-opt warning: ${JSON.stringify(warnings)}`)
    } finally {
      if (prev === undefined) delete process.env.CHROXY_DEBUG_CTOR_OPTS
      else process.env.CHROXY_DEBUG_CTOR_OPTS = prev
    }
  })

  it('always warns on an unrecognized key with NO NODE_ENV/CHROXY_DEBUG_CTOR_OPTS set (#6952 review)', () => {
    // The general unknown-key warning used to be gated on
    // `process.env.NODE_ENV === 'test'`, but nothing in this repo's harness,
    // tests/_setup.mjs, or CI workflows ever sets NODE_ENV=test — so the
    // whole-key-class safety net (catching e.g. `persistenceDebounceMs`
    // typo'd for `persistDebounceMs`) never actually fired outside of someone
    // manually exporting the debug flag. This is the regression guard: both
    // gates are explicitly unset here, proving the warning is now always-on.
    //
    // Uses a key distinct from the other tests in this file (rather than
    // reusing `persistenceDebounceMs`) because the fix's dedup Set is
    // module-level and process-lifetime — reusing an already-warned key here
    // would make this assertion depend on test execution order.
    const prevNodeEnv = process.env.NODE_ENV
    const prevDebug = process.env.CHROXY_DEBUG_CTOR_OPTS
    delete process.env.NODE_ENV
    delete process.env.CHROXY_DEBUG_CTOR_OPTS
    try {
      const warnings = captureWarnings(() => {
        // eslint-disable-next-line no-new
        new SessionManager({
          skipPreflight: true,
          legacyDebounceIntervalTypo: 0, // a genuinely unknown ctor option
          stateFilePath: tmpStateFile(),
        })
      })
      const surfaced = warnings.find((w) => w.includes('legacyDebounceIntervalTypo') && w.includes('unrecognized'))
      assert.ok(surfaced, `expected an unrecognized-option warning with no env gates set; got: ${JSON.stringify(warnings)}`)
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prevNodeEnv
      if (prevDebug === undefined) delete process.env.CHROXY_DEBUG_CTOR_OPTS
      else process.env.CHROXY_DEBUG_CTOR_OPTS = prevDebug
    }
  })

  it('dedups the general unknown-key warning — a repeated key warns only once per process', () => {
    // Direct coverage of the new module-level dedup Set: the always-on
    // warning above must not spam a long-lived daemon log if the same
    // unrecognized key is passed to more than one SessionManager
    // construction. Uses its own unique key so it can't be silenced by (or
    // silence) any other test's use of the general-warning path.
    const prevNodeEnv = process.env.NODE_ENV
    const prevDebug = process.env.CHROXY_DEBUG_CTOR_OPTS
    delete process.env.NODE_ENV
    delete process.env.CHROXY_DEBUG_CTOR_OPTS
    try {
      const firstWarnings = captureWarnings(() => {
        // eslint-disable-next-line no-new
        new SessionManager({
          skipPreflight: true,
          totallyUniqueDedupTestKey: 0,
          stateFilePath: tmpStateFile(),
        })
      })
      const secondWarnings = captureWarnings(() => {
        // eslint-disable-next-line no-new
        new SessionManager({
          skipPreflight: true,
          totallyUniqueDedupTestKey: 0,
          stateFilePath: tmpStateFile(),
        })
      })

      const firstSurfaced = firstWarnings.find((w) => w.includes('totallyUniqueDedupTestKey'))
      assert.ok(firstSurfaced, `expected the first construction to warn; got: ${JSON.stringify(firstWarnings)}`)
      const secondSurfaced = secondWarnings.find((w) => w.includes('totallyUniqueDedupTestKey'))
      assert.equal(secondSurfaced, undefined, `expected the second construction with the same key to be deduped (silent); got: ${JSON.stringify(secondWarnings)}`)
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prevNodeEnv
      if (prevDebug === undefined) delete process.env.CHROXY_DEBUG_CTOR_OPTS
      else process.env.CHROXY_DEBUG_CTOR_OPTS = prevDebug
    }
  })
})
