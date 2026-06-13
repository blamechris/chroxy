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

// #5326 (WP-5.4): how often the periodic auto-reaper re-sweeps after the
// boot sweep. 30 min is a balance — short enough that a long-running daemon
// reclaims mid-run agent worktrees without a restart, long enough that the
// (synchronous-per-repo) git scans don't add meaningful steady-state load.
const DEFAULT_REAP_INTERVAL_MS = 30 * 60 * 1000

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

  // #5706: pass the configured absolute-age fallback through to the GC core.
  // A test's `deps.planDeps` still wins (spread last) so seams override config.
  const cfgMaxAge = config.worktreeGc.maxLockAgeMs
  const planDeps = {
    ...(Number.isFinite(cfgMaxAge) && cfgMaxAge >= 0 ? { maxLockAgeMs: cfgMaxAge } : {}),
    ...(deps.planDeps || {}),
  }
  const summary = await reapWorktrees({ repos, planDeps, yieldFn: deps.yieldFn })

  const base = `worktree auto-reap: reclaimed ${summary.reclaimed} worktree(s) across ${summary.repos} repo(s); ${summary.skipped} preserved (live/dirty/unknown)`
  // Warn whenever anything went wrong — both per-item failures (counted in
  // `failed`) and repo-level discovery/plan errors (recorded in `errors`
  // without incrementing `failed`). Otherwise an unscannable repo would log a
  // misleading "nothing to reclaim" info line and hide the failure.
  if (summary.failed > 0 || summary.errors.length > 0) {
    log.warn(`${base}; ${summary.failed} failed, ${summary.errors.length} error(s)`)
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

/**
 * #5326 (WP-5.4): start the worktree auto-reaper for the lifetime of the
 * daemon. Runs once immediately (the original boot sweep) and then on a
 * recurring interval so a long-running server reclaims agent worktrees
 * created MID-RUN — previously the sweep ran once at boot only, so a worktree
 * orphaned an hour into a session was never reclaimed without a restart.
 *
 * No-op (returns null) unless `config.worktreeGc.autoReap === true`. Each sweep
 * is fire-and-forget: a failure is logged and never propagates (so a transient
 * git error can't tear down the interval or the daemon). The interval is
 * `unref()`'d so it never keeps the process alive on its own.
 *
 * @param {object} config - merged server config
 * @param {{ info: Function, warn: Function }} log - server logger
 * @param {object} [deps] - test seams: run, setIntervalFn, plus maybeAutoReapWorktrees deps
 * @returns {ReturnType<typeof setInterval>|null} the interval handle (for clearInterval on shutdown), or null when disabled
 */
export function startPeriodicAutoReap(config, log, deps = {}) {
  if (!config || !config.worktreeGc || config.worktreeGc.autoReap !== true) return null

  const run = deps.run || maybeAutoReapWorktrees
  // Reentrancy guard: if a sweep runs longer than the interval (e.g. a tiny
  // reapIntervalMs over a huge repo set), skip the tick rather than letting two
  // sweeps run concurrently. Each sweep already builds its own summary and the
  // GC core re-plans live, so an overlap wouldn't corrupt state — but skipping
  // is cheaper and clearer than racing two scans (#5363 review).
  let sweeping = false
  const sweep = () => {
    if (sweeping) {
      log.info('worktree auto-reaper: previous sweep still running, skipping this tick')
      return
    }
    sweeping = true
    Promise.resolve()
      .then(() => run(config, log, deps))
      .catch((err) => log.warn(`worktree auto-reaper failed: ${(err && err.message) || err}`))
      .finally(() => { sweeping = false })
  }

  // Boot sweep — same behavior as before this WP.
  sweep()

  const configured = config.worktreeGc.reapIntervalMs
  const intervalMs = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REAP_INTERVAL_MS
  const setIntervalFn = deps.setIntervalFn || setInterval
  const timer = setIntervalFn(sweep, intervalMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}
