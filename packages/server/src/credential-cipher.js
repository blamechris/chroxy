/**
 * Envelope encryption for the credential store at rest (#5154).
 *
 * `credentials.json` holds the highest-value secrets chroxy persists — BYOK
 * provider API keys and the Claude Code OAuth token. Mode 0600 keeps them
 * owner-only, but a stolen disk image / backup / errant `cat` still exposes
 * them in plaintext. This module encrypts the whole JSON blob with a random
 * 32-byte data key that lives in the OS keychain — NOT next to the file — so a
 * file-read alone is not enough to recover the secrets.
 *
 *   on disk:   { v: 1, alg: 'nacl-secretbox', nonce: <b64>, data: <b64> }
 *   keychain:  service 'chroxy-cred-key', the base64 data key (one entry)
 *
 * Crypto: `nacl.secretbox` (XSalsa20-Poly1305 AEAD) — the same primitive the
 * transport layer already uses, and `tweetnacl` is already a server dependency.
 * The 24-byte nonce is random per write; the Poly1305 tag detects tampering on
 * open (a wrong key or a flipped byte fails closed).
 *
 * Honest threat model: encryption only adds real protection because the key
 * lives in the OS keychain (macOS Keychain / Linux libsecret), which a
 * file-read attacker cannot reach. Where no keychain is available (Windows,
 * headless Linux without `secret-tool`) there is nowhere safe to put the key,
 * so the store falls back to today's 0600 plaintext and the server logs a
 * one-time warning rather than inventing a machine-derived key (which would be
 * obfuscation, not security). See docs/security/credentials-at-rest.md for the
 * full threat model.
 *
 * The keychain is dependency-injected (every export takes an optional
 * `keychain` arg defaulting to the real module) so callers and tests stay
 * deterministic regardless of the host's actual keychain.
 */
import nacl from 'tweetnacl'
import { randomBytes } from 'node:crypto'
import * as realKeychain from './keychain.js'

/** Keychain service for the credential data key. Distinct from the primary
 *  API-token entry (service 'chroxy') so the two never collide. */
export const CRED_KEY_SERVICE = 'chroxy-cred-key'

export const ENVELOPE_VERSION = 1
const ALG = 'nacl-secretbox'
const KEY_BYTES = 32 // nacl.secretbox key length
const NONCE_BYTES = 24 // nacl.secretbox nonce length

/**
 * Is `obj` a well-formed encrypted envelope (vs. a legacy plaintext object)?
 * Used by the store to decide decrypt-vs-passthrough on read.
 */
export function isEncryptedEnvelope(obj) {
  return (
    !!obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    obj.v === ENVELOPE_VERSION &&
    obj.alg === ALG &&
    typeof obj.nonce === 'string' &&
    typeof obj.data === 'string'
  )
}

/**
 * Read the existing data key from the keychain WITHOUT creating one. Returns a
 * 32-byte Uint8Array, or null when no keychain is available or no key is stored
 * (or the stored value is the wrong length — treated as absent).
 */
export function getMasterKey(keychain = realKeychain) {
  if (!keychain.isKeychainAvailable()) return null
  const stored = keychain.getToken(CRED_KEY_SERVICE)
  if (!stored) return null
  const buf = Buffer.from(stored, 'base64')
  return buf.length === KEY_BYTES ? new Uint8Array(buf) : null
}

/**
 * Get the data key from the keychain, generating and persisting a fresh one if
 * none exists. Returns null when no keychain is available (caller must fall
 * back to plaintext). A stored-but-malformed key is replaced (the old encrypted
 * blob, if any, becomes undecryptable — acceptable: the alternative is a hard
 * failure, and a corrupt keychain entry already means the secrets are lost).
 */
export function getOrCreateMasterKey(keychain = realKeychain) {
  if (!keychain.isKeychainAvailable()) return null
  const existing = getMasterKey(keychain)
  if (existing) return existing
  const key = randomBytes(KEY_BYTES)
  keychain.setToken(Buffer.from(key).toString('base64'), CRED_KEY_SERVICE)
  return new Uint8Array(key)
}

