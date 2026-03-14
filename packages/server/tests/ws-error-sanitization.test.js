import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeErrorMessage } from '../src/ws-server.js'

describe('sanitizeErrorMessage', () => {
  it('returns readable message for INVALID_MESSAGE code', () => {
    const err = new Error('zod parse failed at path.foo')
    err.code = 'INVALID_MESSAGE'
    assert.equal(sanitizeErrorMessage(err), 'Message validation failed')
  })

  it('returns readable message for SESSION_NOT_FOUND code', () => {
    const err = new Error('no session with id abc-123 in map')
    err.code = 'SESSION_NOT_FOUND'
    assert.equal(sanitizeErrorMessage(err), 'Session not found')
  })

  it('returns readable message for PERMISSION_DENIED code', () => {
    const err = new Error('client lacks admin role')
    err.code = 'PERMISSION_DENIED'
    assert.equal(sanitizeErrorMessage(err), 'Permission denied')
  })

  it('returns generic message for unknown error codes', () => {
    const err = new Error('ENOENT: no such file or directory /etc/shadow')
    err.code = 'ENOENT'
    assert.equal(sanitizeErrorMessage(err), 'An internal error occurred')
  })

  it('returns generic message for errors without a code', () => {
    const err = new Error('Cannot read properties of undefined')
    assert.equal(sanitizeErrorMessage(err), 'An internal error occurred')
  })

  it('does not leak stack traces in any returned message', () => {
    const err = new Error('secret database connection string leaked')
    err.code = 'DB_CONNECTION_FAILED'
    const result = sanitizeErrorMessage(err)
    assert.ok(!result.includes('secret'))
    assert.ok(!result.includes('database'))
    assert.ok(!result.includes('leaked'))
    assert.ok(!result.includes('at '))
  })

  it('does not leak the original error message for unknown errors', () => {
    const err = new Error('/home/user/.ssh/id_rsa: permission denied')
    const result = sanitizeErrorMessage(err)
    assert.ok(!result.includes('.ssh'))
    assert.ok(!result.includes('id_rsa'))
  })

  it('handles null/undefined error gracefully', () => {
    assert.equal(sanitizeErrorMessage(null), 'An internal error occurred')
    assert.equal(sanitizeErrorMessage(undefined), 'An internal error occurred')
  })
})
