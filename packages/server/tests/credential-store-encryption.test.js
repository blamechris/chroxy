import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getStoredCredential,
  setStoredCredential,
  deleteStoredCredential,
  getCredentialsStatus,
  maybeEncryptCredentialsAtRest,
  _setCredentialKeychainForTests,
} from '../src/credential-store.js'
import { isEncryptedEnvelope } from '../src/credential-cipher.js'

/**
 * Encrypted-path tests for the credential store (#5154). An in-memory keychain
 * fake drives the encrypted branch; HOME points at a tmpdir so the real
 * ~/.chroxy is never touched. The shared bootstrap (_setup.mjs) defaults every
 * suite to a no-keychain stub, so we install our in-memory one per test and
 * restore the no-keychain default afterwards.
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
const noKeychain = { isKeychainAvailable: () => false }

describe('credential-store at-rest encryption (#5154)', () => {
  let tmpHome
  let originalHome
  let keychain
  const savedEnv = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-enc-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    for (const k of CRED_ENV_VARS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    keychain = inMemoryKeychain()
    _setCredentialKeychainForTests(keychain)
  })

  afterEach(() => {
    // Clear the injection so the bootstrap env default (no keychain) governs
    // again — sibling suites stay on the plaintext path.
    _setCredentialKeychainForTests(null)
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    for (const k of CRED_ENV_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  function credPath() {
    return join(tmpHome, '.chroxy', 'credentials.json')
  }
  function onDisk() {
    return JSON.parse(readFileSync(credPath(), 'utf8'))
  }

  it('writes an encrypted envelope (not plaintext) when a keychain is available', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-secret-value')
    const raw = onDisk()
    assert.equal(isEncryptedEnvelope(raw), true)
    // The raw secret must NOT appear anywhere on disk.
    assert.ok(!readFileSync(credPath(), 'utf8').includes('sk-ant-secret-value'))
    // A data key was stored in the (fake) keychain.
    assert.ok(keychain._store.has('chroxy-cred-key'))
    // …but it still round-trips through the API.
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-secret-value')
  })

  it('keeps the encrypted file at mode 0600', () => {
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-abc')
    if (process.platform !== 'win32') {
      assert.equal(statSync(credPath()).mode & 0o777, 0o600)
    }
  })

  it('round-trips multiple keys and re-encrypts on each write', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-one')
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-two')
    assert.equal(isEncryptedEnvelope(onDisk()), true)
    const status = getCredentialsStatus()
    assert.equal(status.fileError, null)
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-one')
    assert.equal(getStoredCredential('OPENAI_API_KEY'), 'sk-openai-two')
  })

  it('delete rewrites the (still encrypted) store and preserves siblings', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-keep')
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-drop')
    deleteStoredCredential('OPENAI_API_KEY')
    assert.equal(isEncryptedEnvelope(onDisk()), true)
    assert.equal(getStoredCredential('OPENAI_API_KEY'), null)
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-keep')
  })

  it('surfaces a clear error (no plaintext leak) when the key is gone', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-locked')
    // Simulate a lost keychain entry (e.g. different machine / wiped keychain).
    keychain._store.delete('chroxy-cred-key')
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), null)
    const status = getCredentialsStatus()
    assert.match(status.fileError, /encrypted but its decryption key is unavailable/)
  })

  describe('maybeEncryptCredentialsAtRest', () => {
    function writePlaintext(obj) {
      mkdirSync(join(tmpHome, '.chroxy'), { recursive: true, mode: 0o700 })
      writeFileSync(credPath(), JSON.stringify(obj, null, 2), { mode: 0o600 })
      if (process.platform !== 'win32') chmodSync(credPath(), 0o600)
    }

    it('encrypts a legacy plaintext file in place', () => {
      writePlaintext({ ANTHROPIC_API_KEY: 'sk-ant-legacy', anthropicApiKey: 'sk-ant-legacy' })
      const res = maybeEncryptCredentialsAtRest()
      assert.equal(res.migrated, true)
      assert.equal(res.reason, 'migrated')
      assert.equal(isEncryptedEnvelope(onDisk()), true)
      assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-legacy')
    })

    it('is idempotent — already-encrypted files are left alone', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-x')
      const res = maybeEncryptCredentialsAtRest()
      assert.equal(res.migrated, false)
      assert.equal(res.reason, 'already-encrypted')
    })

    it('no-ops when there is no file', () => {
      const res = maybeEncryptCredentialsAtRest()
      assert.equal(res.migrated, false)
      assert.equal(res.reason, 'no-file')
    })

    it('warns and leaves plaintext when no keychain is available', () => {
      writePlaintext({ ANTHROPIC_API_KEY: 'sk-ant-plain', anthropicApiKey: 'sk-ant-plain' })
      _setCredentialKeychainForTests(noKeychain)
      const warns = []
      const res = maybeEncryptCredentialsAtRest({ log: { info: () => {}, warn: (m) => warns.push(m) } })
      assert.equal(res.migrated, false)
      assert.equal(res.reason, 'no-keychain')
      assert.equal(isEncryptedEnvelope(onDisk()), false) // still plaintext
      assert.ok(warns.some((m) => /plaintext/.test(m)))
    })
  })
})
