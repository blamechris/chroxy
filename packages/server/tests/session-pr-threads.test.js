import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  surveySessionPrThreads,
  summariseReviewThreads,
  REVIEW_THREAD_PAGE_SIZE,
  NO_OPEN_PR_REASON,
  UNSAFE_REPO_REASON,
  UNPARSEABLE_REASON,
  NO_THREAD_DATA_REASON,
} from '../src/session-pr-threads.js'
import { GH_MISSING_REASON, NO_GITHUB_REMOTE_REASON } from '../src/session-pr-status.js'

/**
 * Tests for the on-demand unresolved-review-thread count (#7430).
 *
 * The one property every case below is really testing: the survey NEVER
 * fabricates a zero. A count it did not take is `unresolvedCount: null` with a
 * `reason`, and those two readings must be distinguishable by a consumer — a
 * missing count printed as "0 unresolved threads" reads as "nothing is blocking
 * this PR", which is the exact false green the whole #7344 surface exists to
 * avoid giving.
 *
 * Resolution (branch → remote → open PR) is NOT re-implemented here: the survey
 * delegates to `surveySessionPrStatus` and inherits its degradation table
 * wholesale, which is why the "no gh" / "no remote" / "detached HEAD" cases
 * below assert a PASS-THROUGH rather than a locally-minted reason.
 */

const PR_STATUS = {
  sessionId: 'sess-1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  branch: 'feat/x',
  repo: { owner: 'blamechris', name: 'chroxy' },
  pr: { number: 7419, title: 't', url: 'https://x/7419', headRefOid: 'abc1234', isDraft: false },
  checks: { state: 'success', counts: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0, unknown: 0 } },
  merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' },
  reason: null,
  indeterminate: false,
}

/** A GraphQL payload with `n` threads, `unresolved` of them open. */
function payload(unresolved, resolved, { hasNextPage = false, totalCount = null } = {}) {
  const nodes = [
    ...Array.from({ length: unresolved }, () => ({ isResolved: false })),
    ...Array.from({ length: resolved }, () => ({ isResolved: true })),
  ]
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: totalCount ?? nodes.length,
            pageInfo: { hasNextPage },
            nodes,
          },
        },
      },
    },
  }
}

/**
 * An exec stub. `graphql` is what the `gh api graphql` call resolves to (a
 * string of stdout) or throws. `which gh` always answers unless `gh` is false.
 */
function makeExec({ graphql, gh = '/usr/bin/gh', onArgs } = {}) {
  const calls = []
  return async (file, args, opts) => {
    calls.push({ file, args, opts })
    if (onArgs) onArgs(file, args)
    if (file === 'which') {
      if (!gh) throw new Error('not found')
      return { stdout: `${gh}\n`, stderr: '' }
    }
    if (typeof graphql === 'function') return graphql(file, args)
    return { stdout: typeof graphql === 'string' ? graphql : JSON.stringify(graphql), stderr: '' }
  }
}

function run(opts = {}) {
  const { status = PR_STATUS, exec = makeExec({ graphql: payload(0, 3) }), ...rest } = opts
  return surveySessionPrThreads({
    sessionId: 'sess-1',
    cwd: '/repo',
    _execFile: exec,
    _now: () => new Date('2026-08-28T12:00:00.000Z'),
    _survey: async () => status,
    ...rest,
  })
}

