/**
 * Control Room — self-hosted runner survey (#5253).
 *
 * Sibling to the Host/Repo Status survey (survey.js). Where that one classifies
 * git repos, this one classifies the GitHub Actions **self-hosted runners**
 * installed on the host: it scans a runner-install root (default
 * `~/github-runners`), parses each install's `.runner` (repo URL + agent name)
 * and `.service` (service label), probes the platform service manager
 * (launchd on macOS, systemd on Linux) for the runner's running/PID/last-exit
 * state, and — when enabled — enriches each with GitHub's view
 * (`gh api .../actions/runners`: online/offline, busy, labels, os). Runners are
 * grouped by the GitHub target (repo or org) they register against.
 *
 * The result conforms to `ServerRunnerStatusSnapshotSchema` from
 * `@chroxy/protocol` (minus the `type` field, which the WS handler adds), the
 * same contract shape the host survey follows.
 *
 * Every external interaction is injectable so tests never touch real fs / exec
 * / the user's home dir:
 *   - `_readdir(dir, { withFileTypes: true })` — async, resolves Dirent-likes.
 *   - `_readFile(path, enc)` — async, resolves a string (rejects when absent).
 *   - `_execFile(file, args, opts)` — async, resolves `{ stdout, stderr }`
 *     (the promisified `child_process.execFile` shape). Rejections tolerated.
 *   - `_now()` — returns a `Date` (defaults to `new Date()`).
 *
 * Service probing dispatches on the per-install service manager parsed from each
 * install's `.service` file (`launchd` vs `systemd`), not on `process.platform`,
 * so no platform seam is needed — the `_execFile` seam already isolates the
 * exec calls from the host.
 *
 * Pure parse/classify helpers are exported individually so the bulk of the
 * logic is unit-tested without any orchestration.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, readdir } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'

const execFileAsync = promisify(execFile)

/** Default runner-install root scanned for `.runner` installs. */
export const DEFAULT_RUNNER_ROOT = join(homedir(), 'github-runners')

/** Default per-target concurrency cap for the survey. */
export const DEFAULT_CONCURRENCY = 5

/**
 * #5259: bound every probe subprocess so a stuck `gh`/`launchctl`/`systemctl`
 * (network blip, wedged service manager) rejects in finite time instead of
 * hanging the survey forever — which would also pin the handler's per-client
 * in-flight guard. The survey already tolerates a rejected probe (degrades to
 * not-running / null GitHub view), so a timeout just guarantees it rejects.
 * Kept consistent with the host survey (survey.js EXEC_TIMEOUT_MS).
 */
export const EXEC_TIMEOUT_MS = 20000
/** Modest output cap for probe subprocesses (runner JSON is small). */
const EXEC_MAX_BUFFER = 8 * 1024 * 1024
/** Shared exec options for every probe. */
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/**
 * Parse a runner install's `.runner` config (JSON). The file GitHub writes is
 * UTF-8 with a BOM, which `JSON.parse` rejects — strip a leading BOM first.
 *
 * @param {string|null} text - raw `.runner` contents, or null when absent.
 * @returns {{ agentName: string|null, gitHubUrl: string|null }|null} parsed
 *   identity, or null when the file is absent / unparseable / not an object.
 */
