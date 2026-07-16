/**
 * #5173 — Control Room host/repo survey + verdict + live-agent engine.
 *
 * Pins the behaviour the WS handler (#5174) and dashboard build on:
 *   - git status --porcelain → clean/dirty + untracked/modified/staged counts
 *   - worktree count, branch, lastTouched parsing
 *   - openPRs: count from gh json, null when gh missing/unauth/unparseable
 *   - attribution: includeCoAuthoredBy:false → true, true → false, else null
 *   - each verdict branch (live session-bound / live heuristic / investigate /
 *     recent / abandoned / onboarded)
 *   - per-repo error tolerance (one failing repo does not fail the survey)
 *   - summary counts match the per-repo verdicts
 *   - the snapshot validates against the @chroxy/protocol wire schema
 *
 * NEVER calls real git/gh or touches real ~/.chroxy / ~/.claude — all command
 * output is canned via the `_execFile` / `_readFile` / `_now` injection seams.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServerHostStatusSnapshotSchema } from '@chroxy/protocol'
import {
  surveyRepos,
  parseTree,
  countWorktrees,
  parseOpenPRs,
  parsePrChecks,
  parseGithubOwnerRepo,
  parseGithubPrsUrl,
  parseAheadBehind,
  detectAttribution,
  resolveActiveRepos,
  DEFAULT_THRESHOLDS,
} from '../src/control-room/survey.js'

const NOW = new Date('2026-06-05T12:00:00.000Z')
const now = () => new Date(NOW)

function iso(msAgo) {
  return new Date(NOW.getTime() - msAgo).toISOString()
}

/**
 * Build an `_execFile` fake from a per-repo command map. The map is keyed by
 * cwd → { branch, status, worktree, log, pr } strings (or an `Error` to reject,
 * or `undefined` to reject as "command not found").
 */
function makeExec(byCwd) {
  return async (file, args, opts) => {
    const cwd = opts && opts.cwd
    const repo = byCwd[cwd] || {}
    const key = cmdKey(file, args)
    const val = repo[key]
    if (val instanceof Error) throw val
    if (val === undefined) {
      const e = new Error(`ENOENT: ${file}`)
      throw e
    }
    return { stdout: val, stderr: '' }
  }
}

function cmdKey(file, args) {
  if (file === 'git' && args[0] === 'rev-parse') return 'branch'
  if (file === 'git' && args[0] === 'status') return 'status'
  if (file === 'git' && args[0] === 'worktree') return 'worktree'
  if (file === 'git' && args[0] === 'log') return 'log'
  if (file === 'git' && args[0] === 'rev-list') return 'aheadbehind'
  if (file === 'git' && args[0] === 'remote') return 'remote'
  if (file === 'gh') return 'pr'
  return 'unknown'
}

/** A clean, onboarded repo command map. */
function cleanRepo({ branch = 'main', log = iso(40 * 24 * 60 * 60 * 1000), pr = '[]', worktree = 'worktree /x\nHEAD abc\nbranch refs/heads/main\n', aheadbehind, remote = 'git@github.com:me/app.git' } = {}) {
  const repo = { branch, status: '', worktree, log, pr, remote }
  // Only define the ahead/behind probe when a test supplies it; leaving it
  // undefined makes makeExec reject (as if there's no upstream) → null/null.
  if (aheadbehind !== undefined) repo.aheadbehind = aheadbehind
  return repo
}

describe('parseTree', () => {
  it('reports clean for empty porcelain', () => {
    assert.deepEqual(parseTree(''), { state: 'clean', untracked: 0, modified: 0, staged: 0 })
  })

  it('counts untracked, modified, staged', () => {
    const porcelain = [
      '?? new.txt',
      ' M edited.txt',
      'M  staged.txt',
      'MM both.txt',
      'A  added.txt',
    ].join('\n')
    const t = parseTree(porcelain)
    assert.equal(t.state, 'dirty')
    assert.equal(t.untracked, 1)
    // ' M' modified, 'MM' modified, => 2 modified
    assert.equal(t.modified, 2)
    // 'M ' staged, 'MM' staged, 'A ' staged => 3 staged
    assert.equal(t.staged, 3)
  })

  it('tolerates CRLF line endings', () => {
    const t = parseTree('?? a.txt\r\n M b.txt\r\n')
    assert.equal(t.untracked, 1)
    assert.equal(t.modified, 1)
    assert.equal(t.state, 'dirty')
  })
})

