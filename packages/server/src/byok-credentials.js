/**
 * Credential sourcing for the claude-byok provider.
 *
 * Priority order:
 *   1. process.env.ANTHROPIC_API_KEY
 *   2. ~/.chroxy/credentials.json — { anthropicApiKey: "sk-ant-..." }
 *      File MUST be mode 0600. We refuse to read it otherwise (security
 *      boundary: API keys are user-pasted secrets and should not be
 *      world-readable; if the user accidentally chmodded the file to 0644
 *      we'd rather fail loudly than silently expose the key).
 *
 * Never logged. The redactor at logger.js scrubs `sk-ant-` and `Bearer`
 * patterns before any log line lands on disk.
 */
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Lazy-resolved per call so tests that mutate process.env.HOME between
// cases pick up the new home; if this were captured at module load, the
// path would freeze at the first import.
function credentialsFilePath() {
  return join(homedir(), '.chroxy', 'credentials.json')
}

/**
 * Resolve the Anthropic API key for a BYOK session.
 *
 * @returns {{ key: string, source: 'env' | 'file' } | { key: null, source: 'none', reason: string }}
 */
export function resolveAnthropicApiKey() {
  const envKey = process.env.ANTHROPIC_API_KEY
  if (typeof envKey === 'string' && envKey.length > 0) {
    return { key: envKey, source: 'env' }
  }

  const CREDENTIALS_FILE = credentialsFilePath()
  let stat
  try {
    stat = statSync(CREDENTIALS_FILE)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        key: null,
        source: 'none',
        reason: `ANTHROPIC_API_KEY not set and ${CREDENTIALS_FILE} does not exist`,
      }
    }
    return {
      key: null,
      source: 'none',
      reason: `unable to stat ${CREDENTIALS_FILE}: ${err.message}`,
    }
  }

  // Refuse anything more permissive than 0600. Permissions check uses the
  // low 9 bits (mode & 0o777). On macOS a file pasted in from elsewhere
  // commonly arrives as 0644; we want to fail with a clear hint rather
  // than read the key from a world-readable file.
  const perms = stat.mode & 0o777
  if (perms !== 0o600) {
    return {
      key: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} has mode ${perms.toString(8).padStart(3, '0')}; refusing to read (must be 0600 — run: chmod 600 ${CREDENTIALS_FILE})`,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'))
  } catch (err) {
    return {
      key: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} unreadable or not valid JSON: ${err.message}`,
    }
  }

  if (typeof parsed?.anthropicApiKey !== 'string' || parsed.anthropicApiKey.length === 0) {
    return {
      key: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} missing or empty "anthropicApiKey" field`,
    }
  }

  return { key: parsed.anthropicApiKey, source: 'file' }
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
