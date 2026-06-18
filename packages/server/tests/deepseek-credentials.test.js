import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDeepSeekApiKey, maskApiKey } from '../src/deepseek-credentials.js'

/**
 * Tests for deepseek-credentials.js (#4656) — env-var precedence,
 * file-fallback, 0600 permission enforcement, key masking re-export.
 *
 * Run with HOME pointed at a tmpdir so we never touch the real
 * ~/.chroxy/credentials.json on the dev machine.
 */

describe('deepseek-credentials', () => {
  let tmpHome
  let originalHome
  let originalApiKey
  let originalAnthropicKey

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-deepseek-cred-test-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.DEEPSEEK_API_KEY
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    delete process.env.DEEPSEEK_API_KEY
    // Defensive: a bleed-through ANTHROPIC_API_KEY must not poison this
    // resolver — the two paths are independent. Confirms isolation.
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalApiKey) process.env.DEEPSEEK_API_KEY = originalApiKey
    else delete process.env.DEEPSEEK_API_KEY
    if (originalAnthropicKey) process.env.ANTHROPIC_API_KEY = originalAnthropicKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
  })

  describe('resolveDeepSeekApiKey', () => {
    it('returns env-var key when DEEPSEEK_API_KEY is set', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-from-env'
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, 'sk-deepseek-from-env')
      assert.equal(result.source, 'env')
    })

    it('returns "none" with helpful reason when neither env nor file present', () => {
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, null)
      assert.equal(result.source, 'none')
      assert.match(result.reason, /DEEPSEEK_API_KEY not set/)
      assert.match(result.reason, /does not exist/)
    })

    it('reads file when env not set and file is mode 0600', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ deepseekApiKey: 'sk-deepseek-from-file' }))
      chmodSync(credPath, 0o600)
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, 'sk-deepseek-from-file')
      assert.equal(result.source, 'file')
    })

    it('refuses to read a 0644 credentials file (security boundary)', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ deepseekApiKey: 'sk-should-not-load' }))
      chmodSync(credPath, 0o644)
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /mode 644/)
      assert.match(result.reason, /must be 0600/)
    })

    it('returns "none" when credentials.json is unparseable', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, 'not valid json {')
      chmodSync(credPath, 0o600)
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /unreadable or not valid JSON/)
    })

    it('returns "none" when credentials.json lacks deepseekApiKey field', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ anthropicApiKey: 'sk-ant-only' }))
      chmodSync(credPath, 0o600)
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /missing or empty "deepseekApiKey"/)
    })

    it('ignores anthropicApiKey siblings — only deepseekApiKey is consulted', () => {
      // A user with both Anthropic and DeepSeek keys in the same
      // credentials.json must have each provider read its own field.
      // Without this isolation the wrong key would silently bind to the
      // wrong provider on every session.
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({
        anthropicApiKey: 'sk-ant-not-mine',
        deepseekApiKey: 'sk-deepseek-mine',
      }))
      chmodSync(credPath, 0o600)
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, 'sk-deepseek-mine')
      assert.equal(result.source, 'file')
    })

    it('prefers env var over file when both are present', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ deepseekApiKey: 'sk-deepseek-from-file' }))
      chmodSync(credPath, 0o600)
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-from-env'
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, 'sk-deepseek-from-env')
      assert.equal(result.source, 'env')
    })

    it('does not interpret ANTHROPIC_API_KEY as a DeepSeek key', () => {
      // The two env vars are independent identity surfaces; setting one
      // must NOT make the other provider claim ready.
      process.env.ANTHROPIC_API_KEY = 'sk-ant-not-mine'
      const result = resolveDeepSeekApiKey()
      assert.equal(result.key, null)
      assert.equal(result.source, 'none')
    })
  })

  describe('maskApiKey re-export', () => {
    it('exports the same masking helper as byok-credentials', () => {
      // The re-export exists so callers don't have to import from two
      // modules to log a redacted DeepSeek key. Use a long input so the
      // visible prefix isn't capped to floor(len/3); maskApiKey hits the
      // 12-char ceiling for any input >= 36 chars.
      const masked = maskApiKey('sk-test-deepseek-' + 'x'.repeat(60))
      assert.match(masked, /^sk-test-deep/)
      assert.match(masked, /\[\d+ chars redacted\]$/)
    })
  })
})
