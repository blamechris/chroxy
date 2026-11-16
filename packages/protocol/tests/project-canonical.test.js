import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, chmodSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  canonicalProjectForCwd,
  _parseCoreConfig,
  deriveProject,
  deriveProjectFromCwd,
  classifyNonProjectCwd,
  worktreeParent,
} from '../src/project.ts'

const SRC_URL = new URL('../src/project.ts', import.meta.url).href

/**
 * canonicalProjectForCwd in a child with a hard timeout: a regression that blocks
 * on a FIFO is a red assertion here, not a hung test runner.
 */
function inChild(cwd, env = NO_TMP, extraEnv = {}) {
  const script = `import { canonicalProjectForCwd } from ${JSON.stringify(SRC_URL)}
process.stdout.write(JSON.stringify(canonicalProjectForCwd(${JSON.stringify(cwd)}, ${JSON.stringify(env)})))`
  const r = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
    timeout: 8000, encoding: 'utf8', env: { ...process.env, ...extraEnv },
  })
  assert.equal(r.error?.code, undefined, 'child blocked or crashed: ' + (r.error?.message ?? r.stderr))
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
function mkfifo(path) {
  execFileSync('mkfifo', [path])
}
/** A minimal valid git dir (directory + regular HEAD) with the given config text. */
function fakeGitDir(path, config) {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'HEAD'), 'ref: refs/heads/main\n')
  if (config !== undefined) writeFileSync(join(path, 'config'), config)
}

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
    fakeGitDir(join(b, 'super', '.git', 'modules', 'subproj'), '[core]\n\tworktree = ../../../subproj\n')
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/subproj\n')
    assert.deepEqual(canonicalProjectForCwd(sub, NO_TMP), { label: 'subproj', root: sub })
  })

  it('bare repo: a linked worktree of a bare repo (any name) is null', () => {
    const b = base()
    for (const name of ['repo.git', '.git']) {
      const bare = join(b, name === '.git' ? 'dotgit' : name, name)
      fakeGitDir(bare, '[core]\n\tbare = true\n')
      fakeGitDir(join(bare, 'worktrees', 'w'))
      writeFileSync(join(bare, 'worktrees', 'w', 'commondir'), '../..\n')
      const wt = join(b, `wt-${name}`)
      mkdirSync(wt)
      writeFileSync(join(wt, '.git'), `gitdir: ${join(bare, 'worktrees', 'w')}\n`)
      assert.equal(canonicalProjectForCwd(wt, NO_TMP), null, name)
    }
  })

  it('real bare repo in a directory named .git, with a real linked worktree, is null', () => {
    const b = base()
    const bare = join(b, 'holder', '.git')
    mkdirSync(join(b, 'holder'))
    git(b, 'init', '-q', '--bare', '-b', 'main', bare)
    git(bare, 'worktree', 'add', '-q', '--orphan', '-b', 'o', join(b, 'wt')) // git >= 2.42
    assert.equal(canonicalProjectForCwd(join(b, 'wt'), NO_TMP), null)
  })

  it('relative gitdir + relative commondir resolve against the right bases', () => {
    const b = base()
    const main = join(b, 'relmain')
    fakeGitDir(join(main, '.git'))
    fakeGitDir(join(main, '.git', 'worktrees', 'w'))
    writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
    const wt = join(b, 'elsewhere')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), 'gitdir: ../relmain/.git/worktrees/w\n')
    assert.deepEqual(canonicalProjectForCwd(wt, NO_TMP), { label: 'relmain', root: main })
  })

  it('core.worktree in the common dir config decides the root', () => {
    const b = base()
    const real = join(b, 'actual-tree')
    mkdirSync(real)
    const common = join(b, 'store.git')
    fakeGitDir(common, '[core]\n\tbare = false\n\tworktree = ../actual-tree\n')
    fakeGitDir(join(common, 'worktrees', 'w'))
    writeFileSync(join(common, 'worktrees', 'w', 'commondir'), '../..\n')
    const wt = join(b, 'lw')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${join(common, 'worktrees', 'w')}\n`)
    assert.deepEqual(canonicalProjectForCwd(wt, NO_TMP), { label: 'actual-tree', root: real })
  })

  it('git init --separate-git-dir: the working tree and a linked worktree of it', () => {
    const b = base()
    const work = join(b, 'sepwork')
    const sep = join(b, 'sepstore.git')
    git(b, 'init', '-q', '-b', 'main', '--separate-git-dir', sep, work)
    writeFileSync(join(work, 'f'), 'x')
    git(work, 'add', 'f')
    git(work, 'commit', '-q', '-m', 'i')
    const lw = join(b, 'sep-linked')
    git(work, 'worktree', 'add', '-q', '--detach', lw)
    // git records the main working tree nowhere readable, so the main checkout and its linked
    // worktrees must AGREE: the git dir, with `.git` stripped from the label
    const fromMain = canonicalProjectForCwd(work, NO_TMP)
    assert.deepEqual(fromMain, { label: 'sepstore', root: sep })
    assert.deepEqual(canonicalProjectForCwd(lw, NO_TMP), fromMain)
  })

  it('submodule and a linked worktree of the submodule resolve to the submodule', () => {
    const { repo: sup } = realRepo('superproj')
    const { repo: lib } = realRepo('libproj')
    execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', sup, 'submodule', 'add', '-q', lib, 'sub'], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 'a@b.c' } })
    const sub = join(sup, 'sub')
    assert.deepEqual(canonicalProjectForCwd(sub, NO_TMP), { label: 'sub', root: sub })
    const lw = join(base(), 'sublinked')
    git(sub, 'worktree', 'add', '-q', '--detach', lw)
    assert.deepEqual(canonicalProjectForCwd(lw, NO_TMP), { label: 'sub', root: sub })
  })

  it('a broken gitdir pointer is null (never a "normal" layout)', () => {
    const b = base()
    const d = join(b, 'dangling')
    mkdirSync(d)
    writeFileSync(join(d, '.git'), 'gitdir: /nonexistent/place\n')
    assert.equal(canonicalProjectForCwd(d, NO_TMP), null)
    const noHead = join(b, 'nohead')
    mkdirSync(join(b, 'gd'))
    mkdirSync(noHead)
    writeFileSync(join(noHead, '.git'), `gitdir: ${join(b, 'gd')}\n`)
    assert.equal(canonicalProjectForCwd(noHead, NO_TMP), null)
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
    const main = join(b, 'bigmain')
    fakeGitDir(join(main, '.git'))
    fakeGitDir(join(main, '.git', 'worktrees', 'w'))
    writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..'.padEnd(5000, '/'))
    assert.equal(canonicalProjectForCwd(mk('bigcd', `gitdir: ${join(main, '.git', 'worktrees', 'w')}\n`), NO_TMP), null)
    const m2 = join(b, 'm2')
    fakeGitDir(join(m2, '.git'))
    fakeGitDir(join(m2, '.git', 'worktrees', 'w'))
    writeFileSync(join(m2, '.git', 'worktrees', 'w', 'commondir'), '   \n')
    assert.equal(canonicalProjectForCwd(mk('emptycd', `gitdir: ${join(m2, '.git', 'worktrees', 'w')}\n`), NO_TMP), null)
    // oversized config
    const m3 = join(b, 'm3')
    fakeGitDir(join(m3, '.git'), '#'.repeat(1024 * 1024 + 16))
    fakeGitDir(join(m3, '.git', 'worktrees', 'w'))
    writeFileSync(join(m3, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
    assert.equal(canonicalProjectForCwd(mk('bigcfg', `gitdir: ${join(m3, '.git', 'worktrees', 'w')}\n`), NO_TMP), null)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const d = mk('unread', 'gitdir: /x\n')
      chmodSync(join(d, '.git'), 0)
      assert.equal(canonicalProjectForCwd(d, NO_TMP), null)
    }
  })

  it('a FIFO at .git, commondir, HEAD or config never blocks and is null', { skip: process.platform === 'win32' }, () => {
    const b = base()
    const fifoGit = join(b, 'fifogit')
    mkdirSync(fifoGit)
    mkfifo(join(fifoGit, '.git'))
    assert.equal(inChild(fifoGit), null)

    const mkWorktree = (name, tweak) => {
      const main = join(b, `${name}-main`)
      fakeGitDir(join(main, '.git'), '[core]\n')
      const gd = join(main, '.git', 'worktrees', 'w')
      fakeGitDir(gd)
      writeFileSync(join(gd, 'commondir'), '../..\n')
      tweak(main, gd)
      const wt = join(b, `${name}-wt`)
      mkdirSync(wt)
      writeFileSync(join(wt, '.git'), `gitdir: ${gd}\n`)
      return wt
    }
    assert.equal(inChild(mkWorktree('fcd', (m, gd) => { rmSync(join(gd, 'commondir')); mkfifo(join(gd, 'commondir')) })), null)
    assert.equal(inChild(mkWorktree('fcfg', (m) => { rmSync(join(m, '.git', 'config')); mkfifo(join(m, '.git', 'config')) })), null)
    assert.equal(inChild(mkWorktree('fhead', (m, gd) => { rmSync(join(gd, 'HEAD')); mkfifo(join(gd, 'HEAD')) })), null)
    const fifoPointer = join(b, 'fifoptr')
    mkdirSync(fifoPointer)
    mkfifo(join(b, 'fifoptr-target'))
    writeFileSync(join(fifoPointer, '.git'), `gitdir: ${join(b, 'fifoptr-target')}\n`)
    assert.equal(inChild(fifoPointer), null)
  })

  it('git repo under a tmp prefix is still a project (git check comes first)', () => {
    const b = base()
    const repo = join(b, 'tmprepo')
    fakeGitDir(join(repo, '.git'))
    const env = { CHROXY_HOOKS_TMP_PREFIXES: b }
    assert.equal(classifyNonProjectCwd(repo, env), 'tmp')
    assert.deepEqual(canonicalProjectForCwd(repo, env), { label: 'tmprepo', root: repo })
    assert.deepEqual(canonicalProjectForCwd(repo, NO_TMP), { label: 'tmprepo', root: repo }, 'also under os.tmpdir()')
  })

  it('non-git tmp dir is null; non-git normal dir is its basename', () => {
    const b = base()
    const plain = join(b, 'plain-dir')
    mkdirSync(plain)
    assert.equal(canonicalProjectForCwd(plain, { CHROXY_HOOKS_TMP_PREFIXES: b }), null)
    // not under the (overridden) OS temp dir: a normal directory, named by basename
    const saved = process.env.TMPDIR
    process.env.TMPDIR = '/nonexistent-os-tmpdir'
    try {
      assert.deepEqual(canonicalProjectForCwd(plain, NO_TMP), { label: 'plain-dir', root: plain })
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    }
    // ...and under the real realpath(os.tmpdir()) a non-git dir is scratch space
    assert.equal(canonicalProjectForCwd(plain, NO_TMP), null)
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


describe('managed (chroxy) worktrees use the bounded resolver', () => {
  function managed() {
    const b = base()
    const root = join(b, 'worktrees')
    mkdirSync(root, { recursive: true })
    const env = { ...NO_TMP, CHROXY_WORKTREES_ROOT: root }
    return { b, root, env }
  }
  const wtDir = (root, id) => {
    const d = join(root, id)
    mkdirSync(d)
    return d
  }

  it('a real managed worktree still resolves to its parent repo', () => {
    const { repo } = realRepo('mgdparent')
    const { root, env } = managed()
    const wt = join(root, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    git(repo, 'worktree', 'add', '-q', '--detach', wt)
    assert.deepEqual(canonicalProjectForCwd(wt, env), { label: 'mgdparent', root: repo })
  })

  it('FIFO .git, oversized pointer, missing target and bare common dir are all null (and never block)', { skip: process.platform === 'win32' }, () => {
    const { b, root, env } = managed()
    const fifo = wtDir(root, 'f1')
    mkfifo(join(fifo, '.git'))
    assert.equal(inChild(fifo, env), null)
    const big = wtDir(root, 'f2')
    writeFileSync(join(big, '.git'), 'gitdir: ' + 'a'.repeat(5000) + '\n')
    assert.equal(inChild(big, env), null)
    const missing = wtDir(root, 'f3')
    writeFileSync(join(missing, '.git'), 'gitdir: /missing/repo/.git/worktrees/f3\n')
    assert.equal(inChild(missing, env), null)
    assert.equal(canonicalProjectForCwd(missing, env), null)
    const bare = join(b, 'bare.git')
    fakeGitDir(bare, '[core]\n\tbare = true\n')
    fakeGitDir(join(bare, 'worktrees', 'f4'))
    writeFileSync(join(bare, 'worktrees', 'f4', 'commondir'), '../..\n')
    const bw = wtDir(root, 'f4')
    writeFileSync(join(bw, '.git'), `gitdir: ${join(bare, 'worktrees', 'f4')}\n`)
    assert.equal(canonicalProjectForCwd(bw, env), null)
  })
})

describe('bare .git directory', () => {
  it('a plain .git directory whose own config says bare is null', () => {
    const b = base()
    const d = join(b, 'weird')
    fakeGitDir(join(d, '.git'), '[core]\n\tbare = true\n')
    assert.equal(canonicalProjectForCwd(d, NO_TMP), null)
    const ok = join(b, 'fine')
    fakeGitDir(join(ok, '.git'), '[core]\n\tbare = false\n')
    assert.deepEqual(canonicalProjectForCwd(ok, NO_TMP), { label: 'fine', root: ok })
  })
})

describe('config parser agrees with git (oracle)', () => {
  const CASES = [
    '[core]\n\tbare = true\n',
    '[core]\n\tbare = false\n',
    '[core]\n\tbare = 2\n',
    '[core]\n\tbare = 0\n',
    '[core]\n\tbare\n',
    '[core]\n\tbare =\n',
    '[core]\n\tbare = YES\n',
    '[core]\n\tbare = off\n',
    '[core]\n\tbare = true ; comment\n',
    '[core]\n\tbare = "true"\n',
    '[CORE]\n\tBARE = true\n',
    '[core "unrelated"]\n\tbare = true\n',
    '[core.unrelated]\n\tbare = true\n',
    '[core] bare = true\n',
    '[core]\n\tbare = true\n\tbare = false\n',
    '[core]\n\tworktree = ../actual\n',
    '[core]\n\tworktree = ../"actual tree"\n',
    '[core]\n\tworktree = "../actual\\t tree"\n',
    '[core]\n\tworktree = "../a\\"b"  # trailing\n',
    '[core]\n\tworktree = ../a \\\n\tb\n',
    '[core]\n\tworktree = ../a   b   \n',
    '[core]\n\tworktree = ../a\\\\b\n',
    '[core]\n\tbare = true\n[remote "origin"]\n\turl = x\n[core]\n\tworktree = ../w\n',
    '# note \\\n[core]\n\tbare = true\n',
    '[core]\n\t# note \\\n\tbare = true\n',
    '[core]\n\t; note \\\n\tworktree = ../w\n',
    '[core]\n\tworktree = a\\\\\n\tb\n',
    '[core]\n\tworktree = a\\\n\tb\n',
    '[core]\n\tworktree = "a\\\n b"\n',
    '[core]\n\tbare = tr\\\nue\n',
  ]
  const REFUSE = [
    '[include]\n\tpath = other\n[core]\n\tbare = false\n',
    '[includeIf "gitdir:~/x/"]\n\tpath = other\n',
    '[core]\n\tbare = maybe\n',
    '[core]\n\tworktree = "unterminated\n',
    '[core]\n\tworktree = ../a\\qb\n',
    '[core\n\tbare = true\n',
    '[ core]\n\tbare = true\n', // git: bad config line
    '[core ]\n\tbare = true\n', // git: bad config line
    '[core]\n\tworktree =\n', // git yields "": not the same as unset, so refuse
    '[core]\n\tworktree = ""\n',
  ]
  const oracle = (text, key, type) => {
    const f = join(base(), 'cfg')
    writeFileSync(f, text)
    try {
      const out = execFileSync('git', ['config', '--file', f, ...(type ? ['--type=bool'] : []), '--get', key], { stdio: 'pipe', encoding: 'utf8' })
      return out.replace(/\n$/, '')
    } catch (err) {
      return err.status === 1 ? null : 'ERROR'
    }
  }

  for (const text of CASES) {
    it(`matches git: ${JSON.stringify(text)}`, () => {
      const mine = _parseCoreConfig(text)
      const bare = oracle(text, 'core.bare', true)
      const wt = oracle(text, 'core.worktree', false)
      assert.notEqual(bare, 'ERROR', 'oracle accepts the fixture')
      assert.notEqual(wt, 'ERROR', 'oracle accepts the fixture')
      assert.ok(mine, 'parser accepts what git accepts')
      assert.equal(mine.bare, bare === 'true')
      assert.equal(mine.worktree, wt)
    })
  }
  for (const text of REFUSE) {
    it(`refuses: ${JSON.stringify(text)}`, () => {
      assert.equal(_parseCoreConfig(text), null)
    })
  }
})


describe('git config vs git: what git rejects we refuse', () => {
  for (const text of ['[ core]\n\tbare = true\n', '[core ]\n\tbare = true\n']) {
    it(`git itself rejects ${JSON.stringify(text)}`, () => {
      const f = join(base(), 'cfg')
      writeFileSync(f, text)
      assert.throws(() => execFileSync('git', ['config', '--file', f, '--get', 'core.bare'], { stdio: 'pipe' }))
    })
  }
})

describe('large configs and stray .git directories', () => {
  it('a config with hundreds of branch and remote entries is still read', () => {
    const b = base()
    const repo = join(b, 'bigcfg')
    let cfg = '[core]\n\tbare = false\n'
    for (let i = 0; i < 800; i++) cfg += `[remote "r${i}"]\n\turl = https://example.invalid/${i}.git\n\tfetch = +refs/heads/*:refs/remotes/r${i}/*\n[branch "b${i}"]\n\tremote = r${i}\n\tmerge = refs/heads/b${i}\n`
    assert.ok(cfg.length > 64 * 1024)
    fakeGitDir(join(repo, '.git'), cfg)
    assert.deepEqual(canonicalProjectForCwd(repo, NO_TMP), { label: 'bigcfg', root: repo })
  })

  it('an empty stray .git directory is skipped: the walk continues to the parent repo, or null', () => {
    const { repo } = realRepo('realparent')
    const stray = join(repo, 'emptygit')
    mkdirSync(join(stray, '.git'), { recursive: true })
    mkdirSync(join(stray, 'sub'))
    assert.deepEqual(canonicalProjectForCwd(join(stray, 'sub'), NO_TMP), { label: 'realparent', root: repo })
    const b = base()
    mkdirSync(join(b, 'lone', '.git'), { recursive: true })
    mkdirSync(join(b, 'lone', 'sub'))
    const saved = process.env.TMPDIR
    process.env.TMPDIR = '/nonexistent-os-tmpdir'
    try {
      const got = canonicalProjectForCwd(join(b, 'lone', 'sub'), NO_TMP)
      assert.notEqual(got?.label, 'lone', 'never the stray directory')
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    }
    assert.equal(canonicalProjectForCwd(join(b, 'lone', 'sub'), NO_TMP), null, 'under os.tmpdir with no repo above: null')
  })

  it('a plain .git whose config sets core.worktree is refused, with a reason and no contents', () => {
    const b = base()
    const d = join(b, 'wtset')
    fakeGitDir(join(d, '.git'), '[core]\n\tworktree = /SECRET-MARKER/elsewhere\n')
    const seen = []
    assert.equal(canonicalProjectForCwd(d, NO_TMP, (info) => seen.push(info)), null)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].reason, 'core_worktree_in_git_dir')
    assert.ok(!JSON.stringify(seen).includes('SECRET-MARKER'))
  })

  it('a refused config reports why through the hook; a clean repo does not', () => {
    const b = base()
    const bad = join(b, 'badcfg')
    fakeGitDir(join(bad, '.git'), '[include]\n\tpath = x\n')
    const seen = []
    assert.equal(canonicalProjectForCwd(bad, NO_TMP, (info) => seen.push(info)), null)
    assert.deepEqual(seen.map((x) => x.reason), ['config_unsupported_syntax'])
    const ok = join(b, 'goodcfg')
    fakeGitDir(join(ok, '.git'), '[core]\n\tbare = false\n')
    const none = []
    assert.ok(canonicalProjectForCwd(ok, NO_TMP, (info) => none.push(info)))
    assert.deepEqual(none, [])
  })
})
