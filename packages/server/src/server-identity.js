/**
 * Long-lived server identity keypair for E2E key pinning (#5536).
 *
 * The transport key exchange (ws-auth.js / ws-history.js) is per-connection and
 * ephemeral — it gives forward secrecy but NO server identity, so it is pure
 * TOFU: a MITM who swaps the server's ephemeral exchange public key in flight
 * relays the whole session undetected. To give the daemon a stable identity we
 * mint a LONG-LIVED Ed25519 signing keypair once, persist it across restarts,
 * and:
 *
 *   1. publish its PUBLIC half out-of-band in the pairing payload (QR /
 *      pairing-code / chroxy:// link — already a trusted channel), where the
 *      client PINS it; and
 *   2. SIGN every per-connection ephemeral exchange public key with the secret
 *      half, so the client can verify (against the pinned identity) that the
 *      exchange key it is about to key off really came from this daemon.
 *
 * A MITM cannot forge the signature without the identity secret, so swapping
 * the exchange key is detected and the client refuses the connection.
 *
 * Persistence mirrors credential-cipher.js's honest model:
 *   - Preferred: the OS keychain (macOS Keychain / Linux libsecret), under a
 *     dedicated service so it never collides with the API token or the
 *     credential data key.
 *   - Fallback: a 0600 file in ~/.chroxy/ when no keychain is available
 *     (Windows / headless Linux). The secret is no more exposed there than the
 *     API token or session state already are on the same disk, and a stable
 *     identity that survives restart is the whole point — a per-restart key
 *     would force a re-pair on every daemon bounce.
 *
 * The keychain module is dependency-injected (tests pass a fake) and the file
 * path is overridable so tests never touch the real ~/.chroxy/ tree.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createSigningKeyPair } from '@chroxy/store-core/crypto'
import nacl from 'tweetnacl'
import * as realKeychain from './keychain.js'
import { createLogger } from './logger.js'

const log = createLogger('identity')

/** Keychain service for the identity secret key. Distinct from 'chroxy' (API
 *  token) and 'chroxy-cred-key' (credential data key) so the three never
 *  collide. */
export const IDENTITY_KEY_SERVICE = 'chroxy-identity-key'

/** Default on-disk fallback location. Overridable for tests. */
export const DEFAULT_IDENTITY_FILE = join(homedir(), '.chroxy', 'server-identity.json')

const SECRET_KEY_BYTES = nacl.sign.secretKeyLength // 64

/**
 * Decode a stored base64 secret key into a SigningKeyPair, or return null when
 * the stored value is absent / malformed (wrong length / bad base64).
 * @param {string|null} storedB64
 * @returns {{ publicKey: string, secretKey: Uint8Array }|null}
 */
function secretKeyFromStored(storedB64) {
  if (!storedB64 || typeof storedB64 !== 'string') return null
  let secretKey
  try {
    secretKey = new Uint8Array(Buffer.from(storedB64.trim(), 'base64'))
  } catch {
    return null
  }
  if (secretKey.length !== SECRET_KEY_BYTES) return null
  // The Ed25519 public key is the trailing 32 bytes of the 64-byte secret key.
  // Buffer base64 is the same standard alphabet tweetnacl-util uses, so the
  // public key string here matches what createSigningKeyPair produced.
  const publicKey = Buffer.from(secretKey.slice(32)).toString('base64')
  return { publicKey, secretKey }
}

/**
 * Load the persisted identity keypair WITHOUT creating one. Checks the keychain
 * first, then the 0600 fallback file. Returns the SigningKeyPair or null when
 * none is stored (or the stored value is malformed — treated as absent).
 *
 * @param {object} [opts]
 * @param {object} [opts.keychain] - injected keychain module (defaults to real)
 * @param {string} [opts.filePath] - fallback file path (defaults to ~/.chroxy/server-identity.json)
 * @returns {{ publicKey: string, secretKey: Uint8Array }|null}
 */
export function loadServerIdentity({ keychain = realKeychain, filePath = DEFAULT_IDENTITY_FILE } = {}) {
  // Keychain first (when available).
  if (keychain.isKeychainAvailable()) {
    const stored = keychain.getToken(IDENTITY_KEY_SERVICE)
    const kp = secretKeyFromStored(stored)
    if (kp) return kp
  }
  // Fallback file.
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const kp = secretKeyFromStored(parsed?.secretKey)
    if (kp) return kp
  } catch {
    // Missing / unreadable / malformed — treated as "no identity yet".
  }
  return null
}

/**
 * Persist a SigningKeyPair's secret half. Writes to the keychain when available,
 * otherwise to a 0600 fallback file (creating the directory if needed). Returns
 * the storage backend used ('keychain' | 'file'), or throws if the file write
 * fails with no keychain available.
 *
 * @param {{ secretKey: Uint8Array }} keyPair
 * @param {object} [opts]
 * @param {object} [opts.keychain]
 * @param {string} [opts.filePath]
 * @returns {'keychain'|'file'}
 */
export function persistServerIdentity(keyPair, { keychain = realKeychain, filePath = DEFAULT_IDENTITY_FILE } = {}) {
  const secretB64 = Buffer.from(keyPair.secretKey).toString('base64')
  if (keychain.isKeychainAvailable()) {
    try {
      keychain.setToken(secretB64, IDENTITY_KEY_SERVICE)
      return 'keychain'
    } catch (err) {
      log.warn(`Keychain write for server identity failed (${err.message}); falling back to 0600 file`)
    }
  }
  // 0600 file fallback.
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify({ v: 1, secretKey: secretB64 }), { mode: 0o600 })
  return 'file'
}

/**
 * Get the daemon's long-lived identity keypair, minting + persisting a fresh one
 * on first run. The public half is what clients pin at pairing time; the secret
 * half signs each connection's ephemeral exchange key.
 *
 * Stable across restarts: a returning daemon loads the SAME key, so previously
 * paired clients keep verifying against the identity they pinned. Re-pairing is
 * only needed if the key is deliberately rotated (deleting the keychain entry /
 * fallback file) — at which point pinned clients correctly refuse until re-paired.
 *
 * @param {object} [opts]
 * @param {object} [opts.keychain]
 * @param {string} [opts.filePath]
 * @returns {{ publicKey: string, secretKey: Uint8Array, created: boolean, backend: 'keychain'|'file' }}
 */
export function getOrCreateServerIdentity({ keychain = realKeychain, filePath = DEFAULT_IDENTITY_FILE } = {}) {
  const existing = loadServerIdentity({ keychain, filePath })
  if (existing) {
    const backend = keychain.isKeychainAvailable() && keychain.getToken(IDENTITY_KEY_SERVICE) ? 'keychain' : 'file'
    return { ...existing, created: false, backend }
  }
  const kp = createSigningKeyPair()
  const backend = persistServerIdentity(kp, { keychain, filePath })
  log.info(`Minted new server identity key (backend: ${backend})`)
  return { ...kp, created: true, backend }
}