describe('countWorktrees', () => {
  it('returns 0 for empty', () => {
    assert.equal(countWorktrees(''), 0)
  })
  it('counts worktree records', () => {
    const out = 'worktree /a\nHEAD x\n\nworktree /b\nHEAD y\n\nworktree /c\n'
    assert.equal(countWorktrees(out), 3)
  })
})

describe('parseOpenPRs', () => {
  it('counts a json array', () => {
    assert.equal(parseOpenPRs('[{"number":1},{"number":2}]'), 2)
  })
  it('returns 0 for empty array', () => {
    assert.equal(parseOpenPRs('[]'), 0)
  })
  it('returns null when gh is missing (null input)', () => {
    assert.equal(parseOpenPRs(null), null)
  })
  it('returns null for unparseable output', () => {
    assert.equal(parseOpenPRs('not json — gh: command not found'), null)
  })
})

describe('parsePrChecks', () => {
  const pr = (over) => ({ number: 1, reviewDecision: null, statusCheckRollup: [], ...over })

  it('returns null when gh failed (null input) or unparseable', () => {
    assert.equal(parsePrChecks(null), null)
    assert.equal(parsePrChecks('not json'), null)
    assert.equal(parsePrChecks('{}'), null) // not an array
  })

  it('all-zero for an empty PR list', () => {
    assert.deepEqual(parsePrChecks('[]'), { failing: 0, pending: 0, approved: 0, changesRequested: 0 })
  })

  it('counts a failing CI rollup (CheckRun conclusion)', () => {
    const json = JSON.stringify([pr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })])
    assert.deepEqual(parsePrChecks(json), { failing: 1, pending: 0, approved: 0, changesRequested: 0 })
  })

  it('counts a failing legacy StatusContext (state)', () => {
    const json = JSON.stringify([pr({ statusCheckRollup: [{ state: 'ERROR' }] })])
    assert.equal(parsePrChecks(json).failing, 1)
  })

  it('counts pending CI (in-progress, no failure)', () => {
    const json = JSON.stringify([pr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }] })])
    assert.deepEqual(parsePrChecks(json), { failing: 0, pending: 1, approved: 0, changesRequested: 0 })
  })

  it('a failure dominates a pending check on the same PR', () => {
    const json = JSON.stringify([pr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }, { conclusion: 'FAILURE' }] })])
    assert.deepEqual(parsePrChecks(json), { failing: 1, pending: 0, approved: 0, changesRequested: 0 })
  })

  it('counts review decisions independently of CI', () => {
    const json = JSON.stringify([
      pr({ reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }),
      pr({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
      pr({ reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [] }),
    ])
    assert.deepEqual(parsePrChecks(json), { failing: 1, pending: 0, approved: 1, changesRequested: 1 })
  })

  it('a PR with no checks counts as neither failing nor pending', () => {
    const json = JSON.stringify([pr({ statusCheckRollup: [] })])
    assert.deepEqual(parsePrChecks(json), { failing: 0, pending: 0, approved: 0, changesRequested: 0 })
  })
})

describe('parseGithubOwnerRepo (#5501 shared derivation)', () => {
  it('derives { owner, repo } from the three GitHub remote forms', () => {
    assert.deepEqual(parseGithubOwnerRepo('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' })
    assert.deepEqual(parseGithubOwnerRepo('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo' })
    assert.deepEqual(parseGithubOwnerRepo('ssh://git@github.com:443/owner/repo.git'), { owner: 'owner', repo: 'repo' })
  })
  it('returns null for non-GitHub / malformed remotes', () => {
    assert.equal(parseGithubOwnerRepo('git@gitlab.com:owner/repo.git'), null)
    assert.equal(parseGithubOwnerRepo('git@github.com:owner/repo/extra.git'), null)
    assert.equal(parseGithubOwnerRepo(null), null)
  })
})

