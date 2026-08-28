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
  CWD_MISSING_REASON,
  redactAbsolutePaths,
  PR_JSON_FIELDS,
  FORK_QUERY_LIMIT,
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

/** The exact `--json` field list the survey requests, so tables key off one source. */
const FIELDS = PR_JSON_FIELDS

/** The happy-path exec table; `prListJson` is the `gh pr list` stdout. */
function happyTable(prListJson, branch = 'feat/x', origin = 'blamechris/chroxy') {
  return {
    'git branch --show-current': `${branch}\n`,
    'git remote get-url origin': `git@github.com:${origin}.git\n`,
    'which gh': '/usr/local/bin/gh\n',
    [`/usr/local/bin/gh pr list -R ${origin} --head ${branch} --state open --limit 1 --json ${FIELDS}`]: prListJson,
    // Default: not a fork. Tests that exercise the fork path override this.
    [`/usr/local/bin/gh repo view ${origin} --json parent`]: JSON.stringify({ parent: null }),
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
    headRepositoryOwner: { login: 'blamechris' },
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

    it('dispatches on the SHAPE when __typename is absent', () => {
      // Live gh always emits __typename, so this fallback is defensive — but it
      // is the branch that picks between the CheckRun and StatusContext
      // grammars, and picking wrong silently mis-buckets every entry.
      assert.equal(bucketRollupEntry({ state: 'FAILURE' }), 'failed')
      assert.equal(bucketRollupEntry({ state: 'SUCCESS' }), 'passed')
      assert.equal(bucketRollupEntry({ status: 'COMPLETED', conclusion: 'FAILURE' }), 'failed')
      assert.equal(bucketRollupEntry({ status: 'IN_PROGRESS' }), 'pending')
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
      assert.equal(snap.indeterminate, false)
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

  describe('fork checkouts — an empty origin result is not yet a negative', () => {
    // A cross-repository PR is listed on the BASE repo, not the head repo, so a
    // fork checkout's `origin` legitimately reports nothing while an open PR
    // with running CI exists. Reporting "no PR" there is the confidently-wrong
    // answer this path exists to prevent.
    //
    // The shapes below are what gh 2.97.0 actually returns — measured before the
    // code was written, because the obvious fix is WRONG: `--head owner:branch`
    // against the base repo returns [].
    function forkTable({ baseRows, branch = 'fix-typos' } = {}) {
      const table = happyTable('[]', branch, 'MsfPablo/cli')
      table[`/usr/local/bin/gh repo view MsfPablo/cli --json parent`] =
        JSON.stringify({ parent: { name: 'cli', owner: { login: 'cli' } } })
      table[`/usr/local/bin/gh pr list -R cli/cli --head ${branch} --state open --limit ${FORK_QUERY_LIMIT} --json ${FIELDS}`] = baseRows
      return table
    }

    it('finds the PR on the upstream when origin is a fork', async () => {
      const row = prRow({ number: 14245, headRepositoryOwner: { login: 'MsfPablo' } })
      const snap = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec(forkTable({ baseRows: JSON.stringify([row]) })),
      })
      assert.equal(snap.pr.number, 14245)
      assert.equal(snap.reason, null)
      // `repo` names where the PR actually lives, which is where the user will
      // find it — the upstream, not the session's origin.
      assert.deepEqual(snap.repo, { owner: 'cli', name: 'cli' })
    })

    it('picks the row whose HEAD OWNER matches, not merely the first', async () => {
      // Two forks with the same branch name open against one base is the reason
      // the base query cannot just take --limit 1.
      const mine = prRow({ number: 14245, headRepositoryOwner: { login: 'MsfPablo' } })
      const theirs = prRow({ number: 999, headRepositoryOwner: { login: 'SomeoneElse' } })
      const snap = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec(forkTable({ baseRows: JSON.stringify([theirs, mine]) })),
      })
      assert.equal(snap.pr.number, 14245, 'must not return another fork\'s PR for the same branch name')
    })

    it('stays a quiet negative when the upstream has no PR from this fork', async () => {
      const theirs = prRow({ number: 999, headRepositoryOwner: { login: 'SomeoneElse' } })
      const snap = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec(forkTable({ baseRows: JSON.stringify([theirs]) })),
      })
      assert.equal(snap.pr, null)
      assert.equal(snap.reason, null)
      // POSITIVE CONTROL for the indeterminate tests above: the upstream WAS
      // queried and answered, so this genuinely is the quiet negative.
      assert.equal(snap.indeterminate, false)
    })

    it('makes NO extra calls when origin is not a fork and DOES find a PR', async () => {
      // The common case must still cost exactly one `gh pr list` — the fork path
      // is a fallback on an empty result, not a tax on every survey.
      const calls = []
      await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec(happyTable(JSON.stringify([prRow()])), calls),
      })
      const ghCalls = calls.filter(c => c.file === '/usr/local/bin/gh')
      assert.equal(ghCalls.length, 1)
      assert.equal(ghCalls[0].args[0], 'pr')
    })

    it('marks a FAILED parent lookup indeterminate — a transient failure is not a negative (#7435)', async () => {
      // The display contract is unchanged — pr null, reason null, so the chip is
      // not downgraded to "cannot determine". But the CI watcher must be able to
      // tell this apart from the authoritative quiet negative, or a single `gh`
      // hiccup silently cancels an armed watch (#7435).
      const table = happyTable('[]', 'feat/x', 'me/chroxy')
      table['/usr/local/bin/gh repo view me/chroxy --json parent'] = new Error('boom')
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
      assert.equal(snap.pr, null)
      assert.equal(snap.reason, null)
      assert.equal(snap.indeterminate, true)
    })

    it('pins each answered-but-unusable parent shape as indeterminate (#7435)', async () => {
      // Each shape exercises a DISTINCT resolveParentRepo failure arm —
      // unparseable output, an answer with no `parent` key, and a parent whose
      // names are not usable strings. Reverting any one of those arms to the
      // pre-#7435 `{ parent: null }` reads "could not use the answer" as
      // "authoritatively not a fork" and must fail here (review on #7440
      // proved all three survived the suite before this test existed).
      for (const bad of ['notjson', '{}', '{"parent":{}}', '{"parent":"x"}']) {
        const table = happyTable('[]', 'feat/x', 'me/chroxy')
        table['/usr/local/bin/gh repo view me/chroxy --json parent'] = bad
        const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
        assert.equal(snap.pr, null, `for ${bad}`)
        assert.equal(snap.reason, null, `for ${bad}`)
        assert.equal(snap.indeterminate, true, `for ${bad}`)
      }
    })

    it('marks a FAILED upstream query indeterminate, not a negative (#7435)', async () => {
      const table = forkTable({ baseRows: '[]' })
      table[`/usr/local/bin/gh pr list -R cli/cli --head fix-typos --state open --limit ${FORK_QUERY_LIMIT} --json ${FIELDS}`] = new Error('boom')
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
      assert.equal(snap.pr, null)
      assert.equal(snap.reason, null)
      assert.equal(snap.indeterminate, true)
    })

    it('marks unparseable upstream output indeterminate, not a negative (#7435)', async () => {
      for (const bad of ['not json', '{"not":"an array"}']) {
        const table = forkTable({ baseRows: bad })
        const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
        assert.equal(snap.pr, null, `for ${JSON.stringify(bad)}`)
        assert.equal(snap.reason, null, `for ${JSON.stringify(bad)}`)
        assert.equal(snap.indeterminate, true, `for ${JSON.stringify(bad)}`)
      }
    })

    it('marks a matching-but-unusable upstream row indeterminate, not a negative (#7435)', async () => {
      // The row IS ours (head owner matches) but carries no usable number — the
      // same condition the same-repo path reports as a reason. Absence was not
      // established, so it must not read as the quiet negative.
      const mine = prRow({ number: 0, headRepositoryOwner: { login: 'MsfPablo' } })
      const snap = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec(forkTable({ baseRows: JSON.stringify([mine]) })),
      })
      assert.equal(snap.pr, null)
      assert.equal(snap.reason, null)
      assert.equal(snap.indeterminate, true)
    })

    it('never puts an option-parseable parent owner/name into an argv slot', async () => {
      // Asserting only on the SNAPSHOT here is vacuous, and a mutation proved
      // it: with the guard removed the survey still returns pr:null/reason:null,
      // because the unsafe call simply misses the fixture table and degrades the
      // same way. Success and not-checking looked identical — the exact shape
      // docs/false-safety-guards.md catalogues. So assert on the ARGV instead:
      // the observable that actually differs is whether the call is MADE.
      const calls = []
      const table = happyTable('[]', 'feat/x', 'me/chroxy')
      table['/usr/local/bin/gh repo view me/chroxy --json parent'] =
        JSON.stringify({ parent: { name: 'cli', owner: { login: '--upload-file' } } })
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table, calls) })

      const listCalls = calls.filter(c => c.args[0] === 'pr' && c.args.includes('-R'))
      for (const call of listCalls) {
        const target = call.args[call.args.indexOf('-R') + 1]
        assert.ok(!target.startsWith('-'), `built an option-parseable -R target: ${target}`)
        assert.ok(!target.includes('--upload-file'), `used the rejected parent owner: ${target}`)
      }
      // #7435: the OUTCOME of the rejection changed too — a parent that exists
      // but cannot be QUERIED is not absence, so it must read indeterminate.
      assert.equal(snap.indeterminate, true, 'a rejected parent name is a failed lookup, not a negative')
    })

    it('positive control: a SAFE parent owner/name IS queried', async () => {
      // Without this, the assertion above would also pass against a survey that
      // never made a fork query at all.
      const calls = []
      const row = prRow({ number: 42, headRepositoryOwner: { login: 'me' } })
      const table = happyTable('[]', 'feat/x', 'me/chroxy')
      table['/usr/local/bin/gh repo view me/chroxy --json parent'] =
        JSON.stringify({ parent: { name: 'chroxy', owner: { login: 'blamechris' } } })
      table[`/usr/local/bin/gh pr list -R blamechris/chroxy --head feat/x --state open --limit ${FORK_QUERY_LIMIT} --json ${FIELDS}`] = JSON.stringify([row])

      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table, calls) })
      assert.equal(snap.pr.number, 42)
      const targets = calls.filter(c => c.args.includes('-R')).map(c => c.args[c.args.indexOf('-R') + 1])
      assert.ok(targets.includes('blamechris/chroxy'), `expected the parent to be queried, got ${JSON.stringify(targets)}`)
    })
  })

  describe('the reply reaches a pairing-bound client, so it must not leak host layout', () => {
    it('strips the absolute gh path out of a degradation reason', async () => {
      // execFile's own message is `Command failed: /Users/<name>/... pr list ...`.
      // Unlike the Control Room surveys this reply is session-scoped, so a
      // share-a-session client would otherwise learn the operator's home path.
      const table = { ...happyTable('[]') }
      const key = Object.keys(table).find(k => k.includes('pr list'))
      table[key] = new Error('Command failed: /Users/someone/bin/gh pr list -R x/y')
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
      assert.ok(!snap.reason.includes('/Users/someone'), `reason leaked a host path: ${snap.reason}`)
      assert.ok(snap.reason.includes('gh'), 'the binary name should survive redaction')
    })

    it('redacts EVERY absolute path, not just the binary it resolved', () => {
      // The first version stripped only the resolved gh path, which a message
      // carrying any OTHER path (a cwd, a config file, a second binary) defeats.
      const out = redactAbsolutePaths('ENOENT /Users/a/b/c and /opt/homebrew/bin/gh')
      assert.ok(!out.includes('/Users/a'), out)
      assert.ok(!out.includes('/opt/homebrew'), out)
    })

    it('leaves a reason with no paths in it untouched', () => {
      // Positive control: a redactor that mangled everything would pass the
      // negative assertions above for the wrong reason.
      assert.equal(redactAbsolutePaths('gh pr list failed: gh: not authenticated'), 'gh pr list failed: gh: not authenticated')
      assert.equal(redactAbsolutePaths('timeout after 20000ms'), 'timeout after 20000ms')
    })

    it('positive control: a stderr-carrying failure still reports gh\'s own message', async () => {
      const table = { ...happyTable('[]') }
      const key = Object.keys(table).find(k => k.includes('pr list'))
      table[key] = Object.assign(new Error('exit 1'), { stderr: 'gh: not authenticated\n' })
      const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
      assert.equal(snap.reason, 'gh pr list failed: gh: not authenticated')
    })

    it('reports a vanished working directory distinctly from a non-repo one', async () => {
      const gone = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec({ 'git branch --show-current': Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
      })
      assert.equal(gone.reason, CWD_MISSING_REASON)

      const notRepo = await surveySessionPrStatus({
        sessionId: 's1', cwd: '/repo',
        _execFile: fakeExec({ 'git branch --show-current': new Error('not a git repository') }),
      })
      assert.equal(notRepo.reason, NOT_A_REPO_REASON)
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
        // #7435: the indeterminate fork bail-out — the schema (a stripping
        // z.object) must keep accepting it; the wire never carries the marker.
        (() => {
          const t = happyTable('[]', 'feat/x', 'me/chroxy')
          t['/usr/local/bin/gh repo view me/chroxy --json parent'] = '{}'
          return t
        })(),
      ]
      for (const table of cases) {
        const snap = await surveySessionPrStatus({ sessionId: 's1', cwd: '/repo', _execFile: fakeExec(table) })
        const parsed = ServerSessionPrStatusSchema.safeParse({ type: 'session_pr_status', requestId: null, ...snap })
        assert.ok(parsed.success, `snapshot rejected by schema: ${JSON.stringify(parsed.error?.issues)}`)
      }
    })
  })
})
