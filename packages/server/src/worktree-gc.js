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
//     untracked / gitignored content is preserved (skipped), never deleted —
//     `git worktree remove` (no --force) still deletes the whole directory
//     INCLUDING gitignored files (node_modules, build/, a local .env), so the
//     clean check counts ignored entries as not-clean (#5244).
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path'
import { chroxyWorktreeRepoPath } from '@chroxy/protocol/project'
import { GIT } from './git.js'

// #5706: absolute-age fallback for the PID-liveness check. A dead agent's pid
// can be RECYCLED by an unrelated process after uptime/PID reuse — then
// `isPidAlive` reports "live", GC skips the orphaned worktree forever, and the
// disk slowly fills. The fallback reclaims a lock whose pid LOOKS alive but
// whose worktree mtime is older than `maxLockAgeMs` (treating the pid as
// recycled) — still subject to the clean-tree guard, so no uncommitted/ignored
// content is ever deleted.
//
// DEFAULT IS 0 (DISABLED): opt-in via `config.worktreeGc.maxLockAgeMs`. It's
// off by default because the age signal is imperfect — directory mtime bumps
// only on TOP-LEVEL entry add/remove (and top-level git ops), NOT on in-place or
// nested-subdir edits. So a genuinely-live, clean, long-running agent that only
// touches existing/nested files could read "stale" and have its working dir
// reclaimed out from under it (no committed-work loss thanks to the clean-tree
// guard, but a disruptive mid-run rug-pull). Operators who hit the recycled-pid
// disk leak set a generous threshold (e.g. 14–30 days, well beyond any real
// agent-session lifetime); the clean-tree guard remains the hard safety net.
const DEFAULT_MAX_LOCK_AGE_MS = 0

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
    // #5706: age-fallback seams. `now`/`mtimeMs` are injectable for tests.
    // `maxLockAgeMs` defaults to 30d; 0 (or negative) disables the fallback.
    now = () => Date.now(),
    mtimeMs = (p) => { try { return statSync(p).mtimeMs } catch { return null } },
    maxLockAgeMs = DEFAULT_MAX_LOCK_AGE_MS,
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
      // pid liveness, with the #5706 absolute-age fallback: a "live" pid whose
      // worktree has been untouched longer than maxLockAgeMs is treated as a
      // recycled pid (the original agent is long gone) so the orphan can be
      // reclaimed instead of leaking forever.
      let pidNote = 'lock held by dead pid'
      if (isPidAlive(pid, kill)) {
        const m = maxLockAgeMs > 0 ? mtimeMs(e.path) : null
        const ageMs = m != null ? now() - m : null
        if (ageMs == null || ageMs <= maxLockAgeMs) {
          items.push({ path: e.path, action: 'skip', skipReason: `locked by a live process (pid ${pid})`, pid, lockReason: reason })
          return
        }
        // pid looks alive but the tree is stale → recycled pid; reclaim.
        const ageDays = Math.round(ageMs / 86_400_000)
        pidNote = `pid ${pid} appears live but worktree untouched ${ageDays}d — treating as a recycled pid (#5706)`
      }
      // reclaimable (dead pid, or recycled-pid stale), subject to the clean-tree guard.
      if (dirGone) {
        items.push({ path: e.path, action: 'prune', pid, lockReason: reason, reason: `directory gone; ${pidNote}`, locked: true })
        return
      }
      const clean = isClean(git, e.path)
      if (clean === null) {
        items.push({ path: e.path, action: 'skip', skipReason: 'could not determine working-tree state; left untouched for safety', pid, lockReason: reason })
        return
      }
      if (!clean) {
        items.push({ path: e.path, action: 'skip', skipReason: 'has uncommitted/untracked/gitignored content (preserved)', pid, lockReason: reason })
        return
      }
      items.push({ path: e.path, action: 'remove', pid, lockReason: reason, reason: `clean worktree; ${pidNote}`, locked: true })
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

/**
 * `git -C <worktree> status --porcelain --ignored` → clean? null when it can't
 * be run. The `--ignored` flag is load-bearing (#5244): `git worktree remove`
 * (run here WITHOUT --force) deletes the entire worktree directory including
 * gitignored content — node_modules, build artifacts, a local `.env` — so a
 * worktree that reads clean by tracked status alone can still hold precious
 * un-versioned files. Treating any ignored entry (`!! ...`) as not-clean keeps
 * such worktrees in the skip set instead of silently deleting their contents.
 */
