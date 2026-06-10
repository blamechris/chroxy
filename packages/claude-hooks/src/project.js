/**
 * Explicit project derivation (#5413 Phase 4 carry-forward).
 *
 * Hooks send `project` explicitly rather than relying on the server's
 * cwd-derivation fallback — worktrees and submodules make a bare cwd
 * ambiguous on the server side, while the hook is running right there and
 * can walk the tree cheaply.
 *
 * Mirrors `deriveProjectFromCwd` in packages/server/src/event-ingest.js:
 * walk up from cwd to the nearest `.git` (directory OR file — worktrees use
 * a `.git` file) and take that directory's basename. Pure fs probing, never
 * shells out (this runs on every hook fire inside the <100ms budget).
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

function gitRootName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  let dir
  try {
    dir = resolve(cwd)
  } catch {
    return null
  }
  let current = dir
  // Bounded walk — terminates at the fs root anyway; the cap is paranoia.
  for (let i = 0; i < 256; i++) {
    try {
      if (existsSync(join(current, '.git'))) {
        const name = basename(current)
        return name.length > 0 ? name : null
      }
    } catch {
      return null
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const fallback = basename(dir)
  return fallback.length > 0 ? fallback : null
}

/**
 * Resolve the project name for the envelope: git root of the payload's cwd
 * first, then $CLAUDE_PROJECT_DIR (Claude Code exports the project root
 * there for hook processes), then null (server-side derivation remains the
 * last-resort fallback).
 */
export function deriveProject(cwd, env = process.env) {
  const fromCwd = gitRootName(cwd)
  if (fromCwd) return fromCwd
  const projectDir = env.CLAUDE_PROJECT_DIR
  if (typeof projectDir === 'string' && projectDir.length > 0) {
    const name = basename(resolve(projectDir))
    if (name.length > 0) return name
  }
  return null
}
