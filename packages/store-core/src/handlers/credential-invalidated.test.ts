import { describe, it, expect } from 'vitest'
import { handleCredentialInvalidated, shouldForgetOnAuthFail } from './auth'

describe('handleCredentialInvalidated', () => {
  it('returns the reason the server gave', () => {
    expect(handleCredentialInvalidated({ type: 'credential_invalidated', reason: 'expired' })).toEqual({ reason: 'expired' })
  })

  it('falls back to a neutral reason for a missing or non-string one', () => {
    expect(handleCredentialInvalidated({ type: 'credential_invalidated' })).toEqual({ reason: 'invalid' })
    expect(handleCredentialInvalidated({ type: 'credential_invalidated', reason: 7 })).toEqual({ reason: 'invalid' })
    expect(handleCredentialInvalidated({ type: 'credential_invalidated', reason: '' })).toEqual({ reason: 'invalid' })
  })
})

describe('shouldForgetOnAuthFail', () => {
  it('forgets only an invalid_token for the token the earlier drop ended on', () => {
    expect(shouldForgetOnAuthFail('invalid_token', 'tok', 'tok')).toBe(true)
  })

  it('does not forget without a prior suspect token', () => {
    expect(shouldForgetOnAuthFail('invalid_token', null, 'tok')).toBe(false)
  })

  it('does not forget a different token', () => {
    expect(shouldForgetOnAuthFail('invalid_token', 'tok', 'other')).toBe(false)
    expect(shouldForgetOnAuthFail('invalid_token', 'tok', undefined)).toBe(false)
  })

  it('does not forget on any other failure reason', () => {
    for (const reason of ['rate_limited', 'timeout', 'invalid_message', 'session_unavailable', 'unsupported protocol version 0 (minimum: 1)']) {
      expect(shouldForgetOnAuthFail(reason, 'tok', 'tok')).toBe(false)
    }
  })
})
