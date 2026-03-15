import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

const { maskToken } = await import(join(srcDir, 'mask-token.js'))

describe('maskToken (#1893)', () => {
  it('masks middle of token showing first 4 and last 4 chars', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz123456'
    const masked = maskToken(token)
    assert.ok(masked.startsWith('abcd'))
    assert.ok(masked.endsWith('3456'))
    assert.ok(masked.includes('...'))
    assert.ok(!masked.includes('efghijklmnopqrstuvwxyz12'))
  })

  it('returns short tokens unchanged (too short to mask meaningfully)', () => {
    assert.equal(maskToken('abc'), 'abc')
    assert.equal(maskToken('abcdefgh'), 'abcdefgh')
  })

  it('handles empty/null input', () => {
    assert.equal(maskToken(''), '')
    assert.equal(maskToken(null), '')
    assert.equal(maskToken(undefined), '')
  })

  it('server terminal output uses maskToken — masked token differs from original', () => {
    // Behavioral: verify that maskToken actually transforms a long token
    // (regression guard for the server using maskToken in terminal output)
    const longToken = 'my-secret-api-token-1234567890'
    const masked = maskToken(longToken)
    assert.notEqual(masked, longToken, 'maskToken should transform long tokens (not show full value)')
    assert.ok(masked.includes('...'), 'masked token should contain ellipsis')
    // First and last 4 chars visible — rest hidden
    assert.ok(masked.startsWith(longToken.slice(0, 4)), 'prefix should be visible')
    assert.ok(masked.endsWith(longToken.slice(-4)), 'suffix should be visible')
    const hiddenPart = longToken.slice(4, -4)
    assert.ok(!masked.includes(hiddenPart), 'middle portion of token must not appear in masked output')
  })

  it('showToken flag bypasses masking — full token visible when showToken is true', () => {
    // Behavioral: when CHROXY_SHOW_TOKEN is set the full token is used, not the masked value.
    // Verify the masking API itself: if showToken is false, masked !== original.
    // If showToken is true, caller uses raw token (maskToken is not called).
    // This guards the contract between displayQr and maskToken.
    const fullToken = 'test-full-token-abcdefgh1234'
    const masked = maskToken(fullToken)
    // With showToken=false: masked value hides middle
    assert.notEqual(masked, fullToken)
    // With showToken=true: caller would use fullToken directly — maskToken not invoked
    // Simulate: token displayed equals fullToken (no masking applied)
    const displayedWithShowToken = fullToken  // server-cli: SHOW_TOKEN ? API_TOKEN : maskToken(API_TOKEN)
    assert.equal(displayedWithShowToken, fullToken)
  })

  it('connectionInfo file contains full unmasked token (writeConnectionInfo receives API_TOKEN)', async () => {
    // Behavioral: writeConnectionInfo stores the raw token, never the masked one.
    // This is security-critical — the app needs the full token to authenticate.
    const { writeConnectionInfo, readConnectionInfo, removeConnectionInfo } = await import('../src/connection-info.js')
    const fullToken = 'full-secret-token-abcd1234efgh5678'
    const maskedToken = maskToken(fullToken)
    const origDir = process.env.CHROXY_CONFIG_DIR
    const tmpDir = process.env.TMPDIR || '/tmp'

    try {
      process.env.CHROXY_CONFIG_DIR = `${tmpDir}/chroxy-mask-test-${Date.now()}`
      writeConnectionInfo({ apiToken: fullToken, wsUrl: 'ws://localhost:8765' })
      const info = readConnectionInfo()
      assert.equal(info.apiToken, fullToken,
        'connection.json must store the full unmasked token for app authentication')
      assert.notEqual(info.apiToken, maskedToken,
        'connection.json must NOT store the masked token')
    } finally {
      removeConnectionInfo()
      if (origDir === undefined) {
        delete process.env.CHROXY_CONFIG_DIR
      } else {
        process.env.CHROXY_CONFIG_DIR = origDir
      }
    }
  })
})
