import { homedir } from 'os'
import { resolveSessionCwd, validatePathWithinCwd } from './common.js'
import { createBrowserOps } from './browser.js'
import { createReaderOps } from './reader.js'
import { createGitOps } from './git.js'

/**
 * Create file operation handlers for the WsServer.
 * These methods handle directory browsing, file reading, git diffs,
 * and slash command / agent listing.
 *
 * @param {Function} sendFn - (ws, message) => void — sends a message to a single client
 * @param {string} [workspaceRoot] - Optional workspace root to restrict git operations (defaults to home directory)
 * @returns {Object} File operation methods
 */
export function createFileOps(sendFn, workspaceRoot) {
  // Cache resolved CWD real paths with TTL to avoid repeated syscalls
  // while allowing stale entries to be refreshed if symlinks change.
  const _cwdRealCache = new Map()
  const CWD_CACHE_TTL = 60_000 // 60 seconds

  // Bind shared utilities to the cache instance
  const boundResolve = (sessionCwd) => resolveSessionCwd(sessionCwd, _cwdRealCache, CWD_CACHE_TTL)
  const boundValidate = (absPath, sessionCwd) => validatePathWithinCwd(absPath, sessionCwd, _cwdRealCache, CWD_CACHE_TTL)

  // Git operations are restricted to the workspace root (defaults to home directory)
  const gitWorkspaceRoot = workspaceRoot || homedir()

  const browser = createBrowserOps(sendFn, boundResolve, boundValidate)
  const reader = createReaderOps(sendFn, boundResolve, boundValidate)
  const git = createGitOps(sendFn, boundResolve, boundValidate, gitWorkspaceRoot)

  return {
    listDirectory: browser.listDirectory,
    browseFiles: browser.browseFiles,
    readFile: reader.readFile,
    writeFile: reader.writeFile,
    getDiff: reader.getDiff,
    listSlashCommands: browser.listSlashCommands,
    listAgents: browser.listAgents,
    listFiles: browser.listFiles,
    gitStatus: git.gitStatus,
    gitBranches: git.gitBranches,
    gitStage: git.gitStage,
    gitUnstage: git.gitUnstage,
    gitCommit: git.gitCommit,
  }
}