function isClean(git, worktreePath) {
  try {
    return git(worktreePath, ['status', '--porcelain', '--ignored']).trim().length === 0
  } catch {
    return null
  }
}


/**
 * #5859 (audit P1-7): boot-time sweep of ORPHANED chroxy session worktrees.
 *
 * Unlike the agent worktrees this module's reaper handles, chroxy's OWN session
 * worktrees (`~/.chroxy/worktrees/<sessionId>`, created `git worktree add
 * --detach`, NO lock) are never reclaimed by the lock/dead-pid reaper. When a
 * session vanishes without a clean destroy (SIGKILL, crash, or a dropped
 * state file) its worktree dir leaks forever.
 *
 * Removes a worktree dir ONLY when BOTH hold:
 *   - its basename (the sessionId) is NOT in `liveSessionIds` (the set
 *     restoreState rebuilt) — so a live session's worktree is never touched, AND
 *   - the tree is CLEAN including ignored files — the same hard guard as the
 *     reaper (`git worktree remove` without --force still deletes gitignored
 *     content, so any uncommitted/untracked/ignored work means SKIP).
 * A dirty orphan, or one whose repo/clean-state can't be determined, is skipped
 * and reported. Never throws; never uses --force.
 *
 * Pure + dependency-injected.
 *
 * @param {object} args
 * @param {string} args.worktreeBase - e.g. ~/.chroxy/worktrees
 * @param {Set<string>} args.liveSessionIds - currently-live session ids (off-limits)
 * @param {object} [args.deps] - { git, readdir, exists }
 * @returns {{ removed: string[], skippedDirty: object[], skippedError: object[], scanned: number }}
 */
export function sweepOrphanChroxyWorktrees({ worktreeBase, liveSessionIds, deps = {} } = {}) {
  const {
    git = (cwd, args) => execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8' }),
    readdir = (p) => readdirSync(p, { withFileTypes: true }),
    exists = existsSync,
  } = deps
  const report = { removed: [], skippedDirty: [], skippedError: [], scanned: 0 }
  if (!worktreeBase || !exists(worktreeBase)) return report
  const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds || [])
  let entries
  try { entries = readdir(worktreeBase) } catch (err) { report.skippedError.push({ path: worktreeBase, error: (err && err.message) || String(err) }); return report }
  for (const ent of entries) {
    if (!ent || typeof ent.isDirectory !== 'function' || !ent.isDirectory()) continue
    const id = ent.name
    // Defense-in-depth: chroxy session ids are 32 lowercase hex (matching the
    // /^[a-f0-9]{32}$/ constraint in session-manager.js). A dir under the base
    // whose name isn't that shape was never created by chroxy (e.g. a user-placed
    // directory) — never a removal candidate, even if it somehow looked clean.
    if (!/^[a-f0-9]{32}$/.test(id)) continue
    if (live.has(id)) continue // owned by a live session — never touch
    report.scanned++
    const wtPath = joinPath(worktreeBase, id)
    const clean = isClean(git, wtPath)
    if (clean !== true) {
      report.skippedDirty.push({ path: wtPath, reason: clean === null ? 'status-unknown' : 'dirty' })
      continue
    }
    const repo = chroxyWorktreeRepoPath(wtPath)
    if (!repo) { report.skippedError.push({ path: wtPath, error: 'repo-unrecoverable' }); continue }
    try {
      git(repo, ['worktree', 'remove', wtPath]) // NO --force; clean-checked above
      report.removed.push(wtPath)
    } catch (err) {
      report.skippedError.push({ path: wtPath, error: (err && err.message) || String(err) })
    }
  }
  return report
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
      let unlocked = false
      try {
        if (item.locked) { git(repoPath, ['worktree', 'unlock', item.path]); unlocked = true }
        git(repoPath, ['worktree', 'remove', item.path]) // NO --force
        results.push({ path: item.path, action: 'remove', ok: true })
      } catch (err) {
        // #5245 — if we unlocked but the remove then failed (e.g. the tree went
        // dirty between plan and apply, so `worktree remove` refuses), re-lock
        // with the original reason so a failed reclaim leaves the worktree's
        // lock state — and its dead-pid provenance — exactly as we found it.
        // Best-effort: a re-lock failure must not mask the original error.
        if (unlocked) {
          try {
            const lockArgs = item.lockReason
              ? ['worktree', 'lock', '--reason', item.lockReason, item.path]
              : ['worktree', 'lock', item.path]
            git(repoPath, lockArgs)
          } catch { /* best-effort re-lock */ }
        }
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
