/**
 * Generalized provider-credential store (#3855).
 *
 * Backs the dashboard "Provider Credentials" Settings pane. Stores per-provider
 * API keys and OAuth tokens in `~/.chroxy/credentials.json`, mode 0600,
 * owner-only. Never stores plaintext world-readable; refuses to read a file
 * whose mode is not exactly 0600 — anything else (more permissive like 0644,
 * OR stricter like 0400) is rejected, matching the #4052 BYOK store this
 * generalizes (see byok-credentials.js). The strict-equality check keeps the
 * boundary simple and predictable; operators always set 0600.
 *
 * Resolution order for each known credential env var (used by spawn-env.js):
 *   1. process.env.<KEY>   — explicit shell export wins (power users keep control)
 *   2. credential store    — fills the Tauri/launchd GUI-launch gap (cwd=/, no rc)
 *   3. unset               — provider's existing missing-key error path fires
 *
 * File layout (forward-compatible with the #4052 single-key shape):
 *   {
 *     "anthropicApiKey": "sk-ant-...",   // legacy #4052 alias for ANTHROPIC_API_KEY
 *     "ANTHROPIC_API_KEY": "sk-ant-...",
 *     "GEMINI_API_KEY": "...",
 *     "OPENAI_API_KEY": "...",
 *     "CLAUDE_CODE_OAUTH_TOKEN": "..."
 *   }
 *
 * The raw value NEVER leaves this module except through resolveCredential()
 * (for injection into a spawned child env). Status views only ever return the
 * masked form via maskApiKey().
 *
 * Credentials are never logged. The redactor at logger.js scrubs `sk-ant-` and
 * `Bearer` patterns, and SENSITIVE_KEYS in config.js masks the file path; this
 * module additionally never passes a raw value to any logger call.
 *
 * At-rest encryption (#5154): on hosts with an OS keychain (macOS Keychain /
 * Linux libsecret), the file is encrypted with a random data key stored in the
 * keychain — see credential-cipher.js. The 0600 owner-only mode is retained as
 * defense-in-depth even when encrypted. Where no keychain is available
 * (Windows, headless Linux without `secret-tool`) the store falls back to 0600
 * plaintext, since a key stored beside the file would be obfuscation, not
 * security. `maybeEncryptCredentialsAtRest()` migrates a legacy plaintext file
 * in place at startup once a keychain is present. See
 * docs/security/credentials-at-rest.md for the full threat model.
 */
import { readFileSync, statSync, writeFileSync, chmodSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { maskApiKey } from './byok-credentials.js'
import * as realKeychain from './keychain.js'
import { createLogger } from './logger.js'
import {
  CRED_KEY_SERVICE,
  isEncryptedEnvelope,
  decryptEnvelope,
  encryptJson,
  getMasterKey,
  getOrCreateMasterKey,
  rotateMasterKey,
  setMasterKey,
} from './credential-cipher.js'

// A keychain stub that reports "no keychain here" — selects the plaintext
// fallback path.
const NO_KEYCHAIN = { isKeychainAvailable: () => false }

// #5258: Windows rename-failure codes that indicate a held handle (antivirus /
// Windows Search) on the destination, not a genuine I/O error. Mirrors
// session-state-persistence.WINDOWS_LOCK_CODES — replaceFileAtomically retries
// once on these.
const CRED_WINDOWS_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])

// #5242: logger for the recoverable encrypted-but-keychain-unavailable warning.
// Injectable for tests. Credentials are NEVER passed to it — only the key NAME
// and the fact of the failure (the logger.js redactor scrubs sk-ant/Bearer too).
let _log = createLogger('credentials')
export function _setCredentialLoggerForTests(logger) {
  _log = logger || createLogger('credentials')
}

// #5242: keys we've already warned about, so the spawn path (which calls
// resolveCredential on every child launch) warns once per key, not per spawn.
const _keychainUnavailableWarned = new Set()
export function _resetKeychainWarningsForTests() {
  _keychainUnavailableWarned.clear()
}

/**
 * #5242: emit a one-time warning that an ENCRYPTED credential exists on disk but
 * its keychain data key is currently unavailable (locked keychain, transient
 * `security`/`secret-tool` failure, denied/timed-out unlock prompt) — a
 * RECOVERABLE condition distinct from a corrupt/bad-mode file. Without this, the
 * spawn path (resolveCredential → buildSpawnEnv) silently launches a subprocess
 * provider unauthenticated despite a valid credential on disk. The warning makes
 * that observable; the value is never logged.
 *
 * @param {string} key
 */
