import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAnthropicApiKey,
  maskApiKey,
  getAnthropicApiKeyStatus,
  hasStoredCredentials,
} from '../src/byok-credentials.js'
import {
  setStoredCredential,
  deleteStoredCredential,
  _setCredentialKeychainForTests,
} from '../src/credential-store.js'

/**
 * Tests for byok-credentials.js — env-var precedence, store-backed file
 * fallback (#5867: reads now go through the cipher-aware credential-store), the
 * 0600 permission boundary, and key masking.
 *
 * Run with HOME pointed at a tmpdir so we never touch the real
 * ~/.chroxy/credentials.json. The test bootstrap (_setup.mjs) sets
 * CHROXY_CRED_DISABLE_KEYCHAIN=1, so the store writes 0600 plaintext by
 * default; the encrypted round-trip test injects an in-memory keychain.
 */

describe('byok-credentials', () => {
  let tmpHome
  let originalHome
  let originalApiKey
  const credPath = () => join(tmpHome, '.chroxy', 'credentials.json')

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-cred-test-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    _setCredentialKeychainForTests(null)
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
  })

  describe('resolveAnthropicApiKey', () => {
    it('returns env-var key when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env'
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, 'sk-ant-from-env')
      assert.equal(result.source, 'env')
    })

    it('returns "none" with helpful reason when neither env nor file present', () => {
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, null)
      assert.equal(result.source, 'none')
      assert.match(result.reason, /ANTHROPIC_API_KEY not set/)
      assert.match(result.reason, /does not exist/)
    })

    it('reads a key stored via the canonical store (mode 0600)', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-from-store')
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, 'sk-ant-from-store')
      assert.equal(result.source, 'file')
    })

    it('reads a legacy { anthropicApiKey } file written by the pre-#5867 path', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath(), JSON.stringify({ anthropicApiKey: 'sk-ant-legacy-alias' }))
      chmodSync(credPath(), 0o600)
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, 'sk-ant-legacy-alias')
      assert.equal(result.source, 'file')
    })

    // POSIX-only: the canonical store's readStore() skips the mode check on
    // win32 (NTFS ACLs don't map to POSIX bits, #4144), so a 0644 file IS read
    // there — the same posture every other credential already has on Windows.
    it('refuses to read a 0644 credentials file (security boundary)', { skip: process.platform === 'win32' }, () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath(), JSON.stringify({ anthropicApiKey: 'sk-ant-should-not-load' }))
      chmodSync(credPath(), 0o644)
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /mode 644/)
      assert.match(result.reason, /must be 0600/)
    })

    it('returns "none" when credentials.json is unparseable', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath(), 'not valid json {')
      chmodSync(credPath(), 0o600)
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /unreadable or not valid JSON/)
    })

    it('returns "none" when the store has no Anthropic credential', () => {
      // A valid, 0600 store with only a sibling key — the file exists and reads
      // fine, but there is no ANTHROPIC_API_KEY / anthropicApiKey in it.
      setStoredCredential('GEMINI_API_KEY', 'gem-sibling-value')
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /no Anthropic credential is stored/)
    })

    it('prefers env var over store when both are present', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-from-store')
      process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env'
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, 'sk-ant-from-env')
      assert.equal(result.source, 'env')
    })
  })

  // #5867 — the BYOK set/clear path now uses the canonical store. These tests
  // pin the two acceptance criteria the legacy whole-file overwrite/unlink
  // violated: sibling credentials survive, and a set→read round-trip works in
  // BOTH plaintext and encrypted (keychain) modes.
  describe('canonical-store integration (#5867)', () => {
    it('setting the BYOK key preserves a sibling provider credential', () => {
      setStoredCredential('GEMINI_API_KEY', 'gem-keep-me')
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-byok-set')
      const parsed = JSON.parse(readFileSync(credPath(), 'utf8'))
      assert.equal(parsed.GEMINI_API_KEY, 'gem-keep-me', 'sibling key must survive the BYOK write')
      assert.equal(resolveAnthropicApiKey().key, 'sk-ant-byok-set')
    })

    it('clearing the BYOK key preserves a sibling and leaves the file intact', () => {
      setStoredCredential('GEMINI_API_KEY', 'gem-keep-me')
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-byok-set')
      deleteStoredCredential('ANTHROPIC_API_KEY')
      assert.ok(existsSync(credPath()), 'file must remain while a sibling exists')
      const parsed = JSON.parse(readFileSync(credPath(), 'utf8'))
      assert.equal(parsed.GEMINI_API_KEY, 'gem-keep-me')
      assert.equal(resolveAnthropicApiKey().key, null, 'Anthropic key is gone')
    })

    it('clearing the only credential removes the file', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-only')
      deleteStoredCredential('ANTHROPIC_API_KEY')
      assert.equal(existsSync(credPath()), false)
    })

    it('round-trips a set→read in ENCRYPTED mode and never writes plaintext', () => {
      // Drive the encrypted-at-rest path with an in-memory keychain (the
      // getToken/setToken interface credential-cipher.js uses).
      const store = new Map()
      _setCredentialKeychainForTests({
        isKeychainAvailable: () => true,
        getToken: (service) => store.get(service) ?? null,
        setToken: (token, service) => { store.set(service, token) },
        deleteToken: (service) => { store.delete(service) },
      })
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-encrypted-roundtrip')
      // On-disk bytes must be an envelope, NOT the plaintext key.
      const raw = readFileSync(credPath(), 'utf8')
      assert.equal(raw.includes('sk-ant-encrypted-roundtrip'), false, 'key must not be on disk in plaintext')
      // Decryption-aware read resolves it.
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, 'sk-ant-encrypted-roundtrip')
      assert.equal(result.source, 'file')
    })
  })

  describe('maskApiKey', () => {
    it('masks all but the first 12 chars and notes redaction', () => {
      const masked = maskApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
      assert.match(masked, /^sk-ant-api03/)
      assert.match(masked, /\[\d+ chars redacted\]$/)
      assert.equal(masked.includes('abcdefghijklmnopqrstuvwxyz'), false)
    })

    it('returns <missing> for null/empty/non-string', () => {
      assert.equal(maskApiKey(''), '<missing>')
      assert.equal(maskApiKey(null), '<missing>')
      assert.equal(maskApiKey(undefined), '<missing>')
      assert.equal(maskApiKey(42), '<missing>')
    })

    it('never echoes the full key — even for unexpectedly short inputs', () => {
      const short = 'sk-ant-x'  // 8 chars
      const masked = maskApiKey(short)
      assert.equal(masked.includes(short), false, 'must not contain the full short key')
      assert.match(masked, /\[\d+ chars redacted\]$/)
      const visibleSegment = masked.split('...')[0]
      assert.ok(visibleSegment.length <= Math.floor(short.length / 3),
        `visible prefix (${visibleSegment.length}) must be <= 1/3 of input (${Math.floor(short.length / 3)})`)
    })

    it('still produces a useful prefix for normal-length keys', () => {
      const real = 'sk-ant-api03-' + 'a'.repeat(95)  // ~108 chars, claude length
      const masked = maskApiKey(real)
      assert.match(masked, /^sk-ant-api03/)
      assert.match(masked, /\[\d+ chars redacted\]$/)
      assert.equal(masked.includes(real.slice(15)), false)
    })
  })

  describe('getAnthropicApiKeyStatus', () => {
    it('reports "missing" when neither env nor file present', () => {
      const s = getAnthropicApiKeyStatus()
      assert.equal(s.status, 'missing')
      assert.equal(s.source, 'none')
      assert.ok(typeof s.reason === 'string' && s.reason.length > 0)
      assert.equal(s.masked, undefined)
    })

    it('reports "set" with source=env when env var is set', () => {
      const longKey = 'sk-ant-api03-' + 'a'.repeat(95)
      process.env.ANTHROPIC_API_KEY = longKey
      const s = getAnthropicApiKeyStatus()
      assert.equal(s.status, 'set')
      assert.equal(s.source, 'env')
      assert.match(s.masked, /^sk-ant-api03/)
      assert.equal(s.masked.includes(longKey.slice(15)), false, 'must not echo full key')
    })

    it('reports "set" with source=file when key is in the store', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-' + 'b'.repeat(95))
      const s = getAnthropicApiKeyStatus()
      assert.equal(s.status, 'set')
      assert.equal(s.source, 'file')
      assert.match(s.masked, /^sk-ant-api03/)
    })

    it('reports fileExists=false when no credentials file is on disk (#4144)', () => {
      assert.equal(getAnthropicApiKeyStatus().fileExists, false)
    })

    it('reports fileExists=true when env wins precedence but file is on disk (#4144 stale-file)', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-' + 'c'.repeat(95))
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-' + 'd'.repeat(95)
      const s = getAnthropicApiKeyStatus()
      assert.equal(s.status, 'set')
      assert.equal(s.source, 'env', 'env must still win precedence')
      assert.equal(s.fileExists, true, 'stale file on disk must be visible to the dashboard')
    })

    it('reports fileExists=true when only the file is the key source (#4144 consistency)', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-' + 'e'.repeat(95))
      const s = getAnthropicApiKeyStatus()
      assert.equal(s.source, 'file')
      assert.equal(s.fileExists, true)
    })
  })

  describe('hasStoredCredentials (#4144)', () => {
    it('returns false when no file exists', () => {
      assert.equal(hasStoredCredentials(), false)
    })

    it('returns true after a store write lands a file', () => {
      setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-api03-' + 'f'.repeat(95))
      assert.equal(hasStoredCredentials(), true)
    })

    it('returns true even when the file mode is wrong (resolve would refuse it)', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath(), '{"anthropicApiKey":"x"}', { mode: 0o644 })
      chmodSync(credPath(), 0o644)
      assert.equal(hasStoredCredentials(), true, 'presence is independent of resolution validity')
    })
  })
})