export function parseRunnerConfig(text) {
  if (text === null || text === undefined) return null
  let parsed
  try {
    parsed = JSON.parse(String(text).replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const agentName = typeof parsed.agentName === 'string' && parsed.agentName.length > 0 ? parsed.agentName : null
  const gitHubUrl = typeof parsed.gitHubUrl === 'string' && parsed.gitHubUrl.length > 0 ? parsed.gitHubUrl : null
  return { agentName, gitHubUrl }
}

/**
 * Resolve a runner install's `.service` file into a service-manager identity.
 *
 * On macOS the runner writes the absolute path of its LaunchAgent plist
 * (`.../actions.runner.<owner>-<repo>.<name>.plist`); the launchd label is that
 * basename minus `.plist`. On Linux it writes the systemd unit name
 * (`actions.runner.<owner>-<repo>.<name>.service`). A missing/empty file means
 * the runner was configured but never installed as a service.
 *
 * @param {string|null} text - raw `.service` contents, or null when absent.
 * @returns {{ manager: 'launchd'|'systemd'|'none', label: string|null }}
 */
export function parseServiceIdentity(text) {
  if (text === null || text === undefined) return { manager: 'none', label: null }
  const trimmed = String(text).trim()
  if (trimmed.length === 0) return { manager: 'none', label: null }
  const base = basename(trimmed)
  if (base.endsWith('.plist')) {
    return { manager: 'launchd', label: base.slice(0, -'.plist'.length) }
  }
  if (base.endsWith('.service')) {
    // systemd unit name (drop a trailing `.service` so we hold the bare unit
    // stem; systemctl accepts either form).
    return { manager: 'systemd', label: base.slice(0, -'.service'.length) }
  }
  // A bare label with no recognised extension — assume launchd (the common
  // macOS case where `.service` somehow held only the label).
  return { manager: 'launchd', label: base }
}

/**
 * Parse `launchctl list <label>` output into a service state.
 *
 * The output is a plist-ish dict with lines like `\t"PID" = 1778;` and
 * `\t"LastExitStatus" = 0;`. A present `PID` means the job is running; its
 * absence means the job is loaded-but-stopped. `LastExitStatus` carries the
 * most recent exit code (the crash signal when a stopped job exited non-zero).
 *
 * @param {string} stdout - raw `launchctl list <label>` output.
 * @returns {{ running: boolean, pid: number|null, lastExitCode: number|null }}
 */
export function parseLaunchctlList(stdout) {
  const text = String(stdout == null ? '' : stdout)
  const pidM = /"PID"\s*=\s*(\d+)\s*;/.exec(text)
  const exitM = /"LastExitStatus"\s*=\s*(-?\d+)\s*;/.exec(text)
  const pid = pidM ? Number(pidM[1]) : null
  const lastExitCode = exitM ? Number(exitM[1]) : null
  return { running: pid !== null && pid > 0, pid: pid !== null && pid > 0 ? pid : null, lastExitCode }
}

/**
 * Parse `systemctl show <unit> --property=ActiveState,MainPID,ExecMainStatus`
 * output (a `Key=Value` block) into a service state. `ActiveState=active` means
 * running; `MainPID` is the worker pid (0 when not running); `ExecMainStatus`
 * is the last exit code.
 *
 * @param {string} stdout
 * @returns {{ running: boolean, pid: number|null, lastExitCode: number|null }}
 */
export function parseSystemctlShow(stdout) {
  const props = {}
  for (const raw of String(stdout == null ? '' : stdout).split('\n')) {
    const line = raw.replace(/\r$/, '')
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    props[line.slice(0, eq)] = line.slice(eq + 1)
  }
  const running = props.ActiveState === 'active'
  const pidNum = Number(props.MainPID)
  const pid = Number.isInteger(pidNum) && pidNum > 0 ? pidNum : null
  const exitNum = Number(props.ExecMainStatus)
  const lastExitCode = props.ExecMainStatus !== undefined && Number.isFinite(exitNum) ? exitNum : null
  return { running, pid: running ? pid : null, lastExitCode }
}

/**
 * Probe a runner's service-manager state, tolerating any failure (an unloaded
 * service makes the probe command exit non-zero → treated as not-running).
 *
 * @param {Function} execFn - promisified execFile seam.
 * @param {{ manager: string, label: string|null }} service
 * @returns {Promise<{ running: boolean, pid: number|null, lastExitCode: number|null }>}
 */
export async function probeService(execFn, service) {
  const stopped = { running: false, pid: null, lastExitCode: null }
  if (!service || !service.label) return stopped
  try {
    if (service.manager === 'launchd') {
      const { stdout } = await execFn('launchctl', ['list', service.label], EXEC_OPTS)
      return parseLaunchctlList(stdout)
    }
    if (service.manager === 'systemd') {
      const { stdout } = await execFn('systemctl', [
        'show', service.label,
        '--property=ActiveState', '--property=MainPID', '--property=ExecMainStatus',
      ], EXEC_OPTS)
      return parseSystemctlShow(stdout)
    }
    return stopped
  } catch {
    // Probe failed (service not loaded / manager unavailable) → not running.
    return stopped
  }
}

/**
 * Parse a runner install's `gitHubUrl` into an owner/repo target.
 *
 * Handles repo URLs (`https://github.com/<owner>/<repo>`), org URLs
 * (`https://github.com/<org>` or `https://github.com/orgs/<org>`), with or
 * without a trailing slash or `.git`. Returns `repo: null` for an org target.
 * Returns nulls for anything that doesn't look like a GitHub URL.
 *
 * @param {string|null} url
 * @returns {{ owner: string|null, repo: string|null }}
 */
export function parseGithubTarget(url) {
  if (!url || typeof url !== 'string') return { owner: null, repo: null }
  const m = /^https?:\/\/github\.com\/(.+?)\/?$/.exec(url.trim())
  if (!m) return { owner: null, repo: null }
  const segs = m[1].split('/').filter(Boolean)
  if (segs.length === 0) return { owner: null, repo: null }
  // `orgs/<org>` → org target.
  if (segs[0] === 'orgs' && segs[1]) return { owner: segs[1], repo: null }
  if (segs.length === 1) return { owner: segs[0], repo: null } // bare org
  const repo = segs[1].replace(/\.git$/, '')
  return { owner: segs[0], repo }
}

/**
 * Build the GitHub runner-settings deep link for a target, or null when the
 * owner is unknown. Repo targets point at the repo's runner settings; org
 * targets at the org's. Shape is locked to what `RepoRunnersSchema.runnersUrl`
 * accepts (it's rendered as an `<a href>`).
 *
 * @param {{ owner: string|null, repo: string|null }} target
 * @returns {string|null}
 */
export function buildRunnersUrl({ owner, repo }) {
  if (!owner) return null
  if (repo) return `https://github.com/${owner}/${repo}/settings/actions/runners`
  return `https://github.com/organizations/${owner}/settings/actions/runners`
}

/**
 * The `gh api` path that lists a target's self-hosted runners.
 *
 * @param {{ owner: string|null, repo: string|null }} target
 * @returns {string|null}
 */
export function ghRunnersApiPath({ owner, repo }) {
  if (!owner) return null
  return repo ? `repos/${owner}/${repo}/actions/runners` : `orgs/${owner}/actions/runners`
}

/**
 * Parse `gh api .../actions/runners` JSON into a name→view map. Each value is
 * GitHub's view of a runner: `{ status, busy, os, labels }`. Returns an empty
 * Map on any failure (null/unparseable/unexpected shape) so the caller simply
 * finds no match and leaves the GitHub fields null.
 *
 * @param {string|null} json
 * @returns {Map<string, { status: string|null, busy: boolean|null, os: string|null, labels: string[] }>}
 */
export function parseGhRunners(json) {
  const out = new Map()
  if (json === null || json === undefined) return out
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return out
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.runners) ? parsed.runners : null
  if (!list) return out
  for (const r of list) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') continue
    const status = r.status === 'online' || r.status === 'offline' ? r.status : null
    const busy = typeof r.busy === 'boolean' ? r.busy : null
    const os = typeof r.os === 'string' ? r.os : null
    const labels = Array.isArray(r.labels)
      ? r.labels.map(l => (typeof l === 'string' ? l : l && typeof l.name === 'string' ? l.name : null)).filter(Boolean)
      : []
    out.set(r.name, { status, busy, os, labels })
  }
  return out
}

