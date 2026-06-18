/**
 * Shared 0600-gated reader for a single field of a credentials JSON file
 * (#4144 security boundary). Extracted from the three byte-divergent copies in
 * byok-credentials.js, deepseek-credentials.js, and anthropic-compatible-session.js
 * (audit P2-9).
 *
 * The 0600-mode refusal, the parse-error reason, and the missing-field reason
 * are byte-identical across all three callers and live here. The ONLY caller
 * divergence is the ENOENT reason (BYOK/DeepSeek prefix it with the env-var
 * name, e.g. "ANTHROPIC_API_KEY not set and …"), so this returns a `code` the
 * caller can branch on to substitute its own message — every other reason
 * string is preserved verbatim.
 *
 * This is the NON-cached path; the `cachedResolveCredentialFile` cache layer
 * (auth-probes.js, #5461) is unaffected and may wrap a call to this.
 *
 * @param {string} path  absolute path to credentials.json
 * @param {string} field  field name to read (e.g. 'anthropicApiKey')
 * @returns {{ key: string } | { key: null, reason: string, code: 'enoent'|'stat'|'mode'|'parse'|'missing' }}
 */
import { readFileSync, statSync } from 'fs'

export function readCredentialJsonField(path, field) {
  let stat
  try {
    stat = statSync(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { key: null, code: 'enoent', reason: `${path} does not exist` }
    }
    return { key: null, code: 'stat', reason: `unable to stat ${path}: ${err.message}` }
  }

  // Refuse anything more permissive than 0600. The check uses the low 9 bits
  // (mode & 0o777). On macOS a file pasted in from elsewhere commonly arrives
  // as 0644; we fail with a clear hint rather than read a world-readable key.
  const perms = stat.mode & 0o777
  if (perms !== 0o600) {
    return {
      key: null,
      code: 'mode',
      reason: `${path} has mode ${perms.toString(8).padStart(3, '0')}; refusing to read (must be 0600 — run: chmod 600 ${path})`,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { key: null, code: 'parse', reason: `${path} unreadable or not valid JSON: ${err.message}` }
  }

  if (typeof parsed?.[field] !== 'string' || parsed[field].length === 0) {
    return { key: null, code: 'missing', reason: `${path} missing or empty "${field}" field` }
  }

  return { key: parsed[field] }
}
