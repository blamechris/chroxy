import { describe, it, expect } from 'vitest'
import { handleCredentialInvalidated, shouldForgetOnAuthFail, classifyCredentialNotice } from './auth'

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

  it('does not forget with an empty token on either side', () => {
    expect(shouldForgetOnAuthFail('invalid_token', '', '')).toBe(false)
    expect(shouldForgetOnAuthFail('invalid_token', 'tok', '')).toBe(false)
  })

  it('does not forget on any other failure reason', () => {
    for (const reason of ['rate_limited', 'timeout', 'invalid_message', 'session_unavailable', 'unsupported protocol version 0 (minimum: 1)']) {
      expect(shouldForgetOnAuthFail(reason, 'tok', 'tok')).toBe(false)
    }
  })
})

describe('classifyCredentialNotice', () => {
  const base = { encryptedFrame: true, authReceived: true, encryptionInUse: true, reason: 'revoked' }

  it('forgets on an encrypted notice for a reason that means the token is gone', () => {
    for (const reason of ['revoked', 'expired', 'evicted']) {
      expect(classifyCredentialNotice({ ...base, reason })).toBe('forget')
    }
  })

  it('only stops on an encrypted notice for any other reason', () => {
    for (const reason of ['destroyed', 'invalid', 'something-new', '']) {
      expect(classifyCredentialNotice({ ...base, reason })).toBe('stop')
    }
  })

  it('ignores a plaintext notice before authentication', () => {
    expect(classifyCredentialNotice({ ...base, encryptedFrame: false, authReceived: false, encryptionInUse: false })).toBe('ignore')
  })

  it('ignores a plaintext notice while encryption is in use', () => {
    expect(classifyCredentialNotice({ ...base, encryptedFrame: false })).toBe('ignore')
  })

  it('only stops on a plaintext notice from an authenticated unencrypted connection', () => {
    expect(classifyCredentialNotice({ ...base, encryptedFrame: false, encryptionInUse: false })).toBe('stop')
  })
})
