/**
 * Generalized provider-credential store (#3855).
 *
 * Backs the dashboard "Provider Credentials" Settings pane. Stores per-provider
 * API keys and OAuth tokens in `~/.chroxy/credentials.json`, mode 0600,
 * owner-only. Never stores plaintext world-readable; refuses to read a file
 * that is more permissive than 0600 (security boundary inherited from the
 * #4052 BYOK store this generalizes — see byok-credentials.js).
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
 * NOTE (scope): the issue's "encrypted at rest with an OS-keychain-derived key"
 * requirement is intentionally NOT implemented here. The established chroxy
 * secret-at-rest baseline is the 0600 owner-only file (refusing anything more
 * permissive), shared with the primary-token fallback and the #4052 BYOK store.
 * Keychain-derived envelope encryption of the multi-key map is tracked as a
 * separable follow-up — see the PR body.
 */
import { readFileSync, statSync, writeFileSync, chmodSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { maskApiKey } from './byok-credentials.js'

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

  // Refuse anything more permissive than 0600 (POSIX). On win32 the mode bits
  // don't reflect NTFS ACLs, so skip the check there (matches #4144).
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
  return { data: parsed, fileExists: true, error: null }
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
  const { data, error } = readStore()
  if (error) return null
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

  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  let renamed = false
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    if (process.platform === 'win32' && existsSync(target)) {
      try { unlinkSync(target) } catch { /* */ }
    }
    renameSync(tmp, target)
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

  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  let renamed = false
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    if (process.platform === 'win32' && existsSync(target)) {
      try { unlinkSync(target) } catch { /* */ }
    }
    renameSync(tmp, target)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmp)) {
      try { unlinkSync(tmp) } catch { /* */ }
    }
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
