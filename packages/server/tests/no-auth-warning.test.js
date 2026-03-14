import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger, addLogListener, removeLogListener, closeFileLogging } from '../src/logger.js'
import { checkNoAuthWarnings } from '../src/no-auth-warnings.js'

describe('no-auth security warnings', () => {
  const captured = []
  let listener

  before(() => {
    listener = (entry) => captured.push(entry)
    addLogListener(listener)
  })

  after(() => {
    removeLogListener(listener)
    closeFileLogging()
  })

  beforeEach(() => {
    captured.length = 0
  })

  it('logs a warn when authRequired is false', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'none' })

    const warns = captured.filter(e => e.level === 'warn')
    assert.ok(warns.length >= 1, 'expected at least one warn log')
    const secWarning = warns.find(e => e.message.includes('[SECURITY]') && e.message.includes('--no-auth'))
    assert.ok(secWarning, 'expected [SECURITY] --no-auth warning')
    assert.ok(secWarning.message.includes('Only safe on isolated networks'), 'expected isolation guidance')
  })

  it('logs an error when authRequired is false AND tunnel is configured', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'quick' })

    const errors = captured.filter(e => e.level === 'error')
    assert.ok(errors.length >= 1, 'expected at least one error log')
    const secError = errors.find(e => e.message.includes('[SECURITY]') && e.message.includes('tunnel'))
    assert.ok(secError, 'expected [SECURITY] tunnel error')
    assert.ok(secError.message.includes('without authentication'), 'expected authentication mention')
  })

  it('does not log warnings when authRequired is true', () => {
    checkNoAuthWarnings({ authRequired: true, tunnel: 'quick' })

    const secLogs = captured.filter(e => e.message.includes('[SECURITY]'))
    assert.equal(secLogs.length, 0, 'expected no [SECURITY] logs when auth is enabled')
  })

  it('logs error for named tunnel mode too', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'named' })

    const errors = captured.filter(e => e.level === 'error')
    const secError = errors.find(e => e.message.includes('[SECURITY]') && e.message.includes('tunnel'))
    assert.ok(secError, 'expected tunnel error for named tunnel')
  })

  it('does not log tunnel error when tunnel is none', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'none' })

    const errors = captured.filter(e => e.level === 'error')
    const secErrors = errors.filter(e => e.message.includes('[SECURITY]') && e.message.includes('tunnel'))
    assert.equal(secErrors.length, 0, 'expected no tunnel error when tunnel=none')
  })

  it('does not log tunnel error when tunnel is undefined', () => {
    checkNoAuthWarnings({ authRequired: false })

    const errors = captured.filter(e => e.level === 'error')
    const secErrors = errors.filter(e => e.message.includes('[SECURITY]') && e.message.includes('tunnel'))
    assert.equal(secErrors.length, 0, 'expected no tunnel error when tunnel is undefined')
  })
})
