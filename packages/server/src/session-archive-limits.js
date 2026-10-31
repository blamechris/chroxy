// Limits shared by the session-archive implementation (session-archive.js) and
// the config validator (config.js). A module of its own so config.js can name
// the bound without importing the archive's runtime dependencies, and so the two
// cannot drift apart.

// The roster is one WebSocket frame and the retention pass is linear in it.
export const SESSION_ARCHIVE_MAX_ENTRIES = 1000

// Whether a persisted session entry holds any history for the archive to keep.
// The archive skips an entry without it (nothing to read), and the boot
// staleness filter keeps such an entry live instead of setting it aside (#8870),
// so the two must use one rule: every stale session is either archived or kept.
export function savedHasHistory(saved) {
  return !!saved && typeof saved === 'object' && Array.isArray(saved.history) && saved.history.length > 0
}