describe('resolveActiveRepos (#6539 exact repo-events scoping)', () => {
  // Stub the promisified execFile: map cwd → origin remote stdout, or throw for
  // a non-repo / no-origin cwd (matching real `git remote get-url` failure).
  const makeExec = (byCwd) => async (_file, _args, opts) => {
    const remote = byCwd[opts?.cwd]
    if (remote === undefined) throw new Error('not a git repository')
    return { stdout: remote }
  }

  it('resolves each active cwd to its exact owner/repo (deduped + sorted)', async () => {
    const exec = makeExec({
      '/a': 'git@github.com:blamechris/chroxy.git',
      '/b': 'https://github.com/octocat/hello.git',
      '/c': 'git@github.com:blamechris/chroxy.git', // dup remote, different cwd (worktree)
    })
    const out = await resolveActiveRepos(['/a', '/b', '/c'], { execFn: exec })
    assert.deepEqual(out, ['blamechris/chroxy', 'octocat/hello'])
  })

  it('drops cwds with no repo / no origin / a non-GitHub remote (graceful degrade)', async () => {
    const exec = makeExec({
      '/gh': 'https://github.com/o/r.git',
      '/gitlab': 'git@gitlab.com:o/r.git', // non-GitHub → dropped
      // '/bare' is absent from the map → exec throws → dropped
    })
    const out = await resolveActiveRepos(['/gh', '/gitlab', '/bare'], { execFn: exec })
    assert.deepEqual(out, ['o/r'])
  })

  it('returns [] for an empty / non-array cwd list without spawning git', async () => {
    let called = false
    const exec = async () => { called = true; return { stdout: '' } }
    assert.deepEqual(await resolveActiveRepos([], { execFn: exec }), [])
    assert.deepEqual(await resolveActiveRepos(undefined, { execFn: exec }), [])
    assert.equal(called, false)
  })

  it('distinguishes two repos that share a basename across owners (the bug #6539 fixes)', async () => {
    const exec = makeExec({
      '/x': 'git@github.com:alice/app.git',
      '/y': 'git@github.com:bob/app.git',
    })
    const out = await resolveActiveRepos(['/x', '/y'], { execFn: exec })
    assert.deepEqual(out, ['alice/app', 'bob/app'], 'same basename "app", distinct owner/repo')
  })

  it('lowercases the owner/repo so a case-mismatched git remote still matches the canonical full_name', async () => {
    // A manually-edited remote can carry non-canonical casing; the webhook always
    // stamps GitHub's canonical (lowercased-here) full_name on ev.repo.
    const exec = makeExec({ '/a': 'git@github.com:BlameChris/Chroxy.git' })
    const out = await resolveActiveRepos(['/a'], { execFn: exec })
    assert.deepEqual(out, ['blamechris/chroxy'])
  })
})

describe('parseGithubPrsUrl', () => {
  const PRS = 'https://github.com/owner/repo/pulls'
  it('parses scp-style ssh remotes', () => {
    assert.equal(parseGithubPrsUrl('git@github.com:owner/repo.git'), PRS)
    assert.equal(parseGithubPrsUrl('git@github.com:owner/repo'), PRS)
  })
  it('parses https remotes', () => {
    assert.equal(parseGithubPrsUrl('https://github.com/owner/repo.git'), PRS)
    assert.equal(parseGithubPrsUrl('https://github.com/owner/repo'), PRS)
  })
  it('parses ssh:// remotes, including ssh-over-:443', () => {
    assert.equal(parseGithubPrsUrl('ssh://git@github.com/owner/repo.git'), PRS)
    assert.equal(parseGithubPrsUrl('ssh://git@github.com:443/owner/repo.git'), PRS)
  })
  it('returns null for non-GitHub or missing remotes', () => {
    assert.equal(parseGithubPrsUrl('git@gitlab.com:owner/repo.git'), null)
    assert.equal(parseGithubPrsUrl('https://example.com/x/y.git'), null)
    assert.equal(parseGithubPrsUrl(null), null)
    assert.equal(parseGithubPrsUrl(''), null)
  })
  it('returns null for remotes with extra path segments (not owner/repo)', () => {
    // Must NOT mint a bogus `.../pulls` for a non-repo path.
    assert.equal(parseGithubPrsUrl('git@github.com:owner/repo/extra.git'), null)
    assert.equal(parseGithubPrsUrl('https://github.com/owner/repo/extra'), null)
  })
})

