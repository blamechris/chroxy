import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

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

  it('server-cli.js uses maskToken for terminal output', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    assert.ok(
      source.includes('maskToken'),
      'server-cli.js should use maskToken'
    )
  })

  it('server-cli.js respects showToken config flag', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    assert.ok(
      source.includes('showToken'),
      'server-cli.js should check showToken flag'
    )
  })

  it('connectionInfo file still contains full unmasked token', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    // writeConnectionInfo should receive API_TOKEN (not masked)
    assert.ok(
      source.includes('writeConnectionInfo') && source.includes('apiToken: API_TOKEN'),
      'writeConnectionInfo should receive the full token'
    )
  })
})