describe('#7430 — summariseReviewThreads', () => {
  it('counts only the UNRESOLVED nodes and reports GitHub\'s own total', () => {
    const s = summariseReviewThreads(payload(2, 5))
    assert.deepEqual(s, { unresolvedCount: 2, totalCount: 7, truncated: false })
  })

  it('a genuine zero is a zero — counted, not fabricated', () => {
    const s = summariseReviewThreads(payload(0, 4))
    assert.equal(s.unresolvedCount, 0)
    assert.equal(s.truncated, false)
  })

  it('hasNextPage marks the count TRUNCATED — a 0 past the page is not a zero', () => {
    // The false-green case in its purest form: 100 resolved threads on page one
    // and every unresolved one past it. Reporting a flat 0 here would say
    // "nothing blocking" about a PR with open threads.
    const s = summariseReviewThreads(payload(0, 100, { hasNextPage: true, totalCount: 150 }))
    assert.equal(s.unresolvedCount, 0)
    assert.equal(s.totalCount, 150)
    assert.equal(s.truncated, true)
  })

  it('infers truncation from totalCount when pageInfo is absent', () => {
    const p = payload(1, 2, { totalCount: 40 })
    delete p.data.repository.pullRequest.reviewThreads.pageInfo
    assert.equal(summariseReviewThreads(p).truncated, true)
  })

  it('is UNUSABLE when neither pageInfo nor totalCount can establish completeness', () => {
    // "Cannot check" must not be treated as "nothing to check".
    const p = payload(1, 2)
    delete p.data.repository.pullRequest.reviewThreads.pageInfo
    delete p.data.repository.pullRequest.reviewThreads.totalCount
    assert.equal(summariseReviewThreads(p), null)
  })

  it('is UNUSABLE when a node carries no boolean isResolved', () => {
    const p = payload(1, 1)
    p.data.repository.pullRequest.reviewThreads.nodes.push({ isResolved: null })
    assert.equal(summariseReviewThreads(p), null, 'an unreadable node must not silently count as resolved')
  })

  it('is UNUSABLE when GraphQL reported errors, even alongside data', () => {
    // A partial response can omit threads. Counting what survived would under-
    // report unresolved threads, which is the dangerous direction.
    const p = payload(0, 3)
    p.errors = [{ message: 'Something went wrong' }]
    assert.equal(summariseReviewThreads(p), null)
  })

  it('is UNUSABLE on a missing pullRequest / repository / nodes array', () => {
    assert.equal(summariseReviewThreads(null), null)
    assert.equal(summariseReviewThreads({}), null)
    assert.equal(summariseReviewThreads({ data: { repository: null } }), null)
    assert.equal(summariseReviewThreads({ data: { repository: { pullRequest: { reviewThreads: { nodes: 'x' } } } } }), null)
  })
})

