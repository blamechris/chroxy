/**
 * The one operator-label grammar for agent principals (agent-principals.md section 3),
 * in a leaf module so the store and the kill switch share it without importing each other.
 */
export const PRINCIPAL_LABEL_PATTERN = /^[a-z0-9_-]{1,32}$/
