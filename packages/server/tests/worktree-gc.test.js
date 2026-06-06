/**
 * Tests for the worktree garbage-collector (#5158).
 *
 * Unit tests cover the pure parsers/guards. Integration tests build a real
 * temp git repo with several linked worktrees in every state the GC must
 * distinguish (clean+dead-pid, dirty+dead-pid, live-pid, no-pid lock,
 * unlocked, dir-gone) and assert the plan + apply do the safe thing: reclaim
 * only clean dead-pid-locked worktrees + stale dir-gone refs, never --force,
 * never touch dirty/live/unknown ones.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { GIT } from '../src/git.js'
import {
  isPidAlive,
  parsePid,
  parseWorktreeList,
  readLockReasonFromAdmin,
  planRepoGc,
  applyPlan,
} from '../src/worktree-gc.js'

// A pid that the fake kill treats as alive; everything else is "dead".
const LIVE_PID = 4000002
const DEAD_PID = 4000001
const fakeKill = (pid) => {
  if (pid === LIVE_PID) return true
  const err = new Error('no such process')
  err.code = 'ESRCH'
  throw err
}

const git = (cwd, args) => execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

describe('worktree-gc unit: isPidAlive', () => {
  it('treats the current process as alive', () => {
    assert.equal(isPidAlive(process.pid), true)
  })
  it('treats EPERM (exists, no permission) as alive', () => {
    assert.equal(isPidAlive(123, () => { const e = new Error('perm'); e.code = 'EPERM'; throw e }), true)
  })
  it('treats ESRCH as dead', () => {
    assert.equal(isPidAlive(123, () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e }), false)
  })
  it('rejects non-positive / non-integer pids', () => {
    assert.equal(isPidAlive(0), false)
    assert.equal(isPidAlive(-5), false)
    assert.equal(isPidAlive(1.5), false)
    assert.equal(isPidAlive(NaN), false)
  })
})

describe('worktree-gc unit: parsePid', () => {
  it('parses the agent lock format', () => {
    assert.equal(parsePid('claude agent agent-x (pid 45492)'), 45492)
  })
  it('parses loose pid forms', () => {
    assert.equal(parsePid('locked, pid: 1234'), 1234)
    assert.equal(parsePid('pid 9'), 9)
  })
  it('returns null when there is no pid', () => {
    assert.equal(parsePid('manual lock, do not touch'), null)
    assert.equal(parsePid(''), null)
    assert.equal(parsePid(null), null)
    assert.equal(parsePid(undefined), null)
  })
})

describe('worktree-gc unit: parseWorktreeList', () => {
  it('parses main + linked worktrees with locked/prunable reasons', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/.claude/worktrees/agent-x',
      'HEAD bbb',
      'detached',
      'locked claude agent agent-x (pid 999)',
      '',
      'worktree /repo/.claude/worktrees/agent-gone',
      'HEAD ccc',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')
    const entries = parseWorktreeList(porcelain)
    assert.equal(entries.length, 3)
    assert.equal(entries[0].path, '/repo')
    assert.equal(entries[1].locked, true)
    assert.equal(entries[1].lockReason, 'claude agent agent-x (pid 999)')
    assert.equal(entries[1].detached, true)
    assert.equal(entries[2].prunable, true)
  })
  it('handles bare keyword locked (no inline reason)', () => {
    const entries = parseWorktreeList('worktree /a\n\nworktree /b\nlocked\n')
    assert.equal(entries[1].locked, true)
    assert.equal(entries[1].lockReason, '')
  })
  it('tolerates empty/nullish input', () => {
    assert.deepEqual(parseWorktreeList(''), [])
    assert.deepEqual(parseWorktreeList(null), [])
  })
})

describe('worktree-gc integration (real git repo)', () => {
  let repo

  function addWorktree(name, { lockReason, dirty } = {}) {
    const wtPath = join(repo, '.claude', 'worktrees', name)
    git(repo, ['worktree', 'add', '--detach', wtPath, 'HEAD'])
    if (dirty) writeFileSync(join(wtPath, 'scratch.txt'), 'uncommitted work')
    if (lockReason) git(repo, ['worktree', 'lock', '--reason', lockReason, wtPath])
    return wtPath
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'chroxy-wtgc-'))
    git(repo, ['init', '--initial-branch=main', '.'])
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'init'])
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('plans: reclaim clean+dead-pid, skip dirty/live/no-pid/unlocked, prune dir-gone', () => {
    addWorktree('clean-dead', { lockReason: `claude agent a1 (pid ${DEAD_PID})` })
    addWorktree('dirty-dead', { lockReason: `claude agent a2 (pid ${DEAD_PID})`, dirty: true })
    addWorktree('live', { lockReason: `claude agent a3 (pid ${LIVE_PID})` })
    addWorktree('no-pid', { lockReason: 'manual lock, keep' })
    addWorktree('unlocked')
    const gone = addWorktree('gone', { lockReason: `claude agent a4 (pid ${DEAD_PID})` })
    // Simulate the process having vanished mid-run: its worktree dir is gone
    // but the locked admin ref remains.
    rmSync(gone, { recursive: true, force: true })

    const plan = planRepoGc(repo, { kill: fakeKill })
    // Match by trailing dir name — git reports canonical paths (/private/var
    // on macOS) that differ from the constructed /var paths.
    const find = (name) => plan.items.find((i) => i.path.endsWith(`/${name}`))

    assert.equal(find('clean-dead').action, 'remove')
    assert.equal(find('dirty-dead').action, 'skip')
    assert.match(find('dirty-dead').skipReason, /uncommitted/)
    assert.equal(find('live').action, 'skip')
    assert.match(find('live').skipReason, /live process/)
    assert.equal(find('no-pid').action, 'skip')
    assert.match(find('no-pid').skipReason, /no pid/)
    assert.equal(find('unlocked').action, 'skip')
    assert.equal(find('gone').action, 'prune')
    // The main worktree is never listed for GC (only the 6 linked ones).
    assert.equal(plan.items.length, 6)
  })

  it('apply: removes clean dead worktree + prunes dir-gone, preserves the rest', () => {
    const cleanDead = addWorktree('clean-dead', { lockReason: `claude agent a1 (pid ${DEAD_PID})` })
    const dirtyDead = addWorktree('dirty-dead', { lockReason: `claude agent a2 (pid ${DEAD_PID})`, dirty: true })
    const live = addWorktree('live', { lockReason: `claude agent a3 (pid ${LIVE_PID})` })
    const gone = addWorktree('gone', { lockReason: `claude agent a4 (pid ${DEAD_PID})` })
    rmSync(gone, { recursive: true, force: true })

    const plan = planRepoGc(repo, { kill: fakeKill })
    const reclaimable = plan.items.filter((i) => i.action === 'remove' || i.action === 'prune')
    const results = applyPlan(repo, { items: reclaimable })

    // Every reclaim op succeeded.
    assert.ok(results.every((r) => r.ok), `apply results: ${JSON.stringify(results)}`)

    // Clean dead worktree dir is gone; dirty + live are preserved on disk.
    assert.equal(existsSync(cleanDead), false)
    assert.equal(existsSync(dirtyDead), true)
    assert.equal(existsSync(live), true)

    // git's own view: clean-dead and gone are no longer tracked; dirty + live remain.
    const list = git(repo, ['worktree', 'list', '--porcelain'])
    assert.ok(!list.includes(cleanDead), 'clean-dead still listed')
    assert.ok(!list.includes(gone), 'gone still listed')
    assert.ok(list.includes(dirtyDead), 'dirty-dead was dropped')
    assert.ok(list.includes(live), 'live was dropped')
  })

  it('never deletes a dirty worktree even when locked by a dead pid', () => {
    const dirtyDead = addWorktree('dirty-dead', { lockReason: `claude agent a2 (pid ${DEAD_PID})`, dirty: true })
    const plan = planRepoGc(repo, { kill: fakeKill })
    const reclaimable = plan.items.filter((i) => i.action !== 'skip')
    applyPlan(repo, { items: reclaimable })
    assert.equal(existsSync(dirtyDead), true)
    assert.equal(existsSync(join(dirtyDead, 'scratch.txt')), true)
  })

  it('#5245: re-locks a worktree when removal fails after planning (preserves lock provenance)', () => {
    const cleanDead = addWorktree('clean-dead', { lockReason: `claude agent a1 (pid ${DEAD_PID})` })
    // Plan while clean → action 'remove'.
    const plan = planRepoGc(repo, { kill: fakeKill })
    const planned = plan.items.find((i) => i.path.endsWith('/clean-dead'))
    assert.ok(planned, 'clean-dead was planned for GC')
    assert.equal(planned.action, 'remove')

    // TOCTOU: the tree goes dirty AFTER planning, so `git worktree remove`
    // (no --force) refuses on apply (untracked file).
    writeFileSync(join(cleanDead, 'scratch.txt'), 'became dirty after planning')

    const results = applyPlan(repo, { items: plan.items })
    const res = results.find((r) => r.path.endsWith('/clean-dead'))
    assert.equal(res.ok, false) // remove failed as expected

    // The worktree must be left LOCKED (not silently unlocked), with its
    // dead-pid provenance intact.
    const entry = parseWorktreeList(git(repo, ['worktree', 'list', '--porcelain']))
      .find((e) => e.path.endsWith('/clean-dead'))
    assert.ok(entry, 'clean-dead still present')
    assert.equal(entry.locked, true)
    assert.match(readLockReasonFromAdmin(cleanDead), new RegExp(`pid ${DEAD_PID}`))
  })

  it('readLockReasonFromAdmin recovers the reason when porcelain omits it', () => {
    const wt = addWorktree('clean-dead', { lockReason: `claude agent a1 (pid ${DEAD_PID})` })
    const reason = readLockReasonFromAdmin(wt)
    assert.match(reason, new RegExp(`pid ${DEAD_PID}`))
  })
})

describe('worktree-gc unit: applyPlan prune reporting (injected git)', () => {
  it('reports a prune item as failed when its pre-prune unlock fails', () => {
    const calls = []
    const git = (cwd, args) => {
      calls.push(args.join(' '))
      if (args[0] === 'worktree' && args[1] === 'unlock') {
        const e = new Error('fatal: cannot unlock'); e.code = 1; throw e
      }
      return '' // prune succeeds
    }
    const results = applyPlan('/repo', {
      items: [{ path: '/repo/wt/gone', action: 'prune', locked: true }],
    }, { git })

    assert.equal(results.length, 1)
    assert.equal(results[0].ok, false)
    assert.match(results[0].error, /unlock failed/)
    // prune still runs (it reclaims any other unlocked dir-gone refs).
    assert.ok(calls.includes('worktree prune'))
  })

  it('reports prune ok when unlock+prune both succeed', () => {
    const git = () => ''
    const results = applyPlan('/repo', {
      items: [{ path: '/repo/wt/gone', action: 'prune', locked: true }],
    }, { git })
    assert.equal(results[0].ok, true)
  })
})

describe('worktree-gc unit: readLockReasonFromAdmin (injected fs)', () => {
  it('resolves a RELATIVE gitdir pointer against the worktree dir', () => {
    // git may write `gitdir:` as a path relative to the worktree (e.g. with
    // extensions.relativeWorktrees). The resolved admin/locked file must hang
    // off the worktree path, not the cwd.
    const wtPath = '/repos/proj/.claude/worktrees/agent-x'
    const expectedLocked = '/repos/proj/.git/worktrees/agent-x/locked'
    const files = {
      [`${wtPath}/.git`]: 'gitdir: ../../../.git/worktrees/agent-x',
      [expectedLocked]: 'claude agent agent-x (pid 4242)',
    }
    const reason = readLockReasonFromAdmin(wtPath, {
      exists: (p) => p in files,
      read: (p) => files[p],
    })
    assert.equal(reason, 'claude agent agent-x (pid 4242)')
  })

  it('still handles an absolute gitdir pointer', () => {
    const wtPath = '/repos/proj/.claude/worktrees/agent-y'
    const files = {
      [`${wtPath}/.git`]: 'gitdir: /repos/proj/.git/worktrees/agent-y',
      '/repos/proj/.git/worktrees/agent-y/locked': 'claude agent agent-y (pid 99)',
    }
    const reason = readLockReasonFromAdmin(wtPath, {
      exists: (p) => p in files,
      read: (p) => files[p],
    })
    assert.equal(reason, 'claude agent agent-y (pid 99)')
  })
})

describe('worktree-gc CLI (runWorktreeGc against a real repo)', () => {
  let repo, cleanDead, dirtyDead

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'chroxy-wtgc-cli-'))
    git(repo, ['init', '--initial-branch=main', '.'])
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'init'])
    cleanDead = join(repo, '.claude', 'worktrees', 'clean-dead')
    dirtyDead = join(repo, '.claude', 'worktrees', 'dirty-dead')
    git(repo, ['worktree', 'add', '--detach', cleanDead, 'HEAD'])
    git(repo, ['worktree', 'lock', '--reason', `claude agent a1 (pid ${DEAD_PID})`, cleanDead])
    git(repo, ['worktree', 'add', '--detach', dirtyDead, 'HEAD'])
    writeFileSync(join(dirtyDead, 'scratch.txt'), 'wip')
    git(repo, ['worktree', 'lock', '--reason', `claude agent a2 (pid ${DEAD_PID})`, dirtyDead])
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('dry-run (default) reports reclaimable and deletes nothing', async () => {
    const { runWorktreeGc } = await import('../src/cli/worktree-gc-cmd.js')
    const out = []
    const { report, applied } = await runWorktreeGc(
      { repo, json: true },
      { write: (s) => out.push(s), planDeps: { kill: fakeKill } },
    )
    assert.equal(applied, null)
    assert.equal(report.apply, false)
    assert.equal(report.reclaimableCount, 1) // clean-dead only; dirty-dead skipped
    assert.equal(report.skippedCount, 1)
    assert.equal(existsSync(cleanDead), true) // nothing deleted in dry-run
  })

  it('--apply reclaims the clean dead worktree and preserves the dirty one', async () => {
    const { runWorktreeGc } = await import('../src/cli/worktree-gc-cmd.js')
    const { applied } = await runWorktreeGc(
      { repo, apply: true },
      { write: () => {}, planDeps: { kill: fakeKill } },
    )
    assert.ok(applied && applied.length === 1 && applied[0].ok)
    assert.equal(existsSync(cleanDead), false)
    assert.equal(existsSync(dirtyDead), true)
  })

  it('#5221 scans the config.repos set when no --repo is given', async () => {
    const { collectWorktreeGc } = await import('../src/cli/worktree-gc-cmd.js')
    // A config that lists the temp repo explicitly — exercises the
    // readConfigSoft → resolveRepoSet({ repos }) path (vs the --repo shortcut).
    const configPath = join(repo, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos: [{ name: 'cfg-repo', path: repo }] }))

    const report = collectWorktreeGc(
      {}, // no --repo
      {
        configPath,
        withSizes: false,
        planDeps: { kill: fakeKill },
        // Stub auto-discovery so the default ~/Projects root isn't walked —
        // isolates the assertion to the explicit config.repos entry.
        repoSetSeams: { _readdir: () => [] },
      },
    )
    assert.equal(report.repoCount, 1)
    assert.equal(report.reclaimableCount, 1) // clean-dead
    assert.equal(report.skippedCount, 1) // dirty-dead
    assert.ok(report.repos.some((r) => r.path === repo), 'config repo was not scanned')
  })
})

describe('worktree-gc CLI (config controlRoomRoot auto-discovery, #5221)', () => {
  let root, repo, cleanDead

  beforeEach(() => {
    // A dedicated discovery root holding one repo, so resolveRepoSet's
    // auto-discovery has a deterministic tree to walk (not all of tmpdir).
    root = mkdtempSync(join(tmpdir(), 'chroxy-wtgc-root-'))
    repo = join(root, 'project-a')
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '--initial-branch=main', '.'])
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'init'])
    cleanDead = join(repo, '.claude', 'worktrees', 'clean-dead')
    git(repo, ['worktree', 'add', '--detach', cleanDead, 'HEAD'])
    git(repo, ['worktree', 'lock', '--reason', `claude agent a1 (pid ${DEAD_PID})`, cleanDead])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('discovers repos under config.controlRoomRoot when no --repo is given', async () => {
    const { collectWorktreeGc } = await import('../src/cli/worktree-gc-cmd.js')
    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({ controlRoomRoot: root }))

    const report = collectWorktreeGc(
      {},
      { configPath, withSizes: false, planDeps: { kill: fakeKill } },
    )
    // Exact count: the temp root holds exactly one repo, so a stronger guard
    // than `>= 1` catches a regression that unions in the default ~/Projects set.
    assert.equal(report.repoCount, 1)
    assert.equal(report.repos[0].path, repo, 'project-a was not the discovered repo')
    assert.equal(report.reclaimableCount, 1) // clean-dead
    assert.equal(report.skippedCount, 0) // only a clean-dead worktree in this fixture
  })
})
