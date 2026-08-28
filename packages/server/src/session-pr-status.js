/**
 * Session → pull-request / CI status survey (#7344, display slice).
 *
 * A session that opened a PR has no durable knowledge of it: the PR number
 * exists only as text the model happened to type, so nothing in the UI can show
 * where the work stands and the agent is left to poll `gh pr checks` on its own
 * schedule. This module answers, for ONE session, the question the user
 * actually has while a session is in flight — *what is the state of the thing
 * this session produced?*
 *
 * Auth: none is introduced. Exactly like the Control Room integrations survey
 * (#5501/#5502), this shells out to the user's existing local `gh auth` and
 * inherits that survey's degradation behaviour when `gh` is absent or the
 * remote isn't GitHub.
 *
 * ## Three things this survey must never do
 *
 * 1. **Never fabricate a verdict.** A head commit with *no* checks at all is
 *    reported as `state: 'none'`, never as success — "no run for this SHA"
 *    and "run in progress" are distinct states with distinct counts, and a
 *    push can legitimately create no run at all. A rollup entry whose status
 *    or conclusion this module does not recognise lands in the `unknown`
 *    bucket and suppresses a `'success'` verdict; it is never counted as a
 *    pass.
 * 2. **Never scrape.** Every GitHub read goes through `--json`. `gh pr checks`
 *    output is TAB-separated, and splitting it on whitespace carves up job
 *    *names* — which makes a poller report "settled" instantly.
 * 3. **Never imply mergeability from CI.** `checks` and `merge` are separate
 *    fields and are never collapsed into a "ready?" boolean. The case that
 *    motivated this issue had 21/21 checks green while `mergeStateStatus` was
 *    `BLOCKED` on one unresolved review thread, so a combined badge would have
 *    been actively wrong in exactly the case the user needed it.
 *
 * ## Consistency of the reading
 *
 * `mergeStateStatus` and the check rollup are both functions of the head SHA, so
 * a reading assembled from two calls can straddle a push. Everything except the
 * branch/remote derivation therefore comes from a SINGLE `gh pr list` response,
 * and the `headRefOid` it reported is carried on the snapshot: the caller can
 * always see which commit the verdict describes. `mergeStateStatus: 'UNKNOWN'`
 * means GitHub is still recomputing, not that a blocker exists, and is passed
 * through verbatim rather than being interpreted here.
 *
 * ## Reading the result
 *
 * `pr: null` with `reason: null` is the quiet negative — this branch definitively
 * has no open PR, on `origin` OR (when `origin` is a fork) on its upstream.
 * `pr: null` with a `reason` means the survey could not find out. Those must
 * render differently; "cannot determine" must never read as an implied green.
 *
 * `indeterminate: true` (#7435) is the third state, and it is SERVER-SIDE ONLY:
 * a fork-widening lookup failed transiently, so absence was NOT established —
 * but the display contract above is deliberately unchanged (still the quiet
 * negative on the wire; a best-effort widening of an already-empty result must
 * not downgrade a usable partial answer). The one consumer that must not read
 * it as a fact is the CI watcher, whose `_reconcile` drops an armed watch on
 * `pr: null` — the marker gets the same "changes nothing" treatment there that
 * `reason` already gets, and the WS handler strips it before the reply goes out.
 *
 * Every external interaction is injectable so tests never touch real git/gh:
 *   - `_execFile(file, args, opts)` — async, resolves `{ stdout, stderr }`.
 *   - `_now()` — returns a `Date` (defaults to `new Date()`).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseGithubOwnerRepo } from './control-room/survey.js'
import { EXEC_TIMEOUT_MS } from './control-room/constants.js'
import { execFailureReason } from './utils/exec-failure-reason.js'
import { isSafeArgvValue } from './utils/argv-safety.js'

const execFileAsync = promisify(execFile)

/** Output cap: one PR's JSON, rollup included, is small. */
const EXEC_MAX_BUFFER = 8 * 1024 * 1024

/** Shared exec options for every probe (see EXEC_TIMEOUT_MS's rationale). */
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/**
 * How many base-repo rows to consider when disambiguating a fork's PR by head
 * owner. One branch name can be open from several forks at once, so this is
 * deliberately more than 1 — but bounded, since it is a fallback path.
 */
export const FORK_QUERY_LIMIT = 30

/** Reason when the session has no working directory to resolve a repo from. */
export const NO_CWD_REASON = 'session has no working directory'

/** Reason when the session's cwd is not inside a git repository. */
export const NOT_A_REPO_REASON = 'session working directory is not a git repository'

