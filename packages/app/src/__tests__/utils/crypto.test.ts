import {
  createKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  nonceFromCounter,
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
  EncryptedEnvelope,
} from '../../utils/crypto'

describe('crypto', () => {
  it('round-trip encrypt/decrypt', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const original = { type: 'input', text: 'hello world' }
    const envelope = encrypt(JSON.stringify(original), serverShared, 0, DIRECTION_SERVER)

    expect(envelope.type).toBe('encrypted')
    expect(envelope.n).toBe(0)
    expect(typeof envelope.d).toBe('string')

    const decrypted = decrypt(envelope, clientShared, 0, DIRECTION_SERVER)
    expect(decrypted).toEqual(original)
  })

  it('cross-side compatibility', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    // Server -> Client
    const msg1 = { type: 'response', content: 'test' }
    const enc1 = encrypt(JSON.stringify(msg1), serverShared, 0, DIRECTION_SERVER)
    expect(decrypt(enc1, clientShared, 0, DIRECTION_SERVER)).toEqual(msg1)

    // Client -> Server
    const msg2 = { type: 'input', text: 'reply' }
    const enc2 = encrypt(JSON.stringify(msg2), clientShared, 0, DIRECTION_CLIENT)
    expect(decrypt(enc2, serverShared, 0, DIRECTION_CLIENT)).toEqual(msg2)
  })

  it('direction isolation: same counter cannot decrypt with wrong direction', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0, DIRECTION_SERVER)
    expect(() => decrypt(envelope, clientShared, 0, DIRECTION_CLIENT)).toThrow('Decryption failed')
  })

  it('tamper detection', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0, DIRECTION_SERVER)
    const tampered: EncryptedEnvelope = { ...envelope, d: envelope.d.slice(0, -4) + 'AAAA' }
    expect(() => decrypt(tampered, clientShared, 0, DIRECTION_SERVER)).toThrow('Decryption failed')
  })

  it('wrong nonce rejection', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0, DIRECTION_SERVER)
    expect(() => decrypt(envelope, clientShared, 1, DIRECTION_SERVER)).toThrow('Unexpected nonce')
  })

  it('key mismatch causes decryption failure', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const wrongKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const wrongShared = deriveSharedKey(wrongKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0, DIRECTION_SERVER)
    expect(() => decrypt(envelope, wrongShared, 0, DIRECTION_SERVER)).toThrow('Decryption failed')
  })

  it('nonceFromCounter produces correct 24-byte nonces with direction', () => {
    const n0 = nonceFromCounter(0, DIRECTION_SERVER)
    expect(n0.length).toBe(24)
    expect(n0[0]).toBe(0) // direction = server

    const n1 = nonceFromCounter(1, DIRECTION_CLIENT)
    expect(n1[0]).toBe(1) // direction = client
    expect(n1[1]).toBe(1) // counter byte 0

    const n256 = nonceFromCounter(256, DIRECTION_SERVER)
    expect(n256[0]).toBe(0)
    expect(n256[1]).toBe(0)
    expect(n256[2]).toBe(1)
  })

  it('handles large messages', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const msg = { type: 'response', content: 'x'.repeat(100_000) }
    const envelope = encrypt(JSON.stringify(msg), serverShared, 0, DIRECTION_SERVER)
    expect(decrypt(envelope, clientShared, 0, DIRECTION_SERVER)).toEqual(msg)
  })
})
