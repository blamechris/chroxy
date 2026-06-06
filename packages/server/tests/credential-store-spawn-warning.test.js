import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getStoredCredential,
  setStoredCredential,
  resolveCredential,
  _setCredentialKeychainForTests,
  _setCredentialLoggerForTests,
  _resetKeychainWarningsForTests,
} from '../src/credential-store.js'

/**
 * #5242 — the spawn path must not SILENTLY resolve an encrypted credential to
 * null when the keychain data key is momentarily unavailable (locked keychain,
 * transient security/secret-tool failure). That recoverable case used to launch
 * a subprocess provider unauthenticated with zero diagnostic. We now emit a
 * one-time warning. Resolution semantics are unchanged (still `unset`) — this is
 * purely observability; the write/availability policy is #5230.
 *
 * In-memory keychain + tmp HOME — the real ~/.chroxy and OS keychain are never
 * touched.
 */

const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']

function inMemoryKeychain() {
  const store = new Map()
  return {
    isKeychainAvailable: () => true,
    getToken: (service) => store.get(service) ?? null,
    setToken: (token, service) => { store.set(service, token) },
    _store: store,
  }
}

function capturingLogger() {
  const warns = []
  return { warn: (m) => warns.push(m), info: () => {}, error: () => {}, debug: () => {}, _warns: warns }
}

describe('credential-store — encrypted-keychain-unavailable warning (#5242)', () => {
  let tmpHome, originalHome, logger
  const savedEnv = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-warn-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    for (const k of CRED_ENV_VARS) { savedEnv[k] = process.env[k]; delete process.env[k] }
    logger = capturingLogger()
    _setCredentialLoggerForTests(logger)
    _resetKeychainWarningsForTests()
  })

  afterEach(() => {
    _setCredentialKeychainForTests(null)
    _setCredentialLoggerForTests(null)
    _resetKeychainWarningsForTests()
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    for (const k of CRED_ENV_VARS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  // Write an encrypted credential with one keychain, then swap to an EMPTY
  // (available, but no data key) keychain so readStore hits the
  // encrypted-but-key-unavailable branch.
  function writeEncryptedThenLoseKey() {
    const k1 = inMemoryKeychain()
    _setCredentialKeychainForTests(k1)
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-secret-value')
    // A different keychain instance: available, but the data key isn't there.
    _setCredentialKeychainForTests(inMemoryKeychain())
  }

  it('warns once when an encrypted credential can not be decrypted (keychain unavailable)', () => {
    writeEncryptedThenLoseKey()
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), null)
    assert.equal(logger._warns.length, 1, 'should warn exactly once')
    assert.match(logger._warns[0], /ANTHROPIC_API_KEY/)
    assert.match(logger._warns[0], /keychain/i)
    // The secret value must never appear in the warning.
    assert.ok(!logger._warns[0].includes('sk-ant-secret-value'))
  })

  it('dedupes: repeated resolves on the spawn path warn once per key', () => {
    writeEncryptedThenLoseKey()
    resolveCredential('ANTHROPIC_API_KEY')
    resolveCredential('ANTHROPIC_API_KEY')
    resolveCredential('ANTHROPIC_API_KEY')
    assert.equal(logger._warns.length, 1, 'one warning despite three resolves')
  })

  it('resolveCredential still returns {value:null, source:unset} (semantics unchanged)', () => {
    writeEncryptedThenLoseKey()
    assert.deepEqual(resolveCredential('ANTHROPIC_API_KEY'), { value: null, source: 'unset' })
  })

  it('does NOT warn for a non-encrypted read error (bad JSON)', () => {
    const file = join(tmpHome, '.chroxy', 'credentials.json')
    mkdirSync(join(tmpHome, '.chroxy'), { recursive: true })
    writeFileSync(file, '{not json', { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(file, 0o600)
    _setCredentialKeychainForTests(inMemoryKeychain())
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), null)
    assert.equal(logger._warns.length, 0, 'a corrupt-file error is not the recoverable keychain case')
  })

  it('does NOT warn when the credential resolves successfully', () => {
    const k1 = inMemoryKeychain()
    _setCredentialKeychainForTests(k1)
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-ok')
    // Same keychain still holds the data key → decrypts fine.
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-ok')
    assert.equal(logger._warns.length, 0)
  })
})