/** Reason when the session's cwd no longer exists (e.g. a reaped worktree). */
export const CWD_MISSING_REASON = 'session working directory no longer exists'

/** Reason when the session's checkout is on a detached HEAD (no branch to match a PR to). */
export const DETACHED_HEAD_REASON = 'detached HEAD — no branch to resolve a pull request from'

/** Reason when the repo has no remote this module recognises as GitHub. */
export const NO_GITHUB_REMOTE_REASON = 'no GitHub remote'

/** Reason when `gh` is not installed (mirrors the Control Room integrations note). */
export const GH_MISSING_REASON = 'gh CLI not found on PATH — install GitHub CLI (gh) to see pull-request and CI status'

/** Reason when the branch name is not safe to place in an option-parsed argv slot. */
export const UNSAFE_BRANCH_REASON = 'branch name cannot be passed safely to gh'

/**
 * The `--json` fields requested from `gh pr list`. One call, one head SHA.
 *
 * `headRepositoryOwner` is here for the fork path below: a base-repo query
 * matches on the bare branch name, and two forks can both have a `fix-typos`
 * branch open against the same base — so the row must be disambiguated by who
 * owns the head, not taken on `--limit 1`.
 */
export const PR_JSON_FIELDS = [
  'headRepositoryOwner',
  'number',
  'title',
  'url',
  'headRefOid',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'statusCheckRollup',
].join(',')

/**
 * Reduce every absolute path in a degradation reason to its basename.
 *
 * This reply is session-scoped rather than host-scoped, so unlike the Control
 * Room surveys it reaches a pairing-bound (share-a-session) client, which has no
 * business learning host filesystem layout. `execFile`'s own error message is
 * `Command failed: /Users/<name>/.../gh pr list …`.
 *
 * Deliberately NOT "strip the one path we resolved": that only removes the path
 * it was told about, and a message can carry others (a cwd, a config path, a
 * second binary). Rewriting every path-shaped token is the general form, and it
 * cannot be defeated by a path the caller did not anticipate.
 *
 * @param {string} reason
 * @returns {string}
 */
export function redactAbsolutePaths(reason) {
  if (typeof reason !== 'string') return reason
  // Any run of non-space characters containing a '/' after a leading '/' —
  // i.e. an absolute path with at least one directory — collapses to its
  // basename. A bare '/' or a lone segment is left alone.
  return reason.replace(/\/\S*\/\S*/g, match => {
    const base = match.slice(match.lastIndexOf('/') + 1)
    return base.length > 0 ? base : '/'
  })
}

/** Zeroed check counts — also the shape returned for a head with no checks. */
function emptyCounts() {
  return { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 }
}

/**
 * CheckRun `status` values that mean "not finished yet". Anything not in here
 * and not `COMPLETED` is unrecognised and lands in `unknown` — the list is
 * deliberately explicit so a new GitHub status is reported as unknown rather
 * than silently absorbed into a pass.
 */
const CHECK_RUN_PENDING_STATUS = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'])

/** CheckRun conclusions that count as a pass. `NEUTRAL` does not fail a rollup. */
const CHECK_RUN_PASS_CONCLUSION = new Set(['SUCCESS', 'NEUTRAL'])

/** CheckRun conclusions that count as a failure. */
const CHECK_RUN_FAIL_CONCLUSION = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
  'STALE',
])

/** Legacy commit-status (`StatusContext`) states, by bucket. */
const STATUS_CONTEXT_BUCKET = new Map([
  ['SUCCESS', 'passed'],
  ['PENDING', 'pending'],
  ['EXPECTED', 'pending'],
  ['FAILURE', 'failed'],
  ['ERROR', 'failed'],
])

/**
 * Bucket ONE `statusCheckRollup` entry.
 *
 * The rollup mixes two GraphQL types — modern `CheckRun`s (a `status` plus, once
 * `COMPLETED`, a `conclusion`) and legacy `StatusContext` commit statuses (a
 * single `state`). Both are handled; anything else is `'unknown'`.
 *
 * @param {unknown} entry
 * @returns {'passed'|'failed'|'pending'|'skipped'|'unknown'}
 */
