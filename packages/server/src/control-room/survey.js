/**
 * Control Room v2 (#5173) — host/repo git + gh survey + verdict engine.
 *
 * Given the resolved repo set (see `repo-set.js`), produces one `RepoStatus`
 * per repo plus aggregate `summary` counts, shaped to the A1
 * `host_status_snapshot` wire contract (minus the `type` field, which the WS
 * handler in #5174 adds). The result conforms exactly to
 * `ServerHostStatusSnapshotSchema` from `@chroxy/protocol`.
 *
 * Every external interaction is injectable so tests never touch real git / gh
 * or the user's home directory:
 *   - `_execFile(file, args, opts)` — async, resolves `{ stdout, stderr }`
 *     (the promisified `child_process.execFile` shape). Rejected promises are
 *     tolerated per-command.
 *   - `_now()` — returns a `Date` (defaults to `new Date()`), for deterministic
 *     verdict/threshold tests.
 *   - `_readFile(path)` — async, resolves a string (for `.claude/settings.json`
 *     attribution detection).
 *
 * Verdict classification (`'live' | 'investigate' | 'abandoned' | 'recent' |
 * 'onboarded'`):
 *   - live        — a live agent is present (chroxy session bound to the repo,
 *                   or the dirty-tree-recently-touched heuristic).
 *   - investigate — an excessive worktree count (likely a leak).
 *   - recent      — dirty tree touched within the recent window, not live.
 *   - abandoned   — dirty tree last touched long ago, not live.
 *   - onboarded   — clean tree on the pull model.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { resolveRepoSet } from './repo-set.js'
import { getErrorMessage } from '../utils/error-message.js'
import { DEFAULT_CONCURRENCY, EXEC_TIMEOUT_MS } from './constants.js'

const execFileAsync = promisify(execFile)

/**
 * stdout cap for every git/gh probe (#5241). Node's execFile default is 1 MB,
 * and overflow REJECTS — which `tryExec` turns into `null`, mislabelling a real
 * repo with a large dirty/untracked tree (>1 MB of `git status --porcelain`) as
 * "not a git repo". 16 MB is far beyond any realistic porcelain output.
 */
const EXEC_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Cap for `gh pr list` (#5240). `gh pr list` defaults to 30, silently capping
 * the open-PR count AND the CI/review rollup. 200 covers even bot-heavy repos;
 * a repo past it is undercounted, but far less often than at the 30 default.
 */
const GH_PR_LIST_LIMIT = 200

/**
 * Default verdict thresholds. All durations are in milliseconds.
 *   - liveMs        — a dirty tree touched more recently than this is treated
 *                     as having a live agent (heuristic). Default 15 min.
 *   - recentMs      — a dirty tree touched more recently than this (but not
 *                     live) is `recent`; older than this is `abandoned`.
 *                     Default ~3 days.
 *   - worktreeLeak  — a worktree count at or above this is `investigate`.
 */
export const DEFAULT_THRESHOLDS = {
  liveMs: 15 * 60 * 1000,
  recentMs: 3 * 24 * 60 * 60 * 1000,
  worktreeLeak: 4,
}

/**
 * Run a git/gh command, tolerating failure. Resolves trimmed stdout on success
 * or `null` on any error (non-zero exit, missing binary, etc.).
 *
 * @param {Function} execFn - promisified execFile seam.
 * @param {string} file - executable (e.g. 'git', 'gh').
 * @param {string[]} args - argument vector.
 * @param {string} cwd - working directory.
 * @returns {Promise<string|null>} trimmed stdout, or null on error.
 */
async function tryExec(execFn, file, args, cwd) {
  try {
    const { stdout } = await execFn(file, args, { cwd, maxBuffer: EXEC_MAX_BUFFER, timeout: EXEC_TIMEOUT_MS })
    return typeof stdout === 'string' ? stdout.trim() : ''
  } catch {
    return null
  }
}

/**
 * Parse `git status --porcelain` output into a tree summary.
 *
 * Porcelain v1 lines are `XY <path>` where X is the index (staged) status and Y
 * is the working-tree (unstaged) status. `??` marks an untracked file. A file
 * may be counted in both staged and modified when it has changes in both the
 * index and the working tree (e.g. `MM`).
 *
 * @param {string} porcelain - raw `git status --porcelain` stdout.
 * @returns {{ state: 'clean'|'dirty', untracked: number, modified: number, staged: number }}
 */
export function parseTree(porcelain) {
  const lines = (porcelain || '')
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.length > 0)

  let untracked = 0
  let modified = 0
  let staged = 0

  for (const line of lines) {
    if (line.startsWith('??')) {
      untracked++
      continue
    }
    const x = line[0]
    const y = line[1]
    if (x && x !== ' ' && x !== '?') staged++
    if (y && y !== ' ' && y !== '?') modified++
  }

  const state = lines.length === 0 ? 'clean' : 'dirty'
  return { state, untracked, modified, staged }
}

