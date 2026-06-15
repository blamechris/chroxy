/**
 * Credential sourcing for the claude-byok provider.
 *
 * Priority order:
 *   1. process.env.ANTHROPIC_API_KEY
 *   2. the canonical credential store (`credential-store.js`,
 *      ~/.chroxy/credentials.json, mode 0600) — decryption-aware (#5154) and
 *      honoring the legacy `anthropicApiKey` alias for files written by the
 *      pre-#5867 single-key BYOK path.
 *
 * #5867: writes/clears now go through `setStoredCredential` /
 * `deleteStoredCredential` (merge + at-rest encryption), so a BYOK set/clear no
 * longer clobbers sibling provider keys or downgrades an encrypted store to
 * plaintext. This module is now read-only (resolve + status + mask); the WS
 * handlers call the store directly.
 *
 * Never logged. The redactor at logger.js scrubs `sk-ant-` and `Bearer`
 * patterns before any log line lands on disk.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { resolveStoredCredentialWithMeta } from './credential-store.js'

// Lazy-resolved per call so tests that mutate process.env.HOME between
// cases pick up the new home; if this were captured at module load, the
// path would freeze at the first import.
function credentialsFilePath() {
  return join(homedir(), '.chroxy', 'credentials.json')
}

/**
 * Resolve the Anthropic API key for a BYOK session. Env var wins; otherwise the
 * cipher-aware credential store. The `reason` (when missing) preserves the
 * store's read distinctions: bad mode, keychain-locked, corrupt envelope,
 * file-absent, or present-but-no-Anthropic-credential.
 *
 * @returns {{ key: string, source: 'env' | 'file' } | { key: null, source: 'none', reason: string }}
 */
export function resolveAnthropicApiKey() {
  const envKey = process.env.ANTHROPIC_API_KEY
  if (typeof envKey === 'string' && envKey.length > 0) {
    return { key: envKey, source: 'env' }
  }

  const { value, fileExists, error } = resolveStoredCredentialWithMeta('ANTHROPIC_API_KEY')
  if (value) {
    return { key: value, source: 'file' }
  }
  const CREDENTIALS_FILE = credentialsFilePath()
  let reason
  if (error) {
    reason = error
  } else if (!fileExists) {
    reason = `ANTHROPIC_API_KEY not set and ${CREDENTIALS_FILE} does not exist`
  } else {
    reason = `ANTHROPIC_API_KEY not set and no Anthropic credential is stored in ${CREDENTIALS_FILE}`
  }
  return { key: null, source: 'none', reason }
}

/**
 * Dashboard / status-line friendly view of the current credential state.
 * Returns `{ status, source, masked?, reason? }`:
 *   - status: 'set' | 'missing'
 *   - source: 'env' | 'file' | 'none'
 *   - masked: when status='set', a redacted view of the key (12-char prefix max)
 *   - reason: when status='missing', a human-readable explanation
 *
 * Wraps `resolveAnthropicApiKey` so callers don't accidentally surface the
 * raw key string — they only ever see the masked form.
 */
export function getAnthropicApiKeyStatus() {
  const r = resolveAnthropicApiKey()
  // #4144: report file presence independently of which source wins. When
  // the env var is set, the file is shadowed by env precedence; the
  // dashboard uses this to surface "stale file on disk" UX and to keep
  // the Remove button enabled even when source is 'env'.
  //
  // Theoretical race: the file could be (un)linked between
  // resolveAnthropicApiKey() and hasStoredCredentials(). Acceptable for
  // a status query — the dashboard polls on open and after every
  // set/clear, so any transient inconsistency self-heals on the next
  // refresh. We're not making security decisions on this flag.
  const fileExists = hasStoredCredentials()
  if (r.key) {
    return { status: 'set', source: r.source, masked: maskApiKey(r.key), fileExists }
  }
  return { status: 'missing', source: 'none', reason: r.reason, fileExists }
}

/**
 * Whether `~/.chroxy/credentials.json` currently exists on disk, regardless
 * of mode validity, JSON shape, or whether resolveAnthropicApiKey would
 * accept it. Used by the dashboard's BYOK section to surface stale-file
 * UX even when an env var wins precedence (#4144).
 *
 * @returns {boolean}
 */
export function hasStoredCredentials() {
  try {
    return existsSync(credentialsFilePath())
  } catch {
    return false
  }
}

/**
 * Mask an API key for display in logs / UI / errors. Returns a string with
 * a short prefix and a redaction marker. Never returns the full key —
 * even for unexpectedly short inputs, where slice(0, 12) would otherwise
 * echo the whole thing (caught by Copilot review on #4055).
 *
 * @param {string} key
 * @returns {string}
 */
export function maskApiKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '<missing>'
  // For a normal Anthropic key (sk-ant-api03-… ~108 chars), show 12 + redact
  // the rest. For an unexpectedly short input, show no more than the first
  // 1/3 (rounded down) so we never echo more than a third of the secret,
  // and always emit a redaction tail so the format stays consistent.
  const visibleLen = Math.min(12, Math.floor(key.length / 3))
  const visible = key.slice(0, visibleLen)
  const redacted = key.length - visibleLen
  return `${visible}...[${redacted} chars redacted]`
}
