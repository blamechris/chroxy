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

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Agent worktree checkouts live under <parent>/.claude/worktrees/<name>. */
const WORKTREE_MARKER = '/.claude/worktrees/'

/** Temp roots (plus their macOS /private realpaths) — never project sessions. */
const TMP_PREFIXES = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']

/** resolve() then realpath (macOS: /tmp → /private/tmp); best-effort, never throws. */
function realResolve(p) {
  let dir
  try {
    dir = resolve(p)
  } catch {
    return null
  }
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/**
 * Normalize separators for the shape checks below: resolve()/realpathSync()
 * emit backslash-separated paths on Windows, where the POSIX marker/prefix
 * substrings would never match (Copilot review on #5462). No-op on POSIX.
 */
function normSlashes(p) {
  return p.replace(/\\/g, '/')
}

/**
 * #5439 GAP B: a cwd inside a worktree checkout belongs to the PARENT
 * project — the segment before /.claude/worktrees/ — not the agent-*
 * checkout (port of extract_project_name's worktree remap; without this
 * every parallel agent mints its own `agent-<hash>` status embed).
 */
export function worktreeParent(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = realResolve(cwd)
  if (!dir) return null
  const norm = normSlashes(dir)
  const idx = norm.indexOf(WORKTREE_MARKER)
  if (idx <= 0) return null
  // basename() handles '/' on every platform (win32 accepts both separators).
  const name = basename(norm.slice(0, idx))
  return name.length > 0 ? name : null
}

/**
 * Classify cwds that should not mint their own status embeds (#5439 GAP B,
 * port of claude-notify.sh's non-project session filter):
 *
 *   'tmp'      — /tmp, /var/tmp (and their /private macOS realpaths)
 *   'home'     — the home directory ROOT itself (basename = username, not a
 *                project); projects under home are fine
 *   'worktree' — .claude/worktrees agent checkouts (runEmit suppresses all
 *                but subagent events, whose counts belong to the parent)
 *
 * Returns null for normal project cwds or when no cwd is available.
 */
export function classifyNonProjectCwd(cwd, env = process.env) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = realResolve(cwd)
  if (!dir) return null
  // Shape checks run on the slash-normalized path so Windows backslash
  // paths classify identically (Copilot review on #5462).
  const norm = normSlashes(dir)
  for (const prefix of TMP_PREFIXES) {
    if (norm === prefix || norm.startsWith(prefix + '/')) return 'tmp'
  }
  if (norm.includes(WORKTREE_MARKER)) return 'worktree'
  const homeRaw = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir()
  if (homeRaw) {
    let homeResolved
    try {
      homeResolved = resolve(homeRaw)
    } catch {
      homeResolved = null
    }
    // Home-root equality is also separator-normalized — both sides come
    // from resolve()/realpath, so on POSIX this is byte-identical to the
    // raw comparison.
    if (
      (homeResolved && norm === normSlashes(homeResolved)) ||
      norm === normSlashes(realResolve(homeRaw) ?? '')
    ) return 'home'
  }
  return null
}

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
 * Resolve the project name for the envelope: worktree-parent remap first
 * (#5439 GAP B — a worktree's own `.git` FILE would otherwise win the walk
 * and name the checkout, not the project), then the git root of the
 * payload's cwd, then $CLAUDE_PROJECT_DIR (Claude Code exports the project
 * root there for hook processes), then null (server-side derivation remains
 * the last-resort fallback).
 */
export function deriveProject(cwd, env = process.env) {
  const fromWorktree = worktreeParent(cwd)
  if (fromWorktree) return fromWorktree
  const fromCwd = gitRootName(cwd)
  if (fromCwd) return fromCwd
  const projectDir = env.CLAUDE_PROJECT_DIR
  if (typeof projectDir === 'string' && projectDir.length > 0) {
    const name = basename(resolve(projectDir))
    if (name.length > 0) return name
  }
  return null
}
