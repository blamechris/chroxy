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

let root
let bin
before(() => {
  assert.ok(GREP && BASH, 'grep and bash are required')
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
})
after(() => rmSync(path.dirname(root), { recursive: true, force: true }))

function run(input, extra = {}) {
  const args = buildGrepArgs(input)
  const cmd = buildGrepCommand({ pattern: 'NEEDLE', root, ...args, ...extra })
  const r = spawnSync(BASH, ['-c', cmd], { env: { PATH: bin }, encoding: 'utf8', timeout: 20_000 })
  const files = r.stdout.split('\n').filter(Boolean).map((l) => path.relative(root, l.split(':')[0])).sort()
  return { ...r, files }
}

describe('Grep grep -r fallback honours glob (#7961)', () => {
  it('with no glob, searches every file (unchanged behaviour)', () => {
    const r = run({})
    assert.equal(r.status, 0)
    assert.deepEqual(r.files, ['-x.js', 'a.js', 'b.ts', 'c.tsx', 'd.min.js', 'src/e.js'])
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
    assert.deepEqual(run({ glob: '!*.min.js' }).files, ['-x.js', 'a.js', 'b.ts', 'c.tsx', 'src/e.js'])
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
    assert.deepEqual(translateGlobForGrep('!*.log'), { args: " --exclude='*.log'" })
    assert.deepEqual(translateGlobForGrep('--include=x'), { args: " --include='--include=x'" })
    for (const g of ['a/b', '**', '!', '*.{a,{b,c}}', '*.{a', 'a}', '{,a}', '*.\\*']) {
      assert.ok('refusal' in translateGlobForGrep(g), g)
    }
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
