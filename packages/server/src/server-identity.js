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
import { readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createSigningKeyPair, signIdentityRotation } from '@chroxy/store-core/crypto'
import nacl from 'tweetnacl'
import * as realKeychain from './keychain.js'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('identity')

/** Keychain service for the identity secret key. Distinct from 'chroxy' (API
 *  token) and 'chroxy-cred-key' (credential data key) so the three never
 *  collide. */
export const IDENTITY_KEY_SERVICE = 'chroxy-identity-key'

/**
 * Thrown when the keychain is PRESENT but the identity read FAILED (locked /
 * interaction-not-allowed / backend error) — i.e. case (b) of #5615. This is the
 * one case where we must NOT mint a fresh key (silent rotation → false MITM for
 * every pinned client) and must NOT silently fall back to TOFU. The caller
 * (server-cli) treats this distinctly: it signs nothing this boot and surfaces
 * an "identity unavailable" state rather than rotating or impersonating.
 *
 * Distinct from a generic error so server startup can tell "keychain hiccup, do
 * not rotate" apart from "no keychain at all / first run" (mint is correct) and
 * from a malformed stored key (re-mint-as-absent — case (c), kept as before).
 */
export class IdentityUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'IdentityUnavailableError'
    this.code = 'IDENTITY_UNAVAILABLE'
  }
}

/** Default on-disk fallback location. Overridable for tests. */
export const DEFAULT_IDENTITY_FILE = join(homedir(), '.chroxy', 'server-identity.json')

/**
 * #5616/#5976 — the identity-rotation continuity-cert sidecar. PUBLIC data only
 * (a signature + two public keys), so it is a plaintext file regardless of where
 * the SECRET key lives (keychain or fallback file) — there is nothing secret to
 * protect here. Single-hop by design: each rotation OVERWRITES it, retaining
 * only the most-recent `prev → current` cert. A client pinned ≥2 rotations back
 * has no chain to follow and correctly falls back to manual re-pair.
 */
export const DEFAULT_IDENTITY_ROTATION_FILE = join(homedir(), '.chroxy', 'server-identity-rotation.json')

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
  // Keychain first (when available). #5615: distinguish a genuine "absent" from a
  // READ FAILURE (locked / interaction-not-allowed). On a read failure we MUST
  // NOT fall through to the file / minting path — that would silently rotate the
  // identity and brick every pinned client with a false MITM alert. Throw a
  // distinct error so the caller fails safe.
  if (keychain.isKeychainAvailable()) {
    const { status, value, error } = readIdentityFromKeychain(keychain)
    if (status === 'error') {
      throw new IdentityUnavailableError(
        `server identity keychain read failed (${error ?? 'unknown'}); refusing to mint a replacement`,
      )
    }
    if (status === 'found') {
      const kp = secretKeyFromStored(value)
      // A malformed stored value (case (c)) is treated as absent — fall through
      // to the file / mint path, re-minting as before. This is deliberately
      // distinct from the read-failure case above (which throws).
      if (kp) return kp
    }
    // status === 'absent' (or malformed found) → continue to the file fallback.
  }
  // Fallback file. Checked even when the keychain is unavailable (disabled OR
  // broken): a valid file identity is authoritative and using it does NOT rotate.
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const kp = secretKeyFromStored(parsed?.secretKey)
    if (kp) return kp
  } catch {
    // Missing / unreadable / malformed — treated as "no identity yet".
  }
  // #5615 (#6234 follow-up): no file identity, and the keychain is present but
  // BROKEN/unreadable (not merely disabled). We cannot confirm there is no
  // pinned identity sitting in the now-unreadable keychain, so minting a fresh
  // one would false-MITM every already-pinned client. Fail safe — refuse to
  // mint — exactly as the pre-#6234 keychain-read-error path did, but WITHOUT
  // the macOS modal (the broken state is detected by the non-prompting probe).
  // Disabled keychains (tests / CHROXY_DISABLE_KEYCHAIN) are NOT broken: they
  // legitimately fall through to mint a first-run identity.
  if (typeof keychain.isKeychainBroken === 'function' && keychain.isKeychainBroken()) {
    throw new IdentityUnavailableError(
      'server identity keychain is unavailable (broken/missing) and no fallback identity file exists; refusing to mint a replacement that would invalidate pinned clients',
    )
  }
  return null
}

/**
 * Read the identity secret from the keychain, distinguishing absent from a read
 * failure. Prefers the injected keychain's `getTokenStatus` (the real module +
 * fakes that opt in); falls back to `getToken` (legacy fakes) where a null read
 * is treated as `absent` — those fakes cannot model a lock, which is fine since
 * they never exercise the failure path.
 *
 * @param {object} keychain
 * @returns {{ status: 'found'|'absent'|'error', value: string|null, error: string|null }}
 */