function warnKeychainUnavailableOnce(key) {
  if (_keychainUnavailableWarned.has(key)) return
  _keychainUnavailableWarned.add(key)
  _log.warn(
    `${key} is stored (encrypted) but its OS keychain data key is currently unavailable — resolving as unset. ` +
    `A spawned child may launch unauthenticated. Unlock the OS keychain (or re-store the credential) and retry.`,
  )
}

// Explicit test injection (an in-memory keychain), or null to use the resolved
// default. Takes precedence over the env escape hatch below.
let _keychainOverride = null

/**
 * Resolve the keychain to use for at-rest encryption, evaluated lazily per call
 * (NOT captured at import). `keychain.js` is imported at the top of this file,
 * but no OS-keychain call (or `process.env` read) happens until a store
 * operation actually runs — so importing `credential-store.js` never triggers a
 * `child_process` keychain probe at module-load time. (Test isolation against
 * `mock.module('child_process')` is owned by `_setup.mjs`, which deliberately
 * imports neither this module nor `keychain.js`.)
 *
 *   1. an explicit test injection wins (the encryption suite's in-memory key);
 *   2. else `CHROXY_CRED_DISABLE_KEYCHAIN=1` forces the plaintext fallback —
 *      an operator escape hatch for hosts with an unreliable keychain, and the
 *      switch the test bootstrap sets so suites never touch the real keychain;
 *   3. else the real OS keychain.
 */
function activeKeychain() {
  if (_keychainOverride) return _keychainOverride
  if (process.env.CHROXY_CRED_DISABLE_KEYCHAIN === '1') return NO_KEYCHAIN
  return realKeychain
}

/**
 * Test seam: inject a keychain (e.g. an in-memory one to drive the encrypted
 * path), or pass null to fall back to the resolved default.
 */
export function _setCredentialKeychainForTests(keychain) {
  _keychainOverride = keychain || null
}

/**
 * The credential env vars the store manages, with display metadata. The order
 * here is the order the dashboard renders rows in.
 *
 * `kind`:
 *   'api-key' — a provider API key (validated by `validate`).
 *   'oauth-token' — a long-lived OAuth token variant (CLAUDE_CODE_OAUTH_TOKEN).
 *
 * `validate(value)` returns null when valid, or an error string. Kept loose on
 * purpose — provider key formats evolve — but catches obvious wrong-thing
 * pastes (e.g. an OpenAI key dropped into the Anthropic field).
 */
export const KNOWN_CREDENTIALS = Object.freeze([
  Object.freeze({
    key: 'ANTHROPIC_API_KEY',
    provider: 'Anthropic',
    label: 'Anthropic API key',
    kind: 'api-key',
    validate: (v) => (v.startsWith('sk-ant-') ? null : 'Anthropic API keys start with "sk-ant-".'),
  }),
  Object.freeze({
    key: 'CLAUDE_CODE_OAUTH_TOKEN',
    provider: 'Anthropic',
    label: 'Claude Code OAuth token',
    kind: 'oauth-token',
    // OAuth token format is opaque; only require a non-empty trimmed value.
    validate: () => null,
  }),
  Object.freeze({
    key: 'GEMINI_API_KEY',
    provider: 'Google Gemini',
    label: 'Gemini API key',
    kind: 'api-key',
    validate: () => null,
  }),
  Object.freeze({
    key: 'OPENAI_API_KEY',
    provider: 'OpenAI / Codex',
    label: 'OpenAI API key',
    kind: 'api-key',
    validate: (v) => (v.startsWith('sk-') ? null : 'OpenAI API keys start with "sk-".'),
  }),
])

const KNOWN_KEYS = new Set(KNOWN_CREDENTIALS.map((c) => c.key))

/**
 * #4052 forward-compat: the original single-key store wrote `anthropicApiKey`.
 * Map that legacy field onto the canonical `ANTHROPIC_API_KEY` slot when
 * reading, and keep writing it alongside the canonical key so an older server
 * (or the byok-session resolver) still finds it.
 */
const LEGACY_FIELD_BY_KEY = Object.freeze({ ANTHROPIC_API_KEY: 'anthropicApiKey' })

/** @returns {boolean} whether `key` is a credential the store manages. */
export function isKnownCredentialKey(key) {
  return KNOWN_KEYS.has(key)
}

// Lazy-resolved per call so tests that mutate process.env.HOME between cases
// pick up the new home; if captured at module load it would freeze on first import.
function credentialsFilePath() {
  return join(homedir(), '.chroxy', 'credentials.json')
}

