import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'

const NONCE_LENGTH = 24
const MAX_NONCE_COUNTER = 2 ** 48
const CONNECTION_SALT_BYTES = 32

/** Direction byte for nonce construction — prevents nonce reuse across send directions */
export const DIRECTION_SERVER = 0x00
export const DIRECTION_CLIENT = 0x01

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
 * Wire up a platform-specific random bytes generator.
 * Must be called once at startup on platforms where TweetNaCl's
 * auto-detection fails (e.g. React Native / JSC).
 *
 * @param getRandomBytes - function returning n random bytes (e.g. expo-crypto's getRandomBytes)
 */
export function initPRNG(getRandomBytes: (n: number) => Uint8Array): void {
  nacl.setPRNG((x: Uint8Array, n: number) => {
    const bytes = getRandomBytes(n)
    // Guard against a short-read from the platform PRNG: tweetnacl consumers
    // assume the full `n` bytes were filled. If the underlying generator
    // returned fewer (or more) bytes, fail loudly rather than silently leaving
    // uninitialised memory in the nonce / key buffer.
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`initPRNG: getRandomBytes must return a Uint8Array, got ${typeof bytes}`)
    }
    if (bytes.length !== n) {
      throw new Error(`initPRNG: getRandomBytes returned ${bytes.length} bytes, expected ${n}`)
    }
    x.set(bytes)
  })
}

/**
 * Generate an ephemeral X25519 keypair for key exchange.
 */
export function createKeyPair(): KeyPair {
  const kp = nacl.box.keyPair()
  return { publicKey: encodeBase64(kp.publicKey), secretKey: kp.secretKey }
}

// -- Server identity signing (#5536) --
//
// The transport key exchange (X25519 box, above) is per-connection and
// ephemeral — it gives forward secrecy but NO server identity, so a MITM who
// can swap the server's ephemeral public key in flight relays the whole
// session (pure TOFU). To pin server identity we add a LONG-LIVED Ed25519
// signing key. Its public half is conveyed out-of-band at pairing time (in the
// QR / pairing-code, which already runs over a trusted channel) and pinned by
// the client. On every handshake the server SIGNS its ephemeral exchange public
// key with the identity key; the client verifies that signature against the
// pinned identity key before trusting the exchange key. A MITM cannot forge the
// signature without the identity secret, so swapping the ephemeral key is
// detected and the connection is refused.
//
// Ed25519 (`nacl.sign`) is part of the tweetnacl dependency already used for
// the box/secretbox primitives — no new crypto dependency is introduced.

export interface SigningKeyPair {
  publicKey: string // base64-encoded 32-byte Ed25519 public key
  secretKey: Uint8Array // 64-byte Ed25519 secret key
}

/**
 * Generate a long-lived Ed25519 identity (signing) keypair. The server
 * persists this across restarts (keychain / state dir); the public half is the
 * value pinned by clients at pairing time.
 */
export function createSigningKeyPair(): SigningKeyPair {
  const kp = nacl.sign.keyPair()
  return { publicKey: encodeBase64(kp.publicKey), secretKey: kp.secretKey }
}

/**
 * Sign an ephemeral exchange public key (base64) with the identity secret key.
 * Returns the detached signature as base64. The signed message is the RAW bytes
 * of the exchange public key (decoded from base64), so both sides sign/verify
 * over identical bytes regardless of base64 canonicalisation.
 *
 * @param exchangePublicKeyBase64 - the per-connection X25519 public key to bind
 * @param identitySecretKey - the 64-byte Ed25519 secret key
 * @returns base64-encoded 64-byte detached signature
 */
export function signExchangeKey(exchangePublicKeyBase64: string, identitySecretKey: Uint8Array): string {
  if (typeof exchangePublicKeyBase64 !== 'string' || exchangePublicKeyBase64.trim().length === 0) {
    throw new Error('signExchangeKey: exchange public key must be a non-empty base64 string')
  }
  if (!(identitySecretKey instanceof Uint8Array) || identitySecretKey.length !== nacl.sign.secretKeyLength) {
    throw new Error(`signExchangeKey: identity secret key must be a ${nacl.sign.secretKeyLength}-byte Uint8Array`)
  }
  const message = new Uint8Array(decodeBase64(exchangePublicKeyBase64))
  const sig = nacl.sign.detached(message, identitySecretKey)
  return encodeBase64(sig)
}

/**
 * Verify that `signatureBase64` is a valid Ed25519 signature over
 * `exchangePublicKeyBase64`, produced by the holder of the secret key matching
 * `identityPublicKeyBase64` (the pinned identity key). Returns true on a valid
 * signature, false on any mismatch / malformed input. NEVER throws — a bad or
 * absent signature is a verification FAILURE the caller must treat as a refusal,
 * not an exception to swallow.
 *
 * @param exchangePublicKeyBase64 - the per-connection X25519 public key offered
 * @param signatureBase64 - the detached signature offered by the server
 * @param identityPublicKeyBase64 - the PINNED identity public key to verify against
 */
