/**
 * Which read error codes describe one file that was read, and which describe
 * the source. The only classifier: every consumer asks `isFileLevelReadError`.
 *
 * A code is listed only if it describes one file in every adapter that emits it
 * (`shape_changed` is not: the state-file and registry adapters report it for the
 * whole source). An allowlist, so it fails safe: a code that is not named here (an unknown or
 * future code, a missing one, `unreadable`, `source_missing`, `unsupported`,
 * `adapter_fault`) counts as describing the source, as every error did before
 * the split. The docs guide lists the same codes and a test holds the two
 * lists equal.
 */
export const FILE_LEVEL_READ_ERRORS = Object.freeze(new Set(['window_exhausted', 'tail_too_small', 'corrupt', 'bad_timestamp']))

/** Whether an error code describes the one file that was read, not the source. */
export function isFileLevelReadError(code) {
  return typeof code === 'string' && FILE_LEVEL_READ_ERRORS.has(code)
}

/** Whether a check state (`outcome`, `errorCode`) is an error that describes the source. */
export function isSourceLevelError(check) {
  return Boolean(check) && check.outcome === 'error' && !isFileLevelReadError(check.errorCode)
}