/**
 * Classify a runner into a verdict from its local service state and GitHub's
 * view. See `RunnerVerdictSchema` for the bucket definitions.
 *
 *   - no service registered                       → 'unregistered'
 *   - not running + GitHub online                 → 'offline' (mismatch)
 *   - not running (no GitHub view / offline)      → 'stopped'
 *   - running + GitHub online + busy              → 'busy'
 *   - running + GitHub online + not busy          → 'idle'
 *   - running + GitHub view unavailable           → 'idle' (locally healthy)
 *   - running + GitHub offline                    → 'offline' (mismatch)
 *
 * @param {{ manager: string, running: boolean }} service
 * @param {{ status: string|null, busy: boolean|null }|null} github
 * @returns {'busy'|'idle'|'offline'|'stopped'|'unregistered'}
 */
export function classifyRunner(service, github) {
  if (!service || service.manager === 'none' || !service.label) return 'unregistered'
  const status = github ? github.status : null
  if (!service.running) {
    // GitHub still reporting the runner online while the local service is down
    // is the inverse mismatch — surface it as 'offline', not a plain 'stopped'.
    return status === 'online' ? 'offline' : 'stopped'
  }
  if (status === 'offline') return 'offline'
  if (status === 'online') return github && github.busy ? 'busy' : 'idle'
  // Running locally with no GitHub view → trust the local healthy state.
  return 'idle'
}

/**
 * Scan the runner root for install directories, reading each one's `.runner`
 * and `.service` files. Returns one descriptor per VALID install (one whose
 * `.runner` parsed and carried a gitHubUrl). Tolerates a missing root / unread
 * entries.
 *
 * @param {object} ctx - { readdirFn, readFn, root }
 * @returns {Promise<Array<{ dir: string, config: object, service: object }>>}
 */
