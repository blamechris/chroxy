import { describe, it, expect } from 'vitest'
import { captureConnectionIdentity, reconnectConnectionIdentity, effectiveConnectionIdentity } from './connection-identity'

const saved = { url: 'wss://own.example.test/ws', token: 'fixture-original', pinnedIdentityKey: 'fixture-pin', lanUrl: 'ws://192.168.1.50/ws', tunnelUrl: 'wss://own.example.test/ws' }

describe('socket identity targets', () => {
  it('captures the pin independently of later credential and saved-record changes', () => {
    const record = { ...saved }
    const target = captureConnectionIdentity(record.url, record, null)
    record.token = 'fixture-updated'
    record.pinnedIdentityKey = 'fixture-other'
    expect(target.pinnedIdentityKey).toBe('fixture-pin')
    expect(target.savedConnection?.token).toBe('fixture-original')
  })

  it('recognizes known alias endpoints and does not borrow an unrelated record', () => {
    expect(captureConnectionIdentity(saved.lanUrl, saved, null).pinnedIdentityKey).toBe('fixture-pin')
    expect(captureConnectionIdentity('wss://other.example.test/ws', saved, null).pinnedIdentityKey).toBeNull()
  })

  it('captures an explicit trusted pairing target', () => {
    const target = captureConnectionIdentity(saved.url, saved, 'fixture-pairing-pin')
    expect(target.pinnedIdentityKey).toBeNull()
    expect(target.pairingIdentityKey).toBe('fixture-pairing-pin')
  })

  it('retains the verified certificate-effective identity on reconnect', () => {
    const target = captureConnectionIdentity(saved.url, saved, null)
    const pin = effectiveConnectionIdentity(target, { action: 'rotate-pin', reason: 'identity-rotated', identityKey: 'fixture-current-pin' })
    const next = reconnectConnectionIdentity(target, pin)
    expect(next.pinnedIdentityKey).toBe('fixture-current-pin')
    expect(next.pairingIdentityKey).toBeNull()
  })
})
