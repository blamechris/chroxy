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
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { GIT } from '../src/git.js'
import { disableRepoAutoGc, RM_RETRY } from './test-helpers.js'
import {
  isPidAlive,
  parsePid,
  parseWorktreeList,
  readLockReasonFromAdmin,
  planRepoGc,
  applyPlan,
  sweepOrphanChroxyWorktrees,
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

  function addWorktree(name, { lockReason, dirty, ignored } = {}) {
    const wtPath = join(repo, '.claude', 'worktrees', name)
    git(repo, ['worktree', 'add', '--detach', wtPath, 'HEAD'])
    if (dirty) writeFileSync(join(wtPath, 'scratch.txt'), 'uncommitted work')
    if (ignored) {
      // A worktree whose ONLY non-tracked content is gitignored: clean to
      // `git status --porcelain`, but `git worktree remove` (no --force) would
      // still delete the whole dir incl. these files (#5244). Commit the
      // .gitignore so the only non-clean signal is the ignored entries.
      writeFileSync(join(wtPath, '.gitignore'), 'node_modules/\n.env.local\n')
      git(wtPath, ['add', '.gitignore'])
      git(wtPath, ['commit', '-m', 'add gitignore'])
      mkdirSync(join(wtPath, 'node_modules'), { recursive: true })
      writeFileSync(join(wtPath, 'node_modules', '.env.local'), 'PRECIOUS local-only secret')
      writeFileSync(join(wtPath, '.env.local'), 'TOKEN=secret')
    }
    if (lockReason) git(repo, ['worktree', 'lock', '--reason', lockReason, wtPath])
    return wtPath
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'chroxy-wtgc-'))
    git(repo, ['init', '--initial-branch=main', '.'])
    disableRepoAutoGc(repo) // #6075: stop background gc racing the teardown rmSync
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'init'])
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
  })

  afterEach(() => {
    rmSync(repo, RM_RETRY)
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

  it('#5244: never removes a worktree whose only content is gitignored (plans skip)', () => {
    addWorktree('ignored-dead', { lockReason: `claude agent a5 (pid ${DEAD_PID})`, ignored: true })
    const plan = planRepoGc(repo, { kill: fakeKill })
    const item = plan.items.find((i) => basename(i.path) === 'ignored-dead')
    assert.ok(item, 'expected a plan item for the ignored-dead worktree')
    // Tracked status is clean, but the gitignored node_modules/.env must keep it skipped.
    assert.equal(item.action, 'skip')
    assert.match(item.skipReason, /gitignored|ignored|untracked/)
  })

  it('#5244: apply preserves an ignored-only worktree and its gitignored files', () => {
    const ignoredDead = addWorktree('ignored-dead', { lockReason: `claude agent a5 (pid ${DEAD_PID})`, ignored: true })
    const plan = planRepoGc(repo, { kill: fakeKill })
    // Apply the FULL plan (mirrors the reaper): a regression would mark this
    // 'remove' and applyPlan would delete the dir + the precious secret.
    const reclaimable = plan.items.filter((i) => i.action !== 'skip')
    applyPlan(repo, { items: reclaimable })
    assert.equal(existsSync(ignoredDead), true)
    assert.equal(existsSync(join(ignoredDead, 'node_modules', '.env.local')), true)
    assert.equal(existsSync(join(ignoredDead, '.env.local')), true)
  })

  // #5706: absolute-age fallback — a "live" pid whose worktree has been
  // untouched longer than maxLockAgeMs is treated as a recycled pid.
  describe('#5706 recycled-pid age fallback', () => {
    // Deterministic age: now - mtimeMs(path). With now=1e6 and mtimeMs=0 the age
    // is 1e6ms; maxLockAgeMs=1000 makes any such worktree "stale".
    const STALE = { kill: fakeKill, now: () => 1_000_000, mtimeMs: () => 0, maxLockAgeMs: 1000 }

    it('reclaims a CLEAN worktree whose live pid is stale (recycled)', () => {
      addWorktree('live-stale', { lockReason: `claude agent a1 (pid ${LIVE_PID})` })
      const item = planRepoGc(repo, STALE).items.find((i) => i.path.endsWith('/live-stale'))
      assert.equal(item.action, 'remove')
      assert.match(item.reason, /recycled pid/)
    })

    it('still SKIPS a live pid whose worktree is recently touched (age within threshold)', () => {
      addWorktree('live-fresh', { lockReason: `claude agent a2 (pid ${LIVE_PID})` })
      const item = planRepoGc(repo, { kill: fakeKill, now: () => 1_000_000, mtimeMs: () => 999_500, maxLockAgeMs: 1000 })
        .items.find((i) => i.path.endsWith('/live-fresh'))
      assert.equal(item.action, 'skip')
      assert.match(item.skipReason, /live process/)
    })

    it('NEVER reclaims a DIRTY worktree even when the live pid is stale (clean-tree guard wins)', () => {
      addWorktree('live-stale-dirty', { lockReason: `claude agent a3 (pid ${LIVE_PID})`, dirty: true })
      const item = planRepoGc(repo, STALE).items.find((i) => i.path.endsWith('/live-stale-dirty'))
      assert.equal(item.action, 'skip')
      assert.match(item.skipReason, /uncommitted/)
    })

    it('maxLockAgeMs=0 disables the fallback — a stale live pid is still skipped', () => {
      addWorktree('live-stale-disabled', { lockReason: `claude agent a4 (pid ${LIVE_PID})` })
      const item = planRepoGc(repo, { kill: fakeKill, now: () => 1_000_000, mtimeMs: () => 0, maxLockAgeMs: 0 })
        .items.find((i) => i.path.endsWith('/live-stale-disabled'))
      assert.equal(item.action, 'skip')
      assert.match(item.skipReason, /live process/)
    })
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

  // #5246: a transient stat failure can misclassify a PRESENT worktree as
  // dir-gone → 'prune'. `git worktree prune` leaves it intact, so applyPlan
  // must NOT report ok:true for it. Verified by re-listing worktrees after the
  // prune and checking the entry is genuinely gone.
  it('reports a prune item as not-ok when the worktree is still present after prune (#5246)', () => {
    const git = (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        // The "reclaimed" path is STILL listed → prune reclaimed nothing.
        return 'worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /repo/wt/present\nHEAD b\nbranch refs/heads/x\n'
      }
      return '' // prune succeeds
    }
    const results = applyPlan('/repo', {
      items: [{ path: '/repo/wt/present', action: 'prune', locked: false }],
    }, { git })
    assert.equal(results[0].ok, false)
    assert.match(results[0].error, /still present after prune/)
  })

  it('reports prune ok when the worktree is genuinely gone after prune (#5246)', () => {
    const git = (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        // Only the main worktree remains — the pruned entry is gone.
        return 'worktree /repo\nHEAD a\nbranch refs/heads/main\n'
      }
      return ''
    }
    const results = applyPlan('/repo', {
      items: [{ path: '/repo/wt/gone', action: 'prune', locked: false }],
    }, { git })
    assert.equal(results[0].ok, true)
  })

  it('falls back to ok (best-effort) when the post-prune re-list fails (#5246)', () => {
    const git = (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        const e = new Error('fatal: re-list failed'); e.code = 1; throw e
      }
      return '' // prune succeeds
    }
    const results = applyPlan('/repo', {
      items: [{ path: '/repo/wt/gone', action: 'prune', locked: false }],
    }, { git })
    // Can't verify, but prune succeeded — don't manufacture a failure.
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
    disableRepoAutoGc(repo) // #6075: stop background gc racing the teardown rmSync
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

  afterEach(() => rmSync(repo, RM_RETRY))

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
    disableRepoAutoGc(repo) // #6075: stop background gc racing the teardown rmSync
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'init'])
    cleanDead = join(repo, '.claude', 'worktrees', 'clean-dead')
    git(repo, ['worktree', 'add', '--detach', cleanDead, 'HEAD'])
    git(repo, ['worktree', 'lock', '--reason', `claude agent a1 (pid ${DEAD_PID})`, cleanDead])
  })

  afterEach(() => rmSync(root, RM_RETRY))

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

  it('#5706: threads config.worktreeGc.maxLockAgeMs into the plan deps (manual gc honors it)', async () => {
    const { collectWorktreeGc } = await import('../src/cli/worktree-gc-cmd.js')
    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({ controlRoomRoot: root, worktreeGc: { maxLockAgeMs: 5000 } }))

    let captured = null
    const planSpy = (_p, deps) => { captured = deps; return { items: [] } }
    collectWorktreeGc({}, { configPath, withSizes: false, plan: planSpy, planDeps: {} })
    assert.equal(captured.maxLockAgeMs, 5000)

    // Test seam (deps.planDeps) overrides config.
    collectWorktreeGc({}, { configPath, withSizes: false, plan: planSpy, planDeps: { maxLockAgeMs: 12345 } })
    assert.equal(captured.maxLockAgeMs, 12345)
  })
})