/**
 * Count worktree entries from `git worktree list --porcelain` output.
 *
 * Each worktree is a record beginning with a `worktree <path>` line; records
 * are separated by blank lines. The count includes the main worktree, so a
 * repo with no extra worktrees reports 1.
 *
 * @param {string} porcelain - raw `git worktree list --porcelain` stdout.
 * @returns {number} number of worktrees (>= 0).
 */
export function countWorktrees(porcelain) {
  if (!porcelain) return 0
  return porcelain.split('\n').filter(l => l.startsWith('worktree ')).length
}

/**
 * Count open PRs from `gh pr list --json number` output.
 *
 * @param {string|null} json - raw stdout, or null if the command failed.
 * @returns {number|null} count, or null when undeterminable (gh missing /
 *   unauth / errored / unparseable).
 */
export function parseOpenPRs(json) {
  if (json === null || json === undefined) return null
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.length : null
  } catch {
    return null
  }
}

/**
 * Derive a repo's GitHub `{ owner, repo }` from its `origin` remote URL.
 *
 * Handles the three forms `git remote get-url origin` can return for a GitHub
 * remote — SCP-style SSH (`git@github.com:owner/repo.git`), `ssh://` URLs, and
 * `https://` URLs — with or without a trailing `.git`. Returns null for a
 * non-GitHub remote, an empty/failed lookup, or anything that doesn't match.
 *
 * Shared derivation: this survey builds the PR rollup link from it (see
 * {@link parseGithubPrsUrl}); the Integrations survey (#5501) reuses it to
 * target `gh run list -R <owner>/<repo>` and the Actions deep link.
 *
 * @param {string|null} remote - raw `git remote get-url origin` stdout.
 * @returns {{ owner: string, repo: string }|null}
 */
export function parseGithubOwnerRepo(remote) {
  if (!remote || typeof remote !== 'string') return null
  const trimmed = remote.trim()
  // owner + repo are each a single path segment ([^/]+) so an extra segment
  // (e.g. `owner/repo/extra`) does NOT match (returns null rather than minting
  // a bogus target). The ssh URL form allows an optional port (e.g. the
  // common ssh-over-:443 remote).
  const patterns = [
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/, // scp-style ssh
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?$/, // ssh url (optional port)
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/, // https
  ]
  for (const re of patterns) {
    const m = re.exec(trimmed)
    if (m) return { owner: m[1], repo: m[2] }
  }
  return null
}

/**
 * Derive a repo's GitHub pull-requests URL from its `origin` remote URL —
 * `https://github.com/<owner>/<repo>/pulls`, or null when the remote isn't a
 * recognisable GitHub repo (see {@link parseGithubOwnerRepo}).
 *
 * @param {string|null} remote - raw `git remote get-url origin` stdout.
 * @returns {string|null}
 */
export function parseGithubPrsUrl(remote) {
  const target = parseGithubOwnerRepo(remote)
  return target ? `https://github.com/${target.owner}/${target.repo}/pulls` : null
}

/**
 * #6539 — resolve the EXACT active-repo set for repo-events scoping. For each
 * distinct active-session cwd, read its `origin` remote (`git remote get-url
 * origin`, failure-tolerant) and map it to `owner/repo` via
 * {@link parseGithubOwnerRepo}. A cwd that isn't a git repo, has no origin, or
 * has a non-GitHub remote resolves to null and is dropped — so a session without
 * a recognizable GitHub remote is simply absent from the set (the dashboard
 * degrades to "show all" for it rather than scoping it out). Deduped + sorted so
 * the snapshot field is deterministic.
 *
 * @param {string[]} cwds - active-session working directories.
 * @param {object} [opts]
 * @param {Function} [opts.execFn] - promisified execFile seam (tests inject a stub).
 * @param {number} [opts.concurrency]
 * @returns {Promise<string[]>} sorted, deduped `owner/repo` full names.
 */