describe('parseAheadBehind', () => {
  it('parses "<behind>\\t<ahead>" (left=behind, right=ahead)', () => {
    // git rev-list --left-right --count @{u}...HEAD → "<behind>\t<ahead>"
    assert.deepEqual(parseAheadBehind('1\t2'), { behind: 1, ahead: 2 })
  })
  it('parses space-separated counts too', () => {
    assert.deepEqual(parseAheadBehind('0 5'), { behind: 0, ahead: 5 })
  })
  it('up-to-date branch is 0/0', () => {
    assert.deepEqual(parseAheadBehind('0\t0'), { behind: 0, ahead: 0 })
  })
  it('returns null/null when the command failed (no upstream / detached)', () => {
    assert.deepEqual(parseAheadBehind(null), { ahead: null, behind: null })
  })
  it('returns null/null for unparseable output', () => {
    assert.deepEqual(parseAheadBehind('fatal: no upstream configured'), { ahead: null, behind: null })
  })
})

describe('detectAttribution', () => {
  it('includeCoAuthoredBy:false → true (attribution suppressed)', () => {
    assert.equal(detectAttribution('{"includeCoAuthoredBy": false}'), true)
  })
  it('includeCoAuthoredBy:true → false', () => {
    assert.equal(detectAttribution('{"includeCoAuthoredBy": true}'), false)
  })
  it('missing key → null', () => {
    assert.equal(detectAttribution('{"other": 1}'), null)
  })
  it('missing file (null) → null', () => {
    assert.equal(detectAttribution(null), null)
  })
  it('unparseable → null', () => {
    assert.equal(detectAttribution('{ bad json'), null)
  })
})

describe('surveyRepos — ahead/behind', () => {
  it('parses ahead/behind from the rev-list probe into the RepoStatus', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({ '/p/app': cleanRepo({ aheadbehind: '1\t3' }) })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.behind, 1)
    assert.equal(r.ahead, 3)
  })

  it('ahead/behind are null when there is no upstream (rev-list fails)', async () => {
    const repo = { name: 'app', path: '/p/app' }
    // cleanRepo() leaves `aheadbehind` undefined → makeExec rejects → null.
    const exec = makeExec({ '/p/app': cleanRepo() })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.ahead, null)
    assert.equal(r.behind, null)
  })
})

describe('surveyRepos — prsUrl', () => {
  it('derives the GitHub PRs URL from the origin remote', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({ '/p/app': cleanRepo({ remote: 'git@github.com:acme/app.git' }) })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    assert.equal(out.repos[0].prsUrl, 'https://github.com/acme/app/pulls')
  })

  it('prsUrl is null when origin is missing or not GitHub', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({ '/p/app': { ...cleanRepo(), remote: undefined } })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    assert.equal(out.repos[0].prsUrl, null)
  })
})

describe('surveyRepos — prChecks rollup', () => {
  it('rolls up CI + review state from the gh probe into the RepoStatus', async () => {
    const prJson = JSON.stringify([
      { number: 1, reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
      { number: 2, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
    ])
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({ '/p/app': cleanRepo({ pr: prJson }) })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.openPRs, 2) // same gh call still feeds the count
    assert.deepEqual(r.prChecks, { failing: 1, pending: 0, approved: 1, changesRequested: 1 })
  })

  it('prChecks is null when the gh probe fails (mirrors openPRs null)', async () => {
    const repo = { name: 'app', path: '/p/app' }
    // gh missing → makeExec rejects the 'pr' command (undefined value).
    const exec = makeExec({ '/p/app': { ...cleanRepo(), pr: undefined } })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.openPRs, null)
    assert.equal(r.prChecks, null)
  })
})