// #5859 (audit P1-7): boot-time sweep of orphaned chroxy session worktrees
// (~/.chroxy/worktrees/<id>, --detach, unlocked). Real git repo + a separate
// worktree base, since these are NOT the .claude/worktrees/agent-* the reaper handles.
describe('sweepOrphanChroxyWorktrees (real git repo)', () => {
  let repo, base

  function addChroxyWorktree(id, { dirty, ignoredOnly } = {}) {
    const wtPath = join(base, id)
    git(repo, ['worktree', 'add', '--detach', wtPath, 'HEAD'])
    if (dirty) writeFileSync(join(wtPath, 'scratch.txt'), 'uncommitted work')
    if (ignoredOnly) {
      writeFileSync(join(wtPath, '.gitignore'), '.env.local\n')
      git(wtPath, ['add', '.gitignore'])
      git(wtPath, ['commit', '-m', 'add gitignore'])
      writeFileSync(join(wtPath, '.env.local'), 'TOKEN=secret') // clean to porcelain, NOT to --ignored
    }
    return wtPath
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'chroxy-cwt-repo-'))
    git(repo, ['init', '--initial-branch=main', '.'])
    disableRepoAutoGc(repo) // #6075: stop background gc racing the teardown rmSync
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'init'])
    base = mkdtempSync(join(tmpdir(), 'chroxy-cwt-base-'))
  })

  afterEach(() => {
    rmSync(repo, RM_RETRY)
    rmSync(base, { recursive: true, force: true })
  })

  it('removes a clean orphan, keeps a live session, skips dirty + ignored-only', () => {
    const orphan = addChroxyWorktree('0000000000000000000000000000aaaa')
    const live = addChroxyWorktree('0000000000000000000000000000bbbb')
    const dirty = addChroxyWorktree('0000000000000000000000000000cccc', { dirty: true })
    const ignored = addChroxyWorktree('0000000000000000000000000000dddd', { ignoredOnly: true })

    const report = sweepOrphanChroxyWorktrees({
      worktreeBase: base,
      liveSessionIds: new Set(['0000000000000000000000000000bbbb']),
    })

    assert.equal(report.removed.map((p) => basename(p)).includes('0000000000000000000000000000aaaa'), true, 'clean orphan removed')
    assert.equal(existsSync(orphan), false, 'clean orphan dir gone')
    assert.equal(existsSync(live), true, 'live session worktree untouched')
    assert.equal(existsSync(dirty), true, 'dirty orphan preserved')
    assert.equal(existsSync(ignored), true, 'ignored-only orphan preserved (--ignored guard)')
    assert.equal(report.skippedDirty.length, 2, 'dirty + ignored-only both skipped as not-clean')
  })

  it('is a no-op when the base does not exist', () => {
    const report = sweepOrphanChroxyWorktrees({ worktreeBase: join(base, 'nonexistent'), liveSessionIds: new Set() })
    assert.deepEqual(report, { removed: [], skippedDirty: [], skippedError: [], scanned: 0 })
  })

  it('never sweeps a dir whose name is not a 32-hex session id (user-placed dir)', () => {
    // A clean worktree that WOULD be a removal candidate but for its non-hex name.
    const userDir = addChroxyWorktree('not-a-chroxy-session-id')
    addChroxyWorktree('0000000000000000000000000000aaaa')

    const report = sweepOrphanChroxyWorktrees({ worktreeBase: base, liveSessionIds: new Set() })

    assert.equal(existsSync(userDir), true, 'non-hex-named dir never touched')
    assert.equal(report.removed.map((p) => basename(p)).includes('not-a-chroxy-session-id'), false, 'non-hex dir not removed')
    assert.equal(report.scanned, 1, 'only the hex-named orphan was scanned (non-hex dir filtered before scan)')
    assert.equal(report.removed.map((p) => basename(p)).includes('0000000000000000000000000000aaaa'), true, 'hex orphan still removed')
  })

  it('skips a dir whose .git cannot be resolved to a repo (no removal)', () => {
    const bogus = join(base, '0000000000000000000000000000beef')
    mkdirSync(bogus, { recursive: true })
    writeFileSync(join(bogus, '.git'), 'gitdir: /nowhere/bogus\n') // status will fail → status-unknown
    const report = sweepOrphanChroxyWorktrees({ worktreeBase: base, liveSessionIds: new Set() })
    assert.equal(existsSync(bogus), true, 'unresolvable orphan left in place')
    assert.equal(report.removed.length, 0)
    assert.equal(report.skippedDirty.length + report.skippedError.length, 1)
  })
})
