/**
 * Session → unresolved review-thread count (#7430, on-demand follow-on to #7344).
 *
 * #7423's prefill line wants "0 unresolved threads" beside the check rollup,
 * because that number is what explains a `BLOCKED` merge state when CI is
 * 21/21 green. `session_pr_status` cannot carry it: `gh pr list --json` has no
 * thread count, and reading one needs a GraphQL `reviewThreads` query.
 *
 * ## Why this is a separate survey and not two more fields on that one
 *
 * Since #7426 `surveySessionPrStatus` runs on a daemon-side SWEEP across every
 * session (`SessionCiWatcher`, on `tickIntervalMs`/`discoveryIntervalMs`), not
 * only when a dashboard asks. Adding a second `gh` invocation there doubles the
 * subprocess and network cost of a background poll — on every session, on every
 * tick — to enrich a string that is only ever built when a user clicks. So the
 * count is paid for at CLICK time, through its own request/reply pair that the
 * sweep never sends. #7422's one-`gh`-call-per-head consistency rule is
 * untouched: the sweep's survey still makes exactly the calls it made before.
 *
 * ## Resolution is DELEGATED, never re-derived
 *
 * Which repo, which branch, which PR number — that is `session-pr-status.js`'s
 * question, and it has a lot of hard-won behaviour in it (a reaped worktree, a
 * detached HEAD, a branch name that would be option-parsed, and the fork path
 * where a cross-repository PR is listed on the BASE repo and must be
 * disambiguated by head owner). A second implementation of that would drift, so
 * this module CALLS it and inherits its degradation table wholesale: every
 * reason `surveySessionPrStatus` can produce passes through here verbatim.
 *
 * The cost is one extra `gh pr list` per counted click. That is the deliberate
 * trade against duplicating resolution logic, and the per-session throttle on
 * the handler bounds how often it can be paid.
 *
 * ## Never a fabricated zero
 *
 * The one contract worth stating twice. A count that was not taken is
 * `unresolvedCount: null` with a `reason` — never `0`. The two are not
 * interchangeable and a consumer must render them differently: "0 unresolved
 * threads" printed for a reading that never happened says "nothing is blocking
 * this PR", which is the exact false green #7344 exists to prevent. The same
 * applies to a TRUNCATED page: 100 resolved threads on page one with every
 * unresolved one past it must not report a flat 0, so `truncated` rides along
 * and a truncated count is a LOWER BOUND.
 *
 * Every external interaction is injectable so tests never touch real git/gh:
 *   - `_execFile(file, args, opts)` — async, resolves `{ stdout, stderr }`.
 *   - `_now()` — returns a `Date` (defaults to `new Date()`).
 *   - `_survey(opts)` — the PR resolution, defaults to `surveySessionPrStatus`.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  surveySessionPrStatus,
  probeGh,
  redactAbsolutePaths,
  EXEC_OPTS,
  GH_MISSING_REASON,
} from './session-pr-status.js'
import { execFailureReason } from './utils/exec-failure-reason.js'
import { isSafeArgvValue } from './utils/argv-safety.js'

const execFileAsync = promisify(execFile)

/**
 * How many review threads one page reads.
 *
 * 100 is GitHub's per-connection maximum for a single `first:` argument, so
 * this is the most one call can see. Beyond it the reading is a lower bound and
 * says so (`truncated`) rather than paginating: a PR with >100 review threads
 * is far outside the case this line serves, and a paging loop would put an
 * unbounded number of `gh` calls behind one click.
 */
export const REVIEW_THREAD_PAGE_SIZE = 100

/**
 * The GraphQL document. Written with variables (never string-interpolated), so
 * the owner/name/number data cannot alter the query's shape.
 *
 * `totalCount` and `pageInfo.hasNextPage` are both requested deliberately —
 * either one alone establishes whether the page is complete, and a reading that
 * has NEITHER is treated as unusable rather than as complete.
 */
