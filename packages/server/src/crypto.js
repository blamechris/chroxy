import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'
const { encodeBase64, decodeBase64 } = naclUtil

const NONCE_LENGTH = 24

/**
 * Generate an ephemeral X25519 keypair for key exchange.
 * @returns {{ publicKey: string, secretKey: Uint8Array }}
 */
export function createKeyPair() {
  const kp = nacl.box.keyPair()
  return { publicKey: encodeBase64(kp.publicKey), secretKey: kp.secretKey }
}

/**
 * Derive a shared symmetric key from the other side's public key and our secret key.
 * Uses nacl.box.before (Curve25519 + HSalsa20).
 * @param {string} theirPubBase64
 * @param {Uint8Array} mySecretKey
 * @returns {Uint8Array} 32-byte shared key
 */
export function deriveSharedKey(theirPubBase64, mySecretKey) {
  const theirPub = decodeBase64(theirPubBase64)
  return nacl.box.before(theirPub, mySecretKey)
}

/**
 * Build a 24-byte nonce from an integer counter.
 * First 8 bytes are the counter (little-endian), rest zero-padded.
 * @param {number} n
 * @returns {Uint8Array}
 */
export function nonceFromCounter(n) {
  const nonce = new Uint8Array(NONCE_LENGTH)
  // Write counter as little-endian uint64 (safe up to Number.MAX_SAFE_INTEGER)
  let val = n
  for (let i = 0; i < 8; i++) {
    nonce[i] = val & 0xff
    val = Math.floor(val / 256)
  }
  return nonce
}

/**
 * Encrypt a JSON string using XSalsa20-Poly1305.
 * @param {string} jsonString - The plaintext JSON to encrypt
 * @param {Uint8Array} sharedKey - 32-byte shared key from deriveSharedKey
 * @param {number} nonceCounter - Auto-incrementing nonce counter
 * @returns {{ type: 'encrypted', d: string, n: number }}
 */
export function encrypt(jsonString, sharedKey, nonceCounter) {
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
 * @param {{ type: 'encrypted', d: string, n: number }} envelope
 * @param {Uint8Array} sharedKey - 32-byte shared key
 * @param {number} expectedNonce - Expected nonce counter (for replay detection)
 * @returns {object} Parsed JSON message
 * @throws {Error} On tamper, wrong nonce, or decryption failure
 */
export function decrypt(envelope, sharedKey, expectedNonce) {
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
