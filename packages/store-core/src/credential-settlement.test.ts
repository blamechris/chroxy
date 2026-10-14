import { describe, it, expect } from 'vitest'
import { CredentialSettlement } from './credential-settlement'
import { handleAuthOk } from './handlers/auth'

function paired(encryption = 'required') {
  return new CredentialSettlement('', handleAuthOk({ encryption, capabilities: { pairedCredentialConfirmation: true } }))
}

describe('credential settlement', () => {
  it('settles the post-auth credential once after authentication', () => {
    const state = paired()
    expect(state.confirm('fixture-issued', true)).toBeNull()
    expect(state.authenticate('fixture-pin')).toBeNull()
    expect(state.confirm(null, true)).toBeNull()
    expect(state.confirm('fixture-issued', false)).toBeNull()
    expect(state.confirm('fixture-issued', true)).toEqual({ token: 'fixture-issued', pin: 'fixture-pin' })
    expect(state.confirm('fixture-later', true)).toBeNull()
  })

  it('retains the direct credential until the transport authenticates', () => {
    const state = new CredentialSettlement('fixture-direct', handleAuthOk({ encryption: 'required' }))
    expect(state.confirm('fixture-other', true)).toBeNull()
    expect(state.authenticate()).toEqual({ token: 'fixture-direct', pin: null })
    expect(state.authenticate()).toBeNull()
  })

  it('refuses older-peer pairing without confirmation support', () => {
    const state = new CredentialSettlement('', handleAuthOk({ encryption: 'required', sessionToken: 'fixture-candidate' }))
    expect(state.supported).toBe(false)
    expect(state.authenticate()).toBeNull()
    expect(state.confirm('fixture-issued', true)).toBeNull()
  })

  it('supports the negotiated plaintext transport after authentication', () => {
    const state = paired('disabled')
    expect(state.confirm('fixture-issued', false)).toBeNull()
    expect(state.authenticate()).toBeNull()
    expect(state.confirm('fixture-issued', false)).toEqual({ token: 'fixture-issued', pin: null })
  })
})
