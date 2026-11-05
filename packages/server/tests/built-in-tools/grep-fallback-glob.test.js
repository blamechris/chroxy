/**
 * #7961 — the `grep -r` fallback (used when ripgrep is absent, e.g. node:22-slim)
 * must honour the Grep tool's `glob`. It used to ignore it silently and return
 * every file's matches as though filtered.
 *
 * The built command is run for real under `bash -c` with a PATH holding only
 * `grep`, so `command -v rg` fails and the fallback arm is what executes.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, accessSync, statSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildGrepArgs,
  buildGrepCommand,
  translateGlobForGrep,
} from '../../src/built-in-tools/tool-transforms.js'

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

/**
 * Capability probe for the real-bash tests. Returns a skip reason, or null when
 * the host can run them. Probed by capability (a runnable bash, a grep binary,
 * a creatable symlink), never by platform name: a host that HAS all three must
 * run the tests, and any unexpected error propagates instead of skipping.
 */
function probeRealBash() {
  if (!BASH) return 'bash is not on PATH'
  if (!GREP) return 'grep is not on PATH'
  const v = spawnSync(BASH, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (v.error || v.status !== 0) return 'bash is present but not runnable'
  const dir = mkdtempSync(path.join(tmpdir(), 'grep-glob-probe-'))
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

let root
let bin
function setupFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'grep-glob-'))
  root = path.join(base, 'ws')
  bin = path.join(base, 'bin')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(bin)
  symlinkSync(GREP, path.join(bin, 'grep'))
  writeFileSync(path.join(root, 'a.js'), 'NEEDLE js\n')
  writeFileSync(path.join(root, 'b.ts'), 'NEEDLE ts\n')
  writeFileSync(path.join(root, 'c.tsx'), 'NEEDLE tsx\n')
  writeFileSync(path.join(root, 'd.min.js'), 'NEEDLE min\n')
  writeFileSync(path.join(root, 'src', 'e.js'), 'NEEDLE nested\n')
  writeFileSync(path.join(root, '-x.js'), 'NEEDLE dash\n')
  mkdirSync(path.join(root, 'skipme'))
  writeFileSync(path.join(root, 'skipme', 'f.txt'), 'NEEDLE in excluded dir\n')
}

function run(input, extra = {}) {
  const args = buildGrepArgs(input)
  const cmd = buildGrepCommand({ pattern: 'NEEDLE', root, ...args, ...extra })
  const r = spawnSync(BASH, ['-c', cmd], { env: { PATH: bin }, encoding: 'utf8', timeout: 20_000 })
  const files = r.stdout.split('\n').filter(Boolean).map((l) => path.relative(root, l.split(':')[0])).sort()
  return { ...r, files }
}