describe('surveyRepos — verdicts', () => {
  it('onboarded: clean tree, not live, no leak', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({ '/p/app': cleanRepo() })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error('no file') } })
    const r = out.repos[0]
    assert.equal(r.verdict, 'onboarded')
    assert.equal(r.live, false)
    assert.equal(r.tree.state, 'clean')
    assert.equal(r.onboarding, '✓ onboarded')
    assert.equal(r.note, undefined)
  })

  it('live (session-bound): an active chroxy session cwd matches the repo', async () => {
    const repo = { name: 'app', path: '/p/app' }
    // clean tree but a session is bound → still live
    const exec = makeExec({ '/p/app': cleanRepo() })
    const out = await surveyRepos([repo], {
      _execFile: exec,
      _now: now,
      _readFile: async () => { throw new Error('no file') },
      activeSessionCwds: ['/p/app/packages/server'],
    })
    const r = out.repos[0]
    assert.equal(r.verdict, 'live')
    assert.equal(r.live, true)
    assert.match(r.note, /Active session here/)
    assert.equal(r.onboarding, 'deferred (live)')
  })

  it('live (heuristic): dirty tree touched within liveMs, no session', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({
      '/p/app': { branch: 'feat/x', status: ' M a.js', worktree: 'worktree /p/app\n', log: iso(60 * 1000), pr: '[]' },
    })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.verdict, 'live')
    assert.equal(r.live, true)
    assert.match(r.note, /likely a live agent/)
  })

  it('investigate: excessive worktree count (leak), not live', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const wt = Array.from({ length: DEFAULT_THRESHOLDS.worktreeLeak }, (_, i) => `worktree /p/app/wt${i}\n`).join('\n')
    const exec = makeExec({
      '/p/app': { branch: 'main', status: '', worktree: wt, log: iso(40 * 24 * 60 * 60 * 1000), pr: '[]' },
    })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.verdict, 'investigate')
    assert.equal(r.live, false)
    assert.match(r.note, /worktrees — likely a leak/)
  })

  it('recent: dirty tree touched within recentMs but not live', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({
      '/p/app': { branch: 'feat/x', status: ' M a.js', worktree: 'worktree /p/app\n', log: iso(2 * 24 * 60 * 60 * 1000), pr: '[]' },
    })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.verdict, 'recent')
    assert.equal(r.live, false)
    assert.match(r.note, /no live agent/)
  })

  it('abandoned: dirty tree last touched long ago, not live', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({
      '/p/app': { branch: 'feat/x', status: ' M a.js', worktree: 'worktree /p/app\n', log: iso(40 * 24 * 60 * 60 * 1000), pr: '[]' },
    })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.verdict, 'abandoned')
    assert.equal(r.live, false)
    assert.match(r.note, /no live agent/)
  })
})

describe('surveyRepos — gh tolerance', () => {
  it('openPRs is null when gh is missing', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({
      // pr key omitted → exec fake rejects ("gh not found")
      '/p/app': { branch: 'main', status: '', worktree: 'worktree /p/app\n', log: iso(1000) },
    })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    assert.equal(out.repos[0].openPRs, null)
  })

  it('openPRs counts PRs when gh works', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({
      '/p/app': { ...cleanRepo({ pr: '[{"number":7},{"number":9},{"number":11}]' }) },
    })
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    assert.equal(out.repos[0].openPRs, 3)
  })
})

describe('surveyRepos — attribution via _readFile', () => {
  it('reads .claude/settings.json and detects suppressed attribution', async () => {
    const repo = { name: 'app', path: '/p/app' }
    const exec = makeExec({ '/p/app': cleanRepo() })
    const readFile = async (path) => {
      assert.match(path, /\.claude[\/\\]settings\.json$/)
      return '{"includeCoAuthoredBy": false}'
    }
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: readFile })
    assert.equal(out.repos[0].attribution, true)
  })
})

