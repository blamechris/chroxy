import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  canonicalProjectForCwd,
  deriveProject,
  deriveProjectFromCwd,
  classifyNonProjectCwd,
  worktreeParent,
} from '../src/project.ts'

// Fixtures live under the OS temp dir; point the tmp classification at a path
// that does not exist so they classify by the real rules (same trick as project.test.js).
const NO_TMP = { CHROXY_HOOKS_TMP_PREFIXES: '/nonexistent-tmp-prefix' }

function base() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'canon-')))
}
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' })
}
function realRepo(name = 'myrepo') {
  const b = base()
  const repo = join(b, name)
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'f'), 'x')
  git(repo, 'add', 'f')
  git(repo, 'commit', '-q', '-m', 'init')
  return { b, repo }
}

describe('canonicalProjectForCwd', () => {
  it('plain repo: label is repo basename, root is the repo', () => {
    const { repo } = realRepo('plainproj')
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    assert.deepEqual(canonicalProjectForCwd(join(repo, 'src', 'deep'), NO_TMP), { label: 'plainproj', root: repo })
  })

  it('.claude/worktrees linked worktree resolves to the MAIN repo', () => {
    const { repo } = realRepo('mainrepo')
    const wt = join(repo, '.claude', 'worktrees', 'agent-1')
    git(repo, 'worktree', 'add', '-q', '--detach', wt)
    assert.deepEqual(canonicalProjectForCwd(wt, NO_TMP), { label: 'mainrepo', root: repo })
  })

  it('linked worktree elsewhere resolves to the main repo name, not the folder name', () => {
    const { repo } = realRepo('mainrepo2')
    const wt = join(base(), 'totally-different-folder')
    git(repo, 'worktree', 'add', '-q', '--detach', wt)
    const got = canonicalProjectForCwd(wt, NO_TMP)
    assert.deepEqual(got, { label: 'mainrepo2', root: repo })
    assert.notEqual(got.label, basename(wt))
  })

  it('chroxy session worktree resolves to its parent repo', () => {
    const { repo } = realRepo('chroxyparent')
    const home = base()
    const root = join(home, 'worktrees')
    const wt = join(root, 'cafebabecafebabecafebabecafebabe')
    mkdirSync(root, { recursive: true })
    git(repo, 'worktree', 'add', '-q', '--detach', wt)
    const env = { ...NO_TMP, CHROXY_WORKTREES_ROOT: root }
    assert.deepEqual(canonicalProjectForCwd(wt, env), { label: 'chroxyparent', root: repo })
    // a chroxy worktree whose parent cannot be recovered is null, never the opaque id
    const bad = join(root, 'deadbeefdeadbeefdeadbeefdeadbeef')
    mkdirSync(bad)
    writeFileSync(join(bad, '.git'), 'gitdir: /somewhere/else\n')
    assert.equal(canonicalProjectForCwd(bad, env), null)
  })

  it('submodule-style .git file without commondir: its own dir is the root', () => {
    const b = base()
    const sub = join(b, 'super', 'subproj')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(b, 'super', '.git', 'modules', 'subproj'), { recursive: true })
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/subproj\n')
    assert.deepEqual(canonicalProjectForCwd(sub, NO_TMP), { label: 'subproj', root: sub })
  })

  it('bare common dir (worktree of a bare repo) is null', () => {
    const b = base()
    const bare = join(b, 'repo.git')
    mkdirSync(join(bare, 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(bare, 'worktrees', 'w', 'commondir'), '../..\n')
    const wt = join(b, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${join(bare, 'worktrees', 'w')}\n`)
    assert.equal(canonicalProjectForCwd(wt, NO_TMP), null)
  })

  it('relative gitdir + relative commondir resolve against the right bases', () => {
    const b = base()
    const main = join(b, 'relmain')
    mkdirSync(join(main, '.git', 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
    const wt = join(b, 'elsewhere')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), 'gitdir: ../relmain/.git/worktrees/w\n')
    assert.deepEqual(canonicalProjectForCwd(wt, NO_TMP), { label: 'relmain', root: main })
  })

  it('malformed / oversized / unreadable .git file is null', () => {
    const b = base()
    const mk = (name, content) => {
      const d = join(b, name)
      mkdirSync(d)
      writeFileSync(join(d, '.git'), content)
      return d
    }
    assert.equal(canonicalProjectForCwd(mk('junk', 'not a pointer\n'), NO_TMP), null)
    assert.equal(canonicalProjectForCwd(mk('big', 'gitdir: ' + 'a'.repeat(5000) + '\n'), NO_TMP), null)
    // oversized commondir
    const main = join(b, 'bigmain')
    mkdirSync(join(main, '.git', 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..'.padEnd(5000, '/'))
    assert.equal(canonicalProjectForCwd(mk('bigcd', `gitdir: ${join(main, '.git', 'worktrees', 'w')}\n`), NO_TMP), null)
    // empty commondir
    const m2 = join(b, 'm2')
    mkdirSync(join(m2, '.git', 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(m2, '.git', 'worktrees', 'w', 'commondir'), '   \n')
    assert.equal(canonicalProjectForCwd(mk('emptycd', `gitdir: ${join(m2, '.git', 'worktrees', 'w')}\n`), NO_TMP), null)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const d = mk('unread', 'gitdir: /x\n')
      chmodSync(join(d, '.git'), 0)
      assert.equal(canonicalProjectForCwd(d, NO_TMP), null)
    }
  })

  it('git repo under a tmp prefix is still a project (git check comes first)', () => {
    const b = base()
    const repo = join(b, 'tmprepo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const env = { CHROXY_HOOKS_TMP_PREFIXES: b }
    assert.equal(classifyNonProjectCwd(repo, env), 'tmp')
    assert.deepEqual(canonicalProjectForCwd(repo, env), { label: 'tmprepo', root: repo })
  })

  it('non-git tmp dir is null; non-git normal dir is its basename', () => {
    const b = base()
    const plain = join(b, 'plain-dir')
    mkdirSync(plain)
    assert.equal(canonicalProjectForCwd(plain, { CHROXY_HOOKS_TMP_PREFIXES: b }), null)
    assert.deepEqual(canonicalProjectForCwd(plain, NO_TMP), { label: 'plain-dir', root: plain })
  })

  it('home root itself is null', () => {
    const b = base()
    assert.equal(canonicalProjectForCwd(b, { ...NO_TMP, HOME: b }), null)
  })

  it('unusable input is null', () => {
    assert.equal(canonicalProjectForCwd('', NO_TMP), null)
    assert.equal(canonicalProjectForCwd(undefined, NO_TMP), null)
  })
})

describe('characterization: existing derivations are unchanged', () => {
  it('worktree fixtures keep their historical outputs', () => {
    const { repo } = realRepo('charrepo')
    const agent = join(repo, '.claude', 'worktrees', 'agent-x')
    git(repo, 'worktree', 'add', '-q', '--detach', agent)
    const elsewhere = join(base(), 'oddname')
    git(repo, 'worktree', 'add', '-q', '--detach', elsewhere)
    const root = join(base(), 'wts')
    const cw = join(root, 'cafebabecafebabecafebabecafebabe')
    mkdirSync(root, { recursive: true })
    git(repo, 'worktree', 'add', '-q', '--detach', cw)
    const env = { ...NO_TMP, CHROXY_WORKTREES_ROOT: root }
    // agent worktree
    assert.equal(worktreeParent(agent, env), 'charrepo')
    assert.equal(deriveProject(agent, env), 'charrepo')
    assert.equal(deriveProjectFromCwd(agent, env), basename(agent)) // .git file wins the walk (historical)
    assert.equal(classifyNonProjectCwd(agent, env), 'worktree')
    // linked worktree elsewhere: historically named after the folder
    assert.equal(worktreeParent(elsewhere, env), null)
    assert.equal(deriveProject(elsewhere, env), 'oddname')
    assert.equal(deriveProjectFromCwd(elsewhere, env), 'oddname')
    assert.equal(classifyNonProjectCwd(elsewhere, env), null)
    // chroxy worktree
    assert.equal(worktreeParent(cw, env), 'charrepo')
    assert.equal(deriveProject(cw, env), 'charrepo')
    assert.equal(deriveProjectFromCwd(cw, env), 'charrepo')
    assert.equal(classifyNonProjectCwd(cw, env), 'worktree')
    // plain repo
    assert.equal(deriveProjectFromCwd(repo, env), 'charrepo')
    assert.equal(deriveProject(repo, env), 'charrepo')
    assert.equal(worktreeParent(repo, env), null)
  })
})
