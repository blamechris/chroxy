import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger, setJsonMode, closeFileLogging } from '../src/logger.js'

describe('logger JSON mode', () => {
  let captured = []
  let originalLog, originalWarn, originalError

  beforeEach(() => {
    captured = []
    originalLog = console.log
    originalWarn = console.warn
    originalError = console.error
    console.log = (...args) => captured.push({ method: 'log', args })
    console.warn = (...args) => captured.push({ method: 'warn', args })
    console.error = (...args) => captured.push({ method: 'error', args })
  })

  afterEach(() => {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    setJsonMode(false)
    closeFileLogging()
  })

  it('produces valid JSON lines when JSON mode is enabled', () => {
    setJsonMode(true)
    const log = createLogger('test')
    log.info('hello world')

    assert.equal(captured.length, 1)
    const parsed = JSON.parse(captured[0].args[0])
    assert.equal(typeof parsed, 'object')
  })

  it('includes ts, level, component, msg fields', () => {
    setJsonMode(true)
    const log = createLogger('ws')
    log.info('Client connected')

    const parsed = JSON.parse(captured[0].args[0])
    assert.equal(typeof parsed.ts, 'string')
    assert.ok(parsed.ts.match(/^\d{4}-\d{2}-\d{2}T/), 'ts should be ISO format')
    assert.equal(parsed.level, 'info')
    assert.equal(parsed.component, 'ws')
    assert.equal(parsed.msg, 'Client connected')
  })

  it('uses correct level values for each log method', () => {
    setJsonMode(true)
    const log = createLogger('srv')

    log.warn('disk low')
    log.error('crash')

    const warn = JSON.parse(captured[0].args[0])
    assert.equal(warn.level, 'warn')
    assert.equal(warn.component, 'srv')

    const err = JSON.parse(captured[1].args[0])
    assert.equal(err.level, 'error')
    assert.equal(err.component, 'srv')
  })

  it('routes warn to console.warn and error to console.error in JSON mode', () => {
    setJsonMode(true)
    const log = createLogger('test')

    log.warn('warning msg')
    log.error('error msg')

    assert.equal(captured[0].method, 'warn')
    assert.equal(captured[1].method, 'error')
  })

  it('human-readable mode remains unchanged (default)', () => {
    const log = createLogger('cli')
    log.info('Server ready')

    assert.equal(captured.length, 1)
    const line = captured[0].args[0]
    // Human-readable format: timestamp [LEVEL] [component] message
    assert.ok(line.includes('[INFO]'), 'should contain [INFO]')
    assert.ok(line.includes('[cli]'), 'should contain [cli]')
    assert.ok(line.includes('Server ready'), 'should contain message')
    // Should NOT be valid JSON
    assert.throws(() => JSON.parse(line), 'human-readable should not be JSON')
  })

  it('setJsonMode toggles between modes', () => {
    const log = createLogger('toggle')

    // Start in text mode
    log.info('text mode')
    assert.ok(captured[0].args[0].includes('[INFO]'))

    // Switch to JSON
    setJsonMode(true)
    log.info('json mode')
    const parsed = JSON.parse(captured[1].args[0])
    assert.equal(parsed.msg, 'json mode')

    // Switch back to text
    setJsonMode(false)
    log.info('text again')
    assert.ok(captured[2].args[0].includes('[INFO]'))
    assert.throws(() => JSON.parse(captured[2].args[0]))
  })

  it('redacts sensitive data in JSON mode', () => {
    setJsonMode(true)
    const log = createLogger('auth')
    log.info('token: sk-abc123456789xyz')

    const parsed = JSON.parse(captured[0].args[0])
    assert.ok(parsed.msg.includes('[REDACTED]'), 'should redact sensitive values')
    assert.ok(!parsed.msg.includes('sk-abc123456789xyz'), 'should not contain raw token')
  })
})
