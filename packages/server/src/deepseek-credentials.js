/**
 * Credential sourcing for the deepseek provider (#4656).
 *
 * Mirrors byok-credentials.js — the priority order, the 0600 mode
 * enforcement, the lazy path resolution, the masking helper — but
 * reads `DEEPSEEK_API_KEY` from the env and `deepseekApiKey` from
 * `~/.chroxy/credentials.json`. Kept as a separate module (rather than
 * a generic "any provider's API key" helper) so a credentials.json with
 * both `anthropicApiKey` and `deepseekApiKey` populated routes to the
 * right provider without either path having to know about the other.
 *
 * Priority order:
 *   1. process.env.DEEPSEEK_API_KEY
 *   2. ~/.chroxy/credentials.json — { deepseekApiKey: "sk-..." }
 *      File MUST be mode 0600. We refuse to read it otherwise (security
 *      boundary: API keys are user-pasted secrets).
 *
 * Never logged. The redactor at logger.js scrubs `Bearer` patterns; the
 * DeepSeek `sk-` prefix overlaps with many other key formats so it isn't
 * special-cased there — masking at the use site is the defense.
 */
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { maskApiKey } from './byok-credentials.js'

// Lazy-resolved per call so tests that mutate process.env.HOME between
// cases pick up the new home (same rationale as byok-credentials.js).
function credentialsFilePath() {
  return join(homedir(), '.chroxy', 'credentials.json')
}

/**
 * Resolve the DeepSeek API key for a DeepSeek session.
 *
 * @returns {{ key: string, source: 'env' | 'file' } | { key: null, source: 'none', reason: string }}
 */
export function resolveDeepSeekApiKey() {
  const envKey = process.env.DEEPSEEK_API_KEY
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
        reason: `DEEPSEEK_API_KEY not set and ${CREDENTIALS_FILE} does not exist`,
      }
    }
    return {
      key: null,
      source: 'none',
      reason: `unable to stat ${CREDENTIALS_FILE}: ${err.message}`,
    }
  }

  // Refuse anything more permissive than 0600 — same security boundary
  // as the BYOK resolver. A pasted-in credentials.json defaulting to 0644
  // on macOS would otherwise leak the key to every local user.
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

  if (typeof parsed?.deepseekApiKey !== 'string' || parsed.deepseekApiKey.length === 0) {
    return {
      key: null,
      source: 'none',
      reason: `${CREDENTIALS_FILE} missing or empty "deepseekApiKey" field`,
    }
  }

  return { key: parsed.deepseekApiKey, source: 'file' }
}

// Re-export the masking helper so callers don't have to import from two
// modules to log a redacted DeepSeek key.
export { maskApiKey }
