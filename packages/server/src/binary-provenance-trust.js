/**
 * Provider-binary provenance trust ledger (#6858).
 *
 * Pins the SHA-256 hash of every spawned provider binary (`claude`, `codex`,
 * `gemini`, `cloudflared`) the daemon has seen. A later change to a pinned hash
 * re-gates the binary (warn / block) — catching an in-place binary swap
 * regardless of code signature or macOS quarantine state. See
 * `utils/verify-provenance.js` for the verification logic and
 * `docs/security/spawned-binary-provenance.md` for the threat model.
 *
 * Storage shape (sidecar JSON file, next to skills-trust.json / session-preset-
 * trust.json):
 *
 *   {
 *     "binaries": {
 *       "/opt/homebrew/bin/codex": {
 *         "sha256": "<64 hex chars>",       // the binary's CONTENT hash
 *         "firstSeen": "2026-07-22T12:34:56.000Z",
 *         "approvedAt": "2026-07-22T12:34:56.000Z"
 *       }
 *     }
 *   }
 *
 * A path is TRUSTED only when its stored `sha256` equals the hash of the
 * currently-resolved binary. First sight (no record) → pin + allow
 * (trust-on-first-use). A changed hash → re-gated. The operator re-approves the
 * CURRENT hash via `approve(path, hash)`; `revoke(path)` drops the record.
 *
 * Since #5580 the ledger mechanics (load/isTrusted/approve/revoke/getRecord +
 * atomic 0600 persist + fail-open) live in `PathHashTrustLedger`; this class is
 * a thin subclass that pins the `binaries` wrapper key and the `approvedAt`
 * timestamp field. Best-effort flush (a read-only $HOME must never break
 * spawning — provenance is a defence-in-depth layer, not a hard dependency).
 */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createLogger } from './logger.js'
import { PathHashTrustLedger } from './path-hash-trust-ledger.js'

const log = createLogger('binary-provenance-trust')

export const DEFAULT_BINARY_TRUST_FILE = join(homedir(), '.chroxy', 'binary-trust.json')

/**
 * Normalise a ledger key for storage / lookup. On case-insensitive filesystems
 * (macOS APFS, Windows NTFS) the same binary can resolve to different casings,
 * so keys are lowercased there; on case-sensitive Linux the key is kept verbatim.
 * Mirrors the skills/preset stores' normaliser (kept local per the base-ledger
 * convention that each subclass owns its own key hook).
 *
 * @param {string} absPath
 * @returns {string}
 */
export function _normalizeKey(absPath) {
  if (typeof absPath !== 'string') return ''
  return (process.platform === 'darwin' || process.platform === 'win32')
    ? absPath.toLowerCase()
    : absPath
}

/**
 * In-memory + on-disk pin ledger for spawned provider binaries. One instance per
 * daemon (constructed by SessionManager); the cloudflared spawn path constructs
 * a second instance over the SAME default file so pins are unified. Tests pass an
 * explicit `filePath` so they never touch the real ledger.
 */
export class BinaryProvenanceLedger extends PathHashTrustLedger {
  /**
   * @param {{ filePath?: string }} [opts]
   */
  constructor({ filePath } = {}) {
    super({
      filePath: filePath || DEFAULT_BINARY_TRUST_FILE,
      log,
      normalizeKey: _normalizeKey,
      approvalField: 'approvedAt',
      wrapperKey: 'binaries',
      throwOnFlushError: false, // best-effort: a read-only $HOME never breaks spawning
    })
    const loaded = this._loadRecords()
    this._records = loaded.records
    this._dirty = false
  }
}

// Helper so tests / callers can confirm the ledger file exists.
export function binaryTrustFileExists(filePath) {
  try {
    return existsSync(filePath)
  } catch {
    return false
  }
}
