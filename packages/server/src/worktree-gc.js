// Worktree garbage-collector core (#5158).
//
// Reclaims git worktrees that were created + locked by an agent/orchestrator
// (e.g. Claude Code's `.claude/worktrees/agent-XXX`, locked with a reason like
// `claude agent agent-XXX (pid 45492)`) and then orphaned when that process
// died without cleaning up. Such locks survive the process forever, so without
// a reaper they pile up across runs (the issue observed 162 worktrees / ~15 GB
// in one repo).
//
// Safety contract (do NOT relax — these are the guardrails from #5158):
//   - Never `git worktree remove --force`. A worktree with uncommitted /
//     untracked changes is preserved (skipped), never deleted.
//   - Only auto-unlock locks held by a VERIFIED-DEAD pid. A live pid, or a
//     lock whose reason has no parseable pid, is skipped (could be the user's
//     own deliberate lock).
//   - Never touch the main worktree (the primary checkout).
//   - Removing a worktree only deletes its working directory + admin refs; it
//     never deletes commits or branches. We still log a manifest of what was
//     reclaimed.
//
// This module is pure + dependency-injected (git exec, process.kill, fs) so it
// is fully testable against real temp repos without poking the real home dir.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { GIT } from './git.js'

/**
 * Existence check for a pid without sending a real signal.
 * Signal 0 only probes for the process; EPERM means it exists but we can't
 * signal it (still alive), ESRCH means it's gone.
 */
export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/**
 * Extract a pid from a worktree lock reason. Handles the agent format
 * `... (pid 45492)` and a looser `pid: 45492` / `pid 45492` fallback.
 * Returns a positive integer or null when no pid is present.
 */
export function parsePid(reason) {
  if (!reason || typeof reason !== 'string') return null
  const m = /\(pid\s+(\d+)\)/i.exec(reason) || /\bpid[\s:=]+(\d+)/i.exec(reason)
  if (!m) return null
  const pid = Number(m[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 * The first entry is always the main worktree. `locked`/`prunable` may carry
 * an inline reason (git >= ~2.36); older git emits the bare keyword, in which
 * case the lock reason is read from the admin file as a fallback.
 */
export function parseWorktreeList(porcelain) {
  const entries = []
  let cur = null
  const flush = () => { if (cur) entries.push(cur) }
  for (const raw of String(porcelain == null ? '' : porcelain).split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      flush()
      cur = { path: line.slice('worktree '.length), locked: false, lockReason: '', prunable: false, detached: false }
    } else if (!cur) {
      continue
    } else if (line === 'bare') {
      cur.bare = true
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length)
    } else if (line === 'detached') {
      cur.detached = true
    } else if (line === 'locked') {
      cur.locked = true
    } else if (line.startsWith('locked ')) {
      cur.locked = true
      cur.lockReason = line.slice('locked '.length)
    } else if (line === 'prunable') {
      cur.prunable = true
    } else if (line.startsWith('prunable ')) {
      cur.prunable = true
      cur.prunableReason = line.slice('prunable '.length)
    }
  }
  flush()
  return entries
}

/**
 * Fallback lock-reason reader for older git that omits the inline reason in
 * porcelain output. A linked worktree's `<path>/.git` is a file containing
 * `gitdir: <maindir>/.git/worktrees/<id>`; the lock reason lives in
 * `<that dir>/locked`. Returns '' when unavailable.
 */
export function readLockReasonFromAdmin(worktreePath, deps = {}) {
  const { exists = existsSync, read = readFileSync } = deps
  try {
    const dotGit = `${worktreePath}/.git`
    if (!exists(dotGit)) return ''
    const pointer = String(read(dotGit, 'utf8')).trim()
    const m = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!m) return ''
    // git may write the gitdir pointer as a path RELATIVE to the worktree dir
    // (e.g. with extensions.relativeWorktrees); resolve it against worktreePath
    // so we read the right `locked` file rather than one off the cwd.
    const gitdir = m[1].trim()
    const adminDir = isAbsolute(gitdir) ? gitdir : resolvePath(worktreePath, gitdir)
    const lockedFile = `${adminDir}/locked`
    if (!exists(lockedFile)) return ''
    return String(read(lockedFile, 'utf8')).trim()
  } catch {
    return ''
  }
}

/**
 * Decide what to do with every linked worktree of `repoPath`. Returns a plan:
 *   { repo, error?, items: [{ path, action, ... }] }
 * where action is one of:
 *   - 'remove' : dead-pid lock, dir present, clean   → unlock + `worktree remove` (no --force)
 *   - 'prune'  : dir gone (dead-pid lock or unlocked) → unlock if needed + `worktree prune`
 *   - 'skip'   : anything we must not touch (live pid, dirty, no pid, unlocked-present, main)
 *
 * Pure aside from the injected `git`/`kill`/`exists` seams.
 */