/**
 * #5229 — generate a FRESH data key, persist it to the keychain (replacing any
 * existing `chroxy-cred-key` entry), and return it as a 32-byte Uint8Array.
 * Returns null when no keychain is available. Unlike getOrCreateMasterKey this
 * always mints a new key — callers use it to rotate, and are responsible for
 * re-encrypting the store under the returned key (and for rolling back via
 * setMasterKey if that write fails).
 */
export function rotateMasterKey(keychain = realKeychain) {
  if (!keychain.isKeychainAvailable()) return null
  const key = randomBytes(KEY_BYTES)
  keychain.setToken(Buffer.from(key).toString('base64'), CRED_KEY_SERVICE)
  return new Uint8Array(key)
}

/**
 * #5229 — restore a specific data key to the keychain (the rekey rollback seam).
 * Pass a 32-byte Uint8Array to set it, or null to delete the entry entirely
 * (used when the store had no prior key — i.e. was plaintext — before a failed
 * rotation). Throws on a wrong-length key.
 */
export function setMasterKey(key, keychain = realKeychain) {
  if (key == null) {
    keychain.deleteToken(CRED_KEY_SERVICE)
    return
  }
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error('credential cipher: key must be a 32-byte Uint8Array')
  }
  keychain.setToken(Buffer.from(key).toString('base64'), CRED_KEY_SERVICE)
}

/**
 * Encrypt a plain JS object into an envelope using `key` (32-byte Uint8Array).
 * Pure: a fresh random nonce each call. Throws on a bad key length.
 */
export function encryptJson(plainObj, key) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error('credential cipher: key must be a 32-byte Uint8Array')
  }
  const nonce = new Uint8Array(randomBytes(NONCE_BYTES))
  const message = new TextEncoder().encode(JSON.stringify(plainObj))
  const box = nacl.secretbox(message, nonce, key)
  return {
    v: ENVELOPE_VERSION,
    alg: ALG,
    nonce: Buffer.from(nonce).toString('base64'),
    data: Buffer.from(box).toString('base64'),
  }
}

/**
 * Decrypt an envelope back to its plain object using `key`. Throws when the key
 * is wrong or the ciphertext was tampered with (Poly1305 verification fails),
 * or when the envelope/JSON is malformed.
 */
export function decryptEnvelope(envelope, key) {
  if (!isEncryptedEnvelope(envelope)) {
    throw new Error('credential cipher: not a valid encrypted envelope')
  }
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error('credential cipher: key must be a 32-byte Uint8Array')
  }
  const nonce = new Uint8Array(Buffer.from(envelope.nonce, 'base64'))
  const box = new Uint8Array(Buffer.from(envelope.data, 'base64'))
  // Guard the decoded lengths before handing them to tweetnacl: a malformed /
  // truncated envelope can decode to a wrong-size nonce, and nacl.secretbox
  // throws 'bad nonce size' rather than returning null — surface a predictable
  // error instead. A short ciphertext (< the Poly1305 tag) likewise can't be a
  // valid box.
  if (nonce.length !== NONCE_BYTES || box.length <= nacl.secretbox.overheadLength) {
    throw new Error('credential decryption failed (wrong key or corrupt data)')
  }
  // secretbox.open returns null on auth failure, but defensively wrap it so any
  // unexpected throw from a corrupt envelope still becomes the same friendly error.
  let opened
  try {
    opened = nacl.secretbox.open(box, nonce, key)
  } catch {
    opened = null
  }
  if (!opened) {
    throw new Error('credential decryption failed (wrong key or corrupt data)')
  }
  const parsed = JSON.parse(new TextDecoder().decode(opened))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credential cipher: decrypted payload is not a JSON object')
  }
  return parsed
}