/**
 * Read + parse the credentials file, enforcing the 0600 mode boundary.
 *
 * @returns {{ data: Record<string, string>, fileExists: boolean, error: string | null }}
 *   `data` is the parsed object (empty when missing/unreadable). `error` is a
 *   human-readable reason when the file exists but cannot be safely read
 *   (bad mode, bad JSON) — callers surface it without exposing any value.
 */
function readStore() {
  const file = credentialsFilePath()
  let stat
  try {
    stat = statSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, fileExists: false, error: null }
    return { data: {}, fileExists: false, error: `unable to stat ${file}: ${err.message}` }
  }

  // Refuse any mode that is not exactly 0600 (POSIX) — both more-permissive
  // (e.g. 0644) and stricter (e.g. 0400) modes are rejected. On win32 the mode
  // bits don't reflect NTFS ACLs, so skip the check there (matches #4144).
  if (process.platform !== 'win32') {
    const perms = stat.mode & 0o777
    if (perms !== 0o600) {
      return {
        data: {},
        fileExists: true,
        error: `${file} has mode ${perms.toString(8).padStart(3, '0')}; refusing to read (must be 0600 — run: chmod 600 ${file})`,
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

  // #5154 — an encrypted envelope requires the keychain data key to decrypt.
  // A plaintext object passes through unchanged (legacy / no-keychain host).
  if (isEncryptedEnvelope(parsed)) {
    const key = getMasterKey(activeKeychain())
    if (!key) {
      // #5242: the RECOVERABLE case — the envelope is intact but the keychain
      // data key can't be fetched (locked keychain, transient probe failure).
      // `keychainUnavailable` distinguishes it from a decrypt-throw corruption
      // below so the spawn-path warning only fires for this recoverable branch.
      return {
        data: {},
        fileExists: true,
        error: `${file} is encrypted but its decryption key is unavailable (OS keychain service "${CRED_KEY_SERVICE}" missing or unreadable)`,
        encrypted: true,
        keychainUnavailable: true,
      }
    }
    try {
      return { data: decryptEnvelope(parsed, key), fileExists: true, error: null, encrypted: true }
    } catch (err) {
      // The data key was present but decryption failed — a corrupt/invalid
      // envelope, NOT a keychain-availability problem. No keychainUnavailable
      // flag, so this does not trigger the keychain-unavailable warning.
      return { data: {}, fileExists: true, error: `${file} could not be decrypted: ${err.message}`, encrypted: true }
    }
  }

  return { data: parsed, fileExists: true, error: null, encrypted: false }
}

/**
 * Atomically move `tmp` over `target`.
 *
 * #5243: relies on `renameSync`'s atomic replace — on win32 Node's
 * `fs.renameSync` uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING |
 * MOVEFILE_WRITE_THROUGH` since v16 (see platform.js), so it already replaces an
 * existing target without a separate delete. The previous win32 path
 * `unlinkSync(target)` immediately BEFORE the rename — a crash in that window
 * left no `credentials.json` at all (the live file deleted, the replacement
 * never moved in). We now never pre-delete the live file; this matches the
 * sibling `writeFileRestricted` (platform.js), which goes straight from
 * `writeFileSync(tmp)` to `renameSync`.
 *
 * #5258: on Windows an antivirus / Windows Search held handle on `target` can
 * make the atomic replace fail with EPERM/EACCES/EBUSY/EEXIST even though
 * renameSync normally replaces atomically. We mirror
 * session-state-persistence._rotateToBak's one-shot retry: snapshot the live
 * target, clear it, then retry the rename once. The unlink happens ONLY after
 * the atomic attempt already failed (never a pre-delete — that was the #5243
 * data-loss bug). The in-memory snapshot lets us restore the live credentials
 * if the *retry* also fails. It does NOT make the unlink→re-rename window
 * crash-safe: a hard process crash in that window leaves `target` gone with the
 * new payload only on the on-disk `.tmp` (no automated reader recovers it). To
 * keep that window from ever destroying the only copy, we refuse to unlink when
 * the snapshot read failed but the file is still present (see below) — so the
 * worst pre-crash state is "live file intact, replace not applied".
 *
 * #5264: the win32 retry/refuse/restore branches emit credentials-safe
 * `_log.warn` breadcrumbs (error codes only — never values or snapshot bytes)
 * for observability parity with `_rotateToBak`.
 *
 * fs ops are injectable for testing (defaults are the real fs calls).
 *
 * @param {string} tmp - source temp path.
 * @param {string} target - destination path.
 * @param {{ rename?: Function, unlink?: Function, readFile?: Function, writeFile?: Function, platform?: string }} [deps]
 */
export function replaceFileAtomically(tmp, target, deps = {}) {
  const {
    rename = renameSync,
    unlink = unlinkSync,
    readFile = readFileSync,
    writeFile = writeFileSync,
    platform = process.platform,
  } = deps
  try {
    rename(tmp, target)
    return
  } catch (err) {
    // Non-Windows, or an error that isn't a Windows held-handle lock: surface
    // it unchanged (no unlink — preserves the #5243 no-pre-delete guarantee).
    if (platform !== 'win32' || !err || !CRED_WINDOWS_LOCK_CODES.has(err.code)) throw err
    // #5264: surface the recovery attempt for observability parity with
    // session-state-persistence._rotateToBak. Only the error code is logged —
    // never the credential value or any snapshot bytes (module invariant).
    _log.warn(`credentials atomic replace hit a Windows held-handle lock (${err.code}); attempting one-shot retry`)
    // Snapshot the live target so we can restore it if the retry also fails.
    let snapshot = null
    let snapshotErr = null
    try { snapshot = readFile(target) } catch (readErr) { snapshotErr = readErr /* target may already be gone */ }
    // If the snapshot failed but the target is still on disk (e.g. readFile threw
    // EACCES/EPERM because the same held handle is blocking the read), unlinking
    // it here would destroy the only copy with no way to restore — re-introducing
    // the #5243 data-loss path. Keep the live file intact and surface the ORIGINAL
    // lock error instead; the caller is no worse off than before the retry.
    if (snapshot === null && existsSync(target)) {
      _log.warn(`credentials atomic replace could not snapshot the live target before retry (lock ${err.code}, read ${snapshotErr?.code || 'unknown'}); leaving it intact and surfacing the lock error`)
      throw err
    }
    try { unlink(target) } catch { /* best-effort — target may be gone */ }
    try {
      rename(tmp, target)
    } catch (retryErr) {
      // Retry still failed — restore the live bytes (if captured) so the prior
      // credentials survive, then surface the error to the caller.
      if (snapshot !== null) {
        try {
          writeFile(target, snapshot, { mode: 0o600 })
        } catch (restoreErr) {
          // Worst case: target deleted, retry failed, restore failed → no
          // credentials on disk. Leave a breadcrumb (codes only) so the thrown
          // error isn't the sole signal that a restore was even attempted.
          _log.warn(`credentials atomic replace failed to restore the prior file after a failed retry (${restoreErr?.code || 'unknown'})`)
        }
      }
      throw retryErr
    }
  }
}

/**
 * Serialize + atomically write the store to `target`, encrypting the blob when
 * a keychain-backed data key is available (#5154) and otherwise writing 0600
 * plaintext. Preserves the temp-file → chmod 0600 → rename crash-safety and the
 * post-write mode re-check (POSIX). `dir` is assumed to already exist (callers
 * mkdir it). Shared by the set/delete/migrate paths.
 */
function writeStoreAtomically(target, nextObj) {
  const key = getOrCreateMasterKey(activeKeychain())
  const payload = key ? encryptJson(nextObj, key) : nextObj

  // randomBytes (not Math.random) for the atomic-write temp suffix — a predictable
  // temp name is a (minor) symlink/pre-creation foothold; cryptographic randomness
  // costs nothing here and matches the pattern in path-hash-trust-ledger.js.
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  let renamed = false
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    // #5243: atomic replace — never unlink the live target first.
    replaceFileAtomically(tmp, target)
    renamed = true
    if (process.platform !== 'win32') {
      const perms = statSync(target).mode & 0o777
      if (perms !== 0o600) {
        try { unlinkSync(target) } catch { /* */ }
        throw new Error(`credentials file ended up with mode ${perms.toString(8)} after write; refused`)
      }
    }
  } finally {
    if (!renamed && existsSync(tmp)) {
      try { unlinkSync(tmp) } catch { /* */ }
    }
  }
}

/**
 * Resolve the stored raw value for a credential key, honoring the legacy
 * `anthropicApiKey` alias. Returns null when not present (or on a read error —
 * callers that need the read error use the status surface instead).
 *
 * @param {string} key
 * @returns {string | null}
 */
export function getStoredCredential(key) {
  if (!isKnownCredentialKey(key)) return null
  const { data, error, keychainUnavailable } = readStore()
  if (error) {
    // #5242: a read error with `keychainUnavailable: true` is the RECOVERABLE
    // case — an intact encrypted envelope whose keychain data key can't be
    // fetched right now. Emit a one-time warning so a silent unauthenticated
    // spawn is observable. Other read errors (bad mode/JSON, or a corrupt
    // envelope that fails to decrypt) are already surfaced via
    // getCredentialsStatus.fileError and are NOT the recoverable case.
    if (keychainUnavailable) warnKeychainUnavailableOnce(key)
    return null
  }
  const canonical = data[key]
  if (typeof canonical === 'string' && canonical.length > 0) return canonical
  const legacyField = LEGACY_FIELD_BY_KEY[key]
  if (legacyField) {
    const legacy = data[legacyField]
    if (typeof legacy === 'string' && legacy.length > 0) return legacy
  }
  return null
}

/**
 * #5867 — resolve a KNOWN credential's value AND the read metadata in one
 * cipher-aware, alias-aware read. Like `getStoredCredential` but also returns
 * the `readStore` metadata (`fileExists`, `error`, `keychainUnavailable`) so a
 * caller can build a status `reason` that preserves the bad-mode /
 * keychain-locked / corrupt-envelope / file-absent distinctions WITHOUT this
 * module logging or echoing the value. The raw `value` is returned only to the
 * caller. Honors the legacy `anthropicApiKey` alias like `getStoredCredential`.
 *
 * Used by byok-credentials.resolveAnthropicApiKey so the BYOK paid-auth read
 * path goes through the encryption-aware store instead of a plaintext re-read.
 *
 * @param {string} key
 * @returns {{ value: string | null, fileExists: boolean, error: string | null, keychainUnavailable: boolean }}
 */
export function resolveStoredCredentialWithMeta(key) {
  if (!isKnownCredentialKey(key)) {
    return { value: null, fileExists: false, error: null, keychainUnavailable: false }
  }
  const { data, fileExists, error, keychainUnavailable } = readStore()
  if (error) {
    return { value: null, fileExists, error, keychainUnavailable: Boolean(keychainUnavailable) }
  }
  const canonical = data[key]
  if (typeof canonical === 'string' && canonical.length > 0) {
    return { value: canonical, fileExists, error: null, keychainUnavailable: false }
  }
  const legacyField = LEGACY_FIELD_BY_KEY[key]
  if (legacyField) {
    const legacy = data[legacyField]
    if (typeof legacy === 'string' && legacy.length > 0) {
      return { value: legacy, fileExists, error: null, keychainUnavailable: false }
    }
  }
  return { value: null, fileExists, error: null, keychainUnavailable: false }
}

/**
 * #5490 — read a single string field out of the credentials store, going
 * through the SAME cipher-aware reader (`readStore`) the API-key resolvers use:
 * 0600 mode enforcement, encrypted-envelope decryption, and the
 * keychain-unavailable / corrupt-envelope distinctions all apply identically.
 *
 * Exposed for credential consumers whose field is NOT a `KNOWN_CREDENTIALS`
 * env-var key — e.g. the Discord webhook URL (`discordWebhookUrl`), which lives
 * in the same file but routes to the notification sink rather than a spawned
 * provider. Returns the read metadata verbatim so the caller can build its own
 * `reason` strings WITHOUT this module ever logging or echoing the value.
 *
 * The raw `value` is returned ONLY to the caller (never logged here). On any
 * read error `value` is null and `error` carries a value-free reason. The
 * `keychainUnavailable` flag marks the RECOVERABLE encrypted-but-locked case so
 * callers can phrase a distinct (still value-free) reason.
 *
 * @param {string} field - the JSON field name to read (e.g. 'discordWebhookUrl')
 * @returns {{ value: string | null, fileExists: boolean, error: string | null, keychainUnavailable: boolean }}
 */
export function readStoredField(field) {
  const { data, fileExists, error, keychainUnavailable } = readStore()
  if (error) {
    return { value: null, fileExists, error, keychainUnavailable: Boolean(keychainUnavailable) }
  }
  const raw = data[field]
  const value = typeof raw === 'string' && raw.length > 0 ? raw : null
  return { value, fileExists, error: null, keychainUnavailable: false }
}

/**
 * #6540 — persist an arbitrary NON-`KNOWN_CREDENTIALS` string field into the
 * same encrypted-at-rest store (mode 0600, OS-keychain-backed cipher when
 * available), the write counterpart to `readStoredField`. Used for secrets that
 * live in the credentials file but are not provider env-var keys injected into a
 * spawned child — e.g. the GitHub webhook HMAC secret (`githubWebhookSecret`).
 *
 * Trims whitespace, refuses an empty value, and (optionally) validates via the
 * caller-supplied `validate(value) -> string|null` rule. Merges into the existing
 * store (a read error aborts rather than clobbering sibling fields) and writes
 * atomically. The raw value is NEVER logged.
 *
 * @param {string} field - the JSON field name (e.g. 'githubWebhookSecret')
 * @param {string} rawValue
 * @param {{ validate?: (v: string) => (string|null) }} [opts]
 * @throws {Error} on empty field/value, validation failure, or a read/write error
 */
export function setStoredField(field, rawValue, { validate } = {}) {
  if (typeof field !== 'string' || field.length === 0) throw new Error('field is required')
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (value.length === 0) throw new Error(`${field} is required (non-empty string)`)
  if (typeof validate === 'function') {
    const validationError = validate(value)
    if (validationError) throw new Error(validationError)
  }

  const target = credentialsFilePath()
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  }

  // Merge with the existing store so we don't clobber sibling keys. A read
  // error (bad mode / corrupt) aborts the write with a clear message rather than
  // overwriting unknown content.
  const { data, error } = readStore()
  if (error) throw new Error(error)
  writeStoreAtomically(target, { ...data, [field]: value })
}

