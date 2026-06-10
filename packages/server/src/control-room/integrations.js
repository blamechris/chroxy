/**
 * Control Room — Integrations survey (#5499, epic #5498).
 *
 * Sibling to the host survey (survey.js) and the runner survey (runners.js).
 * Where those classify git repos and self-hosted runners, this one surveys
 * **integration status** per repo — repo-memory for this slice (a sibling
 * repo-relay block is the follow-up sub-issue of #5498):
 *
 *   - config:  does `.repo-memory.json` exist in the repo root? Parse its
 *     `summarizer` and enabled tool groups when it does.
 *   - cache:   `.repo-memory/cache.db` (+ `-wal` sidecar) file stats — present,
 *     combined size, newest mtime (the "last activity" proxy, since the
 *     telemetry report carries no timestamp of its own).
 *   - report:  `repo-memory report <repoRoot> --json --diagnostics` — total
 *     events, hit ratio, tokens saved, cache entry/stale counts. Read-only CLI.
 *
 * Degradation semantics (the survey NEVER fails because one cell did):
 *   - The `repo-memory` binary is resolved ONCE per snapshot (`which`), not per
 *     repo. When absent, every configured repo's report cell degrades with a
 *     per-repo `reason` and the snapshot carries a `repoMemoryCli` note.
 *   - A per-repo CLI failure (exit 1, timeout, unparseable output) degrades
 *     that repo's report cell with a `reason` string.
 *   - A repo without `.repo-memory.json` is a quiet `configured: false` row —
 *     absence is signal, not an error.
 *
 * The result conforms to `ServerIntegrationStatusSnapshotSchema` from
 * `@chroxy/protocol` (minus the `type` field, which the WS handler adds).
 *
 * Every external interaction is injectable so tests never touch real fs/exec:
 *   - `_readFile(path, enc)` — async, resolves a string (rejects when absent).
 *   - `_stat(path)` — async, resolves `{ size, mtimeMs }` (rejects when absent).
 *   - `_execFile(file, args, opts)` — async, resolves `{ stdout, stderr }`
 *     (the promisified `child_process.execFile` shape). Rejections tolerated.
 *   - `_now()` — returns a `Date` (defaults to `new Date()`).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

const execFileAsync = promisify(execFile)

/** Per-repo concurrency cap for the survey (matches the sibling surveys). */
export const DEFAULT_CONCURRENCY = 5

/**
 * Bound every subprocess so a stuck `which`/`repo-memory` rejects in finite
 * time instead of hanging the survey forever — which would also pin the
 * handler's per-client in-flight guard. Kept consistent with survey.js /
 * runners.js EXEC_TIMEOUT_MS.
 */
export const EXEC_TIMEOUT_MS = 20000
/** Output cap for the report subprocess (report JSON is small). */
const EXEC_MAX_BUFFER = 8 * 1024 * 1024
/** Shared exec options for every probe. */
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/** Snapshot-level note used when the binary probe finds nothing. */
export const CLI_MISSING_NOTE = 'repo-memory CLI not found on PATH — install @blamechris/repo-memory globally or set controlRoomRepoMemoryBin'

/**
 * Parse a repo's `.repo-memory.json` config.
 *
 * @param {string|null} text - raw config contents, or null when absent.
 * @returns {{ summarizer: string|null, toolGroups: string[] }|null} parsed
 *   config, or null when the file is absent / unparseable / not an object.
 *   `toolGroups` lists the tool groups enabled under the `tools` map (keys
 *   with a truthy value), sorted for stable output.
 */
