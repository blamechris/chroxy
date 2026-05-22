import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAnthropicApiKey, maskApiKey } from '../src/byok-credentials.js'

/**
 * Tests for byok-credentials.js — env-var precedence, file-fallback,
 * permission enforcement (0600 required), key masking.
 *
 * Run with HOME pointed at a tmpdir so we never touch the real
 * ~/.chroxy/credentials.json on the dev machine.
 */

describe('byok-credentials', () => {
  let tmpHome
  let originalHome
  let originalApiKey

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-cred-test-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
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

    it('reads file when env not set and file is mode 0600', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ anthropicApiKey: 'sk-ant-from-file' }))
      chmodSync(credPath, 0o600)
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, 'sk-ant-from-file')
      assert.equal(result.source, 'file')
    })

    it('refuses to read a 0644 credentials file (security boundary)', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ anthropicApiKey: 'sk-ant-should-not-load' }))
      chmodSync(credPath, 0o644)
      const result = resolveAnthropicApiKey()
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
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /unreadable or not valid JSON/)
    })

    it('returns "none" when credentials.json lacks anthropicApiKey field', () => {
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ otherKey: 'sk-other' }))
      chmodSync(credPath, 0o600)
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, null)
      assert.match(result.reason, /missing or empty "anthropicApiKey"/)
    })

    it('prefers env var over file when both are present', () => {
      // Demonstrates the priority order — env wins. Allows users to
      // override a saved file by exporting the env var temporarily.
      const chroxyDir = join(tmpHome, '.chroxy')
      const credPath = join(chroxyDir, 'credentials.json')
      mkdirSync(chroxyDir, { recursive: true })
      writeFileSync(credPath, JSON.stringify({ anthropicApiKey: 'sk-ant-from-file' }))
      chmodSync(credPath, 0o600)
      process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env'
      const result = resolveAnthropicApiKey()
      assert.equal(result.key, 'sk-ant-from-env')
      assert.equal(result.source, 'env')
    })
  })

  describe('maskApiKey', () => {
    it('masks all but the first 12 chars and notes redaction', () => {
      const masked = maskApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
      assert.match(masked, /^sk-ant-api03/)
      assert.match(masked, /\[\d+ chars redacted\]$/)
      // Critical: the full key must not appear in the masked output.
      assert.equal(masked.includes('abcdefghijklmnopqrstuvwxyz'), false)
    })

    it('returns <missing> for null/empty/non-string', () => {
      assert.equal(maskApiKey(''), '<missing>')
      assert.equal(maskApiKey(null), '<missing>')
      assert.equal(maskApiKey(undefined), '<missing>')
      assert.equal(maskApiKey(42), '<missing>')
    })

    it('never echoes the full key — even for unexpectedly short inputs', () => {
      // Pre-fix, slice(0, 12) returned the entire string for any input
      // shorter than 12 chars, leaking the whole secret into logs.
      // Caught by Copilot review on PR #4055.
      const short = 'sk-ant-x'  // 8 chars
      const masked = maskApiKey(short)
      assert.equal(masked.includes(short), false, 'must not contain the full short key')
      assert.match(masked, /\[\d+ chars redacted\]$/)
      // The visible prefix should be at most one-third of the input.
      const visibleSegment = masked.split('...')[0]
      assert.ok(visibleSegment.length <= Math.floor(short.length / 3),
        `visible prefix (${visibleSegment.length}) must be <= 1/3 of input (${Math.floor(short.length / 3)})`)
    })

    it('still produces a useful prefix for normal-length keys', () => {
      const real = 'sk-ant-api03-' + 'a'.repeat(95)  // ~108 chars, claude length
      const masked = maskApiKey(real)
      // Still 12 chars of useful prefix for grepping logs.
      assert.match(masked, /^sk-ant-api03/)
      assert.match(masked, /\[\d+ chars redacted\]$/)
      assert.equal(masked.includes(real.slice(15)), false)
    })
  })
})