/**
 * #6540 — remove an arbitrary NON-`KNOWN_CREDENTIALS` field written by
 * `setStoredField`. No-op when the field (or the whole file) is absent. Deletes
 * the file entirely when it would be left empty. Mirrors `deleteStoredCredential`
 * for the non-provider-key case.
 *
 * @param {string} field
 */
export function deleteStoredField(field) {
  if (typeof field !== 'string' || field.length === 0) throw new Error('field is required')
  const target = credentialsFilePath()
  const { data, fileExists, error } = readStore()
  if (!fileExists) return
  if (error) throw new Error(error)
  if (!(field in data)) return

  const next = { ...data }
  delete next[field]

  if (Object.keys(next).length === 0) {
    try { unlinkSync(target) } catch (err) { if (err.code !== 'ENOENT') throw err }
    return
  }

  writeStoreAtomically(target, next)
}

/**
 * Resolution order: process.env > store > unset.
 *
 * Used by spawn-env.js to inject stored credentials into a spawned child's
 * environment when the operator's shell hasn't already exported the var. This
 * is what makes a Tauri/launchd GUI launch (cwd=/, minimal PATH, no rc file)
 * able to authenticate from stored credentials alone.
 *
 * @param {string} key
 * @returns {{ value: string, source: 'env' | 'store' } | { value: null, source: 'unset' }}
 */
