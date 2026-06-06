// Opt-in worktree auto-reaper (#5158).
//
// When `config.worktreeGc.autoReap` is true, the server reclaims orphaned,
// dead-pid-locked agent worktrees once on startup. It reuses the GC core
// (planRepoGc/applyPlan), so the full safety contract holds unchanged: only
// clean worktrees locked by a verified-dead pid (plus dir-gone stale refs) are
// reclaimed, never --force, never the main worktree, never a dirty/live one.
//
// Default is OFF. The manual `chroxy worktree gc` CLI (dry-run by default) is
// always available regardless of this setting.
//
// Scope mirrors the CLI: the resolved repo set (config.repos ∪ auto-discover
// under config.controlRoomRoot). To keep an opt-in startup sweep from starving
// the freshly-booted server's event loop, the orchestrator yields between
// repos (each repo's git calls are still synchronous, but bounded).

import { resolveRepoSet } from './control-room/repo-set.js'
import { planRepoGc, applyPlan } from './worktree-gc.js'

/**
 * Reap one repo into the running summary. Sync (the GC core uses execFileSync).
 */
function reapOneRepo(repoPath, summary, planDeps) {
  const plan = planRepoGc(repoPath, planDeps)
  if (plan.error) {
    summary.errors.push({ repo: repoPath, error: plan.error })
    return
  }
  const reclaimable = plan.items.filter((it) => it.action === 'remove' || it.action === 'prune')
  summary.skipped += plan.items.filter((it) => it.action === 'skip').length
  if (reclaimable.length === 0) return
  const results = applyPlan(repoPath, { items: reclaimable }, planDeps)
  for (const res of results) {
    if (res.ok) {
      summary.reclaimed += 1
      summary.removed.push(res.path)
    } else {
      summary.failed += 1
      summary.errors.push({ repo: repoPath, path: res.path, error: res.error })
    }
  }
}

/**
 * Reap a set of repos. `repos` is `[{ name, path }]`. Yields to the event loop
 * between repos so a large sweep doesn't block a freshly-booted server.
 * Returns a manifest summary. Pure aside from the injected GC seams (planDeps).
 */
export async function reapWorktrees({ repos = [], planDeps = {}, yieldFn } = {}) {
  const summary = { repos: repos.length, reclaimed: 0, failed: 0, skipped: 0, removed: [], errors: [] }
  const yieldToLoop = yieldFn || (() => new Promise((resolve) => setImmediate(resolve)))
  for (const r of repos) {
    await yieldToLoop()
    reapOneRepo(r.path, summary, planDeps)
  }
  return summary
}

/**
 * Startup entry point. No-op (returns null) unless `config.worktreeGc.autoReap`
 * is true. Resolves the repo set the same way the CLI does, reaps, and logs a
 * manifest. Best-effort: callers should fire-and-forget and not let a failure
 * here affect boot.
 *
 * @param {object} config - merged server config
 * @param {{ info: Function, warn: Function }} log - server logger
 * @param {object} [deps] - test seams: resolveRepoSet, repoSetSeams, planDeps, yieldFn
 */
export async function maybeAutoReapWorktrees(config, log, deps = {}) {
  if (!config || !config.worktreeGc || config.worktreeGc.autoReap !== true) return null

  const resolve = deps.resolveRepoSet || resolveRepoSet
  let repos
  try {
    repos = resolve({
      repos: config.repos,
      root: config.controlRoomRoot,
      ...(deps.repoSetSeams || {}),
    })
  } catch (err) {
    log.warn(`worktree auto-reap: repo discovery failed: ${(err && err.message) || err}`)
    return null
  }

  const summary = await reapWorktrees({ repos, planDeps: deps.planDeps || {}, yieldFn: deps.yieldFn })

  const base = `worktree auto-reap: reclaimed ${summary.reclaimed} worktree(s) across ${summary.repos} repo(s); ${summary.skipped} preserved (live/dirty/unknown)`
  if (summary.failed > 0) {
    log.warn(`${base}; ${summary.failed} failed`)
    for (const e of summary.errors) {
      log.warn(`  - ${e.path || e.repo}: ${e.error}`)
    }
  } else if (summary.reclaimed > 0) {
    log.info(base)
  } else {
    log.info('worktree auto-reap: nothing to reclaim')
  }
  return summary
}
