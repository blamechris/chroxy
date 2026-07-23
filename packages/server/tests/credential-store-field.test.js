import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setStoredField,
  deleteStoredField,
  readStoredField,
  setStoredCredential,
  getStoredCredential,
} from '../src/credential-store.js'

/**
 * #6540: setStoredField / deleteStoredField — the write counterpart to
 * readStoredField for arbitrary NON-KNOWN_CREDENTIALS fields (e.g. the GitHub
 * webhook secret). The test bootstrap disables the keychain
 * (CHROXY_CRED_DISABLE_KEYCHAIN=1) so writes land as 0600 plaintext; a temp HOME
 * isolates the real credentials store.
 */
describe('setStoredField / deleteStoredField (#6540)', () => {
  let tmpHome
  let originalHome
  const FIELD = 'githubWebhookSecret'

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-field-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  it('persists a field at 0600 and reads it back through readStoredField', () => {
    setStoredField(FIELD, '  a-secret-value  ') // trims
    assert.equal(readStoredField(FIELD).value, 'a-secret-value')
    if (process.platform !== 'win32') {
      const file = join(tmpHome, '.chroxy', 'credentials.json')
      assert.equal(statSync(file).mode & 0o777, 0o600)
    }
  })

  it('rejects an empty value', () => {
    assert.throws(() => setStoredField(FIELD, '   '), /required/)
    assert.throws(() => setStoredField('', 'x'), /field is required/)
  })

  it('runs a caller-supplied validate rule', () => {
    assert.throws(() => setStoredField(FIELD, 'nope', { validate: () => 'bad value' }), /bad value/)
    assert.doesNotThrow(() => setStoredField(FIELD, 'ok', { validate: () => null }))
  })

  it('merges without clobbering a sibling provider credential', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-sibling-key-000')
    setStoredField(FIELD, 'a-secret-value')
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-sibling-key-000')
    assert.equal(readStoredField(FIELD).value, 'a-secret-value')
  })

  it('deleteStoredField removes only the field; siblings survive', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-sibling-key-000')
    setStoredField(FIELD, 'a-secret-value')
    deleteStoredField(FIELD)
    assert.equal(readStoredField(FIELD).value, null)
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-sibling-key-000')
  })

  it('deleteStoredField removes the file when it would be left empty', () => {
    setStoredField(FIELD, 'a-secret-value')
    const file = join(tmpHome, '.chroxy', 'credentials.json')
    assert.equal(existsSync(file), true)
    deleteStoredField(FIELD)
    assert.equal(existsSync(file), false)
  })

  it('deleteStoredField is a no-op when the field / file is absent', () => {
    assert.doesNotThrow(() => deleteStoredField(FIELD)) // no file
    setStoredField('otherField', 'x')
    assert.doesNotThrow(() => deleteStoredField(FIELD)) // file exists, field absent
    assert.equal(readStoredField('otherField').value, 'x')
  })
})
