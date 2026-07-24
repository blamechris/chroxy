import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
// DEFAULT_PROVIDER is single-sourced in @chroxy/protocol; import it from there
// (Zod/SDK-free) rather than ../src/providers.js, whose provider registry
// statically pulls the Agent SDK into the module graph (not installed locally).
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
})
