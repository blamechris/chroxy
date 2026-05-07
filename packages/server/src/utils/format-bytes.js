/**
 * Render a byte count as a human-readable string with a binary-prefix unit
 * (`B`, `KiB`, `MiB`, `GiB`).  Used in operator log lines where a raw byte
 * count is hard to scan at a glance — e.g. the `stdin_dropped` cumulative
 * total at the 10 MiB error-escalation threshold reads `10485760` raw, but
 * `10.0 MiB` after formatting (#3543).
 *
 * Conventions:
 *   - Below 1024:           `${n} B`            (no decimal — bytes are exact)
 *   - 1024 .. 1024^2-1:     `${k.kk} KiB`       (one decimal)
 *   - 1024^2 .. 1024^3-1:   `${m.mm} MiB`       (one decimal)
 *   - >= 1024^3:            `${g.gg} GiB`       (one decimal)
 *
 * The decimal is always one digit so threshold-cross log lines stay aligned
 * and scriptable consumers can parse the suffix with a fixed-width regex.
 *
 * @param {number} bytes - Non-negative integer byte count.
 * @returns {string} Humanised label, e.g. `"10.0 MiB"`.
 */
export function formatBytes(bytes) {
  // Defensive: non-finite or negative inputs fall back to a B label so the
  // caller's log line stays well-formed even if it ever hands us junk.
  if (!Number.isFinite(bytes) || bytes < 0) {
    return `${bytes} B`
  }

  const KIB = 1024
  const MIB = 1024 * 1024
  const GIB = 1024 * 1024 * 1024

  if (bytes < KIB) return `${bytes} B`
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KiB`
  if (bytes < GIB) return `${(bytes / MIB).toFixed(1)} MiB`
  return `${(bytes / GIB).toFixed(1)} GiB`
}