export const REVIEW_THREADS_QUERY = [
  'query($owner: String!, $name: String!, $number: Int!, $first: Int!) {',
  '  repository(owner: $owner, name: $name) {',
  '    pullRequest(number: $number) {',
  '      reviewThreads(first: $first) {',
  '        totalCount',
  '        pageInfo { hasNextPage }',
  '        nodes { isResolved }',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n')

/** Reason when the branch definitively has no open PR to count threads on. */
export const NO_OPEN_PR_REASON = 'no open pull request for this branch — no review threads to count'

/** Reason when the resolved repo owner/name is not safe for an option-parsed argv slot. */
export const UNSAFE_REPO_REASON = 'repository owner or name cannot be passed safely to gh'

/** Reason when `gh api graphql` answered with something that is not JSON. */
export const UNPARSEABLE_REASON = 'gh api graphql produced unparseable output'

/** Reason when the response parsed but carried no usable review-thread data. */
export const NO_THREAD_DATA_REASON = 'gh api graphql returned no usable review-thread data'

/**
 * Reduce a `gh api graphql` response to `{ unresolvedCount, totalCount, truncated }`,
 * or `null` when the response cannot be trusted to answer the question.
 *
 * Returning `null` is not a formality — it is the only alternative to guessing,
 * and every guess available here is a guess in the dangerous direction (an
 * unreadable node absorbed as "resolved", a partial response counted as whole,
 * an unknown page state read as complete). Each of those under-reports
 * unresolved threads, i.e. manufactures the green.
 *
 * @param {unknown} payload - the parsed `gh api graphql` JSON.
 * @returns {{ unresolvedCount: number, totalCount: number|null, truncated: boolean }|null}
 */
export function summariseReviewThreads(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  // GitHub can answer with data AND errors; the data is then partial, and
  // counting what survived under-reports. Refuse the whole reading.
  if (Array.isArray(payload.errors) && payload.errors.length > 0) return null

  const threads = payload?.data?.repository?.pullRequest?.reviewThreads
  if (!threads || typeof threads !== 'object' || Array.isArray(threads)) return null
  const nodes = threads.nodes
  if (!Array.isArray(nodes)) return null

  let unresolvedCount = 0
  for (const node of nodes) {
    // `isResolved` is `Boolean!` in GitHub's schema, so anything else means the
    // response is not what was asked for. Treating it as resolved would hide a
    // thread; treating it as unresolved would invent one.
    if (!node || typeof node !== 'object' || typeof node.isResolved !== 'boolean') return null
    if (!node.isResolved) unresolvedCount += 1
  }

  const rawTotal = threads.totalCount
  const totalCount = Number.isInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null
  const hasNextPage = threads?.pageInfo?.hasNextPage

  let truncated
  if (hasNextPage === true) truncated = true
  else if (hasNextPage === false) truncated = totalCount !== null && totalCount > nodes.length
  else if (totalCount !== null) truncated = totalCount > nodes.length
  // Neither signal is readable: completeness was never established, so it must
  // not be assumed. "Cannot check" is not "nothing to check".
  else return null

  return { unresolvedCount, totalCount, truncated }
}

/** The skeleton every return path shares — a count-shaped nothing. */
function baseSnapshot(sessionId, countedAt) {
  return {
    sessionId,
    countedAt,
    prNumber: null,
    unresolvedCount: null,
    totalCount: null,
    truncated: false,
    reason: null,
  }
}

/**
 * Count the session PR's unresolved review threads.
 *
 * Never throws for an environmental cause: an unresolvable PR, a missing `gh`,
 * a failed or unparseable call all resolve to a snapshot carrying a `reason`
 * and a null count.
 *
 * @param {object} opts
 * @param {string} opts.sessionId - the session this reading describes.
 * @param {string|null|undefined} opts.cwd - the session's working directory.
 * @param {Function} [opts._execFile] - promisified execFile seam.
 * @param {Function} [opts._now] - Date factory seam.
 * @param {Function} [opts._survey] - PR resolution seam.
 * @returns {Promise<object>} the reading (minus the wire `type`/`requestId`,
 *   which the handler adds).
 */
export async function surveySessionPrThreads({
  sessionId,
  cwd,
  _execFile = execFileAsync,
  _now = () => new Date(),
  _survey = surveySessionPrStatus,
} = {}) {
  // Stamped when the reading STARTS, matching `generatedAt`'s convention on the
  // status snapshot — but a field of its own, because the two go stale on
  // different schedules and one timestamp over both would claim a consistency
  // neither message has.
  const snapshot = baseSnapshot(sessionId ?? null, _now().toISOString())

  const status = await _survey({ sessionId, cwd, _execFile, _now })

  // Resolution failed and already said why, in the vocabulary the status chip
  // uses. Repeating it in different words here would make the same condition
  // read as two different problems.
  if (status?.reason) {
    snapshot.reason = status.reason
    return snapshot
  }
  if (!status?.pr || !status?.repo) {
    snapshot.reason = NO_OPEN_PR_REASON
    return snapshot
  }

  const { owner, name } = status.repo
  const number = status.pr.number
  // Named even when the count fails, so a consumer can tell WHICH PR it has no
  // count for — and refuse to print a count next to a different PR's number.
  snapshot.prNumber = number

  // These come from the git remote via parseGithubOwnerRepo rather than from a
  // client, but they go into option-parsed argv slots, so they are checked like
  // any other argv datum (argv-safety.js, fix shape 1).
  if (!isSafeArgvValue(owner) || !isSafeArgvValue(name)) {
    snapshot.reason = UNSAFE_REPO_REASON
    return snapshot
  }

  const ghPath = await probeGh(_execFile)
  if (!ghPath) {
    snapshot.reason = GH_MISSING_REASON
    return snapshot
  }

  // Every datum rides in a `key=value` token, so none of them can begin with a
  // `-` even in principle, and the query itself is a constant.
  const args = [
    'api', 'graphql',
    '-f', `query=${REVIEW_THREADS_QUERY}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `number=${number}`,
    '-F', `first=${REVIEW_THREAD_PAGE_SIZE}`,
  ]

  let stdout
  try {
    ;({ stdout } = await _execFile(ghPath, args, { ...EXEC_OPTS, cwd }))
  } catch (err) {
    // This reply reaches a pairing-bound (share-a-session) client, which has no
    // business learning host filesystem layout — and execFile's own message is
    // `Command failed: <absolute gh path> …`.
    snapshot.reason = redactAbsolutePaths(execFailureReason(err, 'gh api graphql'))
    return snapshot
  }

  let parsed
  try {
    parsed = JSON.parse(String(stdout == null ? '' : stdout))
  } catch {
    snapshot.reason = UNPARSEABLE_REASON
    return snapshot
  }

  const summary = summariseReviewThreads(parsed)
  if (!summary) {
    snapshot.reason = NO_THREAD_DATA_REASON
    return snapshot
  }

  return { ...snapshot, ...summary }
}
