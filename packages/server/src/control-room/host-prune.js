/**
 * Host prune guardrails survey (#6140, epic #5530) — READ-ONLY.
 *
 * Surfaces reclaimable HOST docker pressure scoped STRICTLY to chroxy's OWN
 * resources, so the Control Room can prune dangling chroxy artifacts (the
 * container analog of `chroxy worktree gc`) without ever touching a non-chroxy
 * workload. chroxy stamps no docker labels — it identifies its resources by
 * naming convention:
 *   - containers: name prefix `chroxy-env-` (docker-backend `--name chroxy-env-<id>`)
 *   - images:     repositories `chroxy-env` (env snapshots `chroxy-env:<id>-<ts>`)
 *                 and `chroxy-byok-snap` (BYOK pool snapshots)
 * There are no chroxy-managed named volumes (the backends use bind mounts).
 *
 * "Prunable" is ORPHAN-ONLY: a stopped (exited/created/dead — never running)
 * chroxy container, or a chroxy snapshot image, that is NOT currently tracked by
 * a live EnvironmentManager record. Tracked resources are excluded so a prune
 * can never pull a container/image out from under a live environment.
 *
 * Degradation-first, like the sibling surveys: docker absent / daemon down / a
 * stuck probe → `dockerAvailable: false` with a `note` and empty lists, never an
 * error. Every external interaction is injectable so tests never touch real
 * docker/exec:
 *   - `listEnvironments()` — the EnvironmentManager's records (to exclude tracked).
 *   - `_execFile(file, args, opts)` — promisified `child_process.execFile`.
 *   - `_now()` — clock.
 *
 * Pure parse/classify helpers are exported individually for unit tests.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseByteSize } from './containers.js'

const execFileAsync = promisify(execFile)

/** Bound the docker probes so a stuck daemon rejects in finite time. */
export const EXEC_TIMEOUT_MS = 20000
const EXEC_MAX_BUFFER = 8 * 1024 * 1024
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/** chroxy container name prefix (docker-backend `--name chroxy-env-<id>`). */
export const CHROXY_CONTAINER_PREFIX = 'chroxy-env-'
/** chroxy image repositories (env snapshots + BYOK pool snapshots). */
export const CHROXY_IMAGE_REPOS = Object.freeze(['chroxy-env', 'chroxy-byok-snap'])
/** Container states that are safe to prune — never `running`/`paused`/`restarting`. */
export const PRUNABLE_CONTAINER_STATES = Object.freeze(['exited', 'created', 'dead'])

/**
 * Parse `docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Size}}'`
 * output into prunable chroxy container records. Keeps only names that actually
 * start with the chroxy prefix (the docker `name=` filter is a loose substring
 * match, so a non-chroxy container whose name merely CONTAINS `chroxy-env` is
 * dropped here as defense-in-depth) and only prunable (stopped) states. The
 * `Size` token is `"<writable> (virtual <total>)"`; we count the writable layer
 * (what `docker rm` actually frees).
 *
 * @param {string} stdout
 * @returns {Array<{id: string, name: string, state: string, sizeBytes: number|null}>}
 */
export function parseContainerLines(stdout) {
  if (typeof stdout !== 'string') return []
  const out = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [id, name, state, ...sizeParts] = trimmed.split('\t')
    if (!id || typeof name !== 'string' || !name.startsWith(CHROXY_CONTAINER_PREFIX)) continue
    const st = (state || '').trim().toLowerCase()
    if (!PRUNABLE_CONTAINER_STATES.includes(st)) continue
    // Size = "1.09kB (virtual 5.59MB)" → writable side before " (".
    const sizeToken = sizeParts.join('\t').split('(')[0]
    out.push({ id: id.trim(), name: name.trim(), state: st, sizeBytes: parseByteSize(sizeToken ? sizeToken.trim() : '') })
  }
  return out
}

