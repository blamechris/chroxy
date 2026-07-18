/**
 * Encrypted-at-rest token store for remote MCP OAuth (#6822).
 *
 * A remote MCP server (BYOK remote transport, #6821) that requires browser-based
 * OAuth (#6822) yields access + refresh tokens the daemon must persist so a
 * previously-authorized server reconnects without re-prompting. Those tokens are
 * CREDENTIALS — this module stores them with the same at-rest protection the
 * credential store uses (#5154 / #6644): a 0600 owner-only JSON file whose whole
 * body is encrypted with a random data key held in the OS keychain (macOS
 * Keychain / Linux libsecret / Windows DPAPI), via credential-cipher.js. Where no
 * keychain is available the store falls back to 0600 plaintext (a key beside the
 * file would be obfuscation, not security) — identical posture to credential-store.
 *
 * File: `~/.chroxy/mcp-oauth-tokens.json`
 * Layout (decrypted): `{ "<serverKey>": <McpOAuthRecord>, ... }` keyed by a
 * normalized form of the server URL (origin + path, no userinfo/query/fragment)
 * so a single server identity survives header/token rotation on the config side.
 *
 * SECURITY: token/secret VALUES never leave this module except through the
 * getters that hand them to the OAuth flow. Nothing here is ever logged — not the
 * record, not the key, not a masked form. The keychain is dependency-injected
 * (mirrors credential-cipher) so tests drive the encrypted path with an in-memory
 * key and NEVER touch the real OS keychain.
 */
import { readFileSync, statSync, writeFileSync, chmodSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import * as realKeychain from './keychain.js'
import { createLogger } from './logger.js'
import {
  isEncryptedEnvelope,
  decryptEnvelope,
  encryptJson,
  getMasterKey,
  getOrCreateMasterKey,
} from './credential-cipher.js'

// One-time breadcrumb when an intact encrypted token record exists on disk but
// its keychain data key is currently unavailable (locked keychain / transient
// probe failure) — matches credential-store's warnKeychainUnavailableOnce so a
// silent unauthenticated MCP reconnect is observable. The value is NEVER logged.
const _log = createLogger('mcp-oauth-store')
let _keychainUnavailableWarned = false
function warnKeychainUnavailableOnce() {
  if (_keychainUnavailableWarned) return
  _keychainUnavailableWarned = true
  _log.warn(
    'an MCP OAuth token is stored (encrypted) but its OS keychain data key is currently unavailable — ' +
    'resolving as absent; the server may re-prompt for authorization. Unlock the OS keychain and retry.',
  )
}

// A keychain stub reporting "no keychain here" — selects the plaintext fallback.
const NO_KEYCHAIN = { isKeychainAvailable: () => false }

// Explicit test injection (an in-memory keychain), or null to use the resolved
// default. Mirrors credential-store's `_setCredentialKeychainForTests` seam.
let _keychainOverride = null

/**
 * Resolve the keychain to use for at-rest encryption, evaluated lazily per call
 * (never captured at import). Precedence:
 *   1. explicit test injection wins;
 *   2. `CHROXY_CRED_DISABLE_KEYCHAIN=1` forces the plaintext fallback (the switch
 *      the test bootstrap sets so suites never touch the real keychain);
 *   3. the real OS keychain.
 */
function activeKeychain() {
  if (_keychainOverride) return _keychainOverride
  if (process.env.CHROXY_CRED_DISABLE_KEYCHAIN === '1') return NO_KEYCHAIN
  return realKeychain
}

/** Test seam: inject a keychain (e.g. an in-memory one), or null to reset. */
export function _setMcpOAuthKeychainForTests(keychain) {
  _keychainOverride = keychain || null
}

// Lazy-resolved per call so tests that mutate process.env.HOME between cases pick
// up the new home (frozen-at-import would break the CHROXY_*_HOME isolation the
// provider-oauth-test-isolation memory prescribes).
function tokensFilePath() {
  return process.env.CHROXY_MCP_OAUTH_TOKENS_PATH || join(homedir(), '.chroxy', 'mcp-oauth-tokens.json')
}

/**
 * Normalize a server URL into the stable per-server storage key: origin + path,
 * lowercased host, no userinfo / query / fragment, no trailing slash. This is the
 * server's OAuth "resource" identity — two configs pointing at the same endpoint
 * with different bearer headers share one token record. Returns null for an
 * unparseable url (caller treats that as "not storable").
 *
 * @param {string} url
 * @returns {string|null}
 */
export function serverKeyForUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s
  } catch {
    return null
  }
}

/**
 * Read + parse the tokens file, enforcing the 0600 mode boundary and decrypting
 * an encrypted envelope. Returns `{ data, fileExists, error }`. On any read error
 * `data` is `{}` and `error` carries a VALUE-FREE reason (never a token). Modeled
 * on credential-store.readStore.
 */
