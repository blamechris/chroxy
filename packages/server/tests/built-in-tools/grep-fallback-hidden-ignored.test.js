/**
 * #7981 — ripgrep skips hidden and gitignored files by default; the `grep -r`
 * fallback (the NORMAL path in node:22-slim containers, which ship no rg) used
 * to read both, so a plain directory Grep returned `.env` and
 * `.claude/settings.local.json`. The fallback now lists the candidate files
 * itself (git ls-files inside a work tree, `find` otherwise), drops any path
 * with a hidden component, and greps only that list.
 *
 * The built command is run for real under `bash -c` with a PATH holding only
 * grep, find, bash (and git for the git cases), so `command -v rg` fails and the
 * fallback arm is what executes. The real-bash tests sit behind the capability
 * probe so Windows CI runs only the pure ones.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync,
  accessSync, statSync, constants,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildGrepArgs, buildGrepCommand } from '../../src/built-in-tools/tool-transforms.js'

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const c = path.join(dir, name)
    try {
      if (!statSync(c).isFile()) continue
      accessSync(c, constants.X_OK)
      return c
    } catch { continue }
  }
  return null
}

const GREP = findOnPath('grep')
const BASH = findOnPath('bash')
const FIND = findOnPath('find')
const GIT = findOnPath('git')

/** Skip reason, or null when the host can run the real-bash tests. */
function probeRealBash() {
  if (!BASH) return 'bash is not on PATH'
  if (!GREP) return 'grep is not on PATH'
  if (!FIND) return 'find is not on PATH'
  const v = spawnSync(BASH, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (v.error || v.status !== 0) return 'bash is present but not runnable'
  const dir = mkdtempSync(path.join(tmpdir(), 'grep-hid-probe-'))
  try {
    symlinkSync(GREP, path.join(dir, 'grep'))
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'ENOSYS' || err.code === 'EACCES')) {
      return `symlinks cannot be created (${err.code})`
    }
    throw err
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return null
}
const SKIP_REAL_BASH = probeRealBash()
const SKIP_GIT = SKIP_REAL_BASH || (GIT ? false : 'git is not on PATH')

let base
let binNoGit
let binGit
function makeBin(name, tools) {
  const bin = path.join(base, name)
  mkdirSync(bin)
  for (const [n, target] of tools) symlinkSync(target, path.join(bin, n))
  return bin
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Run a Grep for NEEDLE under `root` with rg absent. Returns status, stdout, stderr, files. */
function run(root, { input = {}, bin = binNoGit, pattern = 'NEEDLE', cmdOpts = {} } = {}) {
  const cmd = buildGrepCommand({ pattern, root, ...buildGrepArgs(input), ...cmdOpts })
  const r = spawnSync(BASH, ['-c', cmd], {
    env: { PATH: bin, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'no-gitconfig') },
    encoding: 'utf8',
    timeout: 30_000,
  })
  const files = r.stdout.split('\n').filter(Boolean).map((l) => path.relative(root, l.split(':')[0])).sort()
  return { ...r, files }
}

/** A tree with every kind of file the fallback must treat differently. */
function populate(dir) {
  write(path.join(dir, 'a.txt'), 'NEEDLE visible\n')
  write(path.join(dir, 'sub', 'ok.txt'), 'NEEDLE nested\n')
  write(path.join(dir, '.env'), 'NEEDLE SECRET_ENV\n')
  write(path.join(dir, '.secret', 'x'), 'NEEDLE SECRET_DIR\n')
  write(path.join(dir, '.claude', 'settings.local.json'), 'NEEDLE SECRET_SETTINGS\n')
  write(path.join(dir, 'sub', '.hidden-deep', 'y.txt'), 'NEEDLE SECRET_DEEP\n')
  write(path.join(dir, 'sub', '.dotfile'), 'NEEDLE SECRET_DOTFILE\n')
}

