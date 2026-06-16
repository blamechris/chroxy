import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  deriveProject,
  deriveProjectFromCwd,
  classifyNonProjectCwd,
  worktreeParent,
  chroxyWorktreeRepoPath,
  _worktreeMarkerIndex,
  _pathWithinPrefix,
} from '../src/project.ts'

/**
 * Direct tests for the shared derivation module (audit P2-2, #5850). The hook
 * and server consumers also cover it transitively, but this pins the behavior
 * at the single source of truth — especially the cross-platform path handling
 * and the env-override reconciliation that merges both former copies.
 */

// A normal git repo: <base>/<name>/.git (directory).
function gitRepoFixture(name = 'myproject') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'proj-')))
  const repo = join(base, name)
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  return { base, repo, deep: join(repo, 'src', 'deep') }
}

// A chroxy session worktree: <root>/<id> with a `.git` FILE pointing at the
// real repo's <repo>/.git/worktrees/<id>.
function chroxyWorktreeFixture(repoName = 'coolproj') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')))
  const root = join(home, '.chroxy', 'worktrees')
  const id = 'cafebabecafebabecafebabecafebabe'
  const wt = join(root, id)
  mkdirSync(wt, { recursive: true })
  const repoRoot = join(home, 'projects', repoName)
  mkdirSync(join(repoRoot, '.git', 'worktrees', id), { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(repoRoot, '.git', 'worktrees', id)}\n`)
  return { home, root, id, wt, repoName }
}

describe('chroxyWorktreeRepoPath (shared .git parser, #5869)', () => {
  it('recovers the owning repo PATH from a worktree .git file', () => {
    const { home, wt, repoName } = chroxyWorktreeFixture()
    assert.equal(chroxyWorktreeRepoPath(wt), join(home, 'projects', repoName))
  })

  it('returns null when the .git file is absent', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'norepo-')))
    assert.equal(chroxyWorktreeRepoPath(dir), null)
  })

  it('returns null when the gitdir pointer is the wrong shape (tamper guard)', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'bad-')))
    const wt = join(home, '.chroxy', 'worktrees', 'cafebabecafebabecafebabecafebabe')
    mkdirSync(wt, { recursive: true })
    // Not `<repo>/.git/worktrees/<id>` — points straight at an arbitrary dir.
    writeFileSync(join(wt, '.git'), `gitdir: ${join(home, 'evil')}\n`)
    assert.equal(chroxyWorktreeRepoPath(wt), null)
  })

  it('the parent-project name is the basename of the recovered repo path', () => {
    const { wt, repoName } = chroxyWorktreeFixture()
    // chroxyWorktreeParentProject (used by deriveProjectFromCwd) derives the
    // project name as basename(chroxyWorktreeRepoPath(...)).
    assert.equal(basename(chroxyWorktreeRepoPath(wt)), repoName)
  })
})

describe('deriveProjectFromCwd (server surface)', () => {
  it('walks up to the nearest .git and returns its basename', () => {
    const { repo, deep } = gitRepoFixture('walkproj')
    assert.equal(deriveProjectFromCwd(deep), 'walkproj')
    assert.equal(deriveProjectFromCwd(repo), 'walkproj')
  })

  it('falls back to basename when no .git is found', () => {
    assert.equal(deriveProjectFromCwd('/nonexistent/zzz/abc'), 'abc')
  })

  it('returns null for unusable input', () => {
    assert.equal(deriveProjectFromCwd(''), null)
    assert.equal(deriveProjectFromCwd(null), null)
    assert.equal(deriveProjectFromCwd(42), null)
  })

  it('recovers the parent repo for a chroxy session worktree, never the opaque id', () => {
    const { root, id, wt, repoName } = chroxyWorktreeFixture()
    const env = { CHROXY_WORKTREES_ROOT: root }
    assert.equal(deriveProjectFromCwd(wt, env), repoName)
    assert.notEqual(deriveProjectFromCwd(wt, env), id)
  })

  it('returns null (not the opaque id) when the worktree .git parse fails', () => {
    const { home, root, id } = chroxyWorktreeFixture()
    const orphan = join(root, 'deadbeefdeadbeefdeadbeefdeadbeef')
    mkdirSync(orphan, { recursive: true }) // no .git file
    assert.equal(deriveProjectFromCwd(orphan, { CHROXY_WORKTREES_ROOT: root }), null)
    assert.ok(home && id) // fixture sanity
  })
})

describe('deriveProject (hook surface)', () => {
  it('remaps an agent .claude/worktrees checkout to the parent project', () => {
    const { base, repo } = gitRepoFixture('parentproj')
    const agentWt = join(repo, '.claude', 'worktrees', 'agent-deadbeef', 'src')
    mkdirSync(agentWt, { recursive: true })
    assert.equal(deriveProject(agentWt), 'parentproj')
    assert.ok(base)
  })

  it('falls back to CLAUDE_PROJECT_DIR inside a chroxy worktree with an unrecoverable parent', () => {
    const { root } = chroxyWorktreeFixture()
    const orphan = join(root, 'feedfacefeedfacefeedfacefeedface')
    mkdirSync(orphan, { recursive: true }) // no .git → parent unrecoverable
    const env = { CHROXY_WORKTREES_ROOT: root, CLAUDE_PROJECT_DIR: '/home/u/realproj' }
    assert.equal(deriveProject(orphan, env), 'realproj')
  })

  it('honors the hook-side env override name (CHROXY_HOOKS_CHROXY_WORKTREES_ROOT)', () => {
    const { root, wt, repoName } = chroxyWorktreeFixture()
    assert.equal(deriveProject(wt, { CHROXY_HOOKS_CHROXY_WORKTREES_ROOT: root }), repoName)
  })
})

describe('worktreeParent', () => {
  it('returns the parent project for a chroxy worktree', () => {
    const { root, wt, repoName } = chroxyWorktreeFixture()
    assert.equal(worktreeParent(wt, { CHROXY_WORKTREES_ROOT: root }), repoName)
  })

  it('falls back to the $HOME default when the override is a bare root or junk', () => {
    // Regression: a bare '/' override must collapse to '' and fall through to
    // the $HOME default, not resolve against cwd.
    const { home, wt, repoName } = chroxyWorktreeFixture()
    for (const bad of ['/', '   ', 'relative/junk']) {
      const env = { HOME: home, CHROXY_WORKTREES_ROOT: bad }
      assert.equal(worktreeParent(wt, env), repoName, `override ${JSON.stringify(bad)} → $HOME default`)
    }
  })

  it('returns null for a normal repo (not a worktree)', () => {
    const { deep } = gitRepoFixture()
    assert.equal(worktreeParent(deep), null)
  })
})

describe('classifyNonProjectCwd', () => {
  const noTmp = { CHROXY_HOOKS_TMP_PREFIXES: '/chroxy-nonexistent-tmp' }

  it("classifies a chroxy worktree as 'worktree' even when the parent is unrecoverable", () => {
    const { root, wt } = chroxyWorktreeFixture()
    assert.equal(classifyNonProjectCwd(wt, { ...noTmp, CHROXY_WORKTREES_ROOT: root }), 'worktree')
  })

  it("classifies the home root as 'home' and a project under it as null", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home2-')))
    const proj = join(home, 'work', 'app')
    mkdirSync(proj, { recursive: true })
    assert.equal(classifyNonProjectCwd(home, { ...noTmp, HOME: home }), 'home')
    assert.equal(classifyNonProjectCwd(proj, { ...noTmp, HOME: home }), null)
  })

  it("classifies a tmp-prefixed path as 'tmp'", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmpcls-')))
    assert.equal(classifyNonProjectCwd(dir, { CHROXY_HOOKS_TMP_PREFIXES: dir }), 'tmp')
    assert.equal(basename(dir).length > 0, true)
  })

  it('returns null for unusable input', () => {
    assert.equal(classifyNonProjectCwd(''), null)
    assert.equal(classifyNonProjectCwd(null), null)
  })
})

/**
 * Cross-platform (#5886) — the public functions can't be driven with Windows
 * paths on a POSIX runner (resolve()/realpathSync are platform-coupled), so the
 * separator-agnostic STRING helpers are unit-tested directly with both `/` and
 * `\` forms. POSIX behavior is pinned to be identical to the old `/`-literal logic.
 */
describe('_worktreeMarkerIndex (separator-agnostic worktree marker)', () => {
  it('finds the marker in a POSIX path at the same index as the old literal', () => {
    const dir = '/home/proj/.claude/worktrees/agent-1/src'
    const idx = _worktreeMarkerIndex(dir)
    assert.equal(idx, dir.indexOf('/.claude/worktrees/'))
    assert.equal(basename(dir.slice(0, idx)), 'proj')
  })

  it('finds the marker in a Windows (backslash) path', () => {
    const dir = 'C:\\Users\\me\\proj\\.claude\\worktrees\\agent-1\\src'
    const idx = _worktreeMarkerIndex(dir)
    assert.ok(idx > 0)
    assert.equal(dir.slice(0, idx), 'C:\\Users\\me\\proj')
  })

  it('returns -1 when no marker is present (either separator)', () => {
    assert.equal(_worktreeMarkerIndex('/home/proj/src'), -1)
    assert.equal(_worktreeMarkerIndex('C:\\Users\\me\\proj\\src'), -1)
  })

  it('returns 0 for a marker at the very start (guarded by idx <= 0 in callers)', () => {
    assert.equal(_worktreeMarkerIndex('/.claude/worktrees/x'), 0)
  })
})

describe('_pathWithinPrefix (separator-agnostic tmp-prefix containment)', () => {
  it('matches a nested path and the prefix itself (POSIX)', () => {
    assert.equal(_pathWithinPrefix('/tmp', '/tmp/sess'), true)
    assert.equal(_pathWithinPrefix('/tmp', '/tmp'), true)
  })

  it('does not match a sibling that merely shares the prefix string (POSIX)', () => {
    assert.equal(_pathWithinPrefix('/tmp', '/tmpfoo'), false)
  })

  it('matches a nested path and the prefix itself (Windows backslash)', () => {
    assert.equal(_pathWithinPrefix('C:\\Users\\me\\Temp', 'C:\\Users\\me\\Temp\\sess'), true)
    assert.equal(_pathWithinPrefix('C:\\Users\\me\\Temp', 'C:\\Users\\me\\Temp'), true)
  })

  it('does not match a Windows sibling sharing the prefix string', () => {
    assert.equal(_pathWithinPrefix('C:\\Temp', 'C:\\Tempfoo'), false)
  })

  it('tolerates a trailing separator on the prefix (both platforms)', () => {
    assert.equal(_pathWithinPrefix('/tmp/', '/tmp/x'), true)
    assert.equal(_pathWithinPrefix('C:\\Temp\\', 'C:\\Temp\\x'), true)
  })
})
