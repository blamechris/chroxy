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

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Agent worktree checkouts live under <parent>/.claude/worktrees/<name>. */
const WORKTREE_MARKER = '/.claude/worktrees/'

/** Temp roots (plus their macOS /private realpaths) — never project sessions. */
const TMP_PREFIXES = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']

/**
 * Test-surface override (colon-separated), sibling of CHROXY_HOOKS_SKIP_CWD_FILTER:
 * on Linux os.tmpdir() IS /tmp, so test fixtures built under the OS temp dir
 * would classify as 'tmp' and legit-repo tests fail on CI but pass on macOS
 * (/var/folders/...). Tests point this at a path that doesn't exist so their
 * fixtures classify by the real rules. Never set in production.
 *
 * Entries are trimmed and stripped of trailing slashes; if the override
 * yields no usable absolute prefixes (e.g. only relative/empty segments),
 * fall back to the built-in list rather than silently disabling suppression.
 */
function tmpPrefixes(env) {
  const raw = env?.CHROXY_HOOKS_TMP_PREFIXES
  if (typeof raw !== 'string' || raw.length === 0) return TMP_PREFIXES
  const prefixes = raw
    .split(':')
    .map((p) => p.trim().replace(/\/+$/, ''))
    .filter((p) => p.startsWith('/'))
  return prefixes.length > 0 ? prefixes : TMP_PREFIXES
}

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
 * #5464: chroxy's SECOND worktree source — session worktrees the daemon
 * creates at ~/.chroxy/worktrees/<sessionId> (DEFAULT_WORKTREE_BASE in
 * packages/server/src/session-manager.js, `git worktree add --detach`).
 * The basename is an opaque hex session id, so unlike .claude/worktrees
 * the parent project is NOT in the path — it has to be recovered from the
 * worktree's .git file (see chroxyWorktreeParentProject).
 *
 * Test-surface override, sibling of CHROXY_HOOKS_TMP_PREFIXES: fixtures
 * must be buildable under a temp dir on any OS, so the root is
 * env-injectable. An unusable override (relative/empty) falls back to the
 * real default rather than silently disabling the classification.
 */
function chroxyWorktreesRoot(env) {
  const override = env?.CHROXY_HOOKS_CHROXY_WORKTREES_ROOT
  if (typeof override === 'string' && override.length > 0) {
    const trimmed = override.trim().replace(/\/+$/, '')
    if (trimmed.startsWith('/')) return realResolve(trimmed)
  }
  const home = typeof env?.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir()
  if (!home) return null
  return realResolve(join(home, '.chroxy', 'worktrees'))
}

/**
 * If `dir` (already real-resolved) is inside a chroxy session worktree,
 * return that worktree's top dir (<root>/<sessionId>); else null. The root
 * itself is not a worktree.
 */
function chroxyWorktreeTopDir(dir, env) {
  const root = chroxyWorktreesRoot(env)
  if (!root || !dir.startsWith(root + '/')) return null
  const id = dir.slice(root.length + 1).split('/')[0]
  return id.length > 0 ? join(root, id) : null
}

/**
 * Recover the parent project for a chroxy session worktree from its .git
 * FILE: `git worktree add` writes `gitdir: <repo>/.git/worktrees/<id>`, so
 * the repo root (the parent project) is three segments up. Returns null on
 * any read/shape surprise — callers fall back, and classification (which
 * must not depend on this parse) is handled separately.
 */
function chroxyWorktreeParentProject(worktreeDir) {
  let raw
  try {
    raw = readFileSync(join(worktreeDir, '.git'), 'utf8')
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw)
  if (!match) return null
  let linkedGitDir
  try {
    // gitdir is absolute in practice; resolve() also covers relative ones.
    linkedGitDir = resolve(worktreeDir, match[1])
  } catch {
    return null
  }
  const worktreesDir = dirname(linkedGitDir) // <repo>/.git/worktrees
  if (basename(worktreesDir) !== 'worktrees') return null
  const gitDir = dirname(worktreesDir) // <repo>/.git
  const repoRoot = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir
  const name = basename(repoRoot)
  return name.length > 0 ? name : null
}

/**
 * #5439 GAP B: a cwd inside a worktree checkout belongs to the PARENT
 * project — the segment before /.claude/worktrees/ — not the agent-*
 * checkout (port of extract_project_name's worktree remap; without this
 * every parallel agent mints its own `agent-<hash>` status embed).
 *
 * #5464 extends this to chroxy session worktrees (~/.chroxy/worktrees/<id>):
 * their basename is an opaque session id, so the parent is parsed from the
 * worktree .git file's gitdir instead. The chroxy check runs FIRST — an
 * agent worktree nested INSIDE a chroxy worktree should still resolve to
 * the real repo (the chroxy worktree's .git points there), not to the
 * opaque id the /.claude/worktrees/ marker split would yield.
 */
export function worktreeParent(cwd, env = process.env) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = realResolve(cwd)
  if (!dir) return null
  const chroxyTop = chroxyWorktreeTopDir(dir, env)
  if (chroxyTop) return chroxyWorktreeParentProject(chroxyTop)
  const idx = dir.indexOf(WORKTREE_MARKER)
  if (idx <= 0) return null
  const name = basename(dir.slice(0, idx))
  return name.length > 0 ? name : null
}

/**
 * Classify cwds that should not mint their own status embeds (#5439 GAP B,
 * port of claude-notify.sh's non-project session filter):
 *
 *   'tmp'      — /tmp, /var/tmp (and their /private macOS realpaths)
 *   'home'     — the home directory ROOT itself (basename = username, not a
 *                project); projects under home are fine
 *   'worktree' — .claude/worktrees agent checkouts AND chroxy session
 *                worktrees under ~/.chroxy/worktrees/<id> (#5464); runEmit
 *                suppresses all but subagent events, whose counts belong
 *                to the parent project
 *
 * Returns null for normal project cwds or when no cwd is available.
 */
export function classifyNonProjectCwd(cwd, env = process.env) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = realResolve(cwd)
  if (!dir) return null
  for (const prefix of tmpPrefixes(env)) {
    if (dir === prefix || dir.startsWith(prefix + '/')) return 'tmp'
  }
  // Path-shape only — never gated on the .git gitdir parse succeeding: a
  // session in a chroxy worktree must stay suppressed even when the parent
  // can't be recovered (it would otherwise mint an opaque-id embed).
  if (dir.includes(WORKTREE_MARKER) || chroxyWorktreeTopDir(dir, env)) return 'worktree'
  const homeRaw = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir()
  if (homeRaw) {
    let homeResolved
    try {
      homeResolved = resolve(homeRaw)
    } catch {
      homeResolved = null
    }
    if (dir === homeResolved || dir === realResolve(homeRaw)) return 'home'
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
  const fromWorktree = worktreeParent(cwd, env)
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