export function verifyExchangeKeySignature(
  exchangePublicKeyBase64: string,
  signatureBase64: string,
  identityPublicKeyBase64: string,
): boolean {
  try {
    if (typeof exchangePublicKeyBase64 !== 'string' || exchangePublicKeyBase64.length === 0) return false
    if (typeof signatureBase64 !== 'string' || signatureBase64.length === 0) return false
    if (typeof identityPublicKeyBase64 !== 'string' || identityPublicKeyBase64.length === 0) return false
    const message = new Uint8Array(decodeBase64(exchangePublicKeyBase64))
    const sig = new Uint8Array(decodeBase64(signatureBase64))
    const identityPub = new Uint8Array(decodeBase64(identityPublicKeyBase64))
    // This function only ever verifies an X25519 EXCHANGE public key, so reject
    // anything that isn't 32 bytes up front — a wrong-length key is malformed
    // input, not a genuine signature mismatch. deriveSharedKey enforces the same
    // length downstream, but checking here keeps the signature API honest.
    if (message.length !== nacl.box.publicKeyLength) return false
    if (sig.length !== nacl.sign.signatureLength) return false
    if (identityPub.length !== nacl.sign.publicKeyLength) return false
    return nacl.sign.detached.verify(message, sig, identityPub)
  } catch {
    return false
  }
}

/**
 * Derive a shared symmetric key from the other side's public key and our secret key.
 */
