import { realpath } from 'fs/promises'
import { resolve } from 'path'

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
 * Validate that a resolved path is within the session CWD.
 * Follows symlinks to prevent symlink escape.
 *
 * @param {string} absPath - Absolute path to validate
 * @param {string} sessionCwd - Session working directory
 * @param {Map} cwdRealCache - Shared cache
 * @param {number} cwdCacheTtl - Cache TTL
 * @returns {Promise<{ valid: boolean, realPath: string, cwdReal: string }>}
 */
export async function validatePathWithinCwd(absPath, sessionCwd, cwdRealCache, cwdCacheTtl) {
  const cwdReal = await resolveSessionCwd(sessionCwd, cwdRealCache, cwdCacheTtl)
  let realAbsPath
  try {
    realAbsPath = await realpath(absPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      realAbsPath = absPath
    } else {
      throw err
    }
  }
  const valid = realAbsPath.startsWith(cwdReal + '/') || realAbsPath === cwdReal
  return { valid, realPath: realAbsPath, cwdReal }
}

/**
 * Validate that a git repo path is within the workspace root.
 * Uses realpath() to resolve symlinks, preventing symlink traversal outside the root.
 *
 * @param {string} repoPath - The directory path for the git operation
 * @param {string} workspaceRoot - The allowed workspace root directory
 * @throws {Error} If repoPath resolves outside the workspace root
 * @returns {Promise<string>} The resolved real path of repoPath
 */
export async function validateGitPath(repoPath, workspaceRoot) {
  const resolvedRoot = await realpath(workspaceRoot)
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