describe('#7430 — surveySessionPrThreads happy path', () => {
  it('returns the count with its OWN timestamp, not the status snapshot\'s', async () => {
    const snap = await run({ exec: makeExec({ graphql: payload(3, 4) }) })
    assert.equal(snap.sessionId, 'sess-1')
    assert.equal(snap.prNumber, 7419)
    assert.equal(snap.unresolvedCount, 3)
    assert.equal(snap.totalCount, 7)
    assert.equal(snap.truncated, false)
    assert.equal(snap.reason, null)
    assert.equal(snap.countedAt, '2026-08-28T12:00:00.000Z')
    assert.ok(!('generatedAt' in snap), 'the count must not borrow generatedAt semantics')
  })

  it('asks GraphQL for the resolved repo + PR, with the number as a typed field', async () => {
    let seen = null
    await run({ exec: makeExec({ graphql: payload(0, 0), onArgs: (file, args) => { if (args[0] === 'api') seen = args } }) })
    assert.ok(seen, 'the graphql call must have happened')
    assert.deepEqual(seen.slice(0, 2), ['api', 'graphql'])
    assert.ok(seen.includes('owner=blamechris'), `owner field missing: ${seen.join(' ')}`)
    assert.ok(seen.includes('name=chroxy'))
    assert.ok(seen.includes('number=7419'))
    const query = seen.find(a => a.startsWith('query='))
    assert.ok(query, 'a query field is required')
    assert.match(query, /reviewThreads\(first: ?\$?first|reviewThreads\(first:/)
    assert.match(query, /isResolved/)
    assert.ok(seen.includes(`first=${REVIEW_THREAD_PAGE_SIZE}`) || query.includes(String(REVIEW_THREAD_PAGE_SIZE)),
      'the page size must reach the query')
  })
})

describe('#7430 — surveySessionPrThreads degrades honestly, never to a zero', () => {
  const assertNoCount = (snap, reason) => {
    assert.equal(snap.unresolvedCount, null, 'a count that was not taken must be null, never 0')
    assert.equal(snap.totalCount, null)
    assert.equal(snap.truncated, false)
    if (reason !== undefined) assert.equal(snap.reason, reason)
    else assert.ok(typeof snap.reason === 'string' && snap.reason.length > 0, 'a degraded reading must carry a reason')
  }

  it('passes the status survey\'s reason through when it could not resolve a PR', async () => {
    const snap = await run({ status: { ...PR_STATUS, pr: null, repo: null, reason: GH_MISSING_REASON } })
    assertNoCount(snap, GH_MISSING_REASON)
    assert.equal(snap.prNumber, null)
  })

  it('passes a non-GitHub remote through as the same reason the status survey gives', async () => {
    const snap = await run({ status: { ...PR_STATUS, pr: null, repo: null, reason: NO_GITHUB_REMOTE_REASON } })
    assertNoCount(snap, NO_GITHUB_REMOTE_REASON)
  })

  it('reports NO_OPEN_PR_REASON for the quiet negative (branch has no open PR)', async () => {
    const snap = await run({ status: { ...PR_STATUS, pr: null, checks: null, merge: null, reason: null } })
    assertNoCount(snap, NO_OPEN_PR_REASON)
  })

  it('degrades when gh is not on PATH', async () => {
    const snap = await run({ exec: makeExec({ gh: false }) })
    assertNoCount(snap, GH_MISSING_REASON)
    assert.equal(snap.prNumber, 7419, 'the PR it could not count on is still named')
  })

  it('degrades on a failed gh call, with the stderr line and no absolute paths', async () => {
    const err = Object.assign(new Error('Command failed: /Users/someone/bin/gh api graphql'), {
      stderr: 'gh: Could not resolve to a Repository with the name /Users/someone/repo.\n',
    })
    const snap = await run({ exec: makeExec({ graphql: () => { throw err } }) })
    assertNoCount(snap)
    assert.match(snap.reason, /gh api graphql failed/)
    assert.ok(!snap.reason.includes('/Users/someone'), `reason leaked a host path: ${snap.reason}`)
  })

  it('degrades on unparseable output', async () => {
    const snap = await run({ exec: makeExec({ graphql: 'not json' }) })
    assertNoCount(snap, UNPARSEABLE_REASON)
  })

  it('degrades when the payload carries no usable thread data', async () => {
    const snap = await run({ exec: makeExec({ graphql: { data: { repository: null } } }) })
    assertNoCount(snap, NO_THREAD_DATA_REASON)
  })

  it('degrades on GraphQL errors rather than counting the surviving nodes', async () => {
    const p = payload(0, 2)
    p.errors = [{ message: 'rate limited' }]
    const snap = await run({ exec: makeExec({ graphql: p }) })
    assertNoCount(snap, NO_THREAD_DATA_REASON)
  })

  it('refuses a repo whose owner or name would be option-parsed by gh', async () => {
    const snap = await run({ status: { ...PR_STATUS, repo: { owner: '-oProxyCommand', name: 'chroxy' } } })
    assertNoCount(snap, UNSAFE_REPO_REASON)
  })

  it('never shells out to gh at all when the status survey already degraded', async () => {
    const calls = []
    const exec = async (file, args) => { calls.push(file); return { stdout: '', stderr: '' } }
    await run({ status: { ...PR_STATUS, pr: null, repo: null, reason: GH_MISSING_REASON }, exec })
    assert.equal(calls.length, 0, 'a degraded resolution must not spend a subprocess')
  })
})
