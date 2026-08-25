import { writeFileSync, renameSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'

/**
 * The permission-mode sidecar: the IPC channel between a live chroxy session
 * and the `permission-hook.sh` processes its provider subprocess spawns.
 *
 * `permission-hook.sh` resolves the mode as
 *   1. CHROXY_PERMISSION_MODE_FILE — re-read on EVERY tool call
 *   2. CHROXY_PERMISSION_MODE      — frozen at subprocess spawn
 *   3. "approve"
 *
 * (1) exists because a running subprocess's environment cannot be mutated
 * from outside. Introduced for the TUI in #4013; extended to `claude-cli`
 * in #7337, whose only refresh channel had been a destructive kill+respawn
 * that leaves the OLD child — still firing hooks — reading the stale mode.
 *
 * This module is the single implementation. Two hand-written copies of the
 * same atomic-write dance is the drift class `docs/false-safety-guards.md`
 * catalogues; both session classes call in here instead.
 */

/**
 * Write `value` to `path` atomically: write a tmp file, then rename(2) over
 * the target.
 *
 * A direct `writeFileSync` truncates-then-writes, so a concurrent PreToolUse
 * hook `cat` can observe an empty or partial value mid-write and silently
 * fall through to the stale env var (#5334). rename(2) is atomic within a
 * filesystem, so a reader sees either the OLD complete value or the NEW
 * complete value — never a torn one.
 *
 * Throws on failure (after a best-effort tmp cleanup) so each caller applies
 * its own fallback rather than inheriting one.
 *
 * @param {string} path  Sidecar path. The tmp file is created alongside it,
 *   so the directory must exist and be on the same filesystem.
 * @param {string} value The permission mode to publish.
 */
export function writePermissionModeSidecarAtomic(path, value) {
  const tmpPath = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(tmpPath, value)
    renameSync(tmpPath, path)
  } catch (err) {
    try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
    throw err
  }
}
