import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  surveySessionPrStatus,
  summariseChecks,
  bucketRollupEntry,
  normalisePrRow,
  NO_CWD_REASON,
  NOT_A_REPO_REASON,
  DETACHED_HEAD_REASON,
  NO_GITHUB_REMOTE_REASON,
  GH_MISSING_REASON,
  UNSAFE_BRANCH_REASON,
} from '../src/session-pr-status.js'
import { ServerSessionPrStatusSchema } from '@chroxy/protocol'

/**
 * Tests for the session → pull-request / CI status survey (#7344).
 *
 * Every git/gh interaction is injected via `_execFile`, so nothing here touches
 * the real PATH, any repo, or any GitHub account.
 *
 * The load-bearing assertions are the NEGATIVE ones. A survey that reported
 * `success` for a head with no checks, or that swallowed a failing run, would
 * pass a naive "does it show green when it's green" test while being wrong in
 * exactly the cases the user needs it for — so each of those has its own test
 * below, and each is paired with the positive control that proves the fixture
 * actually reached the code under test.
 */

/** Build an `_execFile` seam from a table of `command args…` → stdout | Error. */
function fakeExec(table, calls = []) {
  return async (file, args, opts) => {
    calls.push({ file, args, opts })
    const key = `${file} ${args.join(' ')}`
    const entry = table[key]
    if (entry === undefined) throw new Error(`unexpected exec: ${key}`)
    if (entry instanceof Error) throw entry
    return { stdout: entry, stderr: '' }
  }
}

/** The happy-path exec table; `prListJson` is the `gh pr list` stdout. */
function happyTable(prListJson, branch = 'feat/x') {
  return {
    'git branch --show-current': `${branch}\n`,
    'git remote get-url origin': 'git@github.com:blamechris/chroxy.git\n',
    'which gh': '/usr/local/bin/gh\n',
    [`/usr/local/bin/gh pr list -R blamechris/chroxy --head ${branch} --state open --limit 1 --json number,title,url,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`]: prListJson,
  }
}

/** A completed CheckRun with the given conclusion. */
const done = (name, conclusion) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion })
/** An in-progress CheckRun. */
const running = name => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: null })

function prRow(overrides = {}) {
  return {
    number: 7419,
    title: 'fix: something',
    url: 'https://github.com/blamechris/chroxy/pull/7419',
    headRefOid: 'abc1234def',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [done('a', 'SUCCESS')],
    ...overrides,
  }
}