export function resolveCredential(key) {
  const envVal = process.env[key]
  if (typeof envVal === 'string' && envVal.length > 0) {
    return { value: envVal, source: 'env' }
  }
  const stored = getStoredCredential(key)
  if (stored) return { value: stored, source: 'store' }
  return { value: null, source: 'unset' }
}

/**
 * Persist a credential value atomically with mode 0600. Trims whitespace and
 * validates against the key's `validate` rule. Overwrites any existing value
 * (rotation = overwrite; no rotation log in v1).
 *
 * Atomicity: write to a temp file with mode 0600, then rename over the target.
 * A crash between write and rename leaves the prior file intact. Post-write the
 * mode is re-stat'd (POSIX) and we throw if it didn't take.
 *
 * @param {string} key
 * @param {string} rawValue
 * @throws {Error} on unknown key, empty value, or validation failure
 */
export function setStoredCredential(key, rawValue) {
  const meta = KNOWN_CREDENTIALS.find((c) => c.key === key)
  if (!meta) throw new Error(`Unknown credential key: ${key}`)
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (value.length === 0) throw new Error(`${key} is required (non-empty string)`)
  const validationError = meta.validate(value)
  if (validationError) throw new Error(validationError)

  const target = credentialsFilePath()
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  }

  // Merge with the existing store so we don't clobber other keys. Read
  // failures (bad mode/JSON) must NOT silently drop sibling keys, so a read
  // error aborts the write with a clear message instead of overwriting.
  const { data, error } = readStore()
  if (error) throw new Error(error)
  const next = { ...data, [key]: value }
  // #4052 forward-compat: keep writing the legacy alias for ANTHROPIC_API_KEY.
  const legacyField = LEGACY_FIELD_BY_KEY[key]
  if (legacyField) next[legacyField] = value

  writeStoreAtomically(target, next)
}

