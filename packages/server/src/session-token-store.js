// session-token-store.js — persist paired session tokens across daemon restarts
// (#6598). Without this, PairingManager._sessionTokens is in-memory only, so any
// restart (supervisor auto-restart, update, crash, reboot) wipes every paired
// device's token and forces a re-pair.
//
// The store is encrypted at rest with the shared credential cipher (a random data
// key in the OS keychain) — see credential-cipher.js — and written 0600 owner-only.
// Where no keychain is available (Windows, headless Linux without secret-tool) it
// falls back to 0600 plaintext, matching the credential store's posture.
//
// PairingManager stays filesystem-agnostic: it takes this as an injected
// { load, save } adapter, so tests can drive it with an in-memory fake.
import { readFileSync, statSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { writeFileRestricted } from './platform.js'
import { getOrCreateMasterKey, encryptJson, decryptEnvelope, isEncryptedEnvelope } from './credential-cipher.js'
import * as realKeychain from './keychain.js'
import { createLogger } from './logger.js'

const log = createLogger('session-token-store')
const STORE_FILE = 'session-tokens.json'

/**
 * Build a persistence adapter for the session-token map.
 *
 * @param {object} opts
 * @param {string} opts.dir - directory to hold the store (e.g. `~/.chroxy`).
 * @param {object} [opts.keychain] - keychain module (injectable for tests).
 * @returns {{ load: () => Array<[string, object]>, save: (entries: Array<[string, object]>) => void }}
 *   `entries` is the `[token, meta]` pair list from the PairingManager map.
 */
export function createSessionTokenStore({ dir, keychain = realKeychain } = {}) {
  const file = join(dir, STORE_FILE)

  return {
    load() {
      try {
        if (!existsSync(file)) return []
        // Enforce owner-only 0600 (POSIX) — same boundary as the credential store.
        // A world/group-readable token file is refused rather than trusted.
        if (process.platform !== 'win32') {
          const perms = statSync(file).mode & 0o777
          if (perms !== 0o600) {
            log.warn(`${file} has mode ${perms.toString(8).padStart(3, '0')}; refusing to read (must be 0600) — devices will re-pair`)
            return []
          }
        }
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (isEncryptedEnvelope(parsed)) {
          const key = getOrCreateMasterKey(keychain)
          if (!key) {
            log.warn('session-token store is encrypted but no keychain key is available — devices will re-pair')
            return []
          }
          const data = decryptEnvelope(parsed, key)
          return Array.isArray(data?.entries) ? data.entries : []
        }
        // Plaintext fallback (no-keychain host).
        return Array.isArray(parsed?.entries) ? parsed.entries : []
      } catch (err) {
        // A missing / corrupt / undecryptable store is not fatal: the worst case
        // is that devices re-pair (the pre-#6598 behaviour). Never throw into the
        // auth path.
        log.warn(`could not load persisted session tokens (${err.message}) — devices will re-pair`)
        return []
      }
    },

    save(entries) {
      try {
        mkdirSync(dir, { recursive: true })
        const payload = { v: 1, entries }
        const key = getOrCreateMasterKey(keychain)
        const body = key ? JSON.stringify(encryptJson(payload, key)) : JSON.stringify(payload)
        writeFileRestricted(file, body)
      } catch (err) {
        // Persistence is best-effort: a failed write just means a restart may
        // require re-pairing. Don't let it break token issuance.
        log.warn(`could not persist session tokens (${err.message})`)
      }
    },
  }
}