export async function resolveActiveRepos(cwds, { execFn = execFileAsync, concurrency = 4 } = {}) {
  const distinct = [...new Set((Array.isArray(cwds) ? cwds : []).filter((c) => typeof c === 'string' && c.length > 0))]
  if (distinct.length === 0) return []
  const tasks = distinct.map((cwd) => async () => {
    const remote = await tryExec(execFn, 'git', ['remote', 'get-url', 'origin'], cwd)
    const parsed = parseGithubOwnerRepo(remote)
    return parsed ? `${parsed.owner}/${parsed.repo}` : null
  })
  const names = await mapWithCap(tasks, concurrency)
  return [...new Set(names.filter(Boolean))].sort()
}

/**
 * Conclusions/states from a `gh` statusCheckRollup entry that count as a failed
 * check. `gh pr list --json statusCheckRollup` mixes two node shapes: CheckRun
 * (GitHub Actions etc., carries `status` + `conclusion`) and StatusContext
 * (legacy commit statuses, carries `state`). We treat either field uniformly.
 */
const CI_FAIL_VALUES = new Set([
  'FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE',
])
const CI_PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'])

/**
 * Reduce one PR's `statusCheckRollup` array to a single CI state.
 *
 * @param {Array|undefined} rollup
 * @returns {'failing'|'pending'|'passing'|'none'} 'none' when there are no checks.
 */
function rollupCiState(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let anyPending = false
  for (const c of rollup) {
    const conclusion = (c && (c.conclusion || c.state)) || ''
    const status = (c && c.status) || ''
    if (CI_FAIL_VALUES.has(conclusion)) return 'failing'
    if (CI_PENDING_STATUSES.has(status) || conclusion === 'PENDING') anyPending = true
  }
  return anyPending ? 'pending' : 'passing'
}

/**
 * Roll up CI + review state across a repo's open PRs from
 * `gh pr list --json number,reviewDecision,statusCheckRollup` output.
 *
 * Returns counts of open PRs that are CI-failing, CI-pending, review-approved,
 * and changes-requested, or `null` when the command failed / output is
 * unparseable (same null semantics as `parseOpenPRs`). All-zero counts mean
 * none of these tracked signals are present — which covers the no-open-PRs case
 * AND PRs that only carry untracked states (e.g. passing CI with a
 * `REVIEW_REQUIRED` decision). `null` ≠ all-zero.
 *
 * @param {string|null} json
 * @returns {{ failing: number, pending: number, approved: number, changesRequested: number }|null}
 */
