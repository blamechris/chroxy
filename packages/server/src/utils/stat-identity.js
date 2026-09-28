/**
 * Shared stat-identity string for cache-by-content-change checks (#8030).
 *
 * `binary-version.js`'s `probeBinaryVersion` cache and `verify-provenance.js`'s
 * `sha256FileCached` / `assessMacSignatureCached` caches all need the same
 * answer to "did the file at this path change since I last looked at it?" —
 * this is the one place that answer is computed, so the two modules can't
 * drift on what "changed" means.
 *
 * The identity string is `path:dev:ino:size:mtimeMs:ctimeMs`. **ctime is
 * included deliberately**: `utimes(2)` lets userland set a file's mtime to
 * any value (including its OLD one), which would let a binary swap that
 * restores the original mtime hide from an mtime-only cache key. ctime is
 * the filesystem's own "metadata last changed" timestamp and cannot be set
 * by userland on any platform this project supports — a `write()` that
 * replaces the file's content always bumps it, even when the writer also
 * rewrites mtime afterward. dev+ino+size are still included alongside both
 * timestamps: they catch a same-path replacement whose new content happens
 * to land on the same byte size, or a filesystem where two timestamps
 * collide at the granularity the OS reports.
 *
 * Returns null when `statFn` throws (e.g. the path vanished) so a transient
 * stat failure can't be cached as a false identity by a caller — every
 * consumer here treats `null` as "cannot verify, don't cache."
 */

import { statSync as fsStatSync } from 'fs'

/**
 * @param {string} path - absolute path whose identity to compute.
 * @param {(p: string) => import('fs').Stats} [statFn=fs.statSync] - injectable in tests.
 * @returns {string|null} `path:dev:ino:size:mtimeMs:ctimeMs`, or null when `statFn` throws.
 */
export function statIdentity(path, statFn = fsStatSync) {
  try {
    const st = statFn(path)
    return `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
  } catch {
    return null
  }
}
