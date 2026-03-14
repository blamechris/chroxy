import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'

describe('validateConfig range validation', () => {
  it('warns when port is 0', () => {
    const result = validateConfig({ port: 0 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('1-65535')))
  })

  it('warns when port is negative', () => {
    const result = validateConfig({ port: -1 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('1-65535')))
  })

  it('warns when port exceeds 65535', () => {
    const result = validateConfig({ port: 70000 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('1-65535')))
  })

  it('accepts valid port numbers', () => {
    for (const port of [1, 80, 443, 8765, 65535]) {
      const result = validateConfig({ port })
      assert.equal(result.valid, true, `port ${port} should be valid`)
    }
  })

  it('warns when maxSessions is 0', () => {
    const result = validateConfig({ maxSessions: 0 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxSessions') && w.includes('>= 1')))
  })

  it('warns when maxSessions is negative', () => {
    const result = validateConfig({ maxSessions: -1 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxSessions') && w.includes('>= 1')))
  })

  it('accepts maxSessions >= 1', () => {
    for (const maxSessions of [1, 5, 100]) {
      const result = validateConfig({ maxSessions })
      assert.equal(result.valid, true, `maxSessions ${maxSessions} should be valid`)
    }
  })

  it('warns when sessionTimeout is too low (1ms parsed as "1" = 1s)', () => {
    // '1ms' is not parseable by parseDuration (no ms unit), so it returns null
    // But '1s' parses to 1000ms which is below 30s minimum
    const result = validateConfig({ sessionTimeout: '1s' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('sessionTimeout') && w.includes('30s')))
  })

  it('warns when sessionTimeout is below 30 seconds', () => {
    const result = validateConfig({ sessionTimeout: '10s' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('sessionTimeout') && w.includes('30s')))
  })

  it('warns when sessionTimeout is "1ms" (unparseable)', () => {
    // '1ms' doesn't match parseDuration patterns — warn about invalid format
    const result = validateConfig({ sessionTimeout: '1ms' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('sessionTimeout')))
  })

  it('accepts valid sessionTimeout values', () => {
    for (const sessionTimeout of ['30s', '5m', '1h', '2h30m']) {
      const result = validateConfig({ sessionTimeout })
      assert.equal(result.valid, true, `sessionTimeout '${sessionTimeout}' should be valid`)
    }
  })

  it('warns when maxPayload is below 1KB (1024)', () => {
    const result = validateConfig({ maxPayload: 512 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxPayload') && w.includes('1KB')))
  })

  it('warns when maxPayload exceeds 100MB', () => {
    const result = validateConfig({ maxPayload: 200 * 1024 * 1024 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxPayload') && w.includes('100MB')))
  })

  it('accepts valid maxPayload values', () => {
    for (const maxPayload of [1024, 64 * 1024, 1024 * 1024, 100 * 1024 * 1024]) {
      const result = validateConfig({ maxPayload })
      assert.equal(result.valid, true, `maxPayload ${maxPayload} should be valid`)
    }
  })

  it('valid config with all range-checked fields passes with no warnings', () => {
    const config = {
      port: 8765,
      maxSessions: 5,
      sessionTimeout: '30m',
      maxPayload: 64 * 1024,
    }
    const result = validateConfig(config)
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('skips range validation when type is wrong (type check catches it first)', () => {
    const result = validateConfig({ port: 'abc' })
    // Should have type warning but not range warning
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('expected number')))
    assert.ok(!result.warnings.some(w => w.includes('1-65535')))
  })
})
