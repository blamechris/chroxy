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
  detectAttribution,
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
  if (file === 'gh') return 'pr'
  return 'unknown'
}

/** A clean, onboarded repo command map. */
function cleanRepo({ branch = 'main', log = iso(40 * 24 * 60 * 60 * 1000), pr = '[]', worktree = 'worktree /x\nHEAD abc\nbranch refs/heads/main\n' } = {}) {
  return { branch, status: '', worktree, log, pr }
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
    // exec fake throws a non-Error for /p/bad branch to simulate an unexpected
    // crash inside surveyOne (Promise.all rejection paths are tolerated, but
    // we also exercise the outer try/catch via a throwing _readFile).
    const exec = async (file, args, opts) => {
      if (opts.cwd === '/p/bad') {
        // throw synchronously-ish (rejected promise) for every command
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
    // Each repo fires up to 5 concurrent commands internally; the cap bounds
    // how many repos run at once, so observed parallel commands stays bounded
    // by cap * (commands per repo). The key invariant: not all 12 repos ran at
    // once. With cap 3 and 5 cmds/repo, ceiling is 15 commands in flight.
    assert.ok(maxInFlight <= 3 * 5, `maxInFlight=${maxInFlight}`)
  })
})