export function parseRepoMemoryConfig(text) {
  if (text === null || text === undefined) return null
  let parsed
  try {
    parsed = JSON.parse(String(text).replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const summarizer = typeof parsed.summarizer === 'string' && parsed.summarizer.length > 0 ? parsed.summarizer : null
  const toolGroups = []
  if (parsed.tools && typeof parsed.tools === 'object' && !Array.isArray(parsed.tools)) {
    for (const [group, enabled] of Object.entries(parsed.tools)) {
      if (enabled) toolGroups.push(group)
    }
  }
  toolGroups.sort()
  return { summarizer, toolGroups }
}

/**
 * Coerce a tolerated "last activity" hint off the report into an ISO-8601
 * string. Current CLI versions (verified against 0.15.0) carry no timestamp —
 * this only fires if a future version adds `lastEventAt` / `lastActivityAt` /
 * `lastActivity` as epoch-ms or an ISO string.
 *
 * @param {object} parsed - the parsed report JSON.
 * @returns {string|null}
 */
function deriveLastActivity(parsed) {
  const raw = parsed.lastEventAt ?? parsed.lastActivityAt ?? parsed.lastActivity
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    try {
      return new Date(raw).toISOString()
    } catch {
      return null
    }
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return new Date(ms).toISOString()
  }
  return null
}

/** Clamp a value to a non-negative finite number, else the fallback. */
function nonNegNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Parse `repo-memory report --json --diagnostics` output into the
 * `RepoMemoryReportSchema` shape. Tolerant: missing numeric fields default to
 * 0, a missing `diagnostics` block leaves the entry counts null, the hit
 * ratio is clamped to [0, 1]. Returns null only when the payload is
 * unparseable or not an object.
 *
 * @param {string|null} json - raw stdout from the report command.
 * @returns {object|null} a `RepoMemoryReportSchema`-shaped object, or null.
 */
export function parseRepoMemoryReport(json) {
  if (json === null || json === undefined) return null
  let parsed
  try {
    parsed = JSON.parse(String(json))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const diag = parsed.diagnostics && typeof parsed.diagnostics === 'object' ? parsed.diagnostics : null
  const ratioRaw = nonNegNumber(parsed.cacheHitRatio, 0)
  return {
    totalEvents: Math.trunc(nonNegNumber(parsed.totalEvents, 0)),
    cacheHits: Math.trunc(nonNegNumber(parsed.cacheHits, 0)),
    cacheMisses: Math.trunc(nonNegNumber(parsed.cacheMisses, 0)),
    cacheHitRatio: Math.min(1, ratioRaw),
    estimatedTokensSaved: nonNegNumber(parsed.estimatedTokensSaved, 0),
    cacheEntryCount: diag && Number.isFinite(diag.cacheEntryCount) && diag.cacheEntryCount >= 0
      ? Math.trunc(diag.cacheEntryCount)
      : null,
    staleEntryCount: diag && Number.isFinite(diag.staleEntryCount) && diag.staleEntryCount >= 0
      ? Math.trunc(diag.staleEntryCount)
      : null,
    lastActivity: deriveLastActivity(parsed),
  }
}

/**
 * Resolve the `repo-memory` binary ONCE per snapshot. An explicit override
 * (config `controlRoomRepoMemoryBin`) wins without probing; otherwise probe
 * the PATH with `which`. Any failure resolves null — the survey then degrades
 * every CLI-derived cell with a snapshot-level note rather than spawning
 * (and failing) once per repo.
 *
 * @param {Function} execFn - promisified execFile seam.
 * @param {string} [binOverride] - explicit binary path from config.
 * @returns {Promise<string|null>} resolved binary path, or null.
 */
export async function resolveRepoMemoryBin(execFn, binOverride) {
  if (typeof binOverride === 'string' && binOverride.length > 0) return binOverride
  try {
    const { stdout } = await execFn('which', ['repo-memory'], EXEC_OPTS)
    const path = String(stdout == null ? '' : stdout).split('\n')[0].trim()
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

/**
 * Stat the repo's cache db + wal sidecar into a `RepoMemoryCacheSchema` shape.
 *
 * @param {Function} statFn - async stat seam ({ size, mtimeMs }).
 * @param {string} repoPath
 * @returns {Promise<{ present: boolean, sizeBytes: number, lastModified: string|null }>}
 */
async function surveyCache(statFn, repoPath) {
  const dbPath = join(repoPath, '.repo-memory', 'cache.db')
  let db = null
  try {
    db = await statFn(dbPath)
  } catch {
    return { present: false, sizeBytes: 0, lastModified: null }
  }
  let wal = null
  try {
    wal = await statFn(`${dbPath}-wal`)
  } catch {
    wal = null
  }
  const sizeBytes = Math.max(0, Math.trunc(nonNegNumber(db?.size, 0) + nonNegNumber(wal?.size, 0)))
  const mtimes = [db?.mtimeMs, wal?.mtimeMs].filter(m => typeof m === 'number' && Number.isFinite(m) && m > 0)
  const lastModified = mtimes.length > 0 ? new Date(Math.max(...mtimes)).toISOString() : null
  return { present: true, sizeBytes, lastModified }
}

/**
 * First meaningful line of a subprocess failure, for the per-repo `reason`.
 *
 * @param {unknown} err
 * @returns {string}
 */
function execFailureReason(err) {
  const stderr = err && typeof err === 'object' && typeof err.stderr === 'string' ? err.stderr : ''
  const firstLine = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (firstLine) return `repo-memory report failed: ${firstLine}`
  const message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : 'unknown error'
  return `repo-memory report failed: ${message}`
}

/**
 * Run `tasks` with a concurrency cap, preserving order. (Same helper shape as
 * survey.js / runners.js — kept local so the modules stay independent.)
 */
async function mapWithCap(tasks, cap) {
  const results = new Array(tasks.length)
  let cursor = 0
  const limit = Math.max(1, Math.min(cap, tasks.length || 1))
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++
      results[i] = await tasks[i]()
    }
  }
  const workers = []
  for (let i = 0; i < limit; i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

/** Tally the summary buckets across the surveyed repos. */
function summarize(repos) {
  const summary = { total: 0, configured: 0, notConfigured: 0, degraded: 0 }
  for (const repo of repos) {
    summary.total++
    const rm = repo.repoMemory
    if (!rm || !rm.configured) {
      summary.notConfigured++
      continue
    }
    summary.configured++
    if (rm.reason !== null) summary.degraded++
  }
  return summary
}

/**
 * Survey one repo's repo-memory status.
 *
 * @param {object} ctx - { readFn, statFn, execFn, binPath }
 * @param {{ name: string, path: string }} repo
 * @returns {Promise<{ name: string, path: string, repoMemory: object }>}
 */
async function surveyRepo(ctx, repo) {
  const { readFn, statFn, execFn, binPath } = ctx

  let configText = null
  try {
    configText = await readFn(join(repo.path, '.repo-memory.json'), 'utf8')
  } catch {
    configText = null
  }

  if (configText === null) {
    // Quiet "not configured" row — absence is signal, not an error.
    return {
      name: repo.name,
      path: repo.path,
      repoMemory: { configured: false, summarizer: null, toolGroups: [], cache: null, report: null, reason: null },
    }
  }

  const config = parseRepoMemoryConfig(configText)
  const cache = await surveyCache(statFn, repo.path)

  let report = null
  let reason = null
  if (!binPath) {
    reason = CLI_MISSING_NOTE
  } else {
    try {
      const { stdout } = await execFn(binPath, ['report', repo.path, '--json', '--diagnostics'], EXEC_OPTS)
      report = parseRepoMemoryReport(typeof stdout === 'string' ? stdout : '')
      if (report === null) reason = 'repo-memory report produced unparseable output'
    } catch (err) {
      reason = execFailureReason(err)
    }
  }

  return {
    name: repo.name,
    path: repo.path,
    repoMemory: {
      configured: true,
      summarizer: config ? config.summarizer : null,
      toolGroups: config ? config.toolGroups : [],
      cache,
      report,
      reason,
    },
  }
}

/**
 * Survey integration status across the resolved repo set and produce an
 * `integration_status_snapshot`-shaped result (minus the `type` field).
 *
 * @param {Array<{ name: string, path: string }>} repoSet - from resolveRepoSet.
 * @param {object} [opts]
 * @param {string} [opts.root] - the discovery root the set was resolved under
 *   (reported on the snapshot; same value the host survey reports).
 * @param {string} [opts.bin] - explicit repo-memory binary path (skips probing).
 * @param {number} [opts.concurrency]
 * @param {Function} [opts._readFile] - async readFile seam.
 * @param {Function} [opts._stat] - async stat seam.
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @param {Function} [opts._now] - returns a `Date`.
 * @returns {Promise<{ generatedAt: string, root: string, summary: object, repos: object[], repoMemoryCli: object }>}
 */
export async function surveyIntegrations(repoSet, opts = {}) {
  const {
    root = '',
    bin,
    concurrency = DEFAULT_CONCURRENCY,
    _readFile = readFile,
    _stat = stat,
    _execFile = execFileAsync,
    _now = () => new Date(),
  } = opts

  const now = _now()
  const repos = Array.isArray(repoSet) ? repoSet.filter(r => r && typeof r.path === 'string') : []

  // One binary probe per snapshot — never one per repo.
  const binPath = await resolveRepoMemoryBin(_execFile, bin)

  const ctx = { readFn: _readFile, statFn: _stat, execFn: _execFile, binPath }
  const tasks = repos.map(repo => () => surveyRepo(ctx, repo))
  const surveyed = await mapWithCap(tasks, concurrency)

  return {
    generatedAt: now.toISOString(),
    root,
    summary: summarize(surveyed),
    repos: surveyed,
    repoMemoryCli: {
      found: binPath !== null,
      path: binPath,
      note: binPath !== null ? null : CLI_MISSING_NOTE,
    },
  }
}