export function bucketRollupEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'unknown'

  // A StatusContext carries `state` and no `status`; a CheckRun is the converse.
  // Dispatch on __typename when present, and fall back to which field exists so
  // a response missing __typename still buckets correctly.
  const typename = typeof entry.__typename === 'string' ? entry.__typename : null
  const looksLikeStatusContext = typename === 'StatusContext' || (typename === null && typeof entry.state === 'string')

  if (looksLikeStatusContext) {
    return STATUS_CONTEXT_BUCKET.get(String(entry.state).toUpperCase()) || 'unknown'
  }

  if (typename !== null && typename !== 'CheckRun') return 'unknown'

  const status = typeof entry.status === 'string' ? entry.status.toUpperCase() : null
  if (status === null) return 'unknown'
  if (CHECK_RUN_PENDING_STATUS.has(status)) return 'pending'
  if (status !== 'COMPLETED') return 'unknown'

  const conclusion = typeof entry.conclusion === 'string' ? entry.conclusion.toUpperCase() : null
  if (conclusion === 'SKIPPED') return 'skipped'
  if (conclusion !== null && CHECK_RUN_PASS_CONCLUSION.has(conclusion)) return 'passed'
  if (conclusion !== null && CHECK_RUN_FAIL_CONCLUSION.has(conclusion)) return 'failed'
  return 'unknown'
}

/**
 * Summarise a `statusCheckRollup` array into a state + counts.
 *
 * The overall `state` follows GitHub's own rollup semantics — a run that is
 * still going is `'pending'` even when something in it has already failed — so
 * `state` alone never implies the run is settled. The `failed` count stays
 * visible alongside it precisely so a UI can say "3 failed / 5 pending" rather
 * than hiding a known failure behind a spinner.
 *
 * `'none'` (an absent or empty rollup) is NOT success: it means this head SHA
 * produced no run, which a push can legitimately do.
 *
 * @param {unknown} rollup - the `statusCheckRollup` value from `gh pr list`.
 * @returns {{ state: 'none'|'pending'|'failure'|'unknown'|'success', counts: object }}
 */
export function summariseChecks(rollup) {
  const counts = emptyCounts()
  if (!Array.isArray(rollup) || rollup.length === 0) return { state: 'none', counts }

  for (const entry of rollup) {
    counts[bucketRollupEntry(entry)] += 1
    counts.total += 1
  }

  // Order matters and is asserted by tests: pending outranks failure (the run is
  // not settled), failure outranks unknown, and success is only claimed when
  // every entry was recognised AND passed or was skipped.
  let state
  if (counts.pending > 0) state = 'pending'
  else if (counts.failed > 0) state = 'failure'
  else if (counts.unknown > 0) state = 'unknown'
  else state = 'success'
  return { state, counts }
}

/**
 * Normalise one `gh pr list --json` row into the snapshot's `pr` / `checks` /
 * `merge` fields. Exported for unit tests.
 *
 * `mergeable` / `mergeStateStatus` / `reviewDecision` are passed through as
 * GitHub reports them (empty string normalised to null) — this module does not
 * interpret them, and in particular does not turn them into a mergeability
 * verdict alongside the check state.
 *
 * @param {unknown} row
 * @returns {{ pr: object, checks: object, merge: object }|null} null when the
 *   row carries no usable PR number.
 */
export function normalisePrRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  if (!Number.isInteger(row.number) || row.number <= 0) return null

  const str = v => (typeof v === 'string' && v.length > 0 ? v : null)
  const { state, counts } = summariseChecks(row.statusCheckRollup)

  return {
    pr: {
      number: row.number,
      title: str(row.title),
      url: str(row.url),
      headRefOid: str(row.headRefOid),
      isDraft: row.isDraft === true,
    },
    checks: { state, counts },
    merge: {
      mergeable: str(row.mergeable),
      mergeStateStatus: str(row.mergeStateStatus),
      reviewDecision: str(row.reviewDecision),
    },
  }
}

/** Build the snapshot skeleton, so every return path has the same shape. */
function baseSnapshot(sessionId, generatedAt) {
  return {
    sessionId,
    generatedAt,
    branch: null,
    repo: null,
    pr: null,
    checks: null,
    merge: null,
    reason: null,
    // #7435: server-side only — stripped by the WS handler, never on the wire.
    indeterminate: false,
  }
}

/**
 * Resolve the session's branch. Returns `{ branch }`, or `{ reason }` when the
 * cwd is not a repo / is on a detached HEAD.
 *
 * The cwd is passed via the `cwd` exec option rather than `git -C <cwd>`, so a
 * path that begins with `-` never reaches git's option parser at all.
 */