function readIdentityFromKeychain(keychain) {
  if (typeof keychain.getTokenStatus === 'function') {
    return keychain.getTokenStatus(IDENTITY_KEY_SERVICE)
  }
  const value = keychain.getToken(IDENTITY_KEY_SERVICE)
  return value
    ? { status: 'found', value, error: null }
    : { status: 'absent', value: null, error: null }
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
 * @param {boolean} [opts.durable] - #6927: fsync the fallback-file write before
 *   returning (temp before rename + dir after). Set ONLY by `rotateServerIdentity`
 *   (the compromise-response path); first-run mint leaves it off (fail-safe — a
 *   lost mint just re-mints). Applies only to the FILE fallback; the keychain
 *   path's durability is the OS keychain's responsibility, not ours.
 * @param {Function} [opts._write] - test seam for the atomic writer.
 * @returns {'keychain'|'file'}
 */
export function persistServerIdentity(keyPair, {
  keychain = realKeychain,
  filePath = DEFAULT_IDENTITY_FILE,
  durable = false,
  _write = writeFileRestricted,
} = {}) {
  const secretB64 = Buffer.from(keyPair.secretKey).toString('base64')
  if (keychain.isKeychainAvailable()) {
    try {
      keychain.setToken(secretB64, IDENTITY_KEY_SERVICE)
      return 'keychain'
    } catch (err) {
      log.warn(`Keychain write for server identity failed (${err.message}); falling back to 0600 file`)
    }
  }
  // 0600 file fallback. Use the repo's atomic, perm-enforcing writer
  // (temp + chmod 0600 + rename) rather than a bare writeFileSync: this file
  // holds the daemon's long-lived identity SECRET, so it must not be left
  // partially written on a crash, and `writeFileSync`'s `mode` is honoured only
  // on CREATION — a pre-existing file at a looser mode would keep that mode.
  // writeFileRestricted chmods the final file to 0600 unconditionally.
  mkdirSync(dirname(filePath), { recursive: true })
  _write(filePath, JSON.stringify({ v: 1, secretKey: secretB64 }), { durable })
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
 * #5615 — three distinct keychain cases:
 *   (a) keychain absent / no identity stored → FIRST RUN, mint (correct).
 *   (b) keychain present but the read FAILED (locked / interaction-not-allowed)
 *       → `loadServerIdentity` throws {@link IdentityUnavailableError}, which
 *       propagates UNCAUGHT here. We do NOT mint a replacement (silent rotation
 *       would brick every pinned client with a false MITM alert). The caller
 *       decides whether to refuse startup or run with pinning disabled THIS BOOT.
 *   (c) keychain present but the stored value is MALFORMED → treated as absent
 *       (re-mint), the long-standing behaviour, kept distinct from (b).
 *
 * @param {object} [opts]
 * @param {object} [opts.keychain]
 * @param {string} [opts.filePath]
 * @returns {{ publicKey: string, secretKey: Uint8Array, created: boolean, backend: 'keychain'|'file' }}
 * @throws {IdentityUnavailableError} when the keychain read failed (case b)
 */
export function getOrCreateServerIdentity({ keychain = realKeychain, filePath = DEFAULT_IDENTITY_FILE } = {}) {
  // NB: a keychain read failure throws IdentityUnavailableError here — let it
  // propagate. Catching it would re-enable the silent-rotation bug (#5615).
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

/**
 * Load the single-hop rotation continuity cert sidecar, or null when absent /
 * malformed. Returns the public triple a rotated daemon presents at handshake:
 * `{ newIdentityKey, rotationCert, previousPublicKey }`.
 *
 * The caller MUST guard against a STALE sidecar: after a clean reinstall the
 * identity is re-minted but an old sidecar may linger, so only present the cert
 * when `newIdentityKey` equals the daemon's CURRENT identity public key (a stale
 * sidecar names a `newIdentityKey` the daemon no longer holds). {@link
 * resolveServerRotationCert} does that check.
 *
 * @param {object} [opts]
 * @param {string} [opts.rotationFilePath]
 * @returns {{ newIdentityKey: string, rotationCert: string, previousPublicKey: string }|null}
 */
export function loadServerRotationCert({ rotationFilePath = DEFAULT_IDENTITY_ROTATION_FILE } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(rotationFilePath, 'utf-8'))
    const { newIdentityKey, rotationCert, previousPublicKey } = parsed ?? {}
    if (
      typeof newIdentityKey === 'string' && newIdentityKey &&
      typeof rotationCert === 'string' && rotationCert &&
      typeof previousPublicKey === 'string' && previousPublicKey
    ) {
      return { newIdentityKey, rotationCert, previousPublicKey }
    }
  } catch {
    // Missing / unreadable / malformed → no cert to present.
  }
  return null
}

/**
 * Resolve the rotation cert to present for a given CURRENT identity public key,
 * applying the staleness guard: a sidecar whose `newIdentityKey` does not match
 * the live identity (e.g. left over from before a clean re-mint) is ignored.
 *
 * @param {string} currentIdentityPublicKey - the daemon's live identity pubkey
 * @param {object} [opts]
 * @param {string} [opts.rotationFilePath]
 * @returns {{ rotationCert: string, previousPublicKey: string }|null}
 */
export function resolveServerRotationCert(currentIdentityPublicKey, { rotationFilePath = DEFAULT_IDENTITY_ROTATION_FILE } = {}) {
  const sidecar = loadServerRotationCert({ rotationFilePath })
  if (!sidecar) return null
  if (sidecar.newIdentityKey !== currentIdentityPublicKey) {
    // Stale sidecar (identity re-minted since rotation) — do NOT present it; a
    // cert for an identity the daemon no longer holds would never verify and
    // could only confuse a pinned client.
    log.warn('Ignoring stale identity-rotation cert (newIdentityKey ≠ current identity)')
    return null
  }
  return { rotationCert: sidecar.rotationCert, previousPublicKey: sidecar.previousPublicKey }
}

/**
 * Rotate the daemon's identity (#5616/#5976, admin-initiated via
 * `chroxy identity rotate`): mint a NEW identity, sign it with the OLD secret to
 * mint a continuity cert ("old signs new"), persist the new secret in place of
 * the old, and write the single-hop sidecar. A previously-pinned client that
 * reconnects then chains its pin forward automatically (no manual re-pair) by
 * verifying the cert against its pinned (old) key + the new key's live exchange
 * signature.
 *
 * The OLD secret is read FIRST (while it still exists) — this is the only moment
 * a cert can be minted. After this returns, the persisted identity is the NEW
 * one; a running daemon keeps its in-memory OLD identity until restarted, so the
 * caller must restart the daemon to serve the new identity.
 *
 * Throws when there is no current identity to rotate FROM (nothing pinned yet —
 * just start the daemon, which mints a first identity), or when the keychain
 * read failed ({@link IdentityUnavailableError} propagates).
 *
 * @param {object} [opts]
 * @param {object} [opts.keychain]
 * @param {string} [opts.filePath] - secret-key store path (fallback file)
 * @param {string} [opts.rotationFilePath] - cert sidecar path
 * @returns {{ previousPublicKey: string, newPublicKey: string, backend: 'keychain'|'file' }}
 */
export function rotateServerIdentity({
  keychain = realKeychain,
  filePath = DEFAULT_IDENTITY_FILE,
  rotationFilePath = DEFAULT_IDENTITY_ROTATION_FILE,
  _write = writeFileRestricted,
} = {}) {
  const current = loadServerIdentity({ keychain, filePath })
  if (!current) {
    throw new Error(
      'No existing server identity to rotate. Start the daemon once to mint an ' +
      'identity (which clients then pair + pin) before rotating.',
    )
  }
  const next = createSigningKeyPair()
  // Mint the continuity cert WHILE the old secret is still loaded — old signs new.
  const rotationCert = signIdentityRotation(next.publicKey, current.secretKey)

  // ORDER MATTERS (fail-safety): write the sidecar BEFORE swapping the secret.
  //   - sidecar write fails → we throw here, the secret is STILL the old one →
  //     the identity did not rotate at all (old pins keep verifying). Safe.
  //   - sidecar ok but persist fails → we throw below, the secret is STILL old →
  //     the daemon serves the OLD identity and the just-written sidecar names a
  //     newIdentityKey ≠ the live identity, so resolveServerRotationCert IGNORES
  //     it as stale. Safe.
  // The dangerous order (persist secret first) could leave a ROTATED identity
  // with no cert — forcing every pinned client to manually re-pair, the exact
  // failure this feature exists to prevent.
  //
  // Single-hop: this overwrites any prior cert — only the most recent
  // prev→current hop is retained. Public data (a signature + two public keys);
  // reuse writeFileRestricted for its ATOMIC temp+rename write so a crash can't
  // leave a half-written cert — the 0600 mode it also sets is incidental here
  // (nothing secret), not a requirement.
  //
  // #6927 — the sidecar is left NON-durable on purpose: its rollback is a
  // CONTINUITY concern, not a security one. If a power loss drops the sidecar
  // (while the durable secret persist below survives), the daemon serves the NEW
  // identity and pinned clients fall back to a manual re-pair — an availability
  // regression, never a resurrection of the retired key. Only the secret persist
  // (whose rollback WOULD resurrect the retired/compromised key) is made durable.
  mkdirSync(dirname(rotationFilePath), { recursive: true })
  _write(
    rotationFilePath,
    JSON.stringify({
      v: 1,
      newIdentityKey: next.publicKey,
      rotationCert,
      previousPublicKey: current.publicKey,
    }),
  )
  // Persist the new secret in place of the old (keychain or fallback file).
  // #6927 — DURABLE: `chroxy identity rotate` is the compromise-response path, so
  // a power-loss rollback resurrecting the RETIRED secret is the same acute class
  // as a token revoke. fsync the fallback-file write before reporting success
  // (the keychain path's durability is the OS's job). First-run mint stays
  // non-durable (fail-safe — a lost mint just re-mints).
  const backend = persistServerIdentity(next, { keychain, filePath, durable: true, _write })
  log.info(`Rotated server identity (backend: ${backend}); continuity cert written for previous pin`)
  return { previousPublicKey: current.publicKey, newPublicKey: next.publicKey, backend }
}
