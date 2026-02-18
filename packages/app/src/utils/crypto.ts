import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'

const NONCE_LENGTH = 24

export interface KeyPair {
  publicKey: string       // base64-encoded
  secretKey: Uint8Array
}

export interface EncryptedEnvelope {
  type: 'encrypted'
  d: string   // base64-encoded ciphertext
  n: number   // nonce counter
}

export interface EncryptionState {
  sharedKey: Uint8Array
  sendNonce: number
  recvNonce: number
}

/**
 * Generate an ephemeral X25519 keypair for key exchange.
 */
export function createKeyPair(): KeyPair {
  const kp = nacl.box.keyPair()
  return { publicKey: encodeBase64(kp.publicKey), secretKey: kp.secretKey }
}

/**
 * Derive a shared symmetric key from the other side's public key and our secret key.
 */
export function deriveSharedKey(theirPubBase64: string, mySecretKey: Uint8Array): Uint8Array {
  const theirPub = decodeBase64(theirPubBase64)
  return nacl.box.before(theirPub, mySecretKey)
}

/**
 * Build a 24-byte nonce from an integer counter.
 */
export function nonceFromCounter(n: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_LENGTH)
  let val = n
  for (let i = 0; i < 8; i++) {
    nonce[i] = val & 0xff
    val = Math.floor(val / 256)
  }
  return nonce
}

/**
 * Encrypt a JSON string using XSalsa20-Poly1305.
 */
export function encrypt(jsonString: string, sharedKey: Uint8Array, nonceCounter: number): EncryptedEnvelope {
  const nonce = nonceFromCounter(nonceCounter)
  const messageBytes = new TextEncoder().encode(jsonString)
  const ciphertext = nacl.secretbox(messageBytes, nonce, sharedKey)
  return {
    type: 'encrypted',
    d: encodeBase64(ciphertext),
    n: nonceCounter,
  }
}

/**
 * Decrypt an encrypted envelope and return the parsed JSON object.
 */
export function decrypt(envelope: EncryptedEnvelope, sharedKey: Uint8Array, expectedNonce: number): Record<string, unknown> {
  if (envelope.n !== expectedNonce) {
    throw new Error(`Unexpected nonce: got ${envelope.n}, expected ${expectedNonce}`)
  }
  const nonce = nonceFromCounter(envelope.n)
  const ciphertext = decodeBase64(envelope.d)
  const plaintext = nacl.secretbox.open(ciphertext, nonce, sharedKey)
  if (!plaintext) {
    throw new Error('Decryption failed: message tampered or wrong key')
  }
  return JSON.parse(new TextDecoder().decode(plaintext))
}
