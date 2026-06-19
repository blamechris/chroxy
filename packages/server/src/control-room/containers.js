/**
 * Control Room — containers & environments survey (#6133, epic #5530).
 *
 * Sibling to the Host/Repo survey (survey.js), the runner survey (runners.js),
 * and the integrations survey (integrations.js). Where those classify git repos,
 * self-hosted runners, and per-repo integrations, this one surveys the
 * **chroxy-managed containers and environments** the daemon is currently
 * depending on: every entry the EnvironmentManager tracks (Docker, Docker
 * Compose, and — as backends are validated — k8s/rancher), with its backing
 * working directory, image, state, session linkage, uptime, and a best-effort
 * `docker stats` resource snapshot.
 *
 * The result conforms to `ServerContainersStatusSnapshotSchema` from
 * `@chroxy/protocol` (minus the `type` field, which the WS handler adds).
 *
 * Degradation is first-class (the survey NEVER fails because one cell did):
 *   - No EnvironmentManager / no environments → an empty, valid snapshot.
 *   - `docker stats` unavailable (docker absent, daemon down, a stuck probe) →
 *     every entry's `stats` is null and the snapshot carries a `dockerStatsNote`;
 *     the survey still returns the environment inventory.
 *   - Only chroxy's OWN tracked environments are surveyed — this never enumerates
 *     arbitrary host containers, so it can't leak non-chroxy workloads.
 *
 * Every external interaction is injectable so tests never touch real docker/exec:
 *   - `listEnvironments()` — returns the EnvironmentManager's environment records.
 *   - `_execFile(file, args, opts)` — promisified `child_process.execFile` shape.
 *   - `_now()` — returns a `Date` (defaults to `new Date()`).
 *
 * Pure parse/classify helpers are exported individually so the bulk of the logic
 * is unit-tested without any orchestration.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * #6133: bound the `docker stats` probe so a stuck docker daemon rejects in
 * finite time instead of hanging the survey forever (which would also pin the
 * handler's per-client in-flight guard). The survey tolerates a rejected probe
 * (degrades to null stats + a note), so a timeout just guarantees it rejects.
 * Kept consistent with the sibling surveys (runners.js EXEC_TIMEOUT_MS).
 */
export const EXEC_TIMEOUT_MS = 20000
/** Modest output cap — one stats line per container, all small. */
const EXEC_MAX_BUFFER = 8 * 1024 * 1024
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/** Statuses counted as "running" in the summary. Everything else is stopped/other. */
const RUNNING_STATUSES = new Set(['running'])
const STOPPED_STATUSES = new Set(['stopped', 'exited', 'error'])

/**
 * Classify an environment record's backend from the fields it carries. The
 * EnvironmentManager records don't tag a backend explicitly, so infer it: a
 * compose project → 'compose'; a plain container id → 'docker'; an explicit
 * `backend` field (k8s/rancher, when those land) wins; else 'unknown'.
 *
 * @param {object} env - an EnvironmentManager environment record.
 * @returns {string} backend label.
 */
export function deriveBackend(env) {
  if (!env || typeof env !== 'object') return 'unknown'
  if (typeof env.backend === 'string' && env.backend.length > 0) return env.backend
  if (env.composeProject) return 'compose'
  if (env.containerId) return 'docker'
  return 'unknown'
}

/**
 * Parse a docker-style byte size (the left side of `MemUsage`, e.g. `45.2MiB`,
 * `1.952GiB`, `512B`, `3.4kB`) into bytes. Handles both binary (KiB/MiB/GiB) and
 * decimal (kB/MB/GB) units docker may emit depending on version/locale.
 *
 * @param {string} text - a size token like `45.2MiB`.
 * @returns {number|null} bytes, or null when unparseable.
 */
export function parseByteSize(text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/)
  if (!m) return null
  const value = parseFloat(m[1])
  if (!Number.isFinite(value)) return null
  const unit = m[2].toLowerCase()
  const mult = {
    '': 1, b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  }[unit]
  if (mult === undefined) return null
  return Math.round(value * mult)
}

/** Parse a percentage token (`2.26%`) into a number, or null. */
export function parsePercent(text) {
  if (typeof text !== 'string') return null
  const v = parseFloat(text.replace('%', '').trim())
  return Number.isFinite(v) ? v : null
}

/**
 * Parse `docker stats --no-stream` output produced with the format
 * `{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}` into a map keyed by the
 * 12-char short container id docker echoes.
 *
 * @param {string} stdout - raw stats output.
 * @returns {Map<string, {cpuPercent: number|null, memBytes: number|null, memPercent: number|null}>}
 */
export function parseDockerStats(stdout) {
  const byId = new Map()
  if (typeof stdout !== 'string') return byId
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [id, cpu, mem, memPct] = trimmed.split('|')
    if (!id) continue
    // MemUsage is "<used> / <limit>"; we want the used side.
    const used = typeof mem === 'string' ? mem.split('/')[0] : ''
    byId.set(id.trim(), {
      cpuPercent: parsePercent(cpu),
      memBytes: parseByteSize(used),
      memPercent: parsePercent(memPct),
    })
  }
  return byId
}