describe('Grep grep -r fallback honours glob (#7961)', { skip: SKIP_REAL_BASH || false }, () => {
  before(setupFixture)
  after(() => rmSync(path.dirname(root), { recursive: true, force: true }))

  it('with no glob, searches every file (unchanged behaviour)', () => {
    const r = run({})
    assert.equal(r.status, 0)
    assert.deepEqual(r.files, ['-x.js', 'a.js', 'b.ts', 'c.tsx', 'd.min.js', 'skipme/f.txt', 'src/e.js'])
  })

  it('a simple *.js glob returns only matching files', () => {
    const r = run({ glob: '*.js' })
    assert.equal(r.status, 0)
    assert.deepEqual(r.files, ['-x.js', 'a.js', 'd.min.js', 'src/e.js'])
  })

  it('a brace set expands to several includes', () => {
    assert.deepEqual(run({ glob: '*.{ts,tsx}' }).files, ['b.ts', 'c.tsx'])
  })

  it('a negated basename glob excludes', () => {
    assert.deepEqual(run({ glob: '!*.min.js' }).files, ['-x.js', 'a.js', 'b.ts', 'c.tsx', 'skipme/f.txt', 'src/e.js'])
  })

  it('a negated glob also excludes a directory of that name (rg parity)', () => {
    const r = run({ glob: '!skipme' })
    assert.equal(r.status, 0)
    assert.ok(!r.files.some((f) => f.startsWith('skipme/')), r.files.join(','))
    assert.ok(r.files.includes('a.js'))
  })

  it('a glob beginning with "-" is a value, not an option', () => {
    const r = run({ glob: '-x.js' })
    assert.equal(r.status, 0)
    assert.deepEqual(r.files, ['-x.js'])
  })

  it('a path glob is refused loudly, never searched unfiltered', () => {
    for (const glob of ['src/**/*.js', '**/*.ts', 'src/*.js']) {
      const r = run({ glob })
      assert.equal(r.status, 2, glob)
      assert.deepEqual(r.files, [], glob)
      assert.ok(r.stderr.includes('cannot be applied'), glob)
    }
  })

  it('refusal text holding shell metacharacters is not executed', () => {
    const r = run({ glob: "a/$(touch pwned)'; touch pwned2 #" })
    assert.equal(r.status, 2)
    assert.ok(r.stderr.includes('$(touch pwned)'))
  })

  it('maskExit keeps a refusal visible on stderr with empty stdout', () => {
    const r = run({ glob: 'a/b' }, { maskExit: true })
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes('cannot be applied'))
  })
})

describe('translateGlobForGrep', () => {
  it('translates and refuses as documented', () => {
    assert.deepEqual(translateGlobForGrep('*.js'), { args: " --include='*.js'" })
    assert.deepEqual(translateGlobForGrep('*.{a,b}'), { args: " --include='*.a' --include='*.b'" })
    assert.deepEqual(translateGlobForGrep('!*.log'), { args: " --exclude='*.log' --exclude-dir='*.log'" })
    assert.deepEqual(translateGlobForGrep('--include=x'), { args: " --include='--include=x'" })
    for (const g of ['a/b', '**', '!', '*.{a,{b,c}}', '*.{a', 'a}', '{,a}', '*.\\*']) {
      assert.ok('refusal' in translateGlobForGrep(g), g)
    }
  })

  it('refuses an oversized glob before expanding anything', () => {
    // The reason names the early length check, not a later brace/byte one.
    assert.ok(translateGlobForGrep('x'.repeat(100000) + '{a,b,c,d}{e,f,g,h}{i,j}').refusal.includes('too long'))
    assert.ok(translateGlobForGrep('x'.repeat(2000)).refusal.includes('too long'))
  })

  it('refuses a brace product as soon as it would exceed the cap (no full expansion)', () => {
    // 4^400 entries if built in full; must return at once.
    assert.ok(translateGlobForGrep('{a,b,c,d}'.repeat(100)).refusal.includes('brace'))
    // One wide set under the input cap: 500 alternatives > the 32 cap.
    assert.ok(translateGlobForGrep('{' + 'a,'.repeat(499) + 'a}').refusal.includes('brace'))
  })

  it('caps the total bytes of generated flags', () => {
    // 32 expansions of a ~400-byte glob: under the input cap, over the flag cap.
    const g = 'z'.repeat(400) + '{a,b}'.repeat(5)
    assert.ok(g.length < 1024)
    const r = translateGlobForGrep(g)
    assert.ok('refusal' in r)
    assert.ok(r.refusal.includes('too many bytes'))
    assert.ok('args' in translateGlobForGrep('z'.repeat(100) + '{a,b}'))
  })

  it('caps brace expansion', () => {
    assert.ok('refusal' in translateGlobForGrep('{a,b,c,d}{a,b,c,d}{a,b,c}'))
  })
})

describe('buildGrepCommand wiring', () => {
  it('throws when globArg is given without grepGlob', () => {
    assert.throws(
      () => buildGrepCommand({ pattern: 'x', root: '/w', ci: '', ln: '', globArg: " --glob='*.js'" }),
      /grepGlob/,
    )
  })
})
