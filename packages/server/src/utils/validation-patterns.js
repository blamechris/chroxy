/**
 * Shared validation regexes (#6201 DRY consolidation).
 *
 * These patterns validate untrusted string inputs and were previously copied
 * verbatim across several modules — the copies even cross-referenced each other
 * in comments ("same regex as docker-sdk-session.js"), the textbook DRY smell.
 * Single-sourcing them keeps every call site in lockstep, so a future tightening
 * (or loosening) lands everywhere at once instead of drifting silently.
 */

/**
 * Valid POSIX/container username: starts with a lowercase letter or underscore,
 * then up to 31 more lowercase-alphanumeric, underscore, or hyphen characters
 * (32 total — the traditional `useradd` limit). Refusing anything else stops a
 * caller-supplied string from smuggling a `docker exec -u` flag.
 */
export const VALID_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/**
 * Lower-case SHA-256 hex digest: exactly 64 hex characters. Used to validate
 * trust-ledger hashes (path-hash-trust-ledger.js, skills-trust.js).
 */
export const HEX64 = /^[0-9a-f]{64}$/
