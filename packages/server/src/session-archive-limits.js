// Limits shared by the session-archive implementation (session-archive.js) and
// the config validator (config.js). A module of its own so config.js can name
// the bound without importing the archive's runtime dependencies, and so the two
// cannot drift apart.

// The roster is one WebSocket frame and the retention pass is linear in it.
export const SESSION_ARCHIVE_MAX_ENTRIES = 1000