function readStore() {
  const file = tokensFilePath()
  let stat
  try {
    stat = statSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, fileExists: false, error: null }
    return { data: {}, fileExists: false, error: `unable to stat ${file}: ${err.message}` }
  }
  if (process.platform !== 'win32') {
    const perms = stat.mode & 0o777
    if (perms !== 0o600) {
      return {
        data: {},
        fileExists: true,
        error: `${file} has mode ${perms.toString(8).padStart(3, '0')}; refusing to read (must be 0600)`,
      }
    }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { data: {}, fileExists: true, error: `${file} unreadable or not valid JSON: ${err.message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: {}, fileExists: true, error: `${file} is not a JSON object` }
  }
  if (isEncryptedEnvelope(parsed)) {
    const key = getMasterKey(activeKeychain())
    if (!key) {
      return { data: {}, fileExists: true, error: `${file} is encrypted but its keychain data key is unavailable`, keychainUnavailable: true }
    }
    try {
      return { data: decryptEnvelope(parsed, key), fileExists: true, error: null, encrypted: true }
    } catch (err) {
      return { data: {}, fileExists: true, error: `${file} could not be decrypted: ${err.message}`, encrypted: true }
    }
  }
  return { data: parsed, fileExists: true, error: null, encrypted: false }
}

/**
 * Serialize + atomically write the store, encrypting when a keychain-backed data
 * key is available and otherwise writing 0600 plaintext (temp → chmod 0600 →
 * rename). Mirrors credential-store.writeStoreAtomically minus the Windows
 * held-handle retry (not load-bearing for this low-churn store).
 */
function writeStoreAtomically(nextObj) {
  const target = tokensFilePath()
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const key = getOrCreateMasterKey(activeKeychain())
  const payload = key ? encryptJson(nextObj, key) : nextObj
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  let renamed = false
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    renameSync(tmp, target)
    renamed = true
    // Post-rename mode re-check (POSIX), matching credential-store: if the file
    // landed with anything other than 0600, remove it and fail rather than
    // leaving tokens at a more permissive mode.
    if (process.platform !== 'win32') {
      const perms = statSync(target).mode & 0o777
      if (perms !== 0o600) {
        try { unlinkSync(target) } catch { /* best-effort */ }
        throw new Error(`mcp-oauth-tokens ended up with mode ${perms.toString(8)} after write; refused`)
      }
    }
  } finally {
    if (!renamed && existsSync(tmp)) {
      try { unlinkSync(tmp) } catch { /* best-effort */ }
    }
  }
}

/**
 * @typedef {object} McpOAuthRecord
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {string} [tokenType]        - 'Bearer' by default.
 * @property {string} [scope]
 * @property {number} expiresAt          - epoch ms; 0 when the server omitted expires_in.
 * @property {string} clientId
 * @property {string} [clientSecret]     - present only for confidential DCR clients.
 * @property {string} tokenEndpoint
 * @property {string} [authorizationEndpoint]
 * @property {string} [registrationEndpoint]
 * @property {string} [resource]         - canonical resource indicator (RFC 8707).
 */

/**
 * Read the stored OAuth record for a server URL, or null when none exists (or on
 * a read error — the caller falls back to the unauthenticated / re-auth path). A
 * read error is intentionally swallowed to null here: a locked keychain must not
 * wedge the connect, and the flow re-authorizes cleanly.
 *
 * @param {string} url
 * @returns {McpOAuthRecord|null}
 */
export function getStoredToken(url) {
  const serverKey = serverKeyForUrl(url)
  if (!serverKey) return null
  const { data, error, keychainUnavailable } = readStore()
  if (error) {
    // Distinguish the RECOVERABLE keychain-locked case (intact envelope, key
    // temporarily unfetchable) from a corrupt/bad-mode read: only the former
    // gets the one-time breadcrumb, matching credential-store's discipline.
    if (keychainUnavailable) warnKeychainUnavailableOnce()
    return null
  }
  const rec = data[serverKey]
  if (!rec || typeof rec !== 'object' || typeof rec.accessToken !== 'string' || !rec.accessToken) return null
  return rec
}

/**
 * Persist an OAuth record for a server URL (merging into the existing store). A
 * prior read error aborts rather than clobbering sibling records — same
 * discipline as credential-store.setStoredCredential.
 *
 * @param {string} url
 * @param {McpOAuthRecord} record
 */
export function setStoredToken(url, record) {
  const serverKey = serverKeyForUrl(url)
  if (!serverKey) throw new Error('MCP OAuth store: unstorable server url')
  if (!record || typeof record.accessToken !== 'string' || !record.accessToken) {
    throw new Error('MCP OAuth store: record requires a non-empty accessToken')
  }
  const { data, error } = readStore()
  if (error) throw new Error(error)
  writeStoreAtomically({ ...data, [serverKey]: record })
}

/**
 * Remove the stored record for a server URL (no-op when absent). Deletes the file
 * entirely when it would be left empty. A read error aborts rather than guessing.
 *
 * @param {string} url
 */
export function deleteStoredToken(url) {
  const serverKey = serverKeyForUrl(url)
  if (!serverKey) return
  const { data, fileExists, error } = readStore()
  if (!fileExists) return
  if (error) throw new Error(error)
  if (!(serverKey in data)) return
  const next = { ...data }
  delete next[serverKey]
  if (Object.keys(next).length === 0) {
    try { unlinkSync(tokensFilePath()) } catch (err) { if (err.code !== 'ENOENT') throw err }
    return
  }
  writeStoreAtomically(next)
}

/**
 * True when a record's access token is expired (or within `skewMs` of expiry).
 * A record with `expiresAt === 0` (server omitted expires_in) is treated as
 * NON-expiring here — the reactive 401 path re-auths it if the server later
 * rejects it.
 *
 * @param {McpOAuthRecord} record
 * @param {number} [skewMs] - refresh-ahead window (default 60s).
 * @returns {boolean}
 */
export function isTokenExpired(record, skewMs = 60_000) {
  if (!record || typeof record.expiresAt !== 'number' || record.expiresAt <= 0) return false
  return Date.now() >= record.expiresAt - skewMs
}