export function parsePrChecks(json) {
  if (json === null || json === undefined) return null
  let arr
  try {
    arr = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  let failing = 0
  let pending = 0
  let approved = 0
  let changesRequested = 0
  for (const pr of arr) {
    if (!pr || typeof pr !== 'object') continue
    const ci = rollupCiState(pr.statusCheckRollup)
    if (ci === 'failing') failing++
    else if (ci === 'pending') pending++
    if (pr.reviewDecision === 'APPROVED') approved++
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') changesRequested++
  }
  return { failing, pending, approved, changesRequested }
}

/**
 * Parse `git rev-list --left-right --count @{u}...HEAD` output into ahead/behind
 * counts relative to the upstream tracking branch.
 *
 * The command prints `<left>\t<right>` where, for `@{u}...HEAD`, the left side
 * counts commits the upstream has that HEAD lacks (= BEHIND) and the right side
 * counts commits HEAD has that the upstream lacks (= AHEAD).
 *
 * Returns `{ ahead: null, behind: null }` when the input is null (no upstream /
 * detached HEAD / command failed) or doesn't match the expected two-number
 * shape — never throws.
 *
 * @param {string|null} raw - raw stdout, or null on command failure.
 * @returns {{ ahead: number|null, behind: number|null }}
 */
export function parseAheadBehind(raw) {
  if (raw === null || raw === undefined) return { ahead: null, behind: null }
  const m = /^(\d+)\s+(\d+)$/.exec(String(raw).trim())
  if (!m) return { ahead: null, behind: null }
  return { behind: Number(m[1]), ahead: Number(m[2]) }
}

/**
 * Detect project-level attribution policy from `.claude/settings.json`.
 *
 * @param {string|null} contents - raw settings.json text, or null if absent.
 * @returns {boolean|null} `true` when `includeCoAuthoredBy` is explicitly
 *   `false` (attribution suppressed — the expected pull-model setup),
 *   `false` when explicitly `true`, `null` when the file is missing,
 *   unparseable, or the key is absent.
 */
export function detectAttribution(contents) {
  if (contents === null || contents === undefined) return null
  let parsed
  try {
    parsed = JSON.parse(contents)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.includeCoAuthoredBy !== 'boolean') return null
  // `includeCoAuthoredBy: false` ⇒ attribution suppressed ⇒ true (expected).
  return parsed.includeCoAuthoredBy === false
}

/**
 * Normalise a repo path into a canonical comparison key for matching against
 * active session cwds. Converts Windows backslashes to forward slashes (a
 * session `cwd` on Windows uses `\\` separators) and strips a single trailing
 * slash so prefix comparisons are separator-agnostic.
 *
 * @param {string} p - a path.
 * @returns {string} comparison key.
 */
function pathKey(p) {
  if (typeof p !== 'string') return ''
  const slashed = p.replace(/\\/g, '/')
  return slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed
}

/**
 * Whether any active chroxy-session cwd is bound to this repo path (exact match
 * or a descendant of the repo directory).
 *
 * @param {string} repoPath - the repo's absolute path.
 * @param {string[]} activeSessionCwds - cwds of active chroxy sessions.
 * @returns {boolean}
 */
function hasBoundSession(repoPath, activeSessionCwds) {
  const key = pathKey(repoPath)
  if (!key) return false
  for (const cwd of activeSessionCwds) {
    const c = pathKey(cwd)
    if (!c) continue
    if (c === key || c.startsWith(key + '/')) return true
  }
  return false
}

/**
 * Classify a repo into a verdict + derived `live`, `onboarding`, and `note`.
 *
 * @param {object} args
 * @param {{ state: string }} args.tree
 * @param {number} args.worktrees
 * @param {Date|null} args.lastTouchedDate
 * @param {boolean} args.sessionBound
 * @param {Date} args.now
 * @param {object} args.thresholds
 * @returns {{ verdict: string, live: boolean, onboarding: string, note?: string }}
 */
function classify({ tree, worktrees, lastTouchedDate, sessionBound, now, thresholds }) {
  const dirty = tree.state === 'dirty'
  const ageMs = lastTouchedDate ? now.getTime() - lastTouchedDate.getTime() : null

  // Live-agent detection: a bound chroxy session, OR the dirty-tree-recently-
  // touched heuristic.
  const heuristicLive = dirty && ageMs !== null && ageMs < thresholds.liveMs
  const live = sessionBound || heuristicLive

  if (live) {
    const note = sessionBound
      ? 'Active session here right now'
      : 'Uncommitted work touched moments ago — likely a live agent'
    return { verdict: 'live', live: true, onboarding: 'deferred (live)', note }
  }

  // Worktree leak takes precedence for a non-live repo — it's the clearest
  // "needs a human look" signal.
  if (worktrees >= thresholds.worktreeLeak) {
    return {
      verdict: 'investigate',
      live: false,
      onboarding: 'skipped — worktree leak',
      note: `${worktrees} worktrees — likely a leak`,
    }
  }

  if (dirty) {
    const recent = ageMs !== null && ageMs < thresholds.recentMs
    if (recent) {
      return {
        verdict: 'recent',
        live: false,
        onboarding: 'skipped — dirty tree',
        note: `Uncommitted work last touched ${humanizeAge(ageMs)} ago, no live agent`,
      }
    }
    return {
      verdict: 'abandoned',
      live: false,
      onboarding: 'skipped — dirty tree',
      note: `Uncommitted work last touched ${humanizeAge(ageMs)} ago, no live agent`,
    }
  }

  // Clean tree, not live, no leak → onboarded on the pull model.
  return { verdict: 'onboarded', live: false, onboarding: '✓ onboarded' }
}

/**
 * Render a coarse human-readable age for a `↳` note. Best-effort, not exact.
 *
 * @param {number|null} ageMs
 * @returns {string}
 */
function humanizeAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return 'an unknown time'
  const sec = Math.floor(ageMs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  return `${weeks}w`
}

/**
 * Survey one repo. A per-repo failure is contained: the worst case still
 * returns a schema-valid degraded `RepoStatus` with a note.
 *
 * @param {{ name: string, path: string }} repo
 * @param {object} ctx - { execFn, readFn, now, activeSessionCwds, thresholds }
 * @returns {Promise<object>} a `RepoStatus`-shaped object.
 */
async function surveyOne(repo, ctx) {
  const { execFn, readFn, now, activeSessionCwds, thresholds } = ctx
  const cwd = repo.path

  try {
    const sessionBound = hasBoundSession(repo.path, activeSessionCwds)

    // Run the independent git probes concurrently.
    const [branchRaw, statusRaw, worktreeRaw, lastRaw, aheadBehindRaw, remoteRaw, prRaw, settingsRaw] = await Promise.all([
      tryExec(execFn, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      tryExec(execFn, 'git', ['status', '--porcelain'], cwd),
      tryExec(execFn, 'git', ['worktree', 'list', '--porcelain'], cwd),
      tryExec(execFn, 'git', ['log', '-1', '--format=%cI'], cwd),
      // No upstream / detached HEAD makes this fail → null → ahead/behind null.
      tryExec(execFn, 'git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd),
      // origin remote → GitHub PRs URL (null for a non-GitHub / missing remote).
      tryExec(execFn, 'git', ['remote', 'get-url', 'origin'], cwd),
      // One gh call serves both the open-PR count and the CI/review rollup.
      // `--limit` is explicit: gh defaults to 30, which would silently cap both.
      tryExec(execFn, 'gh', ['pr', 'list', '--limit', String(GH_PR_LIST_LIMIT), '--json', 'number,reviewDecision,statusCheckRollup'], cwd),
      readSettings(readFn, repo.path),
    ])

    // `git status --porcelain` is the authoritative tree probe. A null here
    // means the command FAILED (path isn't a git repo, git unavailable, etc.)
    // — distinct from a successful empty string (a genuinely clean tree). We
    // must NOT fall back to parseTree('') in that case: it would paint a
    // false `clean`/`onboarded` row. Surface it as a degraded `investigate`
    // row instead so the Control Room flags it for a human look.
    if (statusRaw === null) {
      return degradedRepo(repo, now, new Error('git status probe failed (not a git repo or git unavailable)'))
    }

    const branch = branchRaw && branchRaw.length > 0 ? branchRaw : 'unknown'
    const tree = parseTree(statusRaw)
    const worktrees = countWorktrees(worktreeRaw || '')
    const { ahead, behind } = parseAheadBehind(aheadBehindRaw)
    const openPRs = parseOpenPRs(prRaw)
    const prChecks = parsePrChecks(prRaw)
    const prsUrl = parseGithubPrsUrl(remoteRaw)
    const attribution = detectAttribution(settingsRaw)

    const lastTouchedDate = lastRaw ? parseIsoDate(lastRaw) : null
    const lastTouched = lastTouchedDate ? lastTouchedDate.toISOString() : now.toISOString()

    const { verdict, live, onboarding, note } = classify({
      tree,
      worktrees,
      lastTouchedDate,
      sessionBound,
      now,
      thresholds,
    })

    const status = {
      name: repo.name,
      path: repo.path,
      branch,
      verdict,
      live,
      tree,
      worktrees,
      ahead,
      behind,
      openPRs,
      prChecks,
      prsUrl,
      attribution,
      onboarding,
      lastTouched,
    }
    if (note) status.note = note
    return status
  } catch (err) {
    // Degraded — never fail the whole survey on one repo.
    return degradedRepo(repo, now, err)
  }
}

/**
 * Read `.claude/settings.json` for a repo, tolerating absence/errors.
 *
 * @param {Function} readFn - async readFile seam.
 * @param {string} repoPath
 * @returns {Promise<string|null>}
 */
async function readSettings(readFn, repoPath) {
  try {
    const contents = await readFn(join(repoPath, '.claude', 'settings.json'), 'utf8')
    return typeof contents === 'string' ? contents : null
  } catch {
    return null
  }
}

/**
 * Parse an ISO date string into a `Date`, or null if invalid.
 *
 * @param {string} raw
 * @returns {Date|null}
 */
function parseIsoDate(raw) {
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t) : null
}

/**
 * Build a schema-valid degraded `RepoStatus` for a repo whose survey threw.
 *
 * @param {{ name: string, path: string }} repo
 * @param {Date} now
 * @param {Error} [err]
 * @returns {object}
 */
function degradedRepo(repo, now, err) {
  return {
    name: repo.name,
    path: repo.path,
    branch: 'unknown',
    verdict: 'investigate',
    live: false,
    tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
    worktrees: 0,
    ahead: null,
    behind: null,
    openPRs: null,
    prChecks: null,
    prsUrl: null,
    attribution: null,
    onboarding: 'skipped — survey failed',
    lastTouched: now.toISOString(),
    note: `Survey failed: ${getErrorMessage(err, 'unknown error')}`,
  }
}

/**
 * Run `tasks` with a concurrency cap, preserving input order in the result.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} cap
 * @returns {Promise<T[]>}
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

/**
 * Tally per-verdict summary counts across surveyed repos.
 *
 * @param {object[]} repos - `RepoStatus[]`.
 * @returns {{ live, onboarded, abandoned, investigate, recent }}
 */
function summarize(repos) {
  const summary = { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 }
  for (const r of repos) {
    if (r.verdict in summary) summary[r.verdict]++
  }
  return summary
}

/**
 * Survey a list of repos and produce a `host_status_snapshot`-shaped result
 * (minus the `type` field, which the WS handler adds).
 *
 * @param {Array<{ name: string, path: string }>} repoSet - resolved repo set.
 * @param {object} [opts]
 * @param {string[]} [opts.activeSessionCwds] - cwds of active chroxy sessions,
 *   supplied by the WS handler (#5174) from SessionManager.
 * @param {string} [opts.root] - the discovery root to report in the snapshot.
 * @param {object} [opts.thresholds] - verdict thresholds (see DEFAULT_THRESHOLDS).
 * @param {number} [opts.concurrency] - per-repo concurrency cap.
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @param {Function} [opts._now] - returns a `Date` for "now".
 * @param {Function} [opts._readFile] - async readFile seam.
 * @returns {Promise<{ generatedAt: string, root: string, summary: object, repos: object[] }>}
 */
export async function surveyRepos(repoSet, opts = {}) {
  const {
    activeSessionCwds = [],
    root = '',
    thresholds: thresholdOverrides = {},
    concurrency = DEFAULT_CONCURRENCY,
    _execFile = execFileAsync,
    _now = () => new Date(),
    _readFile = readFile,
  } = opts

  const now = _now()
  const thresholds = { ...DEFAULT_THRESHOLDS, ...thresholdOverrides }
  const ctx = {
    execFn: _execFile,
    readFn: _readFile,
    now,
    activeSessionCwds: Array.isArray(activeSessionCwds) ? activeSessionCwds : [],
    thresholds,
  }

  const list = Array.isArray(repoSet) ? repoSet : []
  const tasks = list.map(repo => () => surveyOne(repo, ctx))
  const repos = await mapWithCap(tasks, concurrency)

  return {
    generatedAt: now.toISOString(),
    root,
    summary: summarize(repos),
    repos,
  }
}

/**
 * Convenience: resolve the repo set (via `resolveRepoSet`) and survey it in one
 * call. The WS handler (#5174) will typically call `resolveRepoSet` and
 * `surveyRepos` separately so it can inject live session cwds, but this wrapper
 * is handy for a one-shot survey from config.
 *
 * @param {object} [opts] - merged options for `resolveRepoSet` + `surveyRepos`.
 * @returns {Promise<object>} snapshot-shaped result.
 */
export async function surveyHost(opts = {}) {
  const repoSet = resolveRepoSet({
    repos: opts.repos,
    root: opts.root,
    _readdir: opts._readdir,
    _stat: opts._stat,
    _exists: opts._exists,
    _realpath: opts._realpath,
  })
  return surveyRepos(repoSet, {
    ...opts,
    root: opts.root || '',
  })
}