export function deriveSharedKey(theirPubBase64: string, mySecretKey: Uint8Array): Uint8Array {
  if (typeof theirPubBase64 !== 'string' || theirPubBase64.trim().length === 0) {
    throw new Error('Invalid peer public key: expected a non-empty base64 string')
  }
  let theirPub: Uint8Array
  try {
    theirPub = decodeBase64(theirPubBase64)
  } catch {
    throw new Error('Invalid peer public key: not valid base64')
  }
  if (theirPub.length !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid peer public key: expected length ${nacl.box.publicKeyLength}, got ${theirPub.length}`)
  }
  // Wrap in Uint8Array to ensure compatibility across environments (Node.js Buffer, jsdom, etc.)
  return new Uint8Array(nacl.box.before(theirPub, mySecretKey))
}

/**
 * Build a 24-byte nonce from a direction byte and integer counter.
 * Byte 0 is direction (0=server, 1=client), bytes 1-8 are counter (little-endian).
 */
export function nonceFromCounter(n: number, direction: number): Uint8Array {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new RangeError('Nonce counter must be a non-negative integer')
  }
  if (n > MAX_NONCE_COUNTER) {
    throw new Error('Nonce counter exhausted — reconnect required for new key exchange')
  }
  const nonce = new Uint8Array(NONCE_LENGTH)
  nonce[0] = direction
  let val = n
  for (let i = 1; i <= 8; i++) {
    nonce[i] = val & 0xff
    val = Math.floor(val / 256)
  }
  return nonce
}

/**
 * Encrypt a JSON string using XSalsa20-Poly1305.
 */
export function encrypt(jsonString: string, sharedKey: Uint8Array, nonceCounter: number, direction: number): EncryptedEnvelope {
  const nonce = nonceFromCounter(nonceCounter, direction)
  // Ensure pure Uint8Array (not Buffer or jsdom subclass) for tweetnacl compatibility
  const messageBytes = new Uint8Array(new TextEncoder().encode(jsonString))
  const ciphertext = nacl.secretbox(new Uint8Array(messageBytes), new Uint8Array(nonce), new Uint8Array(sharedKey))
  return {
    type: 'encrypted',
    d: encodeBase64(ciphertext),
    n: nonceCounter,
  }
}

/**
 * Decrypt an encrypted envelope and return the parsed JSON object.
 *
 * **Replay protection contract:**
 * This function enforces strict equality between `envelope.n` and `expectedNonce`,
 * which prevents replay attacks when the caller advances `expectedNonce` by one after
 * each successful decryption. The replay protection guarantee holds only if:
 *
 * 1. The caller increments `expectedNonce` (e.g. `recvNonce++`) immediately after
 *    each successful `decrypt()` call.
 * 2. `expectedNonce` is never reset to a value ≤ a previously accepted counter
 *    without also rotating the shared key (i.e. performing a new key exchange).
 *
 * Violating rule 1 allows a captured frame to be replayed. Violating rule 2 opens
 * a counter-reset attack after a reconnect.
 *
 * @param envelope      - The received encrypted frame.
 * @param sharedKey     - Symmetric key derived from the X25519 key exchange.
 * @param expectedNonce - The next counter value the receiver expects. Must be
 *                        exactly `envelope.n`; any deviation throws an Error whose
 *                        message starts with `'Unexpected nonce: got <n>, expected <e>'`.
 * @param direction     - Directional byte (DIRECTION_SERVER or DIRECTION_CLIENT)
 *                        used to namespace the nonce and prevent cross-direction replays.
 * @throws {Error} `'Unexpected nonce: got <n>, expected <e>'` when `envelope.n !== expectedNonce`
 * @throws {Error} `'Decryption failed: message tampered or wrong key'` when MAC verification fails
 * @throws {Error} `'Decryption failed: plaintext is not valid JSON'` when the verified plaintext does not parse as JSON
 * @throws {TypeError} `'decrypt: envelope.d must be a base64 string'` / `'decrypt: envelope.n must be a number'`
 */
export function decrypt(envelope: EncryptedEnvelope, sharedKey: Uint8Array, expectedNonce: number, direction: number): Record<string, unknown> {
  if (typeof envelope.d !== 'string') {
    throw new TypeError('decrypt: envelope.d must be a base64 string')
  }
  if (typeof envelope.n !== 'number') {
    throw new TypeError('decrypt: envelope.n must be a number')
  }
  if (envelope.n !== expectedNonce) {
    throw new Error(`Unexpected nonce: got ${envelope.n}, expected ${expectedNonce}`)
  }
  const nonce = nonceFromCounter(envelope.n, direction)
  const ciphertext = new Uint8Array(decodeBase64(envelope.d))
  const plaintext = nacl.secretbox.open(ciphertext, new Uint8Array(nonce), new Uint8Array(sharedKey))
  if (!plaintext) {
    throw new Error('Decryption failed: message tampered or wrong key')
  }
  // The MAC verified, so the bytes are authentic — but a peer bug (or a
  // future protocol change) could still hand us non-JSON plaintext. Re-throw
  // on the documented `'Decryption failed: …'`-prefixed contract instead of
  // leaking a raw SyntaxError, so the three call sites' close-the-connection
  // handling stays uniform. (audit P2-12)
  try {
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new Error('Decryption failed: plaintext is not valid JSON')
  }
}

/**
 * Generate a fresh 32-byte random salt for a new connection.
 * The salt must be exchanged during the handshake so both sides can derive
 * the same per-connection sub-key via deriveConnectionKey().
 *
 * @returns base64-encoded 32 random bytes
 */
export function generateConnectionSalt(): string {
  return encodeBase64(nacl.randomBytes(CONNECTION_SALT_BYTES))
}

/**
 * Derive a per-connection sub-key from the long-lived DH shared key and a
 * fresh random salt.  Uses SHA-512(sharedKey ∥ saltBytes) and takes the
 * first 32 bytes as the XSalsa20-Poly1305 key.
 *
 * Because each connection uses a unique salt, the nonce counter can safely
 * start at 0 for every connection without risking nonce reuse under the
 * same key.
 *
 * @param sharedKey  - 32-byte DH shared key from deriveSharedKey()
 * @param saltBase64 - base64-encoded 32-byte salt from generateConnectionSalt()
 * @returns 32-byte derived key (first half of SHA-512 output)
 */
export function deriveConnectionKey(sharedKey: Uint8Array, saltBase64: string): Uint8Array {
  if (!(sharedKey instanceof Uint8Array) || sharedKey.length !== nacl.secretbox.keyLength) {
    throw new Error(`Invalid shared key: expected ${nacl.secretbox.keyLength}-byte Uint8Array, got ${sharedKey instanceof Uint8Array ? sharedKey.length : typeof sharedKey}`)
  }
  if (typeof saltBase64 !== 'string' || saltBase64.trim().length === 0) {
    throw new Error('Invalid connection salt: expected a non-empty base64 string')
  }
  let saltBytes: Uint8Array
  try {
    saltBytes = decodeBase64(saltBase64)
  } catch {
    throw new Error('Invalid connection salt: not valid base64')
  }
  if (saltBytes.length !== CONNECTION_SALT_BYTES) {
    throw new Error(`Invalid connection salt: expected ${CONNECTION_SALT_BYTES} bytes, got ${saltBytes.length}`)
  }
  // Concatenate sharedKey ∥ saltBytes and hash with SHA-512.
  const input = new Uint8Array(sharedKey.length + saltBytes.length)
  input.set(sharedKey, 0)
  input.set(saltBytes, sharedKey.length)
  const hash = nacl.hash(input)
  // Return the first 32 bytes as the sub-key.
  return hash.slice(0, nacl.secretbox.keyLength)
}
