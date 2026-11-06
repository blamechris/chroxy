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
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, chmodSync,
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
const TEST_BIN = findOnPath('test')
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

  describe('round-1 review blockers', () => {
    const POSIX_PERMS = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
      ? 'permission bits are not enforced here (Windows or root)'
      : false

    // A shim `find`/`git` that is a shell script, so a lister can be made to
    // emit one valid candidate and then FAIL.
    function shimBin(name, scripts) {
      const bin = path.join(base, name)
      mkdirSync(bin)
      symlinkSync(GREP, path.join(bin, 'grep'))
      for (const [n, body] of Object.entries(scripts)) {
        const f = path.join(bin, n)
        writeFileSync(f, `#!/bin/sh\n${body}\n`)
        chmodSync(f, 0o755)
      }
      return bin
    }

    describe('A: a symlinked ancestor must not escape the root', { skip: SKIP_GIT || false }, () => {
      it('a tracked sub/f.txt whose sub became a symlink to an outside directory reads nothing', () => {
        const root = path.join(base, 'anc1')
        const outside = path.join(base, 'anc1-outside')
        write(path.join(root, 'sub', 'f.txt'), 'NEEDLE tracked\n')
        write(path.join(root, 'ok.txt'), 'NEEDLE ok\n')
        write(path.join(outside, 'f.txt'), 'NEEDLE SECRET_OUTSIDE_MARKER\n')
        const g = gitInit(root)
        g('add', '-f', 'sub/f.txt', 'ok.txt')
        rmSync(path.join(root, 'sub'), { recursive: true })
        symlinkSync(outside, path.join(root, 'sub'))
        const r = run(root, { bin: binGit })
        assert.equal(SECRETS.test(r.stdout), false, r.stdout)
        assert.equal(r.stdout.includes('OUTSIDE'), false, r.stdout)
        assert.deepEqual(r.files, ['ok.txt'])
      })

      it('also when the link is several levels up', () => {
        const root = path.join(base, 'anc2')
        const outside = path.join(base, 'anc2-outside')
        write(path.join(root, 'a', 'b', 'c', 'f.txt'), 'NEEDLE tracked\n')
        write(path.join(outside, 'c', 'f.txt'), 'NEEDLE SECRET_OUTSIDE\n')
        const g = gitInit(root)
        g('add', '-f', 'a/b/c/f.txt')
        rmSync(path.join(root, 'a', 'b'), { recursive: true })
        symlinkSync(outside, path.join(root, 'a', 'b'))
        const r = run(root, { bin: binGit })
        assert.equal(SECRETS.test(r.stdout), false, r.stdout)
        assert.equal(r.status, 1)
      })
    })

    describe('B: a listing failure is an error with no stdout, never a partial success', () => {
      it('find that emits one candidate then fails: no stdout, exit 2, find named', () => {
        const root = path.join(base, 'fail-find')
        write(path.join(root, 'a.txt'), 'NEEDLE a\n')
        const bin = shimBin('bin-failfind', { find: "printf './a.txt\\0'; exit 1" })
        for (const maskExit of [false, true]) {
          const r = run(root, { bin, cmdOpts: { maskExit } })
          assert.equal(r.stdout, '', `maskExit=${maskExit}`)
          assert.equal(r.status, maskExit ? 0 : 2, `maskExit=${maskExit}`)
          assert.ok(r.stderr.includes('`find` could not enumerate'), r.stderr)
          assert.equal(r.stderr.includes('git'), false, 'must not blame git when git was not used')
        }
      })

      it('git that emits one candidate then fails: no stdout, exit 2, git named', () => {
        const root = path.join(base, 'fail-git')
        write(path.join(root, 'a.txt'), 'NEEDLE a\n')
        const bin = shimBin('bin-failgit', {
          find: 'exit 1',
          git: [
            'case "$*" in',
            '  *is-inside-work-tree*) echo true;;',
            '  *show-prefix*) ;;',
            '  *" -ci "*) ;;',
            "  *ls-files*) printf 'a.txt\\0'; exit 1;;",
            'esac',
          ].join('\n'),
        })
        for (const maskExit of [false, true]) {
          const r = run(root, { bin, cmdOpts: { maskExit } })
          assert.equal(r.stdout, '', `maskExit=${maskExit}`)
          assert.equal(r.status, maskExit ? 0 : 2, `maskExit=${maskExit}`)
          assert.ok(r.stderr.includes('`git ls-files` could not enumerate'), r.stderr)
        }
      })

      it('a failure after matches would have flushed still prints nothing (batch > 1)', () => {
        const root = path.join(base, 'fail-late')
        let list = ''
        for (let i = 0; i < 250; i++) {
          write(path.join(root, `f${i}.txt`), 'NEEDLE x\n')
          list += `./f${i}.txt\\0`
        }
        const bin = shimBin('bin-latefail', { find: `printf '${list}'; exit 1` })
        const r = run(root, { bin })
        assert.equal(r.stdout, '')
        assert.equal(r.status, 2)
      })
    })

    describe('C: a root inside a gitignored directory is still searched', { skip: SKIP_GIT || false }, () => {
      it('build/ and node_modules/pkg roots return their matches; hidden still dropped', () => {
        const root = path.join(base, 'ignroot')
        write(path.join(root, '.gitignore'), 'build/\nnode_modules/\n')
        write(path.join(root, 'build', 'out.js'), 'NEEDLE built\n')
        write(path.join(root, 'build', '.cache', 'c.js'), 'NEEDLE SECRET_CACHE\n')
        write(path.join(root, 'node_modules', 'pkg', 'index.js'), 'NEEDLE pkg\n')
        write(path.join(root, 'src.js'), 'NEEDLE src\n')
        gitInit(root)
        const b = run(path.join(root, 'build'), { bin: binGit })
        assert.equal(b.status, 0, b.stderr)
        assert.deepEqual(b.files, ['out.js'])
        const n = run(path.join(root, 'node_modules', 'pkg'), { bin: binGit })
        assert.deepEqual(n.files, ['index.js'])
        // ...while the repo root still honours the ignore rules.
        assert.deepEqual(run(root, { bin: binGit }).files, ['src.js'])
      })
    })

    describe('git-specific list shaping', { skip: SKIP_GIT || false }, () => {
      it('expands a nested repository the way ripgrep searches into it (hidden still dropped)', () => {
        const root = path.join(base, 'nested1')
        write(path.join(root, 'top.txt'), 'NEEDLE top\n')
        write(path.join(root, 'nested', 'n.txt'), 'NEEDLE nested\n')
        write(path.join(root, 'nested', 'deep', 'd.txt'), 'NEEDLE deep\n')
        write(path.join(root, 'nested', '.env'), 'NEEDLE SECRET_NESTED\n')
        gitInit(root)
        gitInit(path.join(root, 'nested'))
        const r = run(root, { bin: binGit })
        assert.equal(r.status, 0, r.stderr)
        assert.deepEqual(r.files, ['nested/deep/d.txt', 'nested/n.txt', 'top.txt'])
        assert.equal(SECRETS.test(r.stdout), false)
      })

      it('skips a tracked file that is also gitignored (ripgrep parity), keeping the in-order merge honest', () => {
        const root = path.join(base, 'tci')
        write(path.join(root, '.gitignore'), '*.log\n')
        for (const f of ['a.txt', 'b.log', 'c.txt', 'd.log', 'e.txt']) write(path.join(root, f), `NEEDLE SECRET_${f}\n`)
        write(path.join(root, 'z.txt'), 'NEEDLE untracked\n')
        const g = gitInit(root)
        g('add', '-f', 'a.txt', 'b.log', 'c.txt', 'd.log', 'e.txt')
        const r = run(root, { bin: binGit })
        assert.deepEqual(r.files, ['a.txt', 'c.txt', 'e.txt', 'z.txt'])
        assert.equal(r.stdout.includes('b.log') || r.stdout.includes('d.log'), false)
      })
    })

    describe('find lister details', () => {
      it('an unreadable subdirectory is skipped with a note; the rest is searched', { skip: POSIX_PERMS }, () => {
        const root = path.join(base, 'unread')
        write(path.join(root, 'a.txt'), 'NEEDLE a\n')
        write(path.join(root, 'priv', 'p.txt'), 'NEEDLE hidden_by_perms\n')
        write(path.join(root, 'sub', 'ok.txt'), 'NEEDLE ok\n')
        chmodSync(path.join(root, 'priv'), 0o000)
        // BSD find has no -readable, so the pruning falls back to the `test` binary.
        const bin = makeBin('bin-unread', [['grep', GREP], ['find', FIND], ...(TEST_BIN ? [['test', TEST_BIN]] : [])])
        try {
          const r = run(root, { bin })
          assert.equal(r.status, 0, r.stderr)
          assert.deepEqual(r.files, ['a.txt', 'sub/ok.txt'])
          assert.ok(r.stderr.includes('Permission denied'), r.stderr)
          assert.ok(r.stderr.includes('priv'), r.stderr)
          // ...and with nothing else to find it is a no-match, not a listing failure.
          const lone = path.join(base, 'unread-lone')
          write(path.join(lone, 'priv', 'p.txt'), 'NEEDLE x\n')
          chmodSync(path.join(lone, 'priv'), 0o000)
          const r2 = run(lone, { bin })
          chmodSync(path.join(lone, 'priv'), 0o755)
          assert.equal(r2.status, 1, r2.stderr)
          assert.equal(r2.stdout, '')
        } finally {
          chmodSync(path.join(root, 'priv'), 0o755)
        }
      })

      it('a missing root is exit 2 even when the glob would exclude it', () => {
        for (const glob of ['!*', '!nope', '*.md']) {
          const r = run(path.join(base, 'nope'), { input: { glob } })
          assert.equal(r.status, 2, glob)
          assert.ok(r.stderr.includes('No such file or directory'), r.stderr)
          assert.equal(r.stdout, '')
        }
      })

      it('bounds a batch by path characters as well as by count', () => {
        const cmd = buildGrepCommand({ pattern: 'x', root: '/w', ...buildGrepArgs({}) })
        assert.ok(cmd.includes('-ge 200 ]') && cmd.includes('-ge 32768 ]'), 'count and character budgets')
        const root = path.join(base, 'longnames')
        const stem = 'n'.repeat(200)
        for (let i = 0; i < 220; i++) write(path.join(root, `${stem}${i}.txt`), 'NEEDLE long\n')
        const r = run(root)
        assert.equal(r.status, 0, r.stderr)
        assert.equal(r.files.length, 220)
      })
    })
  })
})
