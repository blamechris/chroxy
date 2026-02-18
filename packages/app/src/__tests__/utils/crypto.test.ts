import {
  createKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  nonceFromCounter,
  EncryptedEnvelope,
} from '../../utils/crypto'

describe('crypto', () => {
  it('round-trip encrypt/decrypt', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const original = { type: 'input', text: 'hello world' }
    const envelope = encrypt(JSON.stringify(original), serverShared, 0)

    expect(envelope.type).toBe('encrypted')
    expect(envelope.n).toBe(0)
    expect(typeof envelope.d).toBe('string')

    const decrypted = decrypt(envelope, clientShared, 0)
    expect(decrypted).toEqual(original)
  })

  it('cross-side compatibility', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    // Server -> Client
    const msg1 = { type: 'response', content: 'test' }
    const enc1 = encrypt(JSON.stringify(msg1), serverShared, 0)
    expect(decrypt(enc1, clientShared, 0)).toEqual(msg1)

    // Client -> Server
    const msg2 = { type: 'input', text: 'reply' }
    const enc2 = encrypt(JSON.stringify(msg2), clientShared, 0)
    expect(decrypt(enc2, serverShared, 0)).toEqual(msg2)
  })

  it('tamper detection', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0)
    const tampered: EncryptedEnvelope = { ...envelope, d: envelope.d.slice(0, -4) + 'AAAA' }
    expect(() => decrypt(tampered, clientShared, 0)).toThrow('Decryption failed')
  })

  it('wrong nonce rejection', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0)
    expect(() => decrypt(envelope, clientShared, 1)).toThrow('Unexpected nonce')
  })

  it('key mismatch causes decryption failure', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const wrongKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const wrongShared = deriveSharedKey(wrongKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0)
    expect(() => decrypt(envelope, wrongShared, 0)).toThrow('Decryption failed')
  })

  it('nonceFromCounter produces correct 24-byte nonces', () => {
    const n0 = nonceFromCounter(0)
    expect(n0.length).toBe(24)
    expect(Array.from(n0).every((b) => b === 0)).toBe(true)

    const n1 = nonceFromCounter(1)
    expect(n1[0]).toBe(1)

    const n256 = nonceFromCounter(256)
    expect(n256[0]).toBe(0)
    expect(n256[1]).toBe(1)
  })

  it('handles large messages', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const msg = { type: 'response', content: 'x'.repeat(100_000) }
    const envelope = encrypt(JSON.stringify(msg), serverShared, 0)
    expect(decrypt(envelope, clientShared, 0)).toEqual(msg)
  })
})
