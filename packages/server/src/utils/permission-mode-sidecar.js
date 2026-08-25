import { randomUUID } from 'crypto'
import { writeFileRestricted } from '../platform.js'

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
 * This module is the single seam both session classes call. It is a thin
 * wrapper, not a third implementation: the atomic write itself belongs to
 * `platform.writeFileRestricted`, which #4874 established as the ONE
 * tmp+rename(2) helper after collapsing the hand-rolled copies in
 * environment-manager.js and models.js onto it.
 */

/**
 * Publish `value` to the sidecar at `path`, atomically and owner-only.
 *
 * Atomic because a direct `writeFileSync` truncates-then-writes, so a
 * concurrent PreToolUse hook `cat` can observe an empty or partial value and
 * silently fall through to the stale env var (#5334). rename(2) is atomic
 * within a filesystem, so a reader sees either the OLD complete value or the
 * NEW complete value — never a torn one.
 *
 * Owner-only (0600 POSIX / owner DACL on Windows) because this file's contents
 * decide whether a tool call is prompted. `writeFileRestricted` also carries the
 * Windows AV-held-handle rename retry, which a hand-rolled copy would not.
 *
 * The tmp suffix is randomised so two writers racing on one sidecar — a respawn
 * seeding it while a mode change publishes to it — cannot collide on the
 * intermediate file.
 *
 * Throws on failure (after `writeFileRestricted`'s own tmp cleanup) so each
 * caller applies its own fallback.
 *
 * @param {string} path  Sidecar path. The tmp file is created alongside it, so
 *   the directory must exist.
 * @param {string} value The permission mode to publish.
 */
export function writePermissionModeSidecarAtomic(path, value) {
  writeFileRestricted(path, value, { tmpSuffix: `.tmp-${randomUUID()}` })
}