/**
 * Remove a single credential from the store. No-op when absent. Rewrites the
 * file atomically with the remaining keys (and removes the legacy alias too).
 * Deletes the file entirely when it would be left empty.
 *
 * @param {string} key
 */
export function deleteStoredCredential(key) {
  if (!isKnownCredentialKey(key)) throw new Error(`Unknown credential key: ${key}`)
  const target = credentialsFilePath()
  const { data, fileExists, error } = readStore()
  if (!fileExists) return
  // A bad-mode/JSON file can't be safely rewritten without risking clobber of
  // unknown content; surface the error rather than guess.
  if (error) throw new Error(error)

  const legacyField = LEGACY_FIELD_BY_KEY[key]
  if (!(key in data) && !(legacyField && legacyField in data)) return // nothing to remove

  const next = { ...data }
  delete next[key]
  if (legacyField) delete next[legacyField]

  // If the store is now empty, remove the file entirely.
  if (Object.keys(next).length === 0) {
    try { unlinkSync(target) } catch (err) { if (err.code !== 'ENOENT') throw err }
    return
  }

  writeStoreAtomically(target, next)
}

/**
 * #5154 — encrypt a legacy plaintext credentials.json in place once an OS
 * keychain is available. Mirrors the primary-token keychain migration in
 * server-cli.js; call once at startup. Best-effort: never throws into boot.
 *
 * No-op (with a reason) when: the file is missing, no keychain is available
 * (logs a one-time plaintext warning), the file is already encrypted, the file
 * can't be safely read (bad mode / corrupt), or the store is empty.
 *
 * @param {{ log?: { info: Function, warn: Function } }} [opts]
 * @returns {{ migrated: boolean, reason: string }}
 */
