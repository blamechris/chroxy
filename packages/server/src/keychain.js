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

  // Store in keychain
  setToken(config.apiToken, service)

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

function _macSetToken(service, token) {
  // Delete existing first (add-generic-password fails if it exists)
  _macDeleteToken(service)
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