async function discoverInstalls(ctx) {
  const { readdirFn, readFn, root } = ctx
  let entries
  try {
    entries = await readdirFn(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = (Array.isArray(entries) ? entries : [])
    .filter(e => e && typeof e.isDirectory === 'function' && e.isDirectory())
    .map(e => join(root, e.name))

  const installs = []
  for (const dir of dirs) {
    let runnerText = null
    try {
      runnerText = await readFn(join(dir, '.runner'), 'utf8')
    } catch {
      continue // not a runner install
    }
    const config = parseRunnerConfig(runnerText)
    if (!config || !config.gitHubUrl) continue // need a target to group under

    let serviceText = null
    try {
      serviceText = await readFn(join(dir, '.service'), 'utf8')
    } catch {
      serviceText = null
    }
    installs.push({ dir, config, service: parseServiceIdentity(serviceText) })
  }
  return installs
}

/**
 * Run `tasks` with a concurrency cap, preserving order. (Same helper shape as
 * survey.js — kept local so the modules stay independent.)
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

/** Tally per-verdict + total counts across the grouped runners. */
function summarize(repos) {
  const summary = { total: 0, busy: 0, idle: 0, offline: 0, stopped: 0, unregistered: 0 }
  for (const group of repos) {
    for (const r of group.runners) {
      summary.total++
      if (r.verdict in summary) summary[r.verdict]++
    }
  }
  return summary
}

/**
 * Survey the host's self-hosted runners and produce a
 * `runner_status_snapshot`-shaped result (minus the `type` field).
 *
 * @param {object} [opts]
 * @param {string} [opts.root] - runner-install root (default ~/github-runners).
 * @param {boolean} [opts.includeGithub=true] - whether to enrich via `gh`.
 * @param {number} [opts.concurrency]
 * @param {Function} [opts._readdir] - async readdir seam.
 * @param {Function} [opts._readFile] - async readFile seam.
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @param {Function} [opts._now] - returns a `Date`.
 * @returns {Promise<{ generatedAt: string, root: string, summary: object, repos: object[] }>}
 */
export async function surveyRunners(opts = {}) {
  const {
    root = DEFAULT_RUNNER_ROOT,
    includeGithub = true,
    concurrency = DEFAULT_CONCURRENCY,
    _readdir = readdir,
    _readFile = readFile,
    _execFile = execFileAsync,
    _now = () => new Date(),
  } = opts

  const now = _now()
  const installs = await discoverInstalls({ readdirFn: _readdir, readFn: _readFile, root })

  // Group installs by their GitHub target (owner/repo), preserving first-seen
  // order so the table is stable.
  const groups = new Map() // key -> { name, owner, repo, githubUrl, runnersUrl, installs: [] }
  for (const inst of installs) {
    const target = parseGithubTarget(inst.config.gitHubUrl)
    const key = `${target.owner || '?'}/${target.repo || ''}`
    if (!groups.has(key)) {
      const name = target.repo || (target.owner ? `org:${target.owner}` : inst.config.gitHubUrl)
      groups.set(key, {
        name,
        owner: target.owner,
        repo: target.repo,
        githubUrl: inst.config.gitHubUrl,
        runnersUrl: buildRunnersUrl(target),
        target,
        installs: [],
      })
    }
    groups.get(key).installs.push(inst)
  }

  const groupList = [...groups.values()]

  // One survey task per group: probe each install's service (concurrently) and
  // optionally make a single `gh` call for the group's GitHub view.
  const tasks = groupList.map(group => async () => {
    const ghPromise = includeGithub
      ? (async () => {
          const path = ghRunnersApiPath(group.target)
          if (!path) return new Map()
          try {
            const { stdout } = await _execFile('gh', ['api', path], EXEC_OPTS)
            return parseGhRunners(typeof stdout === 'string' ? stdout : '')
          } catch {
            return new Map()
          }
        })()
      : Promise.resolve(new Map())

    const [serviceStates, ghMap] = await Promise.all([
      Promise.all(group.installs.map(inst => probeService(_execFile, inst.service))),
      ghPromise,
    ])

    const runners = group.installs.map((inst, i) => {
      const svc = serviceStates[i]
      const service = {
        manager: inst.service.manager,
        label: inst.service.label,
        running: svc.running,
        pid: svc.pid,
        lastExitCode: svc.lastExitCode,
      }
      const gh = inst.config.agentName ? ghMap.get(inst.config.agentName) || null : null
      return {
        name: inst.config.agentName || basename(inst.dir),
        dir: inst.dir,
        verdict: classifyRunner(service, gh),
        service,
        githubStatus: gh ? gh.status : null,
        busy: gh ? gh.busy : null,
        os: gh ? gh.os : null,
        labels: gh ? gh.labels : [],
      }
    })

    return {
      name: group.name,
      owner: group.owner,
      repo: group.repo,
      githubUrl: group.githubUrl,
      runnersUrl: group.runnersUrl,
      runners,
    }
  })

  const repos = await mapWithCap(tasks, concurrency)

  return {
    generatedAt: now.toISOString(),
    root,
    summary: summarize(repos),
    repos,
  }
}
