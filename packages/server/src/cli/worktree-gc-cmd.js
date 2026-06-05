// `chroxy worktree gc` — reclaim orphaned, dead-pid-locked agent worktrees (#5158).
//
// Dry-run by DEFAULT: it reports what it would reclaim and changes nothing.
// Pass --apply to actually unlock + remove (clean trees only, never --force).
//
// Scans the resolved repo set (config.repos ∪ auto-discover under the
// configured root, default ~/Projects) — or a single repo via --repo — and,
// per the safety contract in worktree-gc.js, only reclaims worktrees that are
// locked by a verified-dead pid AND clean, plus stale dir-gone admin refs.

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, basename } from 'node:path'
import { CONFIG_FILE } from './shared.js'
import { resolveRepoSet } from '../control-room/repo-set.js'
import { planRepoGc, applyPlan } from '../worktree-gc.js'

/** Read config.json best-effort for repos + discovery root (never throws/exits). */
function readConfigSoft(configPath, deps = {}) {
  const { exists = existsSync, read = readFileSync } = deps
  try {
    if (!exists(configPath)) return {}
    return JSON.parse(read(configPath, 'utf-8')) || {}
  } catch {
    return {}
  }
}

/** Best-effort directory size in KiB via `du -sk`; null when unavailable. */
function dirSizeKib(path, deps = {}) {
  const { exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }) } = deps
  try {
    const out = exec('du', ['-sk', path])
    const kib = parseInt(String(out).split(/\s+/)[0], 10)
    return Number.isFinite(kib) ? kib : null
  } catch {
    return null
  }
}

function humanSize(kib) {
  if (kib == null) return ''
  if (kib < 1024) return `${kib} KiB`
  const mib = kib / 1024
  if (mib < 1024) return `${mib.toFixed(1)} MiB`
  return `${(mib / 1024).toFixed(2)} GiB`
}

/**
 * Build the GC report across all target repos. Returns a structured object
 * (also what --json prints). Pure aside from injected seams.
 */
export function collectWorktreeGc(options = {}, deps = {}) {
  const {
    configPath = CONFIG_FILE,
    plan = planRepoGc,
    sizeOf = (p) => dirSizeKib(p, deps),
    withSizes = true,
  } = deps

  let repos
  if (options.repo) {
    const p = resolve(options.repo)
    repos = [{ name: basename(p), path: p }]
  } else {
    const cfg = readConfigSoft(configPath, deps)
    repos = resolveRepoSet({
      repos: cfg.repos,
      root: cfg.controlRoomRoot,
      ...(deps.repoSetSeams || {}),
    })
  }

  const reposOut = []
  let reclaimableCount = 0
  let reclaimableKib = 0
  let skippedCount = 0

  for (const r of repos) {
    const p = plan(r.path, deps.planDeps || {})
    const reclaimable = p.items.filter((it) => it.action === 'remove' || it.action === 'prune')
    const skipped = p.items.filter((it) => it.action === 'skip')
    if (withSizes) {
      for (const it of reclaimable) {
        if (it.action === 'remove') {
          it.sizeKib = sizeOf(it.path)
          if (it.sizeKib != null) reclaimableKib += it.sizeKib
        }
      }
    }
    reclaimableCount += reclaimable.length
    skippedCount += skipped.length
    reposOut.push({ name: r.name, path: r.path, error: p.error, reclaimable, skipped })
  }

  return {
    apply: !!options.apply,
    repoCount: repos.length,
    reclaimableCount,
    reclaimableKib,
    skippedCount,
    repos: reposOut,
  }
}

function printHuman(report, applied) {
  const lines = []
  const mode = report.apply ? 'apply' : 'dry-run'
  lines.push(`Worktree GC (${mode}) — scanned ${report.repoCount} repo${report.repoCount === 1 ? '' : 's'}`)
  lines.push('')

  let any = false
  for (const repo of report.repos) {
    const reclaimable = repo.reclaimable
    if (repo.error) {
      lines.push(`  ${repo.name}  —  error: ${repo.error}`)
      any = true
      continue
    }
    if (reclaimable.length === 0) continue
    any = true
    lines.push(`  ${repo.name}  (${repo.path})`)
    for (const it of reclaimable) {
      const size = it.sizeKib != null ? `  [${humanSize(it.sizeKib)}]` : ''
      const verb = it.action === 'prune' ? 'prune' : 'remove'
      const why = it.reason ? ` — ${it.reason}` : ''
      let status = ''
      if (applied) {
        const res = applied.find((a) => a.path === it.path)
        status = res ? (res.ok ? '  ✓ done' : `  ✗ failed: ${res.error}`) : ''
      }
      lines.push(`    ${verb}  ${it.path}${size}${why}${status}`)
    }
    lines.push('')
  }

  if (!any) {
    lines.push('  Nothing to reclaim — no dead-pid-locked or stale worktrees found.')
    lines.push('')
  }

  const sz = report.reclaimableKib ? ` (~${humanSize(report.reclaimableKib)})` : ''
  lines.push(`Summary: ${report.reclaimableCount} reclaimable${sz}, ${report.skippedCount} skipped (live/dirty/unknown — preserved).`)
  if (!report.apply && report.reclaimableCount > 0) {
    lines.push('Re-run with --apply to reclaim them (clean trees only; never --force).')
  }
  return lines.join('\n')
}

export async function runWorktreeGc(options = {}, deps = {}) {
  const out = deps.write || console.log
  const report = collectWorktreeGc(options, deps)

  let applied = null
  if (options.apply) {
    applied = []
    for (const repo of report.repos) {
      if (repo.error || repo.reclaimable.length === 0) continue
      const res = applyPlan(repo.path, { items: repo.reclaimable }, deps.planDeps || {})
      applied.push(...res)
    }
  }

  if (options.json) {
    out(JSON.stringify({ ...report, applied }, null, 2))
  } else {
    out(printHuman(report, applied))
  }
  return { report, applied }
}

export function registerWorktreeCommand(program) {
  const wt = program
    .command('worktree')
    .description('Manage chroxy/agent git worktrees')

  wt
    .command('gc')
    .description('Reclaim orphaned worktrees locked by dead agent processes (dry-run by default)')
    .option('--repo <path>', 'Scan a single repo instead of the configured/discovered set')
    .option('--apply', 'Actually unlock + remove reclaimable worktrees (default: dry-run report only)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      await runWorktreeGc(options)
    })
}