export function maybeEncryptCredentialsAtRest({ log } = {}) {
  const file = credentialsFilePath()
  if (!existsSync(file)) return { migrated: false, reason: 'no-file' }

  if (!activeKeychain().isKeychainAvailable()) {
    if (log) log.warn(`${file} is stored as plaintext — no OS keychain available to encrypt it at rest`)
    return { migrated: false, reason: 'no-keychain' }
  }

  const { data, error, encrypted } = readStore()
  if (error) {
    if (log) log.warn(`Credentials at-rest encryption skipped: ${error}`)
    return { migrated: false, reason: 'read-error' }
  }
  if (encrypted) return { migrated: false, reason: 'already-encrypted' }
  if (Object.keys(data).length === 0) return { migrated: false, reason: 'empty' }

  try {
    writeStoreAtomically(file, data) // getOrCreateMasterKey → writes an envelope
    if (log) log.info('Encrypted credentials.json at rest using an OS-keychain-backed key')
    return { migrated: true, reason: 'migrated' }
  } catch (err) {
    if (log) log.warn(`Credentials at-rest encryption failed: ${err.message}`)
    return { migrated: false, reason: 'write-error' }
  }
}

/**
 * #5229 — rotate the at-rest credential data key. Generates a fresh keychain
 * data key, re-encrypts the existing store under it, and atomically replaces
 * credentials.json (temp → chmod 0600 → rename, via writeStoreAtomically). The
 * single keychain entry (service `chroxy-cred-key`) is overwritten in place, so
 * no stale key is left dangling.
 *
 * Crash-safety: the keychain rotation and the re-encrypting atomic write share a
 * single try/catch failure domain. If either throws (disk full, permission, OS
 * keychain write failure, mode re-check), the keychain is rolled back to the
 * prior key (or deleted, if the store had been plaintext) so the existing on-disk
 * envelope stays decryptable.
 *
 * One narrow exception to "envelope stays decryptable": writeStoreAtomically does
 * a post-rename 0600 mode re-check, and on failure it unlinks the just-renamed
 * target before throwing. In that single case the rollback restores the old key
 * but there is no longer a file to decrypt — the new envelope was already removed.
 * This is a defensive last resort (the file landed with unexpected perms, which
 * shouldn't happen given the temp file is created mode 0600); the secrets remain
 * recoverable from the provider, and the operator can re-run rekey/migrate.
 *
 * The only other unrecoverable window is a hard process crash between the keychain
 * swap and the file rename — unavoidable without a second key slot, and
 * vanishingly small.
 *
 * No-op (with a reason) when: no keychain is available (nowhere to hold a key),
 * the file is missing, the store can't be safely read (bad mode / corrupt /
 * undecryptable), or the store is empty.
 *
 * @param {{ log?: { info: Function, warn: Function } }} [opts]
 * @returns {{ rekeyed: boolean, reason: string }}
 */
