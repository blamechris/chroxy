import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getStoredCredential,
  setStoredCredential,
  rekeyCredentialStore,
  _setCredentialKeychainForTests,
} from '../src/credential-store.js'
import {
  CRED_KEY_SERVICE,
  isEncryptedEnvelope,
  decryptEnvelope,
  getMasterKey,
  rotateMasterKey,
  setMasterKey,
} from '../src/credential-cipher.js'
import { runCredentialsRekey } from '../src/cli/credentials-cmd.js'

/**
 * Credential data-key rotation / rekey (#5229). An in-memory keychain fake
 * drives the encrypted path; HOME points at a tmpdir so the real ~/.chroxy is
 * never touched (the _setup.mjs sandbox would otherwise throw). The fake
 * includes deleteToken so the rollback-to-plaintext path is exercised.
 */

const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']

function inMemoryKeychain() {
  const store = new Map()
  return {
    isKeychainAvailable: () => true,
    getToken: (service) => store.get(service) ?? null,
    setToken: (token, service) => { store.set(service, token) },
    deleteToken: (service) => { store.delete(service) },
    _store: store,
  }
}
const noKeychain = { isKeychainAvailable: () => false }

describe('credential data-key rekey (#5229)', () => {
  let tmpHome
  let originalHome
  let keychain
  const savedEnv = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-rekey-test-'))
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
    _setCredentialKeychainForTests(null)
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    for (const k of CRED_ENV_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    // Restore mode in case a rollback test left the dir read-only.
    try { chmodSync(join(tmpHome, '.chroxy'), 0o700) } catch { /* */ }
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  const credDir = () => join(tmpHome, '.chroxy')
  const credPath = () => join(credDir(), 'credentials.json')
  const onDisk = () => JSON.parse(readFileSync(credPath(), 'utf8'))

  // ---- cipher key-rotation primitives ----

  it('rotateMasterKey mints a fresh 32-byte key, persists it, and replaces any prior entry', () => {
    const first = rotateMasterKey(keychain)
    assert.ok(first instanceof Uint8Array)
    assert.equal(first.length, 32)
    const firstStored = keychain.getToken(CRED_KEY_SERVICE)
    assert.equal(Buffer.from(firstStored, 'base64').length, 32)

    const second = rotateMasterKey(keychain)
    assert.notDeepEqual([...second], [...first]) // a genuinely new key
    assert.notEqual(keychain.getToken(CRED_KEY_SERVICE), firstStored) // entry replaced in place
  })

  it('rotateMasterKey returns null when no keychain is available', () => {
    assert.equal(rotateMasterKey(noKeychain), null)
  })

  it('setMasterKey sets a given key and deletes the entry on null', () => {
    const key = rotateMasterKey(keychain)
    setMasterKey(null, keychain)
    assert.equal(keychain.getToken(CRED_KEY_SERVICE), null)
    setMasterKey(key, keychain)
    assert.equal(Buffer.from(keychain.getToken(CRED_KEY_SERVICE), 'base64').length, 32)
    assert.throws(() => setMasterKey(new Uint8Array(8), keychain), /32-byte/)
  })

  // ---- rekeyCredentialStore ----

  it('rotates the data key, re-encrypts the store, and preserves the credentials', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-secret-value')
    setStoredCredential('OPENAI_API_KEY', 'sk-openai-abc')
    assert.ok(isEncryptedEnvelope(onDisk()))
    const oldKey = getMasterKey(keychain)
    const oldStored = keychain.getToken(CRED_KEY_SERVICE)

    const res = rekeyCredentialStore()
    assert.deepEqual(res, { rekeyed: true, reason: 'rekeyed' })

    // Keychain entry was replaced with a different key.
    assert.notEqual(keychain.getToken(CRED_KEY_SERVICE), oldStored)
    // File is still an encrypted envelope, and the credentials round-trip.
    assert.ok(isEncryptedEnvelope(onDisk()))
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-secret-value')
    assert.equal(getStoredCredential('OPENAI_API_KEY'), 'sk-openai-abc')
    // The OLD key can no longer decrypt the rotated file.
    assert.throws(() => decryptEnvelope(onDisk(), oldKey), /decryption failed/)
    // Mode stayed 0600.
    if (process.platform !== 'win32') {
      assert.equal(statSync(credPath()).mode & 0o777, 0o600)
    }
  })

  it('encrypts a legacy plaintext store under a fresh key (previous key was absent)', () => {
    mkdirSync(credDir(), { recursive: true, mode: 0o700 })
    writeFileSync(credPath(), JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-plain' }), { mode: 0o600 })
    assert.ok(!isEncryptedEnvelope(onDisk()))
    assert.equal(getMasterKey(keychain), null) // no data key yet

    const res = rekeyCredentialStore()
    assert.deepEqual(res, { rekeyed: true, reason: 'rekeyed' })
    assert.ok(isEncryptedEnvelope(onDisk()))
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-plain')
  })

  it('is a no-op with reason no-keychain when no keychain is available', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-secret-value') // encrypted under the in-memory keychain
    _setCredentialKeychainForTests(noKeychain)
    const before = readFileSync(credPath(), 'utf8')
    assert.deepEqual(rekeyCredentialStore(), { rekeyed: false, reason: 'no-keychain' })
    assert.equal(readFileSync(credPath(), 'utf8'), before) // untouched
  })

  it('is a no-op with reason no-file when there is no credentials.json', () => {
    assert.deepEqual(rekeyCredentialStore(), { rekeyed: false, reason: 'no-file' })
  })

  it('is a no-op with reason empty for an empty store', () => {
    mkdirSync(credDir(), { recursive: true, mode: 0o700 })
    writeFileSync(credPath(), JSON.stringify({}), { mode: 0o600 })
    assert.deepEqual(rekeyCredentialStore(), { rekeyed: false, reason: 'empty' })
  })

  it('aborts with reason read-error (and leaves the key untouched) on a bad-mode file', (t) => {
    if (process.platform === 'win32') return t.skip('mode bits not enforced on win32')
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-secret-value')
    const keyBefore = keychain.getToken(CRED_KEY_SERVICE)
    chmodSync(credPath(), 0o644) // refused by readStore's 0600 boundary
    assert.deepEqual(rekeyCredentialStore(), { rekeyed: false, reason: 'read-error' })
    assert.equal(keychain.getToken(CRED_KEY_SERVICE), keyBefore) // key never rotated
  })

  it('rolls the keychain key back on a write failure so the existing store stays readable', (t) => {
    if (process.platform === 'win32') return t.skip('dir-permission write failure not reproducible on win32')
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-secret-value')
    const keyBefore = keychain.getToken(CRED_KEY_SERVICE)
    // Make the atomic temp-write fail: a read-only parent dir can't hold the tmp file.
    chmodSync(credDir(), 0o500)
    const res = rekeyCredentialStore()
    chmodSync(credDir(), 0o700) // restore so the assertions below can read

    assert.deepEqual(res, { rekeyed: false, reason: 'write-error' })
    // Key rolled back to the original, so the unchanged on-disk envelope decrypts.
    assert.equal(keychain.getToken(CRED_KEY_SERVICE), keyBefore)
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-secret-value')
  })

  // ---- `chroxy credentials rekey` CLI runner (deps-injected, no real keychain) ----

  describe('runCredentialsRekey CLI', () => {
    const noopLog = { info() {}, warn() {} }

    it('prints a human success line and leaves exit code unset on rekeyed', async () => {
      const lines = []
      const prevExit = process.exitCode
      const res = await runCredentialsRekey({}, {
        write: (s) => lines.push(s),
        log: noopLog,
        rekey: () => ({ rekeyed: true, reason: 'rekeyed' }),
      })
      assert.deepEqual(res, { rekeyed: true, reason: 'rekeyed' })
      assert.match(lines.join('\n'), /^✓ Rotated the credential data key/)
      assert.equal(process.exitCode, prevExit) // success doesn't set a failure code
    })

    it('emits JSON when --json is passed', async () => {
      const lines = []
      await runCredentialsRekey({ json: true }, {
        write: (s) => lines.push(s),
        log: noopLog,
        rekey: () => ({ rekeyed: false, reason: 'no-file' }),
      })
      assert.deepEqual(JSON.parse(lines.join('\n')), { rekeyed: false, reason: 'no-file' })
    })

    it('maps a benign no-op (no-keychain) to a bullet line', async () => {
      const lines = []
      await runCredentialsRekey({}, {
        write: (s) => lines.push(s),
        log: noopLog,
        rekey: () => ({ rekeyed: false, reason: 'no-keychain' }),
      })
      assert.match(lines.join('\n'), /^• No OS keychain available/)
    })
  })
})
