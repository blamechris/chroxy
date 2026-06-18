/**
 * Control Room — Integrations survey (#5499, epic #5498).
 *
 * Sibling to the host survey (survey.js) and the runner survey (runners.js).
 * Where those classify git repos and self-hosted runners, this one surveys
 * **integration status** per repo — repo-memory (#5499) and repo-relay
 * (#5501):
 *
 *   - config:  does `.repo-memory.json` exist in the repo root? Parse its
 *     `summarizer` and enabled tool groups when it does.
 *   - cache:   `.repo-memory/cache.db` (+ `-wal` sidecar) file stats — present,
 *     combined size, newest mtime (the "last activity" proxy, since the
 *     telemetry report carries no timestamp of its own).
 *   - report:  `repo-memory report <repoRoot> --json --diagnostics` — total
 *     events, hit ratio, tokens saved, cache entry/stale counts. Read-only CLI.
 *   - relay (#5501): `.github/workflows/repo-relay.yml` presence, the
 *     `uses: blamechris/repo-relay@<ref>` version pin (tag or sha+comment),
 *     the latest upstream release (`gh api .../releases/latest`, ONE call per
 *     snapshot + a short module cache), and the five most recent workflow runs
 *     (`gh run list -R <owner>/<repo>` — owner/repo derived from the git
 *     remote via survey.js's parseGithubOwnerRepo).
 *
 * Degradation semantics (the survey NEVER fails because one cell did):
 *   - The `repo-memory` binary is resolved ONCE per snapshot (`which`), not per
 *     repo. When absent, every configured repo's report cell degrades with a
 *     per-repo `reason` and the snapshot carries a `repoMemoryCli` note.
 *   - Same for `gh` (#5501): one probe per snapshot; when absent every
 *     installed repo's relay run/release cells degrade with a per-repo
 *     `reason` and the snapshot carries a `ghCli` note.
 *   - A per-repo CLI failure (exit 1, timeout, unparseable output) degrades
 *     that repo's report cell with a `reason` string.
 *   - A repo without `.repo-memory.json` is a quiet `configured: false` row —
 *     absence is signal, not an error. Same for a repo without the relay
 *     workflow file (`installed: false`).
 *   - A repo with no GitHub remote still answers `installed` (and the pin)
 *     from the filesystem; the run cells degrade with reason
 *     'no GitHub remote'. Drift is still assessed — the pin comes from the
 *     workflow file and the latest release is repo-independent.
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
import { parseGithubOwnerRepo } from './survey.js'

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

/** #5501: snapshot-level note (and per-repo reason) when `gh` is missing. */
export const GH_MISSING_NOTE = 'gh CLI not found on PATH — install GitHub CLI (gh) to populate repo-relay run and release data'

/** #5501: per-repo reason when a repo has no recognisable GitHub remote. */
export const NO_GITHUB_REMOTE_REASON = 'no GitHub remote'

/** #5501: the upstream action repo whose releases define "latest". */
export const RELAY_UPSTREAM_REPO = 'blamechris/repo-relay'

/** #5501: the workflow file (and `gh run list --workflow` target) per repo. */
export const RELAY_WORKFLOW_FILE = 'repo-relay.yml'

/**
 * #5500: timeout for `repo-memory index` — deliberately much more generous
 * than the 20s survey probes: a cold index of a big repo summarizes every
 * indexable file and legitimately takes minutes-of-seconds. A run that blows
 * through this is treated as a failure with a reason, never a hang.
 */
export const INDEX_TIMEOUT_MS = 120000
/** Output cap for the index subprocess (per-file report lines can add up). */
const INDEX_EXEC_OPTS = { timeout: INDEX_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

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
  return probeBinOnPath(execFn, 'repo-memory')
}

/**
 * Probe the PATH for a binary with `which`. Any failure resolves null.
 *
 * @param {Function} execFn - promisified execFile seam.
 * @param {string} name - binary name (e.g. 'repo-memory', 'gh').
 * @returns {Promise<string|null>} resolved binary path, or null.
 */
