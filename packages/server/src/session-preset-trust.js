/**
 * Session-preset trust store (#5553).
 *
 * Mirrors the skills trust model (skills-trust.js): a repo-local preset that
 * silently feeds the system prompt is a prompt-injection vector for cloned /
 * collaborative repos. So the first time a repo-local `.chroxy/session.json` is
 * seen — or whenever its content hash CHANGES — the preset is INERT (pending)
 * until an operator approves it. Daemon-side config overrides are pre-trusted
 * (the operator wrote them) and never consult this store.
 *
 * Storage shape (sidecar JSON file next to skills-trust.json):
 *
 *   {
 *     "presets": {
 *       "/abs/path/to/.chroxy/session.json": {
 *         "sha256": "<64 hex chars>",        // the preset CONTENT hash
 *         "firstSeen": "2026-06-11T12:34:56.000Z",
 *         "approvedAt": "2026-06-11T12:34:56.000Z"
 *       }
 *     }
 *   }
 *
 * A path is TRUSTED only when its stored `sha256` equals the hash of the
 * currently-resolved preset content. First sight (no record) → pending. A
 * changed hash (record present but differs) → pending again (re-gated). The
 * operator approves the CURRENT hash via `approve(path, hash)`; `revoke(path)`
 * drops the record so the preset goes inert again.
 *
 * Since #5580 the ledger mechanics (load/isTrusted/approve/revoke/getRecord +
 * atomic 0600 persist + fail-open) live in `PathHashTrustLedger`; this class is
 * a thin subclass that pins the `presets` wrapper key and the `approvedAt`
 * timestamp field. The on-disk format is byte-identical to the pre-#5580 file.
 *
 * Persistence safety mirrors SkillsTrustStore: atomic write-via-rename, mode
 * 0600, fail-open on a corrupt/missing file. Failures are non-fatal (best-effort
 * flush) so a read-only $HOME never breaks session creation.
 */
import { existsSync } from 'fs'
import { createLogger } from './logger.js'
import { PathHashTrustLedger } from './path-hash-trust-ledger.js'
import { DEFAULT_PRESET_TRUST_FILE, _normalizePathKey } from './session-preset.js'

const log = createLogger('session-preset-trust')

export { DEFAULT_PRESET_TRUST_FILE }

/**
 * In-memory + on-disk trust ledger for repo-local session presets. One
 * instance per daemon (constructed by SessionManager); tests pass an explicit
 * `filePath` so they never touch the real ledger.
 */
export class SessionPresetTrustStore extends PathHashTrustLedger {
  /**
   * @param {{ filePath?: string }} [opts]
   */
  constructor({ filePath } = {}) {
    super({
      filePath: filePath || DEFAULT_PRESET_TRUST_FILE,
      log,
      normalizeKey: _normalizePathKey,
      approvalField: 'approvedAt',
      wrapperKey: 'presets',
      throwOnFlushError: false, // best-effort: a read-only $HOME never breaks session creation
    })
    const loaded = this._loadRecords()
    this._records = loaded.records
    this._dirty = false
  }
}

// Helper so tests can confirm the file existed at one point.
export function presetTrustFileExists(filePath) {
  try {
    return existsSync(filePath)
  } catch {
    return false
  }
}