/**
 * Parse `docker images <repo> --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}'`
 * output into chroxy image records, dropping any whose repository is not in the
 * chroxy set (defense-in-depth) and `<none>` dangling rows with no usable ref.
 *
 * @param {string} stdout
 * @returns {Array<{id: string, ref: string, repository: string, sizeBytes: number|null}>}
 */
export function parseImageLines(stdout) {
  if (typeof stdout !== 'string') return []
  const out = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [id, repository, tag, size] = trimmed.split('\t')
    if (!id || typeof repository !== 'string' || !CHROXY_IMAGE_REPOS.includes(repository.trim())) continue
    const repo = repository.trim()
    const t = (tag || '').trim()
    const ref = t && t !== '<none>' ? `${repo}:${t}` : repo
    out.push({ id: id.trim(), ref, repository: repo, sizeBytes: parseByteSize((size || '').trim()) })
  }
  return out
}

/** Sum a list of `{ sizeBytes }` records, treating null as 0. */
export function sumBytes(records) {
  return (records || []).reduce((acc, r) => acc + (Number.isFinite(r?.sizeBytes) ? r.sizeBytes : 0), 0)
}

/**
 * Build the set of container ids + image refs CURRENTLY tracked by live
 * EnvironmentManager records, so the prune survey excludes them (orphan-only).
 * Matches both full and 12-char short container ids (the writable-layer id docker
 * may echo) by recording the id and its 12-char prefix.
 *
 * @param {Array<object>} envs
 * @returns {{ containerIds: Set<string>, imageRefs: Set<string> }}
 */
export function trackedResources(envs) {
  const containerIds = new Set()
  const imageRefs = new Set()
  for (const env of Array.isArray(envs) ? envs : []) {
    const cid = typeof env?.containerId === 'string' ? env.containerId : ''
    if (cid) {
      containerIds.add(cid)
      containerIds.add(cid.slice(0, 12))
    }
    const image = typeof env?.image === 'string' ? env.image : ''
    if (image) imageRefs.add(image)
  }
  return { containerIds, imageRefs }
}

/** True if a surveyed container id is tracked by a live env (full or short id). */
function isTrackedContainer(id, tracked) {
  if (!id) return false
  if (tracked.containerIds.has(id) || tracked.containerIds.has(id.slice(0, 12))) return true
  // A stored full id may be longer than the surveyed short id — match forward.
  for (const tid of tracked.containerIds) {
    if (tid.length >= 12 && tid.startsWith(id)) return true
    if (id.length >= 12 && id.startsWith(tid)) return true
  }
  return false
}

/**
 * Survey reclaimable, chroxy-scoped, ORPHAN-ONLY host docker pressure.
 *
 * @param {object} [opts]
 * @param {() => Array<object>} [opts.listEnvironments] - live env records (to exclude tracked).
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @param {() => Date} [opts._now] - clock seam.
 * @returns {Promise<{generatedAt: string, dockerAvailable: boolean, note: string|null,
 *   containers: Array, images: Array, summary: {containerCount: number, imageCount: number,
 *   reclaimableBytes: number}}>}
 */