async function resolveBranch(execFn, cwd) {
  let stdout
  try {
    ;({ stdout } = await execFn('git', ['branch', '--show-current'], { ...EXEC_OPTS, cwd }))
  } catch (err) {
    // A worktree can be reaped out from under a live session (the harness GCs
    // `.claude/worktrees/` on its own schedule), and "not a git repository" would
    // be a misleading way to say the directory is simply gone.
    if (err && typeof err === 'object' && err.code === 'ENOENT') return { reason: CWD_MISSING_REASON }
    return { reason: NOT_A_REPO_REASON }
  }
  const branch = String(stdout == null ? '' : stdout).trim()
  // `branch --show-current` prints an empty line on a detached HEAD; it exits 0,
  // so the empty result IS the signal and must not be mistaken for a failure.
  if (branch.length === 0) return { reason: DETACHED_HEAD_REASON }
  if (!isSafeArgvValue(branch)) return { reason: UNSAFE_BRANCH_REASON }
  return { branch }
}

/** Resolve `origin` into `{ owner, repo }`, or null when it is not GitHub. */
async function resolveRepo(execFn, cwd) {
  try {
    const { stdout } = await execFn('git', ['remote', 'get-url', 'origin'], { ...EXEC_OPTS, cwd })
    return parseGithubOwnerRepo(typeof stdout === 'string' ? stdout : '')
  } catch {
    return null
  }
}

/**
 * Resolve the upstream this repo was forked from.
 *
 * The caller needs the AUTHORITATIVE and the TRANSIENT outcome kept apart
 * (#7435): "gh answered, and this repo has no parent" licenses the quiet
 * negative, while "the lookup itself failed" establishes nothing and must not.
 *
 * @returns {Promise<{parent: {owner: string, repo: string}|null}|{failed: true}>}
 *   `{ parent }` when gh answered (`parent: null` = authoritatively not a
 *   fork); `{ failed: true }` when the lookup failed or answered in a shape
 *   that cannot be used (including a parent name that would be option-parsed —
 *   the upstream exists but cannot be queried, which is still not absence).
 */
async function resolveParentRepo(execFn, ghPath, target, cwd) {
  let stdout
  try {
    ;({ stdout } = await execFn(ghPath, ['repo', 'view', `${target.owner}/${target.repo}`, '--json', 'parent'], { ...EXEC_OPTS, cwd }))
  } catch {
    return { failed: true }
  }
  let parsed
  try {
    parsed = JSON.parse(String(stdout == null ? '' : stdout))
  } catch {
    return { failed: true }
  }
  if (!parsed || typeof parsed !== 'object' || !('parent' in parsed)) return { failed: true }
  if (parsed.parent === null) return { parent: null }
  const owner = parsed?.parent?.owner?.login
  const repo = parsed?.parent?.name
  if (typeof owner !== 'string' || typeof repo !== 'string') return { failed: true }
  // These come from GitHub's own JSON rather than a client, but they go straight
  // into an option-parsed `-R` slot, so they are checked like any other argv datum.
  if (!isSafeArgvValue(owner) || !isSafeArgvValue(repo)) return { failed: true }
  return { parent: { owner, repo } }
}

