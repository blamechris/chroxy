/**
 * Tests for the shared E2E key-pinning decision (#5536).
 */
import { describe, it, expect } from 'vitest'
import { createKeyPair, createSigningKeyPair, signExchangeKey } from './crypto'
import {
  decideKeyPin,
  decideKeyPinWithPairingIdentity,
  KEY_PIN_MISMATCH_MESSAGE,
} from './key-pinning'

/** Mint an identity + a signed ephemeral exchange key, the server's handshake offer. */
function makeHandshake() {
  const identity = createSigningKeyPair()
  const exchange = createKeyPair()
  const serverKeySig = signExchangeKey(exchange.publicKey, identity.secretKey)
  return { identity, exchange, serverKeySig }
}

describe('decideKeyPin — pinned record', () => {
  it('CONNECTs when the offered key is signed by the pinned identity', () => {
    const { identity, exchange, serverKeySig } = makeHandshake()
    const d = decideKeyPin({
      pinnedIdentityKey: identity.publicKey,
      exchangePublicKey: exchange.publicKey,
      serverKeySig,
    })
    expect(d).toEqual({ action: 'connect', reason: 'verified' })
  })

  it('REFUSEs when the signature is from a different (attacker) identity', () => {
    const real = createSigningKeyPair()
    const attacker = createSigningKeyPair()
    const attackerExchange = createKeyPair()
    const attackerSig = signExchangeKey(attackerExchange.publicKey, attacker.secretKey)
    const d = decideKeyPin({
      pinnedIdentityKey: real.publicKey, // pinned the REAL daemon
      exchangePublicKey: attackerExchange.publicKey,
      serverKeySig: attackerSig,
    })
    expect(d.action).toBe('refuse')
    if (d.action === 'refuse') {
      expect(d.reason).toBe('signature-mismatch')
      expect(d.message).toBe(KEY_PIN_MISMATCH_MESSAGE)
    }
  })

  it('REFUSEs a pinned-but-unsigned handshake (downgrade attempt)', () => {
    const { identity, exchange } = makeHandshake()
    const d = decideKeyPin({
      pinnedIdentityKey: identity.publicKey,
      exchangePublicKey: exchange.publicKey,
      serverKeySig: null, // MITM stripped the signature to force TOFU
    })
    expect(d.action).toBe('refuse')
    if (d.action === 'refuse') expect(d.reason).toBe('pinned-but-unsigned')
  })

  it('REFUSEs when the exchange key was substituted (valid sig over a different key)', () => {
    const { identity, serverKeySig } = makeHandshake()
    const substituted = createKeyPair()
    const d = decideKeyPin({
      pinnedIdentityKey: identity.publicKey,
      exchangePublicKey: substituted.publicKey, // not what was signed
      serverKeySig,
    })
    expect(d.action).toBe('refuse')
  })
})

describe('decideKeyPin — unpinned record', () => {
  it('CONNECTs (TOFU) when the daemon advertises no identity', () => {
    const exchange = createKeyPair()
    const d = decideKeyPin({
      pinnedIdentityKey: null,
      exchangePublicKey: exchange.publicKey,
      serverKeySig: null,
    })
    expect(d).toEqual({ action: 'connect', reason: 'unpinned-no-identity' })
  })

  it('CONNECTs (TOFU) even when a sig is present but nothing is pinned (no pairing identity)', () => {
    const { exchange, serverKeySig } = makeHandshake()
    const d = decideKeyPin({
      pinnedIdentityKey: null,
      exchangePublicKey: exchange.publicKey,
      serverKeySig,
    })
    expect(d).toEqual({ action: 'connect', reason: 'unpinned-no-identity' })
  })
})

describe('decideKeyPinWithPairingIdentity — pin-on-first-use', () => {
  it('PINs the pairing identity when first-connect verification passes', () => {
    const { identity, exchange, serverKeySig } = makeHandshake()
    const d = decideKeyPinWithPairingIdentity({
      pinnedIdentityKey: null,
      pairingIdentityKey: identity.publicKey, // captured from the QR `idk=`
      exchangePublicKey: exchange.publicKey,
      serverKeySig,
    })
    expect(d).toEqual({
      action: 'pin-and-connect',
      reason: 'pin-on-first-use',
      identityKey: identity.publicKey,
    })
  })

  it('REFUSEs a first connect whose sig does NOT match the pairing identity (first-connect MITM)', () => {
    const pairingIdentity = createSigningKeyPair()
    const mitm = createSigningKeyPair()
    const mitmExchange = createKeyPair()
    const mitmSig = signExchangeKey(mitmExchange.publicKey, mitm.secretKey)
    const d = decideKeyPinWithPairingIdentity({
      pinnedIdentityKey: null,
      pairingIdentityKey: pairingIdentity.publicKey, // trusted, from QR
      exchangePublicKey: mitmExchange.publicKey,
      serverKeySig: mitmSig,
    })
    expect(d.action).toBe('refuse')
    if (d.action === 'refuse') expect(d.reason).toBe('signature-mismatch')
  })

  it('REFUSEs a first connect that is unsigned but had a pairing identity (downgrade)', () => {
    const pairingIdentity = createSigningKeyPair()
    const exchange = createKeyPair()
    const d = decideKeyPinWithPairingIdentity({
      pinnedIdentityKey: null,
      pairingIdentityKey: pairingIdentity.publicKey,
      exchangePublicKey: exchange.publicKey,
      serverKeySig: null,
    })
    expect(d.action).toBe('refuse')
    if (d.action === 'refuse') expect(d.reason).toBe('pinned-but-unsigned')
  })

  it('falls through to TOFU when neither a pin nor a pairing identity exists', () => {
    const exchange = createKeyPair()
    const d = decideKeyPinWithPairingIdentity({
      pinnedIdentityKey: null,
      pairingIdentityKey: null,
      exchangePublicKey: exchange.publicKey,
      serverKeySig: null,
    })
    expect(d).toEqual({ action: 'connect', reason: 'unpinned-no-identity' })
  })

  it('prefers the existing pin over a (stale) pairing identity', () => {
    // Already pinned daemon A; a leftover pairing identity B must NOT override it.
    const daemonA = createSigningKeyPair()
    const exchange = createKeyPair()
    const sigA = signExchangeKey(exchange.publicKey, daemonA.secretKey)
    const stalePairing = createSigningKeyPair()
    const d = decideKeyPinWithPairingIdentity({
      pinnedIdentityKey: daemonA.publicKey,
      pairingIdentityKey: stalePairing.publicKey,
      exchangePublicKey: exchange.publicKey,
      serverKeySig: sigA,
    })
    expect(d).toEqual({ action: 'connect', reason: 'verified' })
  })
})