export function rekeyCredentialStore({ log } = {}) {
  const file = credentialsFilePath()
  const keychain = activeKeychain()

  if (!keychain.isKeychainAvailable()) {
    if (log) log.warn('Credential rekey skipped — no OS keychain available to hold a data key')
    return { rekeyed: false, reason: 'no-keychain' }
  }
  if (!existsSync(file)) return { rekeyed: false, reason: 'no-file' }

  // Decrypt the current store up front: a read error (bad mode / corrupt /
  // undecryptable) must abort BEFORE we touch the keychain, so we never strand
  // a readable store behind a rotated key.
  const { data, error } = readStore()
  if (error) {
    if (log) log.warn(`Credential rekey skipped: ${error}`)
    return { rekeyed: false, reason: 'read-error' }
  }
  if (Object.keys(data).length === 0) return { rekeyed: false, reason: 'empty' }

  // Capture the prior key for rollback (null when the store was plaintext).
  const previousKey = getMasterKey(keychain)
  // Treat the keychain rotation AND the re-encrypting file write as one failure
  // domain: if EITHER throws we roll the keychain back to previousKey so the
  // still-on-disk envelope stays decryptable. rotateMasterKey lives inside the
  // try because its keychain write can throw (e.g. execFileSync to the OS
  // keychain fails) and a partially-applied rotation would otherwise strand the
  // existing envelope behind an uncaught error.
  try {
    rotateMasterKey(keychain) // keychain now holds the new key
    writeStoreAtomically(file, data) // getOrCreateMasterKey → encrypts under the new key
    if (log) log.info('Rotated the credential data key and re-encrypted credentials.json')
    return { rekeyed: true, reason: 'rekeyed' }
  } catch (err) {
    // Roll the keychain back so the still-on-disk envelope stays decryptable.
    // Best-effort: if rollback itself throws, surface the original error reason
    // rather than masking it with a secondary keychain failure.
    try {
      setMasterKey(previousKey, keychain)
    } catch (rollbackErr) {
      if (log) log.warn(`Credential rekey rollback failed: ${rollbackErr.message}`)
    }
    if (log) log.warn(`Credential rekey failed: ${err.message}`)
    return { rekeyed: false, reason: 'write-error' }
  }
}

/** @returns {boolean} whether the credentials file exists on disk. */
export function credentialsFileExists() {
  try { return existsSync(credentialsFilePath()) } catch { return false }
}

/**
 * Build the masked, value-free status for every known credential. This is the
 * ONLY status surface the WS layer should expose — it never includes a raw
 * value. Each entry:
 *   - key, provider, label, kind  — display metadata
 *   - status: 'set' | 'missing'
 *   - source: 'env' | 'store' | 'oauth' | 'none'
 *   - masked: when status='set' (and source !== 'oauth'), a redacted preview
 *   - oauth:  true when an OAuth credential is detected for the provider
 *
 * @param {object} [helpers] - OAuth probes (injectable for tests).
 * @param {() => boolean} [helpers.hasClaudeOAuthCreds]
 * @param {() => boolean} [helpers.hasGeminiOAuthCreds]
 * @param {() => boolean} [helpers.hasCodexOAuthCreds]
 * @returns {{ credentials: Array<object>, fileExists: boolean, fileError: string | null }}
 */
export function getCredentialsStatus(helpers = {}) {
  const { hasClaudeOAuthCreds, hasGeminiOAuthCreds, hasCodexOAuthCreds } = helpers
  const oauthByProvider = {
    Anthropic: typeof hasClaudeOAuthCreds === 'function' ? Boolean(hasClaudeOAuthCreds()) : false,
    'Google Gemini': typeof hasGeminiOAuthCreds === 'function' ? Boolean(hasGeminiOAuthCreds()) : false,
    'OpenAI / Codex': typeof hasCodexOAuthCreds === 'function' ? Boolean(hasCodexOAuthCreds()) : false,
  }

  const { fileExists, error } = readStore()

  const credentials = KNOWN_CREDENTIALS.map((meta) => {
    const resolved = resolveCredential(meta.key)
    const oauth = Boolean(oauthByProvider[meta.provider])
    if (resolved.value) {
      return {
        key: meta.key,
        provider: meta.provider,
        label: meta.label,
        kind: meta.kind,
        status: 'set',
        source: resolved.source,
        masked: maskApiKey(resolved.value),
        oauth,
      }
    }
    // No API key/token configured. If the provider has OAuth creds, surface
    // that as the live source (read-only — we don't manage `claude login`).
    if (oauth) {
      return {
        key: meta.key,
        provider: meta.provider,
        label: meta.label,
        kind: meta.kind,
        status: 'missing',
        source: 'oauth',
        oauth: true,
      }
    }
    return {
      key: meta.key,
      provider: meta.provider,
      label: meta.label,
      kind: meta.kind,
      status: 'missing',
      source: 'none',
      oauth: false,
    }
  })

  return { credentials, fileExists, fileError: error }
}

export { maskApiKey }