/** Probe the PATH for `gh`. Any failure resolves null (the survey then degrades). */
async function probeGh(execFn) {
  try {
    const { stdout } = await execFn('which', ['gh'], EXEC_OPTS)
    const path = String(stdout == null ? '' : stdout).split('\n')[0].trim()
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

/**
 * Survey one session's pull-request and CI status.
 *
 * Never throws for an environmental cause: a missing `gh`, a non-GitHub remote,
 * a cwd that is not a repo and a `gh` invocation that fails all resolve to a
 * snapshot carrying a `reason`. Absence is signal.
 *
 * @param {object} opts
 * @param {string} opts.sessionId - the session this snapshot describes.
 * @param {string|null|undefined} opts.cwd - the session's working directory.
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @param {Function} [opts._now] - Date factory seam.
 * @returns {Promise<object>} the snapshot (minus the wire `type`/`requestId`,
 *   which the handler adds).
 */
export async function surveySessionPrStatus({ sessionId, cwd, _execFile = execFileAsync, _now = () => new Date() } = {}) {
  const snapshot = baseSnapshot(sessionId ?? null, _now().toISOString())

  if (typeof cwd !== 'string' || cwd.length === 0) {
    snapshot.reason = NO_CWD_REASON
    return snapshot
  }

  const branchResult = await resolveBranch(_execFile, cwd)
  if (branchResult.reason) {
    snapshot.reason = branchResult.reason
    return snapshot
  }
  snapshot.branch = branchResult.branch

  // Branch and remote are useful on their own, so they are resolved before the
  // `gh` probe: a host without `gh` still shows which branch the session is on.
  const target = await resolveRepo(_execFile, cwd)
  if (!target) {
    snapshot.reason = NO_GITHUB_REMOTE_REASON
    return snapshot
  }
  snapshot.repo = { owner: target.owner, name: target.repo }

  const ghPath = await probeGh(_execFile)
  if (!ghPath) {
    snapshot.reason = GH_MISSING_REASON
    return snapshot
  }

  // `-R <owner>/<repo>` comes from the git remote via parseGithubOwnerRepo, never
  // from a client; `--head` is the branch, rejected above if it could be
  // option-parsed. One call, so every field below describes one head SHA.
  const args = [
    'pr', 'list',
    '-R', `${target.owner}/${target.repo}`,
    '--head', snapshot.branch,
    '--state', 'open',
    '--limit', '1',
    '--json', PR_JSON_FIELDS,
  ]

  let stdout
  try {
    ;({ stdout } = await _execFile(ghPath, args, { ...EXEC_OPTS, cwd }))
  } catch (err) {
    // Deliberately NOT the raw message fallback. Unlike the Control Room
    // surveys, this reply reaches a pairing-bound (share-a-session) client, and
    // execFile's own message is `Command failed: <absolute gh path> ...` — a
    // host filesystem path, often including the operator's username. gh's first
    // stderr line is the useful part and carries no such path.
    snapshot.reason = redactAbsolutePaths(execFailureReason(err, 'gh pr list'))
    return snapshot
  }

  let rows
  try {
    rows = JSON.parse(String(stdout == null ? '' : stdout))
  } catch {
    snapshot.reason = 'gh pr list produced unparseable output'
    return snapshot
  }
  if (!Array.isArray(rows)) {
    snapshot.reason = 'gh pr list produced unparseable output'
    return snapshot
  }

  // An empty array is NOT yet the quiet negative — it is also what a FORK
  // checkout looks like. A cross-repository PR is listed on the BASE repo, not
  // on the head repo, so `origin` (the fork) legitimately reports nothing while
  // an open PR with running CI exists. Reporting "no PR" there would be
  // confidently wrong in exactly the "lost in no man's land" case #7344 exists
  // to remove.
  //
  // Measured against gh 2.97.0 before writing this, because the obvious fix is
  // wrong: `--head owner:branch` against the base repo returns NOTHING. The base
  // repo must be queried with the BARE branch name, and the row then
  // disambiguated by `headRepositoryOwner` — two forks can have the same branch
  // name open against one base, so `--limit 1` alone could return someone
  // else's PR.
  //
  // Only a fork pays these two extra calls; the common same-repo case still
  // makes exactly one.
  if (rows.length === 0) {
    const parentResult = await resolveParentRepo(_execFile, ghPath, target, cwd)
    // A FAILED lookup did not establish absence. The wire fields stay the quiet
    // negative (the display posture: a best-effort widening of an already-empty
    // result must not downgrade a usable answer to "cannot determine"), but the
    // server-side marker keeps the CI watcher from reading it as a fact (#7435).
    if (parentResult.failed) {
      snapshot.indeterminate = true
      return snapshot
    }
    // gh answered: not a fork, so the empty origin result IS the quiet negative.
    if (!parentResult.parent) return snapshot
    const parent = parentResult.parent

    let parentRows
    try {
      const { stdout: parentOut } = await _execFile(ghPath, [
        'pr', 'list',
        '-R', `${parent.owner}/${parent.repo}`,
        '--head', snapshot.branch,
        '--state', 'open',
        '--limit', String(FORK_QUERY_LIMIT),
        '--json', PR_JSON_FIELDS,
      ], { ...EXEC_OPTS, cwd })
      parentRows = JSON.parse(String(parentOut == null ? '' : parentOut))
    } catch {
      snapshot.indeterminate = true
      return snapshot
    }
    if (!Array.isArray(parentRows)) {
      snapshot.indeterminate = true
      return snapshot
    }

    const mine = parentRows.find(row => row?.headRepositoryOwner?.login === target.owner)
    // The upstream answered and no open PR has our fork as its head: this is the
    // authoritative quiet negative, exactly like an answered-empty origin list.
    if (!mine) return snapshot

    const forkNormalised = normalisePrRow(mine)
    // Our row exists but is unusable — the same condition the same-repo path
    // reports as a reason. Absence was not established either way (#7435).
    if (!forkNormalised) {
      snapshot.indeterminate = true
      return snapshot
    }
    // `repo` names the repo the PR actually lives on, which is what the user
    // needs in order to find it — for a fork that is the base, not `origin`.
    return { ...snapshot, repo: { owner: parent.owner, name: parent.repo }, ...forkNormalised }
  }

  const normalised = normalisePrRow(rows[0])
  if (!normalised) {
    snapshot.reason = 'gh pr list returned a row without a usable pull-request number'
    return snapshot
  }

  return { ...snapshot, ...normalised }
}
