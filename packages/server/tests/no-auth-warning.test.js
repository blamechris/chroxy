import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * checkNoAuthWarnings is inlined into server-cli.js (#2339).
 * Test the function logic directly via console spying.
 */
function checkNoAuthWarnings({ authRequired, tunnel }) {
  if (authRequired) return
  console.warn('[SECURITY] --no-auth disables all authentication. Only safe on isolated networks!')
  if (tunnel && tunnel !== 'none') {
    console.error('[SECURITY] --no-auth with tunnel exposes your server to the internet without authentication!')
  }
}

describe('no-auth security warnings', () => {
  const capturedWarn = []
  const capturedError = []
  let originalWarn
  let originalError

  beforeEach(() => {
    capturedWarn.length = 0
    capturedError.length = 0
    originalWarn = console.warn
    originalError = console.error
    console.warn = (...args) => capturedWarn.push(args.join(' '))
    console.error = (...args) => capturedError.push(args.join(' '))
  })

  afterEach(() => {
    console.warn = originalWarn
    console.error = originalError
  })

  it('logs a warn when authRequired is false', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'none' })

    assert.ok(capturedWarn.length >= 1, 'expected at least one warn log')
    const secWarning = capturedWarn.find(m => m.includes('[SECURITY]') && m.includes('--no-auth'))
    assert.ok(secWarning, 'expected [SECURITY] --no-auth warning')
    assert.ok(secWarning.includes('Only safe on isolated networks'), 'expected isolation guidance')
  })

  it('logs an error when authRequired is false AND tunnel is configured', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'quick' })

    assert.ok(capturedError.length >= 1, 'expected at least one error log')
    const secError = capturedError.find(m => m.includes('[SECURITY]') && m.includes('tunnel'))
    assert.ok(secError, 'expected [SECURITY] tunnel error')
    assert.ok(secError.includes('without authentication'), 'expected authentication mention')
  })

  it('does not log warnings when authRequired is true', () => {
    checkNoAuthWarnings({ authRequired: true, tunnel: 'quick' })

    const secWarnLogs = capturedWarn.filter(m => m.includes('[SECURITY]'))
    const secErrorLogs = capturedError.filter(m => m.includes('[SECURITY]'))
    assert.equal(secWarnLogs.length, 0, 'expected no [SECURITY] warn logs when auth is enabled')
    assert.equal(secErrorLogs.length, 0, 'expected no [SECURITY] error logs when auth is enabled')
  })

  it('logs error for named tunnel mode too', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'named' })

    const secError = capturedError.find(m => m.includes('[SECURITY]') && m.includes('tunnel'))
    assert.ok(secError, 'expected tunnel error for named tunnel')
  })

  it('does not log tunnel error when tunnel is none', () => {
    checkNoAuthWarnings({ authRequired: false, tunnel: 'none' })

    const secErrors = capturedError.filter(m => m.includes('[SECURITY]') && m.includes('tunnel'))
    assert.equal(secErrors.length, 0, 'expected no tunnel error when tunnel=none')
  })

  it('does not log tunnel error when tunnel is undefined', () => {
    checkNoAuthWarnings({ authRequired: false })

    const secErrors = capturedError.filter(m => m.includes('[SECURITY]') && m.includes('tunnel'))
    assert.equal(secErrors.length, 0, 'expected no tunnel error when tunnel is undefined')
  })
})
