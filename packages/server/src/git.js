import { execFileSync } from 'child_process'
import { existsSync } from 'fs'

/**
 * Resolve the full path to the git binary.
 *
 * When the process runs with a minimal PATH (e.g. only the Node bin
 * directory), `execFileSync('git', ...)` fails with ENOENT.  This
 * module resolves the git path once at import time and exports it
 * for all callers that need to spawn git.
 */
function resolveGit() {
  // Try PATH first
  try {
    return execFileSync('which', ['git'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch { /* git not on PATH */ }

  // Fall back to common locations
  const candidates = [
    '/opt/homebrew/bin/git',  // macOS ARM (Homebrew)
    '/usr/local/bin/git',     // macOS Intel / Linux manual install
    '/usr/bin/git',           // Linux package manager
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  // Last resort — return bare name and let the caller handle ENOENT
  return 'git'
}

export const GIT = resolveGit()