function gitInit(dir) {
  const env = { PATH: path.dirname(GIT), HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'no-gitconfig') }
  const g = (...args) => {
    const r = spawnSync(GIT, args, { cwd: dir, env, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  g('init', '-q')
  return g
}

const SECRETS = /SECRET_/

describe('Grep grep-fallback skips hidden and ignored files (#7981): command shape', () => {
  it('lists files itself and never hands grep the directory (no grep -r)', () => {
    const cmd = buildGrepCommand({ pattern: 'x', root: '/w', ...buildGrepArgs({}) })
    assert.equal(cmd.includes('grep -r'), false)
    assert.ok(cmd.includes('ls-files -z --cached --others --exclude-standard'), 'git lister')
    assert.ok(cmd.includes("find . -mindepth 1 \\( -name '.*' -prune \\) -o -type f -print0"), 'find lister')
    assert.ok(cmd.includes('case /$f in */.*) continue;; esac'), 'hidden filter on the path relative to the root')
  })

  it('leaves the rg branch unchanged', () => {
    const cmd = buildGrepCommand({ pattern: 'x', root: '/w', ci: '-i', ln: '-n', globArg: '' })
    assert.ok(cmd.includes("then rg --no-config -i -n --no-heading -e 'x' -- '/w'; else __gx_search '/w'; fi"))
  })

  it('a refusing glob still refuses, without the listing prelude', () => {
    const cmd = buildGrepCommand({ pattern: 'x', root: '/w', ...buildGrepArgs({ glob: 'a/b' }) })
    assert.equal(cmd.includes('__gx_search'), false)
    assert.ok(cmd.includes('cannot be applied'))
  })
})

describe('Grep grep-fallback skips hidden and ignored files (#7981)', { skip: SKIP_REAL_BASH || false }, () => {
  before(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'grep-hid-')))
    binNoGit = makeBin('bin-nogit', [['grep', GREP], ['find', FIND]])
    binGit = makeBin('bin-git', [['grep', GREP], ['find', FIND], ...(GIT ? [['git', GIT]] : [])])
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  describe('outside a git work tree (hidden excluded; gitignore unknowable)', () => {
    it('does not return hidden files or the contents of hidden directories', () => {
      const root = path.join(base, 'nogit')
      populate(root)
      const r = run(root)
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(r.files, ['a.txt', 'sub/ok.txt'])
      assert.equal(SECRETS.test(r.stdout), false, r.stdout)
    })

    it('documented limit: a non-hidden file a .gitignore would hide is still searched', () => {
      const root = path.join(base, 'nogit-ign')
      write(path.join(root, '.gitignore'), 'ign.txt\n')
      write(path.join(root, 'ign.txt'), 'NEEDLE ignored_but_unknowable\n')
      write(path.join(root, 'a.txt'), 'NEEDLE a\n')
      assert.deepEqual(run(root).files, ['a.txt', 'ign.txt'])
    })

    it('a root that is itself hidden, or under a hidden directory, is still searched', () => {
      for (const sub of ['.config/proj', '.proj', '.a/.b/c']) {
        const root = path.join(base, 'nogit-hroot', sub)
        populate(root)
        const r = run(root)
        assert.equal(r.status, 0, `${sub}: ${r.stderr}`)
        assert.deepEqual(r.files, ['a.txt', 'sub/ok.txt'], sub)
        assert.equal(SECRETS.test(r.stdout), false, sub)
      }
    })

    it('a root of "." (relative) is searched, and its own dot name is not a hidden component', () => {
      const root = path.join(base, 'nogit-dot')
      populate(root)
      const cmd = buildGrepCommand({ pattern: 'NEEDLE', root: '.', ...buildGrepArgs({}) })
      const r = spawnSync(BASH, ['-c', cmd], { cwd: root, env: { PATH: binNoGit }, encoding: 'utf8', timeout: 30_000 })
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(r.stdout.split('\n').filter(Boolean).map((l) => l.split(':')[0]).sort(), ['./a.txt', './sub/ok.txt'])
    })

    it('an explicitly named hidden FILE root is searched (rg does the same)', () => {
      const root = path.join(base, 'nogit-file')
      write(path.join(root, '.env'), 'NEEDLE named_explicitly\n')
      const r = run(path.join(root, '.env'))
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.includes('named_explicitly'))
    })

    it('an empty list is "no matches" (exit 1), not an error and not a whole-tree search', () => {
      const root = path.join(base, 'nogit-empty')
      write(path.join(root, '.env'), 'NEEDLE SECRET_ONLY_HIDDEN\n')
      write(path.join(root, '.secret', 'x'), 'NEEDLE SECRET_ONLY_HIDDEN\n')
      const r = run(root)
      assert.equal(r.status, 1, r.stderr)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
    })

    it('a missing root is still an error (exit 2)', () => {
      const r = run(path.join(base, 'does-not-exist'))
      assert.equal(r.status, 2)
      assert.equal(r.stdout, '')
    })

    it('keeps the output shape: <root>/<relative path>:<line>:<text>', () => {
      const root = path.join(base, 'nogit-shape')
      write(path.join(root, 'sub', 'f.txt'), 'x\nNEEDLE here\n')
      const r = run(root)
      assert.equal(r.stdout, `${root}/sub/f.txt:2:NEEDLE here\n`)
    })

    it('honours -i and a no-line-number request', () => {
      const root = path.join(base, 'nogit-flags')
      write(path.join(root, 'f.txt'), 'needle lower\n')
      assert.equal(run(root).status, 1)
      const r = run(root, { input: { '-i': true, '-n': false } })
      assert.equal(r.stdout, `${root}/f.txt:needle lower\n`)
    })

    it('is NUL-safe: spaces, a leading dash and a newline in a file name', () => {
      const root = path.join(base, 'nogit-names')
      write(path.join(root, 'a b.txt'), 'NEEDLE space\n')
      write(path.join(root, '-dash.txt'), 'NEEDLE dash\n')
      write(path.join(root, 'new\nline.txt'), 'NEEDLE newline\n')
      const r = run(root)
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.includes('NEEDLE space') && r.stdout.includes('NEEDLE dash') && r.stdout.includes('NEEDLE newline'), r.stdout)
    })

    it('searches every file when there are more than one grep batch', () => {
      const root = path.join(base, 'nogit-many')
      for (let i = 0; i < 450; i++) write(path.join(root, `d${i % 7}`, `f${i}.txt`), `NEEDLE ${i}\n`)
      const r = run(root)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.files.length, 450)
    })

    it('does not follow a symlink out of the root', () => {
      const root = path.join(base, 'nogit-link')
      const outside = path.join(base, 'nogit-link-outside')
      write(path.join(outside, 'o.txt'), 'NEEDLE outside\n')
      write(path.join(root, 'a.txt'), 'NEEDLE a\n')
      symlinkSync(outside, path.join(root, 'out'))
      assert.deepEqual(run(root).files, ['a.txt'])
    })

    it('fails closed when find is unavailable: exit 2, never "no matches"', () => {
      const root = path.join(base, 'nogit-nofind')
      populate(root)
      const bin = makeBin('bin-nofind', [['grep', GREP]])
      const r = run(root, { bin })
      assert.equal(r.status, 2)
      assert.equal(r.stdout, '')
      assert.ok(r.stderr.includes('could not list the files'), r.stderr)
    })

    it('glob include/exclude apply to the list; an exclusion matching the root no longer refuses', () => {
      const root = path.join(base, 'nogit-ws')
      populate(root)
      write(path.join(root, 'sub', 'skip', 'z.txt'), 'NEEDLE z\n')
      write(path.join(root, 'b.md'), 'NEEDLE md\n')
      assert.deepEqual(run(root, { input: { glob: '*.md' } }).files, ['b.md'])
      assert.deepEqual(run(root, { input: { glob: '!skip' } }).files, ['a.txt', 'b.md', 'sub/ok.txt'])
      for (const glob of ['!ws', '!n*', '!*-ws', '!nogit-ws']) {
        const r = run(root, { input: { glob } })
        assert.equal(r.status, 0, `${glob}: ${r.stderr}`)
        assert.ok(r.files.includes('a.txt'), glob)
      }
    })

    it('maskExit keeps the empty-list no-match visible as empty stdout', () => {
      const root = path.join(base, 'nogit-mask')
      write(path.join(root, '.env'), 'NEEDLE SECRET_X\n')
      const r = run(root, { cmdOpts: { maskExit: true } })
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '')
    })
  })

  describe('inside a git work tree (gitignore honoured)', { skip: SKIP_GIT || false }, () => {
    it('does not return gitignored, hidden, or tracked-but-hidden files', () => {
      const root = path.join(base, 'git1')
      populate(root)
      write(path.join(root, '.gitignore'), 'ign.txt\nbuild/\n*.log\n')
      write(path.join(root, 'ign.txt'), 'NEEDLE SECRET_IGN\n')
      write(path.join(root, 'build', 'out.js'), 'NEEDLE SECRET_BUILD\n')
      write(path.join(root, 'sub', 'x.log'), 'NEEDLE SECRET_LOG\n')
      write(path.join(root, 'tracked.txt'), 'NEEDLE tracked\n')
      const g = gitInit(root)
      g('add', '-f', '.env', 'tracked.txt', 'a.txt')
      const r = run(root, { bin: binGit })
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(r.files, ['a.txt', 'sub/ok.txt', 'tracked.txt'])
      assert.equal(SECRETS.test(r.stdout), false, r.stdout)
    })

    it('honours .git/info/exclude', () => {
      const root = path.join(base, 'git2')
      write(path.join(root, 'a.txt'), 'NEEDLE a\n')
      write(path.join(root, 'local.txt'), 'NEEDLE SECRET_LOCAL\n')
      gitInit(root)
      write(path.join(root, '.git', 'info', 'exclude'), 'local.txt\n')
      assert.deepEqual(run(root, { bin: binGit }).files, ['a.txt'])
    })

    it('searches a subdirectory root of a work tree, hidden root included', () => {
      const root = path.join(base, 'git3')
      write(path.join(root, '.gitignore'), 'ign.txt\n')
      populate(path.join(root, '.cfg', 'proj'))
      write(path.join(root, '.cfg', 'proj', 'ign.txt'), 'NEEDLE SECRET_IGN\n')
      gitInit(root)
      const r = run(path.join(root, '.cfg', 'proj'), { bin: binGit })
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(r.files, ['a.txt', 'sub/ok.txt'])
    })

    it('skips a file that is tracked but deleted from disk, and a symlink', () => {
      const root = path.join(base, 'git4')
      write(path.join(root, 'a.txt'), 'NEEDLE a\n')
      write(path.join(root, 'gone.txt'), 'NEEDLE gone\n')
      write(path.join(base, 'git4-outside.txt'), 'NEEDLE SECRET_OUTSIDE\n')
      symlinkSync(path.join(base, 'git4-outside.txt'), path.join(root, 'link.txt'))
      const g = gitInit(root)
      g('add', '-f', 'a.txt', 'gone.txt', 'link.txt')
      rmSync(path.join(root, 'gone.txt'))
      const r = run(root, { bin: binGit })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stderr, '')
      assert.deepEqual(r.files, ['a.txt'])
    })

    it('a work tree with nothing searchable is "no matches" (exit 1)', () => {
      const root = path.join(base, 'git5')
      write(path.join(root, '.gitignore'), '*\n')
      write(path.join(root, 'x.txt'), 'NEEDLE SECRET_IGN\n')
      gitInit(root)
      const r = run(root, { bin: binGit })
      assert.equal(r.status, 1)
      assert.equal(r.stdout, '')
    })
  })
})
