import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDefaultSessionIfNeeded,
  isProviderPreflightError,
} from '../src/server-cli.js'
import {
  ProviderBinaryNotFoundError,
  ProviderBinaryQuarantinedError,
  ProviderBinaryProvenanceError,
  ProviderBinaryUnsupportedError,
  ProviderBinaryVersionError,
  ProviderCredentialMissingError,
} from '../src/utils/preflight.js'

/**
 * #8029: `chroxy start --skip-checks` crashed with an uncaught exception
 * when the configured default provider failed preflight while
 * `startCliServer` created the startup "Default" session — the restore path
 * a few lines above already catches this exact error class per-session, but
 * the unconditional `sessionManager.createSession({ name: 'Default' })` a
 * few lines below it did not.
 *
 * `startCliServer()` itself is never driven end-to-end in this suite (it
 * migrates tokens, binds a real port, stands up a WS server and a tunnel —
 * see the note in models-overlay-reload-broadcast.test.js). Instead these
 * tests exercise the extracted `createDefaultSessionIfNeeded` step directly,
 * the same pattern used for `resolveStartupTimeouts`,
 * `createDaemonSessionManager`, etc.
 *
 * No real SessionManager / stateFilePath is constructed anywhere in this
 * file — `sessionManager` is a hand-rolled fake, so there is nothing here
 * for the fs test sandbox to catch and nothing that could touch
 * `~/.chroxy`.
 */

function fakeLogger() {
  const warnings = []
  return { warnings, warn: (msg) => warnings.push(msg) }
}

const PREFLIGHT_ERROR_FIXTURES = [
  ['ProviderBinaryNotFoundError', () => new ProviderBinaryNotFoundError({ provider: 'claude-sdk', binary: 'claude', candidates: [], installHint: 'install claude' })],
  ['ProviderBinaryQuarantinedError', () => new ProviderBinaryQuarantinedError({ provider: 'claude-sdk', binary: 'claude', path: '/usr/local/bin/claude', quarantine: true })],
  ['ProviderBinaryProvenanceError', () => new ProviderBinaryProvenanceError({ provider: 'claude-sdk', binary: 'claude', path: '/usr/local/bin/claude', status: 'blocked', message: 'hash mismatch', remediation: 're-pin the binary' })],
  ['ProviderBinaryUnsupportedError', () => new ProviderBinaryUnsupportedError({ provider: 'claude-sdk', binary: 'claude', path: 'C:\\claude.cmd', remediation: 'install the native executable' })],
  ['ProviderBinaryVersionError', () => new ProviderBinaryVersionError({ provider: 'claude-sdk', binary: 'claude', path: '/usr/local/bin/claude', found: '1.0.0', required: '2.0.0', reason: 'too_old', remediation: 'claude update' })],
  ['ProviderCredentialMissingError', () => new ProviderCredentialMissingError({ provider: 'anthropic-api', envVars: ['ANTHROPIC_API_KEY'], hint: 'set ANTHROPIC_API_KEY' })],
]

describe('isProviderPreflightError (#8029)', () => {
  for (const [name, make] of PREFLIGHT_ERROR_FIXTURES) {
    it(`classifies ${name} as a provider preflight error`, () => {
      assert.equal(isProviderPreflightError(make()), true)
    })
  }

  it('does not classify a generic Error', () => {
    assert.equal(isProviderPreflightError(new Error('boom')), false)
  })

  it('does not classify a plain object that merely spoofs a matching .code', () => {
    // Guards against a duck-typed `err.code === 'PROVIDER_BINARY_NOT_FOUND'`
    // re-implementation slipping in later — only genuine instances of the
    // typed error classes qualify.
    const spoof = { code: 'PROVIDER_BINARY_NOT_FOUND', message: 'not a real preflight error' }
    assert.equal(isProviderPreflightError(spoof), false)
  })

  it('does not classify an unrelated typed error (e.g. a session directory error)', () => {
    class SessionDirectoryError extends Error {
      constructor(message) {
        super(message)
        this.code = 'SESSION_DIRECTORY_ERROR'
      }
    }
    assert.equal(isProviderPreflightError(new SessionDirectoryError('Directory does not exist: /nope')), false)
  })
})

describe('createDefaultSessionIfNeeded (#8029)', () => {
  it('returns the already-restored session id without calling createSession', () => {
    let called = false
    const sessionManager = { createSession: () => { called = true; return 'should-not-be-used' } }
    const logger = fakeLogger()

    const result = createDefaultSessionIfNeeded({
      sessionManager,
      defaultSessionId: 'restored-session-id',
      logger,
    })

    assert.equal(result, 'restored-session-id')
    assert.equal(called, false)
    assert.deepEqual(logger.warnings, [])
  })

  it('returns the newly created session id on success', () => {
    const sessionManager = { createSession: ({ name }) => { assert.equal(name, 'Default'); return 'new-session-id' } }
    const logger = fakeLogger()

    const result = createDefaultSessionIfNeeded({
      sessionManager,
      defaultSessionId: null,
      logger,
    })

    assert.equal(result, 'new-session-id')
    assert.deepEqual(logger.warnings, [])
  })

  for (const [name, make] of PREFLIGHT_ERROR_FIXTURES) {
    it(`RED without the guard: swallows a ${name} thrown by createSession, logs it, and returns null instead of crashing`, () => {
      const err = make()
      const sessionManager = { createSession: () => { throw err } }
      const logger = fakeLogger()

      let result
      assert.doesNotThrow(() => {
        result = createDefaultSessionIfNeeded({ sessionManager, defaultSessionId: null, logger })
      }, `${name} must not propagate as an uncaught exception from the startup default-session step`)

      assert.equal(result, null)
      assert.ok(logger.warnings.length >= 1, 'expected at least one warning to be logged')
      assert.ok(
        logger.warnings.some((w) => w.includes(err.message)),
        `expected a logged warning to include the error message ${JSON.stringify(err.message)}, got ${JSON.stringify(logger.warnings)}`,
      )
    })
  }

  it('still propagates a non-preflight error thrown by createSession (e.g. the session limit)', () => {
    class SessionLimitError extends Error {
      constructor() {
        super('Cannot create session: limit reached (10/10)')
        this.code = 'SESSION_LIMIT_REACHED'
      }
    }
    const sessionManager = { createSession: () => { throw new SessionLimitError() } }
    const logger = fakeLogger()

    assert.throws(
      () => createDefaultSessionIfNeeded({ sessionManager, defaultSessionId: null, logger }),
      /Cannot create session: limit reached/,
    )
    assert.deepEqual(logger.warnings, [])
  })

  it('still propagates a plain unexpected error thrown by createSession', () => {
    const sessionManager = { createSession: () => { throw new TypeError('unexpected shape') } }
    const logger = fakeLogger()

    assert.throws(
      () => createDefaultSessionIfNeeded({ sessionManager, defaultSessionId: null, logger }),
      /unexpected shape/,
    )
    assert.deepEqual(logger.warnings, [])
  })
})