describe('#7344 — session PR/CI status survey', () => {
  describe('summariseChecks — never fabricates a verdict', () => {
    it("reports 'none' (NOT success) for a head with no checks at all", () => {
      // The guard that matters most: a push can legitimately produce no run,
      // and "absence of failure" must never read as a green.
      for (const rollup of [null, undefined, []]) {
        const { state, counts } = summariseChecks(rollup)
        assert.equal(state, 'none', `rollup ${JSON.stringify(rollup)} must not be a verdict`)
        assert.equal(counts.total, 0)
        assert.notEqual(state, 'success')
      }
    })

    it("positive control: the SAME code path reports 'success' when checks actually passed", () => {
      // Without this, the assertion above would also pass against a function
      // that returned 'none' unconditionally.
      const { state, counts } = summariseChecks([done('a', 'SUCCESS'), done('b', 'SKIPPED')])
      assert.equal(state, 'success')
      assert.deepEqual(counts, { total: 2, passed: 1, failed: 0, pending: 0, skipped: 1, unknown: 0 })
    })

    it('reports a FAILING run — the case the user most needs to hear about', () => {
      const { state, counts } = summariseChecks([done('a', 'SUCCESS'), done('b', 'FAILURE')])
      assert.equal(state, 'failure')
      assert.equal(counts.failed, 1)
      assert.equal(counts.passed, 1)
    })

    it("pending outranks failure, and the failed count stays visible alongside it", () => {
      // 'pending' because the run is not settled; `failed` is still carried so a
      // client can say "1 failed / 1 pending" instead of hiding it behind a spinner.
      const { state, counts } = summariseChecks([done('a', 'FAILURE'), running('b')])
      assert.equal(state, 'pending')
      assert.equal(counts.failed, 1)
      assert.equal(counts.pending, 1)
    })

    it('an UNRECOGNISED status is counted as unknown and suppresses a success verdict', () => {
      // A future GitHub state must surface as unknown, never be absorbed into a pass.
      const { state, counts } = summariseChecks([done('a', 'SUCCESS'), { __typename: 'CheckRun', status: 'TELEPORTING' }])
      assert.equal(counts.unknown, 1)
      assert.equal(counts.passed, 1)
      assert.equal(state, 'unknown')
      assert.notEqual(state, 'success')
    })

    it('handles legacy StatusContext commit statuses alongside CheckRuns', () => {
      const { state, counts } = summariseChecks([
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'ci/other', state: 'FAILURE' },
      ])
      assert.equal(state, 'failure')
      assert.equal(counts.passed, 1)
      assert.equal(counts.failed, 1)
    })
  })

  describe('bucketRollupEntry', () => {
    it('buckets each recognised CheckRun conclusion', () => {
      assert.equal(bucketRollupEntry(done('a', 'SUCCESS')), 'passed')
      assert.equal(bucketRollupEntry(done('a', 'NEUTRAL')), 'passed')
      assert.equal(bucketRollupEntry(done('a', 'SKIPPED')), 'skipped')
      assert.equal(bucketRollupEntry(done('a', 'TIMED_OUT')), 'failed')
      assert.equal(bucketRollupEntry(done('a', 'CANCELLED')), 'failed')
      assert.equal(bucketRollupEntry(running('a')), 'pending')
      assert.equal(bucketRollupEntry({ __typename: 'CheckRun', status: 'QUEUED' }), 'pending')
    })

    it('a COMPLETED CheckRun with NO conclusion is unknown, not a pass', () => {
      assert.equal(bucketRollupEntry({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: null }), 'unknown')
    })

    it('a non-object, a null and an unrecognised __typename are all unknown', () => {
      assert.equal(bucketRollupEntry(null), 'unknown')
      assert.equal(bucketRollupEntry('SUCCESS'), 'unknown')
      assert.equal(bucketRollupEntry([]), 'unknown')
      assert.equal(bucketRollupEntry({ __typename: 'Something', status: 'COMPLETED', conclusion: 'SUCCESS' }), 'unknown')
    })
  })

  describe('normalisePrRow — checks and merge stay SEPARATE facts', () => {
    it('reports 21/21 green alongside mergeStateStatus BLOCKED without collapsing them', () => {
      // The motivating case. A survey that derived one "ready?" answer would be
      // actively wrong here, so the two are asserted independently.
      const rollup = Array.from({ length: 21 }, (_, i) => done(`c${i}`, 'SUCCESS'))
      const out = normalisePrRow(prRow({ statusCheckRollup: rollup, mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE' }))
      assert.equal(out.checks.state, 'success')
      assert.equal(out.checks.counts.passed, 21)
      assert.equal(out.merge.mergeStateStatus, 'BLOCKED')
      assert.equal(out.merge.mergeable, 'MERGEABLE')
      // No derived mergeability verdict is minted anywhere on the result.
      assert.deepEqual(Object.keys(out).sort(), ['checks', 'merge', 'pr'])
    })

    it("passes mergeStateStatus 'UNKNOWN' through rather than interpreting it", () => {
      // UNKNOWN means GitHub is recomputing after a base change, not that a
      // blocker exists — the server must not decide which.
      const out = normalisePrRow(prRow({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }))
      assert.equal(out.merge.mergeStateStatus, 'UNKNOWN')
    })

    it('normalises an empty-string reviewDecision to null', () => {
      const out = normalisePrRow(prRow({ reviewDecision: '' }))
      assert.equal(out.merge.reviewDecision, null)
    })

    it('rejects a row with no usable PR number', () => {
      assert.equal(normalisePrRow({ number: 0 }), null)
      assert.equal(normalisePrRow({ number: '7419' }), null)
      assert.equal(normalisePrRow(null), null)
    })
  })

  describe('surveySessionPrStatus — degradation is honest', () => {
    it('a branch with NO open PR is the quiet negative: pr null AND reason null', async () => {
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(happyTable('[]')) })
      assert.equal(snap.pr, null)
      assert.equal(snap.reason, null, 'no-PR must be distinguishable from cannot-determine')
      assert.equal(snap.branch, 'feat/x')
      assert.deepEqual(snap.repo, { owner: 'blamechris', name: 'chroxy' })
    })

    it('a FAILED gh call is cannot-determine: pr null WITH a reason', async () => {
      // Same `pr: null` as the test above — the `reason` is the only thing that
      // separates them, which is why both are asserted.
      const err = Object.assign(new Error('exit 1'), { stderr: 'gh: not authenticated\n' })
      const table = { ...happyTable('[]') }
      table[Object.keys(table).find(k => k.includes('pr list'))] = err
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
      assert.equal(snap.pr, null)
      assert.equal(snap.reason, 'gh pr list failed: gh: not authenticated')
    })

    it('unparseable gh output degrades rather than throwing', async () => {
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(happyTable('not json')) })
      assert.equal(snap.pr, null)
      assert.equal(snap.reason, 'gh pr list produced unparseable output')
    })

    it('a non-array JSON body is also unparseable, not a silent empty result', async () => {
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(happyTable('{"number":1}')) })
      assert.equal(snap.reason, 'gh pr list produced unparseable output')
    })

    it('returns the full snapshot for an open PR', async () => {
      const snap = await surveySessionPrStatus({
        sessionId: 's1',
        cwd: '/repo',
        _execFile: fakeExec(happyTable(JSON.stringify([prRow()]))),
      })
      assert.equal(snap.pr.number, 7419)
      assert.equal(snap.pr.headRefOid, 'abc1234def')
      assert.equal(snap.checks.state, 'success')
      assert.equal(snap.merge.mergeStateStatus, 'CLEAN')
      assert.equal(snap.reason, null)
    })

    it('reports no cwd, a non-repo cwd, a detached HEAD, a non-GitHub remote and a missing gh', async () => {
      const noCwd = await surveySessionPrStatus({ sessionId: 's1', cwd: null, _execFile: fakeExec({}) })
      assert.equal(noCwd.reason, NO_CWD_REASON)

      const notRepo = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/tmp',
        _execFile: fakeExec({ 'git branch --show-current': new Error('not a git repository') }),
      })
      assert.equal(notRepo.reason, NOT_A_REPO_REASON)

      // `branch --show-current` EXITS 0 with an empty line on a detached HEAD,
      // so the empty result is the signal — not a failure.
      const detached = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec({ 'git branch --show-current': '\n' }),
      })
      assert.equal(detached.reason, DETACHED_HEAD_REASON)
      assert.equal(detached.branch, null)

      const noRemote = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec({
          'git branch --show-current': 'feat/x\n',
          'git remote get-url origin': 'git@gitlab.com:someone/thing.git\n',
        }),
      })
      assert.equal(noRemote.reason, NO_GITHUB_REMOTE_REASON)
      assert.equal(noRemote.branch, 'feat/x', 'the branch is still reported when the remote is not GitHub')

      // gh missing still reports branch AND repo — a partial answer beats none.
      const noGh = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec({
          'git branch --show-current': 'feat/x\n',
          'git remote get-url origin': 'git@github.com:blamechris/chroxy.git\n',
          'which gh': new Error('not found'),
        }),
      })
      assert.equal(noGh.reason, GH_MISSING_REASON)
      assert.deepEqual(noGh.repo, { owner: 'blamechris', name: 'chroxy' })
    })

    it('REFUSES a branch name that would be option-parsed by gh', async () => {
      // execFile's array argv stops SHELL injection but not ARGUMENT injection:
      // `--head -x` would have `-x` read as an option by gh's own parser.
      const snap = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec({ 'git branch --show-current': '--version\n' }),
      })
      assert.equal(snap.reason, UNSAFE_BRANCH_REASON)
      assert.equal(snap.branch, null)
    })

    it('passes the session cwd via the exec OPTION, never as a `git -C` argv value', async () => {
      // A cwd beginning with `-` must never reach git's option parser.
      const calls = []
      await surveySessionPrStatus({ sessionId: 's1', cwd: '-weird-dir', _execFile: fakeExec(happyTable('[]'), calls) })
      const gitCalls = calls.filter(c => c.file === 'git')
      assert.ok(gitCalls.length > 0, 'fixture must actually reach git')
      for (const call of gitCalls) {
        assert.ok(!call.args.includes('-C'), 'cwd must not be passed as a -C argv value')
        assert.equal(call.opts.cwd, '-weird-dir')
      }
    })

    it('reads checks and merge state from ONE gh call, so both describe one head SHA', async () => {
      const calls = []
      await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec(happyTable(JSON.stringify([prRow()])), calls),
      })
      const ghCalls = calls.filter(c => c.args[0] === 'pr')
      assert.equal(ghCalls.length, 1, 'a second call could straddle a push and mix two heads')
    })
  })

  describe('wire contract', () => {
    it('every snapshot shape validates against ServerSessionPrStatusSchema', async () => {
      const cases = [
        happyTable(JSON.stringify([prRow()])),
        happyTable(JSON.stringify([prRow({ statusCheckRollup: [] })])),
        happyTable(JSON.stringify([prRow({ statusCheckRollup: [done('a', 'FAILURE')] })])),
        happyTable('[]'),
        { 'git branch --show-current': new Error('nope') },
      ]
      for (const table of cases) {
        const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
        const parsed = ServerSessionPrStatusSchema.safeParse({ type: 'session_pr_status', requestId: null, ...snap })
        assert.ok(parsed.success, `snapshot rejected by schema: ${JSON.stringify(parsed.error?.issues)}`)
      }
    })
  })
})
