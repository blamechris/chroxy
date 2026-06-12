/**
 * OS keychain integration for secure token storage.
 *
 * Uses native CLI tools (no npm dependencies):
 * - macOS: `security` command (Keychain Services)
 * - Linux: `secret-tool` (libsecret)
 * - Windows/fallback: returns null (caller falls back to chmod 600 file)
 */
import { execFileSync } from 'child_process'
import { isMac, isLinux } from './platform.js'

const DEFAULT_SERVICE = 'chroxy'
const ACCOUNT = 'api-token'

/**
 * macOS `security` exit code for errSecItemNotFound — the item genuinely is not
 * in the keychain (a clean "absent"). Any OTHER non-zero exit (locked keychain,
 * interaction-not-allowed, keychain not found, auth denied, …) is a READ FAILURE
 * we must NOT confuse with absence — see getTokenStatus / #5615.
 */
const MAC_ERR_SEC_ITEM_NOT_FOUND = 44

/**
 * Check if OS keychain is available on this system.
 */
export function isKeychainAvailable() {
  if (isMac) {
    try {
      execFileSync('security', ['help'], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  if (isLinux) {
    try {
      execFileSync('which', ['secret-tool'], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Get token from OS keychain.
 * @param {string} [service] - Keychain service name (default: 'chroxy')
 * @returns {string|null} Token or null if not found
 */
export function getToken(service = DEFAULT_SERVICE) {
  if (isMac) {
    return _macGetToken(service)
  }
  if (isLinux) {
    return _linuxGetToken(service)
  }
  return null
}

/**
 * @typedef {object} KeychainReadResult
 * @property {'found'|'absent'|'error'} status
 *   - `found`  — the item exists; `value` is the stored string.
 *   - `absent` — the item genuinely is not stored (clean first-run signal).
 *   - `error`  — the read FAILED for a reason other than absence (keychain
 *                locked / interaction-not-allowed / backend error). The caller
 *                MUST NOT treat this as absence — see #5615.
 * @property {string|null} value  - the token when `found`, else null.
 * @property {string|null} error  - a short diagnostic when `status === 'error'`.
 */

/**
 * Read a token while DISTINGUISHING "genuinely absent" from "read failed".
 *
 * `getToken` collapses both into `null`, which is fine for the API token and the
 * credential data-key (a failed read there just falls back to a file or re-prompts).
 * It is NOT fine for the server identity key (#5615): a transient keychain lock
 * read as "absent" would re-mint a fresh identity → every already-pinned client
 * sees a false MITM. This variant lets that caller fail safe instead of rotating.
 *
 * Heuristic by platform:
 *   - macOS: `security find-generic-password` exits 44 (errSecItemNotFound) when
 *     the item is absent; ANY other non-zero exit is a read failure.
 *   - Linux: `secret-tool lookup` exits 1 with NO output when absent; a non-zero
 *     exit WITH stderr (or any other code) is a read failure. secret-tool does
 *     not expose a distinct not-found code, so this is best-effort — and it errs
 *     toward `error` (fail safe), never silently toward `absent`.
 *   - Other platforms: no keychain → `absent` (the file fallback owns identity).
 *
 * @param {string} [service]
 * @returns {KeychainReadResult}
 */
export function getTokenStatus(service = DEFAULT_SERVICE) {
  if (isMac) {
    return _macGetTokenStatus(service)
  }
  if (isLinux) {
    return _linuxGetTokenStatus(service)
  }
  return { status: 'absent', value: null, error: null }
}

/**
 * Store token in OS keychain.
 * @param {string} token - Token to store
 * @param {string} [service] - Keychain service name (default: 'chroxy')
 */
export function setToken(token, service = DEFAULT_SERVICE) {
  if (isMac) {
    _macSetToken(service, token)
  } else if (isLinux) {
    _linuxSetToken(service, token)
  }
}

/**
 * Delete token from OS keychain.
 * @param {string} [service] - Keychain service name (default: 'chroxy')
 */
export function deleteToken(service = DEFAULT_SERVICE) {
  if (isMac) {
    _macDeleteToken(service)
  } else if (isLinux) {
    _linuxDeleteToken(service)
  }
}

/**
 * Migrate token from config object to keychain.
 *
 * If `config.apiToken` exists and keychain doesn't have a token yet,
 * stores it in the keychain and returns a new config without apiToken.
 *
 * @param {object} config - Config object (may have apiToken)
 * @param {string} [service] - Keychain service name
 * @returns {{ migrated: boolean, config: object }}
 */
export function migrateToken(config, service = DEFAULT_SERVICE) {
  if (!config.apiToken || !isKeychainAvailable()) {
    return { migrated: false, config }
  }

  const existing = getToken(service)
  if (existing) {
    // Already in keychain — no migration needed
    return { migrated: false, config }
  }

  // Store in keychain (if write fails, keep token in config)
  try {
    setToken(config.apiToken, service)
  } catch {
    return { migrated: false, config }
  }

  // Return config without apiToken
  const { apiToken, ...rest } = config
  return { migrated: true, config: rest }
}

// -- macOS implementation (security command) --

function _macGetToken(service) {
  try {
    const output = execFileSync('security', [
      'find-generic-password',
      '-s', service,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return output.trim() || null
  } catch {
    return null
  }
}

function _macGetTokenStatus(service) {
  try {
    const output = execFileSync('security', [
      'find-generic-password',
      '-s', service,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    const value = output.trim() || null
    // A zero exit with empty output should not happen for a stored secret, but
    // treat it as absence rather than a phantom "found null".
    return value ? { status: 'found', value, error: null } : { status: 'absent', value: null, error: null }
  } catch (err) {
    // errSecItemNotFound (44) = genuinely absent. Anything else = read failure.
    if (err && err.status === MAC_ERR_SEC_ITEM_NOT_FOUND) {
      return { status: 'absent', value: null, error: null }
    }
    const detail = (err && (err.stderr?.toString().trim() || err.message)) || `exit ${err?.status}`
    return { status: 'error', value: null, error: detail }
  }
}

function _macSetToken(service, token) {
  // -U flag updates existing entry or creates new one (atomic)
  execFileSync('security', [
    'add-generic-password',
    '-s', service,
    '-a', ACCOUNT,
    '-w', token,
    '-U',
  ], { stdio: 'pipe' })
}

function _macDeleteToken(service) {
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', service,
      '-a', ACCOUNT,
    ], { stdio: 'pipe' })
  } catch {
    // Not found — that's fine
  }
}

// -- Linux implementation (secret-tool / libsecret) --

function _linuxGetToken(service) {
  try {
    const output = execFileSync('secret-tool', [
      'lookup',
      'service', service,
      'account', ACCOUNT,
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return output.trim() || null
  } catch {
    return null
  }
}

function _linuxGetTokenStatus(service) {
  try {
    const output = execFileSync('secret-tool', [
      'lookup',
      'service', service,
      'account', ACCOUNT,
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    const value = output.trim() || null
    return value ? { status: 'found', value, error: null } : { status: 'absent', value: null, error: null }
  } catch (err) {
    // secret-tool exits 1 with NO stderr when the item simply isn't stored. A
    // non-empty stderr (or any other exit code) means the lookup itself failed
    // (locked collection / D-Bus error / no session bus) — fail safe to `error`.
    const stderr = (err && err.stderr?.toString().trim()) || ''
    if (!stderr && err && err.status === 1) {
      return { status: 'absent', value: null, error: null }
    }
    const detail = stderr || (err && err.message) || `exit ${err?.status}`
    return { status: 'error', value: null, error: detail }
  }
}

function _linuxSetToken(service, token) {
  execFileSync('secret-tool', [
    'store',
    '--label', `Chroxy API Token (${service})`,
    'service', service,
    'account', ACCOUNT,
  ], { input: token, stdio: ['pipe', 'pipe', 'pipe'] })
}

function _linuxDeleteToken(service) {
  try {
    execFileSync('secret-tool', [
      'clear',
      'service', service,
      'account', ACCOUNT,
    ], { stdio: 'pipe' })
  } catch {
    // Not found — that's fine
  }
}