async function probeBinOnPath(execFn, name) {
  try {
    const { stdout } = await execFn('which', [name], EXEC_OPTS)
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
 * First meaningful line of a subprocess failure, for the per-repo `reason` /
 * the reindex error message. `label` names the failing command ("repo-memory
 * report" for the survey cell, "repo-memory index" for the #5500 action).
 *
 * @param {unknown} err
 * @param {string} [label]
 * @returns {string}
 */
function execFailureReason(err, label = 'repo-memory report') {
  const stderr = err && typeof err === 'object' && typeof err.stderr === 'string' ? err.stderr : ''
  const firstLine = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (firstLine) return `${label} failed: ${firstLine}`
  const message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : 'unknown error'
  return `${label} failed: ${message}`
}

/**
 * #5500: parse the human-readable `repo-memory index <root>` report into the
 * `IntegrationActionCountsSchema` shape. The CLI has no `--json` for index —
 * the report is line-based (verified empirically against the installed CLI):
 *
 *   Indexed <root>
 *     scanned:       412
 *     summarized:    12
 *     already fresh: 398
 *     skipped:       2
 *     ...
 *
 * All four counts must parse or the whole result is null — the ack then
 * carries `counts: null` and the dashboard falls back to a survey refresh
 * rather than rendering a half-true breakdown.
 *
 * @param {string|null|undefined} stdout - raw stdout from the index command.
 * @returns {{ scanned: number, summarized: number, fresh: number, skipped: number }|null}
 */
export function parseRepoMemoryIndexCounts(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null
  const grab = re => {
    const m = re.exec(stdout)
    return m ? Number.parseInt(m[1], 10) : null
  }
  const counts = {
    scanned: grab(/^\s*scanned:\s*(\d+)\s*$/m),
    summarized: grab(/^\s*summarized:\s*(\d+)\s*$/m),
    fresh: grab(/^\s*already fresh:\s*(\d+)\s*$/m),
    skipped: grab(/^\s*skipped:\s*(\d+)\s*$/m),
  }
  for (const value of Object.values(counts)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
  }
  return counts
}

/**
 * #5500: run `repo-memory index <repoPath>` to prewarm/refresh the summary
 * cache. Shares the survey's binary resolution (`resolveRepoMemoryBin`) so a
 * `controlRoomRepoMemoryBin` override behaves identically for both surfaces.
 * Deliberately NOT `--quiet` — the human-readable report is the only place
 * the scanned/summarized/fresh/skipped counts exist.
 *
 * Resolves `{ counts }` (null when the report is unparseable). Throws with a
 * legible message when the binary is missing or the run fails/times out —
 * the WS handler turns that into an INTEGRATION_ACTION_FAILED session_error.
 *
 * @param {string} repoPath - canonical repo root (the handler validates
 *   membership in the surveyed repo set BEFORE calling this).
 * @param {object} [opts]
 * @param {string} [opts.bin] - explicit repo-memory binary path (skips probing).
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @returns {Promise<{ counts: object|null }>}
 */
export async function runRepoMemoryIndex(repoPath, opts = {}) {
  const { bin, _execFile = execFileAsync } = opts
  const binPath = await resolveRepoMemoryBin(_execFile, bin)
  if (!binPath) throw new Error(CLI_MISSING_NOTE)
  let stdout
  try {
    ;({ stdout } = await _execFile(binPath, ['index', repoPath], INDEX_EXEC_OPTS))
  } catch (err) {
    throw new Error(execFailureReason(err, 'repo-memory index'))
  }
  return { counts: parseRepoMemoryIndexCounts(typeof stdout === 'string' ? stdout : '') }
}

// ───────────────────────────────────────────────────────────────────────────
// #5502 — repo-relay Re-run action.
// ───────────────────────────────────────────────────────────────────────────

/**
 * #5502: timeout for `gh run rerun` — a single API mutation, so it gets a
 * 30s bound (longer than the 20s survey probes to ride out a slow API,
 * nowhere near the 120s index budget).
 */
export const RERUN_TIMEOUT_MS = 30000
/** Shared exec options for the rerun mutation. */
const RERUN_EXEC_OPTS = { timeout: RERUN_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/**
 * #5502: build an Error carrying a stable machine `reason` alongside the
 * human message. The WS handler echoes `reason` on the
 * INTEGRATION_ACTION_FAILED session_error so the dashboard can branch
 * without parsing message text.
 */
function rerunFailure(reason, message) {
  const err = new Error(message)
  err.reason = reason
  return err
}

/**
 * #5502: re-run a FAILED repo-relay workflow run via
 * `gh run rerun <databaseId> -R <owner>/<repo>`.
 *
 * SECURITY — the client-supplied `runId` is a LOOKUP KEY, never a trusted
 * exec target: before any mutation this re-fetches the same five-run window
 * the observability snapshot (#5501) surfaced and requires the id to (a) be
 * present in that fresh list and (b) have concluded `failure`. A stale,
 * fabricated, or non-failed id is rejected with a legible reason — `gh run
 * rerun` never sees an id the server didn't just observe. The owner/repo
 * target likewise derives server-side from the repo's git remote (the same
 * parseGithubOwnerRepo derivation the survey uses), never from the client.
 *
 * Throws with a machine `reason` (`gh-missing` / `no-github-remote` /
 * `run-list-failed` / `unknown-run` / `run-not-failed` / `rerun-failed`) —
 * the WS handler turns that into an INTEGRATION_ACTION_FAILED session_error.
 *
 * @param {string} repoPath - canonical repo root (the handler validates
 *   membership in the surveyed repo set BEFORE calling this).
 * @param {number} runId - the GitHub Actions run databaseId to re-run.
 * @param {object} [opts]
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @returns {Promise<{ runId: number }>}
 */
export async function runRepoRelayRerun(repoPath, runId, opts = {}) {
  const { _execFile = execFileAsync } = opts

  const ghPath = await probeBinOnPath(_execFile, 'gh')
  if (!ghPath) throw rerunFailure('gh-missing', GH_MISSING_NOTE)

  // Server-side owner/repo derivation — same source as the survey (#5501).
  let target = null
  try {
    const { stdout } = await _execFile('git', ['remote', 'get-url', 'origin'], { ...EXEC_OPTS, cwd: repoPath })
    target = parseGithubOwnerRepo(typeof stdout === 'string' ? stdout : '')
  } catch {
    target = null
  }
  if (!target) {
    throw rerunFailure('no-github-remote', `cannot re-run: ${NO_GITHUB_REMOTE_REASON} for ${repoPath}`)
  }
  const slug = `${target.owner}/${target.repo}`

  // runId re-validation: fresh fetch of the window the snapshot showed.
  let listStdout
  try {
    ;({ stdout: listStdout } = await _execFile(ghPath, [
      'run', 'list', `--workflow=${RELAY_WORKFLOW_FILE}`, '-R', slug,
      '--limit', '5', '--json', 'databaseId,conclusion,status',
    ], EXEC_OPTS))
  } catch (err) {
    throw rerunFailure('run-list-failed', execFailureReason(err, 'gh run list'))
  }
  const runs = parseRelayRuns(typeof listStdout === 'string' ? listStdout : '')
  if (runs === null) {
    throw rerunFailure('run-list-failed', 'gh run list produced unparseable output')
  }
  const match = runs.find(r => r.databaseId === runId)
  if (!match) {
    throw rerunFailure('unknown-run',
      `runId ${runId} is not among the last 5 repo-relay runs for ${slug} — refresh the survey and retry`)
  }
  if (match.conclusion !== 'failure') {
    const state = match.conclusion ?? match.status ?? 'not concluded'
    throw rerunFailure('run-not-failed',
      `run ${runId} did not fail (${state}) — only failed runs can be re-run`)
  }

  try {
    await _execFile(ghPath, ['run', 'rerun', String(runId), '-R', slug], RERUN_EXEC_OPTS)
  } catch (err) {
    throw rerunFailure('rerun-failed', execFailureReason(err, 'gh run rerun'))
  }
  return { runId }
}

// ───────────────────────────────────────────────────────────────────────────
// #5501 — repo-relay observability helpers.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse the `uses: blamechris/repo-relay@<ref>` line out of a workflow file.
 *
 * Handles both pin forms:
 *   - tag-pinned:          `uses: blamechris/repo-relay@v1.1.0`
 *   - sha-pinned+comment:  `uses: blamechris/repo-relay@f08840b9… # v1.1.0`
 *     (chroxy's own `.github/workflows/repo-relay.yml` is the live example)
 *
 * `version` resolves from the tag (when it looks like a version) or from the
 * sha pin's trailing `# vX.Y.Z` comment; it stays null for a bare sha or a
 * branch pin — drift then can't be assessed (`driftUnknown` upstream).
 *
 * @param {string|null|undefined} text - raw workflow YAML.
 * @returns {{ ref: string, sha: string|null, version: string|null }|null}
 *   the parsed pin, or null when no repo-relay uses line is present.
 */
export function parseRelayPin(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const m = /^\s*(?:-\s+)?uses:\s*['"]?blamechris\/repo-relay@([^\s'"#]+)['"]?[ \t]*(?:#[ \t]*(\S+))?[ \t]*$/m.exec(text)
  if (!m) return null
  const ref = m[1]
  const comment = m[2] || null
  const versionLike = v => typeof v === 'string' && /^v?\d+(\.\d+){0,2}$/.test(v)
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    return { ref, sha: ref, version: versionLike(comment) ? comment : null }
  }
  return { ref, sha: null, version: versionLike(ref) ? ref : null }
}

/**
 * Compare two version tags (`v1.1.0` / `1.1` — the leading `v` and a missing
 * minor/patch are tolerated). Returns -1/0/1, or null when either side is
 * unparseable (branch names, bare shas) — callers treat null as "can't
 * assess", never as equality.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1|0|1|null}
 */
export function compareVersions(a, b) {
  const parse = v => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(v ?? '').trim())
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/**
 * Parse `gh run list --json status,conclusion,event,createdAt,databaseId`
 * output into the `RepoRelayRunSchema` shape, most-recent-first as gh emits
 * it. Entries without a usable `databaseId` are dropped (#5502's rerun action
 * needs the id); `createdAt` is normalised to a strict ISO-8601 string.
 *
 * @param {string|null|undefined} json - raw stdout, or null when unavailable.
 * @returns {object[]|null} parsed runs, or null when the payload is
 *   absent/unparseable/not an array (the caller degrades with a reason).
 */
export function parseRelayRuns(json) {
  if (json === null || json === undefined) return null
  let parsed
  try {
    parsed = JSON.parse(String(json))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const runs = []
  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue
    if (!Number.isInteger(r.databaseId) || r.databaseId < 0) continue
    const str = v => (typeof v === 'string' && v.length > 0 ? v : null)
    const createdMs = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN
    runs.push({
      databaseId: r.databaseId,
      status: str(r.status),
      conclusion: str(r.conclusion),
      event: str(r.event),
      createdAt: Number.isNaN(createdMs) ? null : new Date(createdMs).toISOString(),
    })
  }
  return runs
}

/**
 * Count consecutive failed conclusions from the most recent run backwards.
 * In-progress runs (no conclusion yet) are skipped — they neither extend nor
 * break the streak; any other conclusion (success, cancelled, …) breaks it.
 *
 * @param {Array<{ conclusion: string|null }>|null|undefined} runs
 * @returns {number}
 */
export function computeRelayFailureStreak(runs) {
  let streak = 0
  for (const r of Array.isArray(runs) ? runs : []) {
    const conclusion = r && typeof r.conclusion === 'string' && r.conclusion.length > 0 ? r.conclusion : null
    if (conclusion === null) continue // still running — no signal yet
    if (conclusion === 'failure') {
      streak++
      continue
    }
    break
  }
  return streak
}

/**
 * Classify a repo's relay status into a `RepoRelayVerdictSchema` bucket.
 * Precedence (most urgent first): a broken relay beats a stale pin beats
 * green:
 *
 *   - not installed                              → 'not_installed'
 *   - latest CONCLUDED run failed                → 'failing'
 *   - pinned version < latest release            → 'drifted'
 *   - latest concluded run succeeded             → 'ok'
 *   - anything else (no concluded runs, runs
 *     unavailable, drift unassessable)           → 'unknown'
 *
 * @param {{ installed: boolean, pinnedVersion: string|null,
 *   latestVersion: string|null, runs: Array<{ conclusion: string|null }> }} relay
 * @returns {'ok'|'failing'|'drifted'|'not_installed'|'unknown'}
 */
export function classifyRelay({ installed, pinnedVersion, latestVersion, runs }) {
  if (!installed) return 'not_installed'
  const latestConcluded = (Array.isArray(runs) ? runs : [])
    .find(r => r && typeof r.conclusion === 'string' && r.conclusion.length > 0)
  if (latestConcluded && latestConcluded.conclusion === 'failure') return 'failing'
  const cmp = compareVersions(pinnedVersion, latestVersion)
  if (cmp !== null && cmp < 0) return 'drifted'
  if (latestConcluded && latestConcluded.conclusion === 'success') return 'ok'
  return 'unknown'
}

/**
 * #5501: how long a fetched `releases/latest` result stays good across
 * snapshots. Refresh-spamming the Integrations tab must not hammer the GitHub
 * API — within this window the module-level cache answers without a call.
 * Only SUCCESSFUL fetches are cached: a rate-limited/offline attempt degrades
 * that snapshot with a reason and the next refresh retries.
 */
export const RELAY_RELEASE_CACHE_TTL_MS = 5 * 60 * 1000

/** Module-level latest-release cache: `{ version, fetchedAtMs }` or null. */
let relayReleaseCache = null

/** Test seam: drop the module-level latest-release cache. */
export function _clearRelayReleaseCache() {
  relayReleaseCache = null
}

/**
 * Fetch the latest blamechris/repo-relay release tag via
 * `gh api repos/blamechris/repo-relay/releases/latest`, honouring the module
 * cache. Never throws — failures resolve `{ version: null, reason }`.
 *
 * @param {Function} execFn - promisified execFile seam.
 * @param {string} ghPath - resolved gh binary path.
 * @param {number} nowMs - snapshot clock (the injected `_now`).
 * @returns {Promise<{ version: string|null, reason: string|null }>}
 */
async function fetchLatestRelayRelease(execFn, ghPath, nowMs) {
  if (relayReleaseCache && nowMs >= relayReleaseCache.fetchedAtMs
    && nowMs - relayReleaseCache.fetchedAtMs < RELAY_RELEASE_CACHE_TTL_MS) {
    return { version: relayReleaseCache.version, reason: null }
  }
  let stdout
  try {
    ;({ stdout } = await execFn(ghPath, ['api', `repos/${RELAY_UPSTREAM_REPO}/releases/latest`], EXEC_OPTS))
  } catch (err) {
    return { version: null, reason: execFailureReason(err, 'gh releases/latest') }
  }
  let parsed
  try {
    parsed = JSON.parse(typeof stdout === 'string' ? stdout : '')
  } catch {
    parsed = null
  }
  const version = parsed && typeof parsed === 'object' && typeof parsed.tag_name === 'string' && parsed.tag_name.length > 0
    ? parsed.tag_name
    : null
  if (version === null) {
    return { version: null, reason: 'gh releases/latest returned no tag_name' }
  }
  relayReleaseCache = { version, fetchedAtMs: nowMs }
  return { version, reason: null }
}

/** The quiet `installed: false` relay block (no workflow file → no probing). */
function relayNotInstalled() {
  return {
    installed: false,
    pinnedVersion: null,
    pinnedSha: null,
    latestVersion: null,
    runs: [],
    failureStreak: 0,
    verdict: 'not_installed',
    driftUnknown: false,
    workflowUrl: null,
    reason: null,
  }
}

/**
 * Survey one repo's repo-relay status (#5501).
 *
 * `installed` + the version pin come from the filesystem alone; the run list
 * and latest release ride on `gh`. Every degradation is per-repo (a `reason`
 * string) — the block always returns. The first applicable reason wins, most
 * actionable first: gh missing → no GitHub remote → run-list failure →
 * latest-release failure → unparseable pin.
 *
 * @param {object} ctx - { readFn, execFn, ghPath, getLatestRelease }
 * @param {{ name: string, path: string }} repo
 * @returns {Promise<object>} a `RepoRelayStatusSchema`-shaped object.
 */
async function surveyRepoRelay(ctx, repo) {
  const { readFn, execFn, ghPath, getLatestRelease } = ctx

  let workflowText = null
  try {
    workflowText = await readFn(join(repo.path, '.github', 'workflows', RELAY_WORKFLOW_FILE), 'utf8')
  } catch {
    workflowText = null
  }
  if (workflowText === null) return relayNotInstalled()

  const pin = parseRelayPin(workflowText)

  // GitHub target from the repo's origin remote — same derivation the host
  // survey uses for its PR rollup (survey.js parseGithubOwnerRepo).
  let target = null
  try {
    const { stdout } = await execFn('git', ['remote', 'get-url', 'origin'], { ...EXEC_OPTS, cwd: repo.path })
    target = parseGithubOwnerRepo(typeof stdout === 'string' ? stdout : '')
  } catch {
    target = null
  }

  let latestVersion = null
  let runs = []
  let reason = null

  if (!ghPath) {
    reason = GH_MISSING_NOTE
  } else {
    // One shared call per snapshot — `getLatestRelease` memoises the promise.
    const latest = await getLatestRelease()
    latestVersion = latest.version

    if (!target) {
      reason = NO_GITHUB_REMOTE_REASON
    } else {
      try {
        const { stdout } = await execFn(ghPath, [
          'run', 'list', `--workflow=${RELAY_WORKFLOW_FILE}`, '-R', `${target.owner}/${target.repo}`,
          '--limit', '5', '--json', 'status,conclusion,event,createdAt,databaseId',
        ], EXEC_OPTS)
        const parsed = parseRelayRuns(typeof stdout === 'string' ? stdout : '')
        if (parsed === null) {
          reason = 'gh run list produced unparseable output'
        } else {
          runs = parsed
        }
      } catch (err) {
        reason = execFailureReason(err, 'gh run list')
      }
    }

    if (reason === null && latest.reason !== null) reason = latest.reason
  }

  if (reason === null && pin === null) {
    reason = 'could not parse the repo-relay uses pin from the workflow'
  }

  const pinnedVersion = pin ? pin.version : null
  const relay = {
    installed: true,
    pinnedVersion,
    pinnedSha: pin ? pin.sha : null,
    latestVersion,
    runs,
    failureStreak: computeRelayFailureStreak(runs),
    verdict: 'unknown',
    // Installed but the pin doesn't resolve to a version (bare sha, branch,
    // unparseable uses line) → drift can't be assessed.
    driftUnknown: pinnedVersion === null,
    workflowUrl: target
      ? `https://github.com/${target.owner}/${target.repo}/actions/workflows/${RELAY_WORKFLOW_FILE}`
      : null,
    reason,
  }
  relay.verdict = classifyRelay(relay)
  return relay
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
  const summary = {
    total: 0,
    configured: 0,
    notConfigured: 0,
    degraded: 0,
    // #5501: repo-relay tallies (verdict buckets the operator scans for).
    relayInstalled: 0,
    relayFailing: 0,
    relayDrifted: 0,
  }
  for (const repo of repos) {
    summary.total++
    const relay = repo.repoRelay
    if (relay && relay.installed) summary.relayInstalled++
    if (relay && relay.verdict === 'failing') summary.relayFailing++
    if (relay && relay.verdict === 'drifted') summary.relayDrifted++
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
 * Survey one repo's repo-memory status (#5499).
 *
 * @param {object} ctx - { readFn, statFn, execFn, binPath }
 * @param {{ name: string, path: string }} repo
 * @returns {Promise<object>} a `RepoMemoryStatusSchema`-shaped object.
 */
async function surveyRepoMemory(ctx, repo) {
  const { readFn, statFn, execFn, binPath } = ctx

  let configText = null
  try {
    configText = await readFn(join(repo.path, '.repo-memory.json'), 'utf8')
  } catch {
    configText = null
  }

  if (configText === null) {
    // Quiet "not configured" row — absence is signal, not an error.
    return { configured: false, summarizer: null, toolGroups: [], cache: null, report: null, reason: null }
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
    configured: true,
    summarizer: config ? config.summarizer : null,
    toolGroups: config ? config.toolGroups : [],
    cache,
    report,
    reason,
  }
}

/**
 * Survey one repo's integration status: the repo-memory block (#5499) and the
 * repo-relay block (#5501), probed concurrently — they share no state.
 *
 * @param {object} ctx - { readFn, statFn, execFn, binPath, ghPath, getLatestRelease }
 * @param {{ name: string, path: string }} repo
 * @returns {Promise<{ name: string, path: string, repoMemory: object, repoRelay: object }>}
 */
async function surveyRepo(ctx, repo) {
  const [repoMemory, repoRelay] = await Promise.all([
    surveyRepoMemory(ctx, repo),
    surveyRepoRelay(ctx, repo),
  ])
  return { name: repo.name, path: repo.path, repoMemory, repoRelay }
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

  // One binary probe per snapshot — never one per repo. The gh probe (#5501)
  // follows the same rule.
  const [binPath, ghPath] = await Promise.all([
    resolveRepoMemoryBin(_execFile, bin),
    probeBinOnPath(_execFile, 'gh'),
  ])

  // #5501: the upstream releases/latest lookup is repo-independent — memoise
  // the promise so the first installed repo triggers it and every other repo
  // shares the result (exactly ONE call per snapshot; the module cache then
  // spans snapshots). Never created when no repo has the workflow installed.
  let latestReleasePromise = null
  const getLatestRelease = () => {
    if (!latestReleasePromise) {
      latestReleasePromise = fetchLatestRelayRelease(_execFile, ghPath, now.getTime())
    }
    return latestReleasePromise
  }

  const ctx = { readFn: _readFile, statFn: _stat, execFn: _execFile, binPath, ghPath, getLatestRelease }
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
    ghCli: {
      found: ghPath !== null,
      path: ghPath,
      note: ghPath !== null ? null : GH_MISSING_NOTE,
    },
  }
}
