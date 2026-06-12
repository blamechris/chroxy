/**
 * At-rest encryption for the AsyncStorage persistence cache (#5644).
 *
 * Message bodies and the terminal buffer can echo secrets (model output,
 * pasted tokens, file contents). AsyncStorage writes them to the device
 * filesystem in cleartext, where an OS backup or filesystem extraction can
 * read them back. This module wraps those blobs in an authenticated-encryption
 * envelope keyed by a random 32-byte key held in the OS keychain
 * (expo-secure-store), so the on-disk representation is opaque.
 *
 * Primitive: XSalsa20-Poly1305 (`nacl.secretbox`) with a fresh random 24-byte
 * nonce per write, prepended to the ciphertext — the same AEAD construction the
 * transport layer uses, but self-contained (nonce travels with the blob) since
 * there is no counter/replay context for at-rest data. We reuse the existing
 * tweetnacl primitive rather than hand-rolling crypto.
 *
 * Importing `../utils/crypto` (transitively) calls `initPRNG()` so tweetnacl's
 * `randomBytes` / `secretbox` work under the React Native JSC runtime.
 */
import * as SecureStore from 'expo-secure-store'
import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'
// Side-effect import: wires expo-crypto's PRNG into tweetnacl (initPRNG).
import '../utils/crypto'

/**
 * SecureStore key for the persistence-cache key. Deliberately distinct from the
 * bearer-token / device-id / input-settings keys so it can be rotated or wiped
 * independently and never collides with identity material.
 */
const SECURE_STORE_KEY = 'chroxy_persist_cache_key'

/**
 * Envelope version prefix. Lets future format changes (different cipher, key
 * derivation, etc.) be detected and migrated. `v1:` → base64(nonce ‖ ciphertext).
 */
const ENVELOPE_PREFIX = 'v1:'

const KEY_BYTES = nacl.secretbox.keyLength // 32
const NONCE_BYTES = nacl.secretbox.nonceLength // 24

/**
 * In-memory cache of the loaded/generated key so we hit the keychain at most
 * once per app run. The promise is memoised to coalesce concurrent first reads.
 */
let _keyPromise: Promise<Uint8Array | null> | null = null

/**
 * Load the persistence key from SecureStore, generating and storing a fresh
 * random key on first use. Returns `null` if SecureStore is unavailable AND we
 * cannot persist a new key — callers must treat a null key as "encryption
 * disabled" and fall back to a safe (non-crashing) path.
 */
async function loadOrCreateKey(): Promise<Uint8Array | null> {
  // Try to read an existing key.
  let stored: string | null = null
  try {
    stored = await SecureStore.getItemAsync(SECURE_STORE_KEY)
  } catch {
    // SecureStore read failed (keychain unavailable). Fall through to attempt a
    // create; if that also fails we return null.
    stored = null
  }

  if (stored) {
    try {
      const bytes = new Uint8Array(decodeBase64(stored))
      if (bytes.length === KEY_BYTES) return bytes
      // Wrong-length stored key (corrupt) — regenerate below.
    } catch {
      // Corrupt base64 — regenerate below.
    }
  }

  // Generate a fresh key and persist it.
  const fresh = nacl.randomBytes(KEY_BYTES)
  try {
    await SecureStore.setItemAsync(SECURE_STORE_KEY, encodeBase64(fresh))
    return fresh
  } catch {
    // Could not persist the key. Returning null disables encryption so the app
    // still launches and functions (cache becomes effectively non-persistent /
    // best-effort) rather than crashing. We do NOT return the un-persisted key,
    // because a key we cannot reload is useless for the next launch's reads.
    return null
  }
}

/** Get the (memoised) persistence key, or null if encryption is unavailable. */
function getKey(): Promise<Uint8Array | null> {
  if (!_keyPromise) {
    _keyPromise = loadOrCreateKey()
  }
  return _keyPromise
}

/**
 * Encrypt a plaintext string for at-rest storage. Returns a `v1:`-prefixed
 * base64 envelope. If the persistence key is unavailable, returns the plaintext
 * UNCHANGED is NOT acceptable (defeats the purpose); instead we throw so the
 * caller's existing try/catch treats the write as a (silent) failure. In
 * practice the key is virtually always available — SecureStore is required for
 * the bearer token already.
 */
export async function encryptForStorage(plaintext: string): Promise<string> {
  const key = await getKey()
  if (!key) {
    // No key → cannot encrypt. Signal failure; the debounced/try-wrapped caller
    // logs and skips the write rather than persisting cleartext.
    throw new Error('persist-crypto: encryption key unavailable')
  }
  const nonce = nacl.randomBytes(NONCE_BYTES)
  const messageBytes = new Uint8Array(new TextEncoder().encode(plaintext))
  const ciphertext = nacl.secretbox(messageBytes, nonce, key)
  // Pack nonce ‖ ciphertext so decryption is self-contained.
  const packed = new Uint8Array(nonce.length + ciphertext.length)
  packed.set(nonce, 0)
  packed.set(ciphertext, nonce.length)
  return ENVELOPE_PREFIX + encodeBase64(packed)
}

/**
 * Decrypt a value read from at-rest storage.
 *
 * Returns the plaintext on success, or `null` when the value cannot be
 * decrypted — this is the graceful-migration contract:
 *
 *  - Legacy CLEARTEXT (written before this change): missing the `v1:` prefix →
 *    return null (treated as empty/absent so the cache re-populates from the
 *    live stream). We deliberately do NOT return the raw cleartext, so old
 *    plaintext is dropped rather than indefinitely re-served.
 *  - Missing / rotated key, corrupt or tampered envelope, MAC failure: return
 *    null. Never throws — the app must still launch cleanly.
 */
export async function decryptForStorage(stored: string | null | undefined): Promise<string | null> {
  if (typeof stored !== 'string' || stored.length === 0) return null
  // Legacy plaintext (or any non-v1 value): not decryptable → treat as absent.
  if (!stored.startsWith(ENVELOPE_PREFIX)) return null

  const key = await getKey()
  if (!key) return null

  try {
    const packed = new Uint8Array(decodeBase64(stored.slice(ENVELOPE_PREFIX.length)))
    if (packed.length <= NONCE_BYTES) return null
    const nonce = packed.slice(0, NONCE_BYTES)
    const ciphertext = packed.slice(NONCE_BYTES)
    const plaintext = nacl.secretbox.open(ciphertext, nonce, key)
    if (!plaintext) return null // MAC failure / wrong (rotated) key
    return new TextDecoder().decode(plaintext)
  } catch {
    // Malformed base64 / unexpected shape — treat as absent.
    return null
  }
}

/**
 * Reset the in-memory key cache. Test-only: lets a test exercise a cold
 * SecureStore read after seeding/clearing the mock keychain.
 */
export function _resetKeyCacheForTesting(): void {
  _keyPromise = null
}

/** Exposed for tests that need to assert on the SecureStore key name. */
export const PERSIST_CACHE_SECURE_STORE_KEY = SECURE_STORE_KEY