/**
 * Match an environment's (possibly full) container id against the 12-char short
 * ids `docker stats` echoes. Returns the stats entry or null.
 */
function statsForContainer(containerId, statsById) {
  if (!containerId || statsById.size === 0) return null
  if (statsById.has(containerId)) return statsById.get(containerId)
  for (const [shortId, stats] of statsById) {
    if (containerId.startsWith(shortId) || shortId.startsWith(containerId)) return stats
  }
  return null
}

/**
 * Best-effort `docker stats --no-stream` for a set of container ids. Returns an
 * empty map (NOT a rejection) when there are no ids; rejects only when the exec
 * itself fails so the caller can record a degradation note.
 */
export async function collectDockerStats(execFn, ids) {
  const wanted = (ids || []).filter(Boolean)
  if (wanted.length === 0) return new Map()
  const { stdout } = await execFn(
    'docker',
    ['stats', '--no-stream', '--format', '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}', ...wanted],
    EXEC_OPTS,
  )
  return parseDockerStats(stdout)
}

/**
 * Project an EnvironmentManager record + optional docker stats into a
 * `ContainerEntry` (the `ServerContainersStatusSnapshotSchema` shape).
 *
 * @param {object} env - environment record.
 * @param {Map} statsById - parsed docker stats keyed by short id.
 * @param {Date} now - survey time (for uptime).
 */
export function toContainerEntry(env, statsById, now) {
  const createdAt = typeof env?.createdAt === 'string' ? env.createdAt : null
  let uptimeMs = null
  if (createdAt) {
    const started = Date.parse(createdAt)
    if (Number.isFinite(started)) uptimeMs = Math.max(0, now.getTime() - started)
  }
  const status = typeof env?.status === 'string' ? env.status : 'unknown'
  const containerId = typeof env?.containerId === 'string' ? env.containerId : null
  return {
    id: String(env?.id ?? ''),
    name: typeof env?.name === 'string' ? env.name : '',
    cwd: typeof env?.cwd === 'string' ? env.cwd : '',
    image: typeof env?.image === 'string' ? env.image : null,
    status,
    backend: deriveBackend(env),
    containerId,
    composeProject: typeof env?.composeProject === 'string' ? env.composeProject : null,
    sessionCount: Array.isArray(env?.sessions) ? env.sessions.length : 0,
    createdAt,
    uptimeMs,
    // Only running containers report live stats; the rest are null by design.
    stats: status === 'running' ? statsForContainer(containerId, statsById) : null,
  }
}

/**
 * Aggregate container counts for the summary chips so the client doesn't
 * re-tally. All non-negative integers.
 */
export function summarize(containers) {
  const summary = { total: 0, running: 0, stopped: 0, other: 0 }
  for (const c of containers) {
    summary.total++
    if (RUNNING_STATUSES.has(c.status)) summary.running++
    else if (STOPPED_STATUSES.has(c.status)) summary.stopped++
    else summary.other++
  }
  return summary
}

/**
 * Survey the chroxy-managed containers & environments.
 *
 * @param {object} [opts]
 * @param {() => object[]} [opts.listEnvironments] - returns EnvironmentManager records.
 * @param {boolean} [opts.includeStats=true] - enrich running containers with `docker stats`.
 * @param {Function} [opts._execFile] - promisified execFile seam (tests).
 * @param {() => Date} [opts._now] - clock seam (tests).
 * @returns {Promise<{ generatedAt: string, summary: object, containers: object[], dockerStatsNote: string|null }>}
 */
export async function surveyContainers(opts = {}) {
  const {
    listEnvironments = () => [],
    includeStats = true,
    _execFile = execFileAsync,
    _now = () => new Date(),
  } = opts

  const now = _now()
  let environments = []
  try {
    const listed = listEnvironments()
    if (Array.isArray(listed)) environments = listed
  } catch {
    // Degrade to an empty inventory rather than failing the whole survey.
    environments = []
  }

  let statsById = new Map()
  let dockerStatsNote = null
  const runningIds = environments
    .filter((e) => e?.status === 'running' && typeof e?.containerId === 'string')
    .map((e) => e.containerId)
  if (includeStats && runningIds.length > 0) {
    try {
      statsById = await collectDockerStats(_execFile, runningIds)
    } catch (err) {
      // The inventory still returns; just no live resource numbers.
      dockerStatsNote = `docker stats unavailable: ${err && err.message ? err.message : 'probe failed'}`
    }
  }

  const containers = environments.map((env) => toContainerEntry(env, statsById, now))
  return {
    generatedAt: now.toISOString(),
    summary: summarize(containers),
    containers,
    dockerStatsNote,
  }
}