export function planRepoGc(repoPath, deps = {}) {
  const {
    git = (cwd, args) => execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8' }),
    kill = process.kill,
    exists = existsSync,
    readLockReason = (wtPath) => readLockReasonFromAdmin(wtPath),
  } = deps

  let porcelain
  try {
    porcelain = git(repoPath, ['worktree', 'list', '--porcelain'])
  } catch (err) {
    return { repo: repoPath, error: (err && err.message) || String(err), items: [] }
  }

  const entries = parseWorktreeList(porcelain)
  const items = []

  entries.forEach((e, i) => {
    if (i === 0) return // main worktree — never GC the primary checkout
    const dirGone = e.prunable || !exists(e.path)

    if (e.locked) {
      const reason = e.lockReason || readLockReason(e.path) || ''
      const pid = parsePid(reason)
      if (pid == null) {
        items.push({ path: e.path, action: 'skip', skipReason: 'locked with no pid in reason (not an abandoned agent worktree)', lockReason: reason })
        return
      }
      if (isPidAlive(pid, kill)) {
        items.push({ path: e.path, action: 'skip', skipReason: `locked by a live process (pid ${pid})`, pid, lockReason: reason })
        return
      }
      // pid is dead — reclaimable, subject to the clean-tree guard.
      if (dirGone) {
        items.push({ path: e.path, action: 'prune', pid, lockReason: reason, reason: 'directory gone; lock held by dead pid', locked: true })
        return
      }
      const clean = isClean(git, e.path)
      if (clean === null) {
        items.push({ path: e.path, action: 'skip', skipReason: 'could not determine working-tree state; left untouched for safety', pid, lockReason: reason })
        return
      }
      if (!clean) {
        items.push({ path: e.path, action: 'skip', skipReason: 'has uncommitted/untracked changes (preserved)', pid, lockReason: reason })
        return
      }
      items.push({ path: e.path, action: 'remove', pid, lockReason: reason, reason: 'clean worktree locked by dead pid', locked: true })
      return
    }

    // Not locked.
    if (dirGone) {
      items.push({ path: e.path, action: 'prune', reason: 'directory gone (stale admin ref)', locked: false })
      return
    }
    items.push({ path: e.path, action: 'skip', skipReason: 'present and unlocked (not an abandoned agent worktree)' })
  })

  return { repo: repoPath, items }
}

/** `git -C <worktree> status --porcelain` → clean? null when it can't be run. */
function isClean(git, worktreePath) {
  try {
    return git(worktreePath, ['status', '--porcelain']).trim().length === 0
  } catch {
    return null
  }
}

/**
 * Execute a plan's reclaimable items. Returns per-item results
 * ({ path, action, ok, error? }). `git worktree remove` is run WITHOUT
 * --force; the plan already excluded dirty trees, so a clean removal succeeds
 * and a surprise-dirty one fails loudly (and is reported) rather than nuking
 * changes. A single `git worktree prune` reclaims all dir-gone admin refs.
 */
export function applyPlan(repoPath, plan, deps = {}) {
  const { git = (cwd, args) => execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8' }) } = deps
  const results = []
  const pruneItems = []
  const unlockErrors = new Map() // item.path -> error message when its pre-prune unlock failed

  for (const item of plan.items) {
    if (item.action === 'remove') {
      try {
        if (item.locked) git(repoPath, ['worktree', 'unlock', item.path])
        git(repoPath, ['worktree', 'remove', item.path]) // NO --force
        results.push({ path: item.path, action: 'remove', ok: true })
      } catch (err) {
        results.push({ path: item.path, action: 'remove', ok: false, error: (err && err.message) || String(err) })
      }
    } else if (item.action === 'prune') {
      // A locked, dir-gone worktree must be unlocked before prune will reclaim
      // it. If the unlock fails the entry stays locked and prune cannot reclaim
      // it, so record the failure and report this item as not-ok rather than
      // claiming success off the back of a prune that skipped it.
      if (item.locked) {
        try {
          git(repoPath, ['worktree', 'unlock', item.path])
        } catch (err) {
          unlockErrors.set(item.path, (err && err.message) || String(err))
        }
      }
      pruneItems.push(item)
    }
  }

  if (pruneItems.length > 0) {
    let pruneError = null
    try {
      git(repoPath, ['worktree', 'prune'])
    } catch (err) {
      pruneError = (err && err.message) || String(err)
    }

    // #5246: verify per-entry that prune actually reclaimed the worktree. The
    // plan classifies an unlocked worktree as 'prune' when `dirGone` is true,
    // and `dirGone` includes `!exists(e.path)` — but `existsSync` returns false
    // on ANY stat error (an unmounted/temporarily-unavailable mount, a TOCTOU
    // race), not only genuine absence. `git worktree prune` correctly leaves a
    // still-present worktree intact, so reporting ok:true off the back of the
    // single global prune would over-count reclamations. Re-list the worktrees
    // and only claim success for items whose admin ref is genuinely gone.
    let remaining = null
    if (!pruneError) {
      try {
        remaining = new Set(parseWorktreeList(git(repoPath, ['worktree', 'list', '--porcelain'])).map(e => e.path))
      } catch {
        // Can't verify — fall back to best-effort (the prune call succeeded).
        remaining = null
      }
    }

    for (const item of pruneItems) {
      const unlockErr = unlockErrors.get(item.path)
      if (unlockErr) {
        results.push({ path: item.path, action: 'prune', ok: false, error: `unlock failed (entry still locked): ${unlockErr}` })
      } else if (pruneError) {
        results.push({ path: item.path, action: 'prune', ok: false, error: pruneError })
      } else if (remaining && remaining.has(item.path)) {
        results.push({
          path: item.path,
          action: 'prune',
          ok: false,
          error: 'still present after prune (not reclaimed) — a transient stat failure likely misclassified a present worktree as dir-gone',
        })
      } else {
        results.push({ path: item.path, action: 'prune', ok: true })
      }
    }
  }

  return results
}