describe('surveyRepos — per-repo error tolerance', () => {
  it('one repo whose _readFile/exec throw unexpectedly does not fail the survey', async () => {
    const ok = { name: 'ok', path: '/p/ok' }
    const bad = { name: 'bad', path: '/p/bad' }
    // The exec fake rejects for every command on /p/bad, so its git status
    // probe returns null — surveyOne's core-probe-failure guard then yields a
    // degraded `investigate` row (branch 'unknown') rather than a false-clean
    // row. The /p/bad _readFile also throws, exercising the tolerant read path.
    const exec = async (file, args, opts) => {
      if (opts.cwd === '/p/bad') {
        throw new Error('disk on fire')
      }
      const repo = cleanRepo()
      return { stdout: repo[cmdKey(file, args)] ?? '', stderr: '' }
    }
    const readFile = async (path) => {
      if (path.includes('/p/bad/')) throw new Error('boom')
      throw new Error('no file')
    }
    const out = await surveyRepos([ok, bad], { _execFile: exec, _now: now, _readFile: readFile })
    assert.equal(out.repos.length, 2)
    const okStatus = out.repos.find(r => r.name === 'ok')
    const badStatus = out.repos.find(r => r.name === 'bad')
    assert.equal(okStatus.verdict, 'onboarded')
    // bad repo: all git probes failed → branch unknown, clean tree fallback,
    // still a valid RepoStatus (not dropped).
    assert.ok(badStatus)
    assert.equal(badStatus.branch, 'unknown')
    // Core git probe failed → degraded `investigate`, NOT a false `onboarded`.
    assert.equal(badStatus.verdict, 'investigate')
  })

  it('core git probe failure (status) yields a degraded investigate row, not onboarded', async () => {
    const repo = { name: 'notgit', path: '/p/notgit' }
    // `git status` fails (path is not a git repo). Other commands also fail.
    const exec = makeExec({ '/p/notgit': {} }) // empty map → every command rejects
    const out = await surveyRepos([repo], { _execFile: exec, _now: now, _readFile: async () => { throw new Error() } })
    const r = out.repos[0]
    assert.equal(r.verdict, 'investigate')
    assert.equal(r.live, false)
    assert.equal(r.branch, 'unknown')
    // Did NOT fall through to a false-clean onboarded row.
    assert.notEqual(r.verdict, 'onboarded')
    assert.match(r.note, /git status probe failed/)
    // Still a schema-valid RepoStatus.
    const parsed = ServerHostStatusSnapshotSchema.safeParse({ type: 'host_status_snapshot', ...out })
    assert.ok(parsed.success)
  })

  it('hasBoundSession matches a Windows-style backslash session cwd', async () => {
    // Repo path uses backslashes (Windows); a bound session cwd under it must
    // still register as live despite the separator difference.
    const repo = { name: 'win', path: 'C:\\proj\\app' }
    const exec = makeExec({ 'C:\\proj\\app': cleanRepo() })
    const out = await surveyRepos([repo], {
      _execFile: exec,
      _now: now,
      _readFile: async () => { throw new Error() },
      activeSessionCwds: ['C:\\proj\\app\\packages\\server'],
    })
    assert.equal(out.repos[0].verdict, 'live')
    assert.equal(out.repos[0].live, true)
  })
})

describe('surveyRepos — summary + schema conformance', () => {
  it('summary counts match per-repo verdicts and snapshot validates', async () => {
    const repos = [
      { name: 'onb', path: '/p/onb' },
      { name: 'liv', path: '/p/liv' },
      { name: 'rec', path: '/p/rec' },
      { name: 'aba', path: '/p/aba' },
      { name: 'inv', path: '/p/inv' },
    ]
    const wtLeak = Array.from({ length: 5 }, (_, i) => `worktree /p/inv/wt${i}\n`).join('\n')
    const exec = makeExec({
      '/p/onb': cleanRepo(),
      '/p/liv': { branch: 'f', status: ' M a', worktree: 'worktree /p/liv\n', log: iso(30 * 1000), pr: '[]' },
      '/p/rec': { branch: 'f', status: ' M a', worktree: 'worktree /p/rec\n', log: iso(2 * 24 * 60 * 60 * 1000), pr: '[]' },
      '/p/aba': { branch: 'f', status: ' M a', worktree: 'worktree /p/aba\n', log: iso(40 * 24 * 60 * 60 * 1000), pr: '[]' },
      '/p/inv': { branch: 'main', status: '', worktree: wtLeak, log: iso(40 * 24 * 60 * 60 * 1000), pr: '[]' },
    })
    const out = await surveyRepos(repos, {
      _execFile: exec,
      _now: now,
      _readFile: async () => { throw new Error() },
      root: '/p',
    })

    assert.deepEqual(out.summary, {
      live: 1,
      onboarded: 1,
      abandoned: 1,
      investigate: 1,
      recent: 1,
    })

    // The handler adds `type`; the survey result is otherwise the full snapshot.
    const snapshot = { type: 'host_status_snapshot', ...out }
    const parsed = ServerHostStatusSnapshotSchema.safeParse(snapshot)
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2))
    assert.equal(out.root, '/p')
    assert.match(out.generatedAt, /^2026-06-05T12:00:00/)
  })

  it('empty repo set yields a valid empty snapshot', async () => {
    const out = await surveyRepos([], { _now: now, root: '/p' })
    assert.deepEqual(out.repos, [])
    assert.deepEqual(out.summary, { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 })
    const parsed = ServerHostStatusSnapshotSchema.safeParse({ type: 'host_status_snapshot', ...out })
    assert.ok(parsed.success)
  })
})