export async function surveyHostPrune(opts = {}) {
  const {
    listEnvironments = () => [],
    _execFile = execFileAsync,
    _now = () => new Date(),
  } = opts
  const now = _now()
  const base = {
    generatedAt: now.toISOString(),
    dockerAvailable: true,
    note: null,
    containers: [],
    images: [],
    summary: { containerCount: 0, imageCount: 0, reclaimableBytes: 0 },
  }

  const tracked = trackedResources(typeof listEnvironments === 'function' ? listEnvironments() : [])

  // Stopped chroxy containers. A docker/daemon failure here means docker is
  // unavailable → degrade the whole survey (no point probing images).
  let containers
  try {
    const { stdout } = await _execFile('docker', [
      'ps', '-a', '--size',
      '--filter', 'name=chroxy-env',
      '--filter', 'status=exited',
      '--filter', 'status=created',
      '--filter', 'status=dead',
      '--format', '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Size}}',
    ], EXEC_OPTS)
    containers = parseContainerLines(stdout).filter((c) => !isTrackedContainer(c.id, tracked))
  } catch (err) {
    return {
      ...base,
      dockerAvailable: false,
      note: `docker is unavailable — host prune survey skipped (${err && err.message ? err.message : 'exec failed'}).`,
    }
  }

  // chroxy images across both repos. A per-repo failure degrades just that repo
  // (the survey stays valid with whatever resolved).
  const images = []
  let imageNote = null
  for (const repo of CHROXY_IMAGE_REPOS) {
    try {
      const { stdout } = await _execFile('docker', [
        'images', repo, '--format', '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}',
      ], EXEC_OPTS)
      for (const img of parseImageLines(stdout)) {
        if (!tracked.imageRefs.has(img.ref)) images.push(img)
      }
    } catch (err) {
      imageNote = `some chroxy image repositories could not be listed (${err && err.message ? err.message : 'exec failed'}).`
    }
  }

  return {
    generatedAt: now.toISOString(),
    dockerAvailable: true,
    note: imageNote,
    containers,
    images,
    summary: {
      containerCount: containers.length,
      imageCount: images.length,
      reclaimableBytes: sumBytes(containers) + sumBytes(images),
    },
  }
}

/** Valid `kind` selectors for a host prune action. */
export const PRUNE_KINDS = Object.freeze(['containers', 'images', 'all'])

/**
 * Execute a host prune (#6140). Re-surveys server-side (the SAME chroxy-scoped,
 * orphan-only set the read survey reports) and removes ONLY those exact resource
 * ids — never a blanket `docker system/container/image prune`, never a running or
 * tracked resource, never a non-chroxy resource. The re-survey at action time is
 * the authority: a client-supplied list is never trusted (there is none — the
 * action takes only a `kind`).
 *
 * `docker rm` / `docker rmi` failures (e.g. an image still referenced by another
 * image, or a container that started racing the survey) are recorded per-resource
 * and do not abort the rest; the removed counts/bytes reflect only what succeeded.
 *
 * @param {object} [opts]
 * @param {'containers'|'images'|'all'} [opts.kind='all']
 * @param {() => Array<object>} [opts.listEnvironments]
 * @param {Function} [opts._execFile]
 * @param {() => Date} [opts._now]
 * @returns {Promise<{kind: string, dockerAvailable: boolean, removedContainers: number,
 *   removedImages: number, reclaimedBytes: number, failures: Array<{ref: string, error: string}>}>}
 */
export async function runHostPrune(opts = {}) {
  const {
    kind = 'all',
    listEnvironments = () => [],
    _execFile = execFileAsync,
    _now = () => new Date(),
  } = opts
  const selected = PRUNE_KINDS.includes(kind) ? kind : 'all'
  const survey = await surveyHostPrune({ listEnvironments, _execFile, _now })

  const result = {
    kind: selected,
    dockerAvailable: survey.dockerAvailable,
    removedContainers: 0,
    removedImages: 0,
    reclaimedBytes: 0,
    failures: [],
  }
  if (!survey.dockerAvailable) return result

  if (selected === 'containers' || selected === 'all') {
    for (const c of survey.containers) {
      try {
        await _execFile('docker', ['rm', c.id], EXEC_OPTS)
        result.removedContainers += 1
        result.reclaimedBytes += Number.isFinite(c.sizeBytes) ? c.sizeBytes : 0
      } catch (err) {
        result.failures.push({ ref: c.name || c.id, error: err && err.message ? err.message : 'docker rm failed' })
      }
    }
  }
  if (selected === 'images' || selected === 'all') {
    for (const img of survey.images) {
      try {
        await _execFile('docker', ['rmi', img.id], EXEC_OPTS)
        result.removedImages += 1
        result.reclaimedBytes += Number.isFinite(img.sizeBytes) ? img.sizeBytes : 0
      } catch (err) {
        result.failures.push({ ref: img.ref || img.id, error: err && err.message ? err.message : 'docker rmi failed' })
      }
    }
  }
  return result
}
