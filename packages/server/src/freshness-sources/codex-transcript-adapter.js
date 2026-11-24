/**
 * Codex transcripts: not supported, and said so.
 *
 * The transcript locator marks the Codex format unsupported
 * (`resolveTranscriptSource`), and no recorded Codex transcript sample backs a
 * reader yet. A reader written from a guess at the format could read a
 * different record as the status block, or read nothing and report a quiet
 * session. This adapter therefore reads nothing: it cannot list, and every read
 * is `error: unsupported`. It opens no file. The reconciler records an
 * unlistable source as `source_unreadable` and an unsupported read as an
 * `error` check, so a Codex session is never graded `idle` and never reads as
 * having no status.
 *
 * Replace this with a tail reader like `claude-transcript-adapter.js` once a
 * sample of the format is recorded and the locator supports it.
 */

import { AdapterContractError, validSourceName } from '../freshness/adapter.js'

export const CODEX_TRANSCRIPT_SOURCE = 'codex-transcript'

/** The capabilities to register for this source in the reconciler's configuration. */
export const CODEX_TRANSCRIPT_CAPS = Object.freeze({ native_in_read: false, activity_read: false, scope: false, can_confirm_gone: false, report_time_basis: 'authored_at' })

/** @param {{ source?: string }} [opts] */
export function createCodexTranscriptAdapter({ source = CODEX_TRANSCRIPT_SOURCE } = {}) {
  if (!validSourceName(source)) throw new AdapterContractError('adapter.source must be a short lowercase name')
  return {
    source,
    list: () => null,
    read: () => ({ outcome: 'error', error_code: 'unsupported' }),
  }
}