describe('surveyRepos — concurrency cap', () => {
  it('never exceeds the configured concurrency cap', async () => {
    const repos = Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, path: `/p/r${i}` }))
    let inFlight = 0
    let maxInFlight = 0
    const exec = async (file, args) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      // minimal valid output per command
      const repo = cleanRepo()
      return { stdout: repo[cmdKey(file, args)] ?? '', stderr: '' }
    }
    await surveyRepos(repos, {
      _execFile: exec,
      _now: now,
      _readFile: async () => { throw new Error() },
      concurrency: 3,
    })
    // Each repo fires up to 7 concurrent commands internally (rev-parse,
    // status, worktree, log, rev-list ahead/behind, remote get-url, gh pr); the
    // cap bounds how many repos run at once, so observed parallel commands stays
    // bounded by cap * (commands per repo). The key invariant: not all 12 repos
    // ran at once. With cap 3 and 7 cmds/repo, ceiling is 21 commands in flight.
    assert.ok(maxInFlight <= 3 * 7, `maxInFlight=${maxInFlight}`)
  })
})

describe('survey probes — exec robustness (#5240/#5241)', () => {
  // Wrap makeExec to capture every (file, args, opts) call while still returning
  // clean-repo output.
  function capturingExec(repoMap) {
    const calls = []
    const base = makeExec(repoMap)
    const fn = async (file, args, opts) => {
      calls.push({ file, args, opts })
      return base(file, args, opts)
    }
    return { fn, calls }
  }

  it('#5240: gh pr list is invoked with an explicit --limit (not the silent 30 default)', async () => {
    const repo = '/r'
    const { fn, calls } = capturingExec({ [repo]: cleanRepo() })
    await surveyRepos([repo], { _execFile: fn, _now: now, _readFile: async () => { throw new Error() } })
    const ghCall = calls.find((c) => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'list')
    assert.ok(ghCall, 'gh pr list was invoked')
    const li = ghCall.args.indexOf('--limit')
    assert.ok(li !== -1, `gh pr list missing --limit; args: ${JSON.stringify(ghCall.args)}`)
    assert.ok(Number(ghCall.args[li + 1]) >= 100, `--limit should be a high cap, got ${ghCall.args[li + 1]}`)
  })

  it('#5241: every git/gh probe passes a maxBuffer well above Node\'s 1MB default', async () => {
    const repo = '/r'
    const { fn, calls } = capturingExec({ [repo]: cleanRepo() })
    await surveyRepos([repo], { _execFile: fn, _now: now, _readFile: async () => { throw new Error() } })
    const probeCalls = calls.filter((c) => c.file === 'git' || c.file === 'gh')
    assert.ok(probeCalls.length > 0, 'at least one probe ran')
    for (const c of probeCalls) {
      assert.ok(
        c.opts && typeof c.opts.maxBuffer === 'number' && c.opts.maxBuffer > 1024 * 1024,
        `probe \`${c.file} ${c.args[0]}\` must pass maxBuffer > 1MB (got ${c.opts && c.opts.maxBuffer})`,
      )
    }
  })

  it('#5259: every git/gh probe passes a bounded timeout so a stuck subprocess rejects', async () => {
    const repo = '/r'
    const { fn, calls } = capturingExec({ [repo]: cleanRepo() })
    await surveyRepos([repo], { _execFile: fn, _now: now, _readFile: async () => { throw new Error() } })
    const probeCalls = calls.filter((c) => c.file === 'git' || c.file === 'gh')
    assert.ok(probeCalls.length > 0, 'at least one probe ran')
    for (const c of probeCalls) {
      assert.ok(
        c.opts && typeof c.opts.timeout === 'number' && c.opts.timeout > 0,
        `probe \`${c.file} ${c.args[0]}\` must pass a positive timeout (got ${c.opts && c.opts.timeout})`,
      )
    }
  })
})
