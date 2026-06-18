import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KNOWN_CREDENTIALS,
  isKnownCredentialKey,
  getStoredCredential,
  setStoredCredential,
  deleteStoredCredential,
  resolveCredential,
  getCredentialsStatus,
  credentialsFileExists,
} from '../src/credential-store.js'

/**
 * Tests for credential-store.js — the generalized multi-key provider
 * credential store (#3855). HOME points at a tmpdir so the real
 * ~/.chroxy/credentials.json is never touched.
 */

const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']

describe('credential-store', () => {
  let tmpHome
  let originalHome
  const savedEnv = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-store-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    for (const k of CRED_ENV_VARS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
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

  describe('isKnownCredentialKey', () => {
    it('accepts the four known keys and rejects others', () => {
      assert.equal(isKnownCredentialKey('ANTHROPIC_API_KEY'), true)
      assert.equal(isKnownCredentialKey('CLAUDE_CODE_OAUTH_TOKEN'), true)
      assert.equal(isKnownCredentialKey('GEMINI_API_KEY'), true)
      assert.equal(isKnownCredentialKey('OPENAI_API_KEY'), true)
      assert.equal(isKnownCredentialKey('DATABASE_URL'), false)
      assert.equal(isKnownCredentialKey(''), false)
      assert.equal(isKnownCredentialKey(undefined), false)
    })
  })

  describe('setStoredCredential', () => {
    it('persists a valid Anthropic key at mode 0600 and keeps the legacy alias', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-test123456789')
      const perms = statSync(credPath()).mode & 0o777
      assert.equal(perms, 0o600)
      const parsed = JSON.parse(readFileSync(credPath(), 'utf8'))
      assert.equal(parsed.ANTHROPIC_API_KEY, 'sk-ant-test123456789')
      // #4052 forward-compat: legacy alias written too.
      assert.equal(parsed.anthropicApiKey, 'sk-ant-test123456789')
    })

    it('trims surrounding whitespace before persisting', () => {
      setStoredCredential('OPENAI_API_KEY', '  sk-openai-abc  \n')
      assert.equal(getStoredCredential('OPENAI_API_KEY'), 'sk-openai-abc')
    })

    it('rejects an Anthropic key without the sk-ant- prefix', () => {
      assert.throws(() => setStoredCredential('ANTHROPIC_API_KEY', 'nope'), /sk-ant-/)
      assert.equal(credentialsFileExists(), false)
    })

    it('rejects an OpenAI key without the sk- prefix', () => {
      assert.throws(() => setStoredCredential('OPENAI_API_KEY', 'nope'), /sk-/)
    })

    it('accepts an opaque OAuth token (no format constraint)', () => {
      setStoredCredential('CLAUDE_CODE_OAUTH_TOKEN', 'opaque-oauth-value-123')
      assert.equal(getStoredCredential('CLAUDE_CODE_OAUTH_TOKEN'), 'opaque-oauth-value-123')
    })

    it('rejects empty values and unknown keys', () => {
      assert.throws(() => setStoredCredential('GEMINI_API_KEY', '   '), /required/)
      assert.throws(() => setStoredCredential('NOT_A_KEY', 'x'), /Unknown credential key/)
    })

    it('does not clobber sibling keys when updating one', () => {
      setStoredCredential('GEMINI_API_KEY', 'gemini-key-1')
      setStoredCredential('OPENAI_API_KEY', 'sk-openai-2')
      assert.equal(getStoredCredential('GEMINI_API_KEY'), 'gemini-key-1')
      assert.equal(getStoredCredential('OPENAI_API_KEY'), 'sk-openai-2')
    })
  })

  describe('getStoredCredential / 0600 boundary', () => {
    it('returns null when no file exists', () => {
      assert.equal(getStoredCredential('GEMINI_API_KEY'), null)
    })

    it('reads the legacy anthropicApiKey alias for ANTHROPIC_API_KEY', () => {
      mkdirSync(join(tmpHome, '.chroxy'), { recursive: true, mode: 0o700 })
      writeFileSync(credPath(), JSON.stringify({ anthropicApiKey: 'sk-ant-legacy' }), { mode: 0o600 })
      chmodSync(credPath(), 0o600)
      assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-legacy')
    })

    it('refuses to read a world-readable (0644) file', () => {
      if (process.platform === 'win32') return // POSIX-only boundary
      mkdirSync(join(tmpHome, '.chroxy'), { recursive: true, mode: 0o700 })
      writeFileSync(credPath(), JSON.stringify({ GEMINI_API_KEY: 'leak' }), { mode: 0o644 })
      chmodSync(credPath(), 0o644)
      // getStoredCredential swallows the error and returns null...
      assert.equal(getStoredCredential('GEMINI_API_KEY'), null)
      // ...and the status surface reports the mode error explicitly.
      const status = getCredentialsStatus()
      assert.match(status.fileError, /must be 0600/)
    })
  })

  describe('resolveCredential — env > store > unset', () => {
    it('prefers the process env over a stored value', () => {
      setStoredCredential('GEMINI_API_KEY', 'stored-value')
      process.env.GEMINI_API_KEY = 'env-value'
      const r = resolveCredential('GEMINI_API_KEY')
      assert.deepEqual(r, { value: 'env-value', source: 'env' })
    })

    it('falls back to the store when env is unset', () => {
      setStoredCredential('GEMINI_API_KEY', 'stored-value')
      const r = resolveCredential('GEMINI_API_KEY')
      assert.deepEqual(r, { value: 'stored-value', source: 'store' })
    })

    it('returns unset when neither env nor store has a value', () => {
      const r = resolveCredential('GEMINI_API_KEY')
      assert.deepEqual(r, { value: null, source: 'unset' })
    })
  })

  describe('deleteStoredCredential', () => {
    it('removes one key but keeps the others', () => {
      setStoredCredential('GEMINI_API_KEY', 'g')
      setStoredCredential('OPENAI_API_KEY', 'sk-o')
      deleteStoredCredential('GEMINI_API_KEY')
      assert.equal(getStoredCredential('GEMINI_API_KEY'), null)
      assert.equal(getStoredCredential('OPENAI_API_KEY'), 'sk-o')
    })

    it('removes the legacy alias when deleting ANTHROPIC_API_KEY', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-x')
      deleteStoredCredential('ANTHROPIC_API_KEY')
      assert.equal(credentialsFileExists(), false) // file removed when empty
    })

    it('deletes the file entirely when the last key is removed', () => {
      setStoredCredential('OPENAI_API_KEY', 'sk-o')
      deleteStoredCredential('OPENAI_API_KEY')
      assert.equal(existsSync(credPath()), false)
    })

    it('is a no-op when the file does not exist', () => {
      assert.doesNotThrow(() => deleteStoredCredential('GEMINI_API_KEY'))
    })
  })

  describe('getCredentialsStatus — masking and OAuth', () => {
    it('never includes a raw value, only masked previews', () => {
      const raw = 'sk-ant-supersecretkeyvalue000'
      setStoredCredential('ANTHROPIC_API_KEY', raw)
      const status = getCredentialsStatus()
      const anth = status.credentials.find((c) => c.key === 'ANTHROPIC_API_KEY')
      assert.equal(anth.status, 'set')
      assert.equal(anth.source, 'store')
      assert.ok(anth.masked && anth.masked.length > 0)
      // The full raw value must never appear anywhere in the serialized status.
      assert.equal(JSON.stringify(status).includes(raw), false)
    })

    it('reports env source when the env var wins', () => {
      process.env.OPENAI_API_KEY = 'sk-env-openai'
      const status = getCredentialsStatus()
      const openai = status.credentials.find((c) => c.key === 'OPENAI_API_KEY')
      assert.equal(openai.source, 'env')
      assert.equal(openai.status, 'set')
    })

    it('surfaces OAuth as the source when no key is set but OAuth creds exist', () => {
      const status = getCredentialsStatus({ hasClaudeOAuthCreds: () => true })
      const anth = status.credentials.find((c) => c.key === 'ANTHROPIC_API_KEY')
      assert.equal(anth.status, 'missing')
      assert.equal(anth.source, 'oauth')
      assert.equal(anth.oauth, true)
    })

    it('returns one entry per known credential', () => {
      const status = getCredentialsStatus()
      assert.equal(status.credentials.length, KNOWN_CREDENTIALS.length)
    })
  })
})
