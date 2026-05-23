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
import { readFileSync, statSync, writeFileSync, chmodSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'fs'
import { join, dirname } from 'path'
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
 * Persist the user's Anthropic API key to ~/.chroxy/credentials.json
 * atomically with mode 0600.
 *
 * Atomicity: write to `credentials.json.tmp.<pid>.<rand>`, chmod 0600,
 * fsync isn't strictly needed for this size, then rename over the
 * target. A crash between write and rename leaves the old file intact.
 *
 * Post-write the mode is re-stat'd and we throw if it didn't take. This
 * guards against an unexpected umask making the file world-readable even
 * after chmod (rare). The security boundary is: refuse a bad state, do
 * not log a warning and continue.
 *
 * Windows note: chmod / 0600 don't map cleanly to NTFS ACLs, so the mode
 * verification is POSIX-only. On win32 the rename and chmod still run
 * (best-effort) but the strict 0o600 assertion is skipped — see #4144.
 *
 * @param {string} key  the `sk-ant-...` API key
 * @throws if key is missing/non-string, or if the post-write mode != 0600 on POSIX
 */
export function writeAnthropicApiKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('writeAnthropicApiKey: key is required (non-empty string)')
  }
  const target = credentialsFilePath()
  const dir = dirname(target)
  // 0o700 on the dir so creds aren't enumerable to other local users.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Existing dir may have a more-permissive mode from before this code
  // existed — tighten it. POSIX-only (Windows ACLs handle differently).
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  }

  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  let renamed = false
  try {
    // Open with mode 0600 directly so the brief window before chmod
    // doesn't expose the key as 0644 (umask-dependent default).
    writeFileSync(tmp, JSON.stringify({ anthropicApiKey: key }, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') {
      chmodSync(tmp, 0o600)
    }
    // win32 renameSync can't atomically replace an existing destination —
    // unlink the target first so the move semantics match POSIX. The
    // window between unlink and rename is tiny; an OS-level crash there
    // can leave the file missing but never world-readable.
    if (process.platform === 'win32' && existsSync(target)) {
      try { unlinkSync(target) } catch { /* */ }
    }
    renameSync(tmp, target)
    renamed = true
    // Verify the mode survived the rename. POSIX-only: on win32 the mode
    // bits don't reflect NTFS ACLs, so a strict 0o600 check would always
    // fail and refuse to write valid credentials.
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
 * Remove the stored credentials file. No-op when missing. Does not touch
 * the parent ~/.chroxy directory.
 */
export function clearAnthropicApiKey() {
  const target = credentialsFilePath()
  try { unlinkSync(target) } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
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
