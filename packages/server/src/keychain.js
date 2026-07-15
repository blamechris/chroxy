/**
 * OS keychain integration for secure token storage.
 *
 * Uses native CLI tools (no npm dependencies):
 * - macOS: `security` command (Keychain Services)
 * - Linux: `secret-tool` (libsecret)
 * - Windows/fallback: returns null (caller falls back to chmod 600 file)
 */
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isMac, isLinux, isWindows, writeFileRestricted } from './platform.js'

const DEFAULT_SERVICE = 'chroxy'
const ACCOUNT = 'api-token'

// -- Windows DPAPI backend (#6644) --
// Windows has no launchd/systemd-style secret CLI, so the keychain "token"
// (e.g. the credential-cipher data key, the API token) is protected with the
// per-user DPAPI master key and stored under %LOCALAPPDATA%\Chroxy\. Protect/
// Unprotect run in PowerShell with the secret passed over STDIN (never argv —
// process args are world-readable via WMI on Windows), mirroring the Linux
// secret-tool stdin pattern. The ciphertext file is written owner-only via
// writeFileRestricted (icacls DACL, #6644).
// Read LAZILY (not a module const) so tests can redirect LOCALAPPDATA to a temp
// dir and stay hermetic, mirroring the keychain off-switch's per-call read.
function winCredDir() {
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Chroxy')
}
const WIN_POWERSHELL = `${process.env.SystemRoot || process.env.windir || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const PS_PROTECT = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$p=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($p);$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($e))"
const PS_UNPROTECT = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))"

/**
 * Global off-switch for OS keychain access.
 *
 * When `CHROXY_DISABLE_KEYCHAIN=1`, every entry point below behaves as if no
 * keychain exists: `isKeychainAvailable()` is false, reads return
 * null/`absent`, and writes/deletes no-op. Callers then transparently fall back
 * to their file/env paths.
 *
 * Read LAZILY (per call, not at import) so tests can toggle it per-process:
 * `tests/_setup.mjs` sets it for the whole suite to stop server tests from
 * shelling out to the real `security`/`secret-tool` — which on a developer's
 * box pollutes (or, with a broken login keychain, pops modal prompts for) the
 * real keychain. This mirrors `CHROXY_CRED_DISABLE_KEYCHAIN` for the credential
 * data-key store; here it covers the api-token keychain. Tests that genuinely
 * drive the keychain code path clear the flag (real integration: keychain.test.js
 * under `CHROXY_TEST_REAL_KEYCHAIN=1`; mocked child_process: keychain-mock.test.js).
 */
function keychainDisabled() {
  return process.env.CHROXY_DISABLE_KEYCHAIN === '1'
}

/**
 * Cached, NON-PROMPTING "is the OS keychain actually usable" probe.
 *
 * The previous `isKeychainAvailable()` only ran `security help`, which succeeds
 * even on a box whose LOGIN keychain is missing/corrupt ("keychain cannot be
 * found"). So the daemon then shelled out to `security find-/add-generic-password`
 * — and macOS answers an inaccessible keychain with a BLOCKING MODAL before
 * returning an error. This probe verifies, without opening the keychain (no
 * modal), that the configured default keychain file actually exists (macOS) or
 * that the backend CLI is present (Linux). When it can't prove the keychain is
 * usable, callers fall back to file/env storage silently.
 *
 * `security default-keychain` only PRINTS the configured path (it does not open
 * the keychain → no prompt); `existsSync` then confirms the file is there. An
 * empty/unparseable path is treated as INCONCLUSIVE → usable, so prior behaviour
 * and mocked tests (which stub execFileSync) are preserved — only a NON-EMPTY
 * path that is missing is a definitive "broken keychain".
 *
 * Cached per-process: the result is stable for a daemon's lifetime (repair the
 * keychain → restart to pick it up). Reset in tests via the export below.
 */
let _keychainUsableCache = null

/** Test-only: clear the cached usability probe so a test can re-toggle it. */
export function _resetKeychainHealthForTests() {
  _keychainUsableCache = null
}

function keychainUsable() {
  if (_keychainUsableCache !== null) return _keychainUsableCache
  _keychainUsableCache = _probeKeychainUsable()
  return _keychainUsableCache
}

function _probeKeychainUsable() {
  if (isMac) {
    try {
      const out = execFileSync('security', ['default-keychain', '-d', 'user'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      // Output is the quoted path, e.g.  "/Users/x/Library/Keychains/login.keychain-db"
      const path = out.trim().replace(/^"(.*)"$/, '$1')
      // INCONCLUSIVE → assume usable (preserve prior behaviour + keep mocked
      // tests working): empty output, OR anything that isn't an absolute path
      // (a mocked/stubbed value, an unexpected `security` format). Only an
      // absolute path that is actually MISSING is a definitive broken-keychain
      // signal — never run existsSync() on a non-path and mistake it for broken.
      if (!path || !path.startsWith('/')) return true
      return existsSync(path)
    } catch {
      // `security` absent or errored → treat as not usable (file fallback).
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
  if (isWindows) {
    // DPAPI is usable if a Protect→Unprotect round-trip works for this user.
    return _probeDpapiUsable()
  }
  return false
}

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
  if (keychainDisabled()) return false
  // Gate on the non-prompting usability probe (CLI present AND the default
  // keychain file actually exists) so a broken/missing login keychain reports
  // unavailable instead of letting callers trigger the macOS "keychain cannot
  // be found" modal.
  return keychainUsable()
}

/**
 * True when the keychain is present-but-UNUSABLE (broken/missing login keychain),
 * as DISTINCT from explicitly disabled (`CHROXY_DISABLE_KEYCHAIN=1`) or simply
 * absent.
 *
 * The server-identity loader (#5615) needs this distinction: a broken keychain
 * must not silently rotate the identity. It uses `isKeychainBroken()` to fail
 * safe — refuse to mint a replacement when it can't confirm there's no pinned
 * identity in the (now unreadable) keychain AND no fallback file exists. The
 * probe is non-prompting, so this never triggers the macOS modal.
 *
 * Non-macOS hosts are NEVER classified as broken here: `isKeychainBroken()`
 * returns false for every non-mac platform, regardless of `secret-tool`. When
 * `secret-tool`/libsecret is missing on Linux that is the documented headless/
 * no-keychain fallback case, so identity storage mints/reloads the 0600 file
 * like other unsupported hosts. When a Linux keychain IS available but a lookup
 * fails, the fail-safe lives elsewhere: `getTokenStatus()` still reports `error`
 * and the identity loader refuses to rotate — it does not rely on this function.
 */
export function isKeychainBroken() {
  if (keychainDisabled()) return false
  if (!isMac) return false
  return !keychainUsable()
}

/**
 * @typedef {object} KeychainHealth
 * @property {'usable'|'broken'|'disabled'|'unsupported'} status — keychain state.
 * @property {'keychain'|'dpapi'|'file'} backend — where credentials are ACTUALLY
 *   stored right now: the OS keychain (mac/linux), Windows DPAPI (#6644), or the
 *   0600 file/env fallback whenever no secret backend is usable.
 * @property {string} detail — one-line human explanation of the status.
 * @property {string} [repairHint] — present only for `broken`: how to fix it.
 */

/**
 * Operator-facing keychain diagnosis for `chroxy doctor` (#6236) — a single
 * non-prompting source of truth (no `find-/add-generic-password`, so no macOS
 * modal) that classifies the keychain and reports which backend credentials land
 * in. Mirrors the runtime gating in {@link isKeychainAvailable}:
 *   - `disabled`    — `CHROXY_DISABLE_KEYCHAIN=1` set → file/env owns secrets.
 *   - `unsupported` — no OS keychain on this platform (Windows/other) → file.
 *   - `broken`      — mac/linux keychain present but unreadable/missing → file
 *                     (this is the silent #6235 fallback the operator should see).
 *   - `usable`      — secrets are in the OS keychain.
 */
export function keychainHealth() {
  if (keychainDisabled()) {
    return {
      status: 'disabled',
      backend: 'file',
      detail: 'OS keychain disabled via CHROXY_DISABLE_KEYCHAIN — using the 0600 file/env fallback',
    }
  }
  if (isWindows) {
    // Windows uses DPAPI (per-user), not a keychain CLI (#6644).
    if (keychainUsable()) {
      return {
        status: 'usable',
        backend: 'dpapi',
        detail: 'credentials are protected with Windows DPAPI (per-user, CurrentUser scope)',
      }
    }
    return {
      status: 'unsupported',
      backend: 'file',
      detail: 'Windows DPAPI/PowerShell unavailable — using the 0600 file/env fallback',
    }
  }
  if (!isMac && !isLinux) {
    return {
      status: 'unsupported',
      backend: 'file',
      detail: 'no OS keychain on this platform — using the 0600 file/env fallback',
    }
  }
  if (!keychainUsable()) {
    return {
      status: 'broken',
      backend: 'file',
      detail: isMac
        ? 'macOS login keychain is missing or unreadable — credentials fell back to the 0600 file'
        : 'Linux secret service (secret-tool/libsecret) is unavailable — credentials fell back to the 0600 file',
      repairHint: isMac
        ? 'recreate the login keychain in Keychain Access (File ▸ New Keychain, or reset via "security" / a relogin), then re-store with `chroxy init`'
        : 'ensure libsecret/`secret-tool` and a running secret service (e.g. gnome-keyring) are available, then re-store with `chroxy init`',
    }
  }
  return {
    status: 'usable',
    backend: 'keychain',
    detail: 'credentials are stored in the OS keychain',
  }
}

/**
 * Get token from OS keychain.
 * @param {string} [service] - Keychain service name (default: 'chroxy')
 * @param {string} [account] - Keychain account (default: 'api-token'). Other
 *   credentials reuse the same OS keychain under a different account — e.g. the
 *   Discord webhook URL at service `chroxy-discord-webhook` / account
 *   `webhook-url` (#5493).
 * @returns {string|null} Token or null if not found
 */
export function getToken(service = DEFAULT_SERVICE, account = ACCOUNT) {
  // Gate on usability (disabled OR broken keychain) so a missing login keychain
  // never reaches the prompting `security find-generic-password` call.
  if (!isKeychainAvailable()) return null
  if (isMac) {
    return _macGetToken(service, account)
  }
  if (isLinux) {
    return _linuxGetToken(service, account)
  }
  if (isWindows) {
    return _winGetToken(service, account)
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
  // The explicit off-switch (tests) → 'absent': the file fallback owns identity.
  if (keychainDisabled()) return { status: 'absent', value: null, error: null }
  // Platforms with NO secret backend at all → 'absent': there is nothing that
  // could hold an identity, so the file legitimately owns it (the documented
  // "other platforms" contract). Windows HAS a backend (DPAPI, #6644) so it is
  // not lumped in here.
  if (!isMac && !isLinux && !isWindows) return { status: 'absent', value: null, error: null }
  // Windows with DPAPI/PowerShell unavailable also has no usable backend → the
  // file owns identity, so report 'absent' (not the mac/linux broken → 'error').
  if (isWindows && !keychainUsable()) return { status: 'absent', value: null, error: null }
  // #5615 fail-safe: on mac/linux a BROKEN/missing keychain reads as 'error',
  // NOT 'absent' — an identity caller that re-mints on 'absent' would false-MITM
  // every already-pinned client. 'error' fails safe (don't rotate) AND avoids
  // the prompting find-generic-password call (no modal).
  if (!keychainUsable()) {
    return { status: 'error', value: null, error: 'keychain unavailable (missing or broken login keychain)' }
  }
  if (isMac) {
    return _macGetTokenStatus(service)
  }
  if (isWindows) {
    return _winGetTokenStatus(service)
  }
  return _linuxGetTokenStatus(service)
}

/**
 * Store token in OS keychain.
 * @param {string} token - Token to store
 * @param {string} [service] - Keychain service name (default: 'chroxy')
 */
export function setToken(token, service = DEFAULT_SERVICE) {
  // Gate on usability so a broken keychain never reaches the prompting
  // `security add-generic-password` call (the "store API token" modal).
  if (!isKeychainAvailable()) return
  if (isMac) {
    _macSetToken(service, token)
  } else if (isLinux) {
    _linuxSetToken(service, token)
  } else if (isWindows) {
    _winSetToken(service, token)
  }
}

/**
 * Delete token from OS keychain.
 * @param {string} [service] - Keychain service name (default: 'chroxy')
 */
export function deleteToken(service = DEFAULT_SERVICE) {
  if (!isKeychainAvailable()) return
  if (isMac) {
    _macDeleteToken(service)
  } else if (isLinux) {
    _linuxDeleteToken(service)
  } else if (isWindows) {
    _winDeleteToken(service)
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

function _macGetToken(service, account = ACCOUNT) {
  try {
    const output = execFileSync('security', [
      'find-generic-password',
      '-s', service,
      '-a', account,
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

function _linuxGetToken(service, account = ACCOUNT) {
  try {
    const output = execFileSync('secret-tool', [
      'lookup',
      'service', service,
      'account', account,
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

// -- Windows implementation (DPAPI via PowerShell) --

// Ciphertext file for a (service, account) pair. Non-filename characters are
// squashed so a service like `chroxy-cred-key` maps to a safe path; the pair is
// preserved so different accounts under one service never collide.
function _winCredFile(service, account) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(winCredDir(), `${safe(service)}__${safe(account)}.dpapi`)
}

// Run a DPAPI Protect/Unprotect. The secret (plaintext to protect, or base64
// ciphertext to unprotect) is passed on STDIN; the result comes back on STDOUT.
// Nothing sensitive is ever placed in argv.
function _dpapi(script, input) {
  return String(execFileSync(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(input, 'utf-8'),
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }))
}

function _winSetToken(service, token) {
  const cipher = _dpapi(PS_PROTECT, token).trim()
  if (!cipher) throw new Error('DPAPI Protect returned empty ciphertext')
  const dir = winCredDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // Owner-only DACL is stamped by writeFileRestricted (icacls, #6644).
  writeFileRestricted(_winCredFile(service, ACCOUNT), cipher)
}

function _winGetToken(service, account = ACCOUNT) {
  const file = _winCredFile(service, account)
  if (!existsSync(file)) return null
  try {
    const plain = _dpapi(PS_UNPROTECT, readFileSync(file, 'utf-8')).replace(/\r?\n$/, '')
    return plain || null
  } catch {
    // Corrupt ciphertext, wrong user (DPAPI is per-user), or PowerShell/DPAPI
    // unavailable → treat as unreadable (caller falls back / re-prompts).
    return null
  }
}

function _winGetTokenStatus(service) {
  const file = _winCredFile(service, ACCOUNT)
  if (!existsSync(file)) return { status: 'absent', value: null, error: null }
  try {
    const plain = _dpapi(PS_UNPROTECT, readFileSync(file, 'utf-8')).replace(/\r?\n$/, '')
    return plain
      ? { status: 'found', value: plain, error: null }
      : { status: 'absent', value: null, error: null }
  } catch (err) {
    // A stored-but-unreadable entry is an ERROR (not absence): a caller that
    // re-mints on 'absent' must fail safe here (mirrors the mac/linux contract).
    return { status: 'error', value: null, error: (err && err.message) || 'DPAPI unprotect failed' }
  }
}

function _winDeleteToken(service) {
  const file = _winCredFile(service, ACCOUNT)
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    // Best-effort — a missing/locked file is fine.
  }
}

// DPAPI availability probe: a round-trip of a marker string. Proves PowerShell +
// ProtectedData are usable for THIS user before we advertise the backend.
function _probeDpapiUsable() {
  try {
    const marker = 'chroxy-dpapi-probe'
    const cipher = _dpapi(PS_PROTECT, marker).trim()
    if (!cipher) return false
    return _dpapi(PS_UNPROTECT, cipher).replace(/\r?\n$/, '') === marker
  } catch {
    return false
  }
}
