import { realpath } from 'fs/promises'
import { resolve, dirname, basename, join } from 'path'

/**
 * Shared utilities for file operations: CWD resolution, path validation, exec helpers.
 *
 * @param {Map} cwdRealCache - Shared cache for resolved CWD real paths
 * @param {number} cwdCacheTtl - TTL in milliseconds for cache entries
 */

/** Resolve a session CWD to its real path, caching with TTL */
export async function resolveSessionCwd(sessionCwd, cwdRealCache, cwdCacheTtl) {
  const key = resolve(sessionCwd)
  const cached = cwdRealCache.get(key)
  if (cached && Date.now() - cached.ts < cwdCacheTtl) {
    return cached.resolved
  }
  const resolved = await realpath(key)
  cwdRealCache.set(key, { resolved, ts: Date.now() })
  return resolved
}

/**
 * Resolve the real path of a (possibly-nonexistent) target by walking up
 * to the deepest existing ancestor, `realpath()`-ing that, and then
 * re-appending the unresolved tail components.
 *
 * Why this exists: the naive "realpath the target, fall back to lexical
 * on ENOENT" pattern has a symlink-escape bug on new-file paths. If
 * `packages/app/.venv/bin/evil.sh` doesn't exist but `.venv` is a
 * symlink to `/etc`, then:
 *   - realpath('.venv/bin/evil.sh') → ENOENT (bin/evil.sh doesn't exist)
 *   - fallback uses the lexical path → looks like it stays in workspace
 *   - O_NOFOLLOW only checks the FINAL component → the kernel happily
 *     follows the `.venv` symlink to `/etc` and writes there
 *
 * Walking up to the deepest existing ancestor closes the gap: realpath
 * on `.venv/` yields `/etc`, we reconstruct the target as `/etc/bin/
 * evil.sh`, and it's then obviously outside the workspace.
 *
 * Found in the 2026-04-11 production readiness audit (blocker 4) —
 * defeats the otherwise-correct 04a2fbbb1 realpath-TOCTOU fix on the
 * new-file code path.
 *
 * @param {string} absPath - Absolute path to resolve (may not exist)
 * @returns {Promise<string>} Real path with all symlink ancestors resolved
 */
export async function realpathOfDeepestAncestor(absPath) {
  const segments = []
  let cursor = absPath
  // Safety ceiling — absolute paths should never nest more than a few
  // dozen components, but guard against pathological inputs.
  const MAX_DEPTH = 256
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      const realAncestor = await realpath(cursor)
      if (segments.length === 0) return realAncestor
      // Rebuild: realAncestor + segments in the order they were stripped.
      // `segments` was pushed leaf-first (cursor kept moving up), so
      // reverse to get ancestor→leaf order for join().
      return join(realAncestor, ...segments.slice().reverse())
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      const parent = dirname(cursor)
      if (parent === cursor) {
        // Reached the filesystem root without finding any existing
        // ancestor — treat as lexical. This should be unreachable on
        // any real OS (root always exists).
        return absPath
      }
      segments.push(basename(cursor))
      cursor = parent
    }
  }
  // Depth ceiling hit — bail with the lexical path; caller will still
  // apply the cwdReal prefix check.
  return absPath
}

/**
 * Validate that a resolved path is within the session CWD.
 * Follows symlinks to prevent symlink escape.
 *
 * For targets that don't exist yet (new-file writes), walks up to the
 * deepest existing ancestor so symlinks in the parent chain still get
 * resolved — see realpathOfDeepestAncestor above for the failure mode
 * this closes.
 *
 * @param {string} absPath - Absolute path to validate
 * @param {string} sessionCwd - Session working directory
 * @param {Map} cwdRealCache - Shared cache
 * @param {number} cwdCacheTtl - Cache TTL
 * @returns {Promise<{ valid: boolean, realPath: string, cwdReal: string }>}
 */
export async function validatePathWithinCwd(absPath, sessionCwd, cwdRealCache, cwdCacheTtl) {
  const cwdReal = await resolveSessionCwd(sessionCwd, cwdRealCache, cwdCacheTtl)
  const realAbsPath = await realpathOfDeepestAncestor(absPath)
  const valid = realAbsPath.startsWith(cwdReal + '/') || realAbsPath === cwdReal
  return { valid, realPath: realAbsPath, cwdReal }
}

/** Cache for resolved workspaceRoot realpaths (key: raw path, value: resolved) */
const _workspaceRootCache = new Map()

/**
 * Validate that a git repo path is within the workspace root.
 * Uses realpath() to resolve symlinks, preventing symlink traversal outside the root.
 * Caches the workspaceRoot realpath since it doesn't change during a server's lifetime.
 *
 * @param {string} repoPath - The directory path for the git operation
 * @param {string} workspaceRoot - The allowed workspace root directory
 * @throws {Error} If repoPath resolves outside the workspace root
 * @returns {Promise<string>} The resolved real path of repoPath
 */
export async function validateGitPath(repoPath, workspaceRoot) {
  // Normalize cache key so relative paths and trailing-slash variants don't create duplicates
  const cacheKey = resolve(workspaceRoot)
  let resolvedRoot = _workspaceRootCache.get(cacheKey)
  if (!resolvedRoot) {
    resolvedRoot = await realpath(workspaceRoot)
    _workspaceRootCache.set(cacheKey, resolvedRoot)
  }
  let resolvedRepo
  try {
    resolvedRepo = await realpath(repoPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      resolvedRepo = resolve(repoPath)
    } else {
      throw err
    }
  }
  if (!resolvedRepo.startsWith(resolvedRoot + '/') && resolvedRepo !== resolvedRoot) {
    throw Object.assign(
      new Error(`Access denied: git operations are restricted to the workspace directory`),
      { code: 'EACCES' }
    )
  }
  return resolvedRepo
}
