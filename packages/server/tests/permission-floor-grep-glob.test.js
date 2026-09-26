import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync, accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  isFlooredTarget,
  isSecretReadTarget,
  globSelectsSecret,
  GLOB_SELECTOR_FLOOR_TOOLS,
  FLOOR_SECRET_NAMES,
} from '../src/permission-floor.js'

/**
 * #7978 — the permission floor ignored Grep's `glob`, the field that picks which
 * files a Grep READS. ripgrep's include globs override its ignore rules, so
 * `Grep({ path: 'src', glob: '.env' })` read a gitignored `.env` while the floor
 * answered "not floored", and a lenient mode auto-approved it.
 *
 * Four layers here:
 *   1. the issue's acceptance rows and their controls, through isFlooredTarget;
 *   2. the fail-closed edges (non-string, oversized, too many alternatives);
 *   3. PARITY with the path floor: a literal glob floors exactly when the same
 *      path would, over a corpus generated from FLOOR_SECRET_NAMES (the floor's
 *      own sets), and every witness name is a secret by the path floor;
 *   4. an ORACLE: real ripgrep, run the way Claude Code and the BYOK executor
 *      run it, against a fixture of gitignored secrets. Whenever ripgrep reads a
 *      secret for a glob, the floor must have floored that glob.
 * Layers 3 and 4 are independent readings: 3 checks the glob machinery against
 * the segment scan, 4 checks it against the program that actually reads files.
 */

const CWD = '/work/project'
const grepFloored = (glob, extra = {}) =>
  isFlooredTarget('Grep', { pattern: 'KEY', path: 'src', glob, ...extra }, CWD)

describe('#7978 acceptance: a benign path + a secret-selecting glob is floored', () => {
  // The issue's rows, then the shapes measured to read a gitignored secret with
  // ripgrep 15.2.0 (see the section comment in permission-floor.js).
  const FLOORED = [
    '.env', '*.env', '**/.env*', '.e?v', '.[e]nv',
    '*', '**', '**/*', '*.*', 'sub/*', '*env*', '{*.ts,.env}',
    '*.json', '.claude/*', 'settings.local.json',
    '*.pem', '?.pem', '*.{pem,key}', 'id_*', '*rsa', '.npmrc',
    '.env.????', '*.local', 'privkey*', '*test*',
    '.ENV', '*.PEM', '.[!x]nv', '.[E]NV', 'x.\u212Aey', // case variants (the floor lowercases)
    '/.env', './.env', '**/.git/config', 'config', '.config/**', '.config/**/config',
    // PR #7980 review: each read a gitignored secret with ripgrep while an
    // earlier revision of this floor answered false. Single-alternative and
    // empty braces are real alternations; classes, escapes and non-ASCII are
    // outside the analyzed grammar and floor unanalyzed.
    '{*}', '*{}', '{**}', '{**/*}', '{.env}', '.env{}', '.e{n}v', '{.npmrc}', '{*.pem}', '{*.json}',
    '.en[v\\]', '.[a-c-z]nv', '.claude[!x]settings.local.json', '{.git,.git[/]config}', '{.[,e]nv}',
    '.env\u0085', '*\u0085', '*.pem\u0085', '{.env', '.env}',
  ]
  for (const glob of FLOORED) {
    it(`glob ${JSON.stringify(glob)} is floored`, () => {
      assert.equal(grepFloored(glob), true)
    })
  }

  it('floors with NO path field at all (a Grep searching the cwd)', () => {
    assert.equal(isFlooredTarget('Grep', { pattern: 'KEY', glob: '.env' }, CWD), true)
  })

  // Controls: ordinary extension and directory filters stay un-prompted.
  const CLEAR = [
    '*.ts', '*.{ts,tsx}', '**/*.js', 'src/**/*.py', '*.md', '*.yml', '*.toml',
    'src/*.ts', 'README*', '*.sh', 'env.js', '!.env', '!*.env', '!**/.env*',
  ]
  for (const glob of CLEAR) {
    it(`control: glob ${JSON.stringify(glob)} is NOT floored`, () => {
      assert.equal(grepFloored(glob), false)
    })
  }

  it('control: a Grep with no glob is decided by its path alone, as before', () => {
    assert.equal(isFlooredTarget('Grep', { pattern: 'KEY', path: 'src' }, CWD), false)
    assert.equal(isFlooredTarget('Grep', { pattern: 'KEY', path: '.env' }, CWD), true)
  })
})

describe('#7978 both glob readings are checked', () => {
  // Claude Code splits `glob` on whitespace, then on commas unless a piece holds
  // a {...} group, and passes each piece as its own --glob. The BYOK executor
  // passes the whole string as ONE --glob. A secret in either reading floors.
  it('a secret hidden behind whitespace (Claude Code reading)', () => {
    assert.equal(grepFloored('*.ts .env'), true)
    assert.equal(grepFloored('*.ts\t**/.env*'), true)
  })

  it('a secret hidden behind a comma (Claude Code reading)', () => {
    assert.equal(grepFloored('*.ts,.env'), true)
  })

  it('a braced piece is kept whole, and its alternatives are still checked', () => {
    assert.equal(grepFloored('*.{ts,tsx} {a,.env}'), true)
    assert.equal(grepFloored('*.{ts,tsx} *.md'), false)
  })

  it('an exclusion piece next to an ordinary one stays clear', () => {
    assert.equal(grepFloored('*.ts !.env'), false)
  })

  it('a whole-tree piece next to an extension filter floors (PR #7980 review: `*.ts {*}`)', () => {
    assert.equal(grepFloored('*.ts {*}'), true)
  })

  it('too many pieces floors without analyzing each one', () => {
    const pieces = (n) => Array.from({ length: n }, (_, i) => `f${i}.ts`).join(' ')
    assert.equal(grepFloored(pieces(30)), false, 'control: under the cap is analyzed')
    assert.equal(grepFloored(pieces(40)), true)
  })
})

describe('#7978 fail-closed edges', () => {
  it('a glob that is present but not a string floors', () => {
    for (const glob of [['.env'], ['*.ts'], 42, { a: 1 }, true]) {
      assert.equal(grepFloored(glob), true, `glob ${JSON.stringify(glob)}`)
    }
  })

  it('an absent or empty glob does not floor on its own', () => {
    assert.equal(isFlooredTarget('Grep', { pattern: 'KEY', path: 'src', glob: null }, CWD), false)
    assert.equal(grepFloored(''), false)
  })

  it('an over-long glob floors without being analyzed', () => {
    assert.equal(globSelectsSecret('a'.repeat(1000) + '.ts'), false, 'control: just under the cap is analyzed')
    assert.equal(globSelectsSecret('a'.repeat(1030) + '.ts'), true)
  })

  it('too many brace alternatives floors', () => {
    const alternatives = (n) => '{' + Array.from({ length: n }, (_, i) => `f${i}`).join(',') + '}.ts'
    assert.equal(globSelectsSecret(alternatives(64)), false, 'control: at the cap is analyzed')
    assert.equal(globSelectsSecret(alternatives(65)), true)
  })

  it('a large expansion floors even under the alternatives cap', () => {
    const glob = '{' + Array.from({ length: 60 }, (_, i) => `${'x'.repeat(80)}${i}`).join(',') + '}.ts'
    assert.equal(globSelectsSecret(glob), true)
  })
})

describe('#7978 scope', () => {
  it('only Grep is glob-inspected', () => {
    assert.deepEqual([...GLOB_SELECTOR_FLOOR_TOOLS], ['Grep'])
    assert.equal(isFlooredTarget('Read', { file_path: 'src/a.ts', glob: '.env' }, CWD), false)
  })

  it('the Glob tool\'s pattern is a deliberate non-goal (it returns names, never contents)', () => {
    assert.equal(isFlooredTarget('Glob', { pattern: '**/.env*' }, CWD), false)
  })

  it('Grep\'s type field is not inspected (ripgrep type filters respect .gitignore)', () => {
    assert.equal(isFlooredTarget('Grep', { pattern: 'KEY', path: 'src', type: 'sh' }, CWD), false)
  })
})

// A literal glob: every glob metacharacter escaped.
const escapeGlob = (text) => text.replace(/[*?[\]{}\\!]/g, (ch) => `\\${ch}`)

describe('#7978 parity with the path floor, over the floor\'s own sets', () => {
  // Names whose secret part is the LAST segment (or ends the path, for the
  // credential-config sequences). A secret-named DIRECTORY is out of scope for
  // the glob floor: an include glob cannot pull a file out of an ignored
  // directory unless the glob also matches the directory's own name, and one
  // that matches a secret name floors as that file name already.
  function corpus() {
    const n = FLOOR_SECRET_NAMES
    const names = [n.envName, n.envPrefix + 'zz9', n.envPrefix + 'a.b', ...n.exact, ...n.credentialConfigPaths]
    for (const ext of n.extensions) names.push('q' + ext, 'ab.cd' + ext)
    for (const tail of n.envTailWitnesses) names.push(n.envPrefix + tail)
    for (const stem of n.keyStemWitnesses) for (const ext of n.extensions) names.push(stem + ext)
    const s = n.claudeSettings
    names.push(`${s.dir}/${s.prefix}${s.suffix}`, `${s.dir}/${s.prefix}.local${s.suffix}`, `${s.dir}/${s.prefix}-x${s.suffix}`)
    // Near misses the path floor does NOT count as secrets; the glob floor must agree.
    names.push(
      '.envrc', 'env', 'my.env', 'x.env.js', '.pem', 'id_rsa.pub', 'x.pem.bak', 'settings.json',
      'git/config', '.git/HEAD', '.claude/skills/x.md', '.vscode/settings.json', 'src/a.ts',
      `${s.dir}/${s.prefix}.yaml`, 'config/credentials.txt',
    )
    // Upper-case spellings of every secret (the floor lowercases).
    return [...names, ...names.map((name) => name.toUpperCase())]
  }

  it('a literal glob floors exactly when the same path is a secret read', () => {
    const mismatches = []
    let secrets = 0
    for (const name of corpus()) {
      // Anchored under a benign directory, so a slashless name is not read as
      // "this basename at any depth" (which would also match `.claude/<name>`).
      const target = `d/${name}`
      const byPath = isSecretReadTarget({ file_path: target }, CWD)
      const byGlob = globSelectsSecret(escapeGlob(target))
      if (byPath) secrets += 1
      if (byPath !== byGlob) mismatches.push(`${target}: path=${byPath} glob=${byGlob}`)
    }
    assert.ok(secrets >= 50, `non-vacuity: the corpus must carry many secrets (got ${secrets})`)
    assert.deepEqual(mismatches, [])
  })

  it('every witness name is already a secret by the path floor (witnesses cannot widen the definition)', () => {
    const n = FLOOR_SECRET_NAMES
    const witnesses = [
      ...n.envTailWitnesses.map((tail) => n.envPrefix + tail),
      ...n.keyStemWitnesses.flatMap((stem) => n.extensions.map((ext) => stem + ext)),
    ]
    assert.ok(witnesses.length >= 20, 'non-vacuity')
    const notSecret = witnesses.filter((w) => !isSecretReadTarget({ file_path: w }, CWD))
    assert.deepEqual(notSecret, [])
  })
})

/**
 * Locate an EXECUTABLE FILE on PATH without shelling out (as in
 * tests/built-in-tools/grep-argv-injection.test.js).
 */
function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

const RG_PATH = findOnPath('rg')

describe('#7978 ORACLE: whenever real ripgrep reads a secret for a glob, the floor floors it', {
  // ripgrep is installed on the Linux/macOS Server Tests legs (ci.yml, #7295),
  // not on the Windows runner.
  skip: process.platform === 'win32' ? 'ripgrep oracle runs on the POSIX legs' : false,
}, () => {
  // Gitignored secrets — the barrier an include glob overrides. The first group
  // are EXACT templates (the floor's names and witnesses); the second are family
  // members no witness names, reachable only through rule (b).
  const EXACT_SECRETS = [
    '.env', 'sub/.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', '.npmrc',
    '.pgpass', '.netrc', 'server.pem', 'privkey.pem', 'tls.key', 'cert.p12',
    '.claude/settings.local.json', '.claude/settings.json', '.config/git/credentials',
    // Claude Code excludes `.git` first, but a later user glob that matches it
    // re-includes the directory (the last matching glob wins).
    '.git/config',
  ]
  const FAMILY_SECRETS = ['.env.zz9', 'q.pem']
  const BENIGN = ['a.ts', 'src/b.ts', 'README.md', 'src/c.py', 'package.json', 'sub/d.js']
  let root
  let rgVersion = ''

  before((t) => {
    if (!RG_PATH) {
      if (process.env.CI) {
        assert.fail('ripgrep is not installed on this CI runner, so the #7978 oracle did not run. Install it in the Server Tests job (see #7295).')
      }
      t.skip('ripgrep is not installed on this machine — the #7978 oracle did NOT run (it is enforced in CI).')
      return
    }
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-7978-oracle-')))
    for (const file of [...EXACT_SECRETS, ...FAMILY_SECRETS, ...BENIGN]) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), 'KEY=1\n')
    }
    writeFileSync(join(root, '.gitignore'), [...EXACT_SECRETS, ...FAMILY_SECRETS].join('\n') + '\n')
    // A .git DIRECTORY (not a repo) is what makes ripgrep honour .gitignore.
    mkdirSync(join(root, '.git'), { recursive: true })
    rgVersion = spawnSync(RG_PATH, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0]
  })

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  // The files ripgrep would read for `glob`, run as Claude Code runs it
  // (`--hidden`, VCS dirs excluded first) and as the BYOK executor runs it.
  function rgReads(glob) {
    // Claude Code's reading: whitespace, then commas unless the piece holds a
    // {...} group, each piece its own --glob after its `!.git` exclusion.
    const pieces = []
    for (const piece of glob.split(/\s+/)) {
      if (piece.includes('{') && piece.includes('}')) pieces.push(piece)
      else pieces.push(...piece.split(',').filter(Boolean))
    }
    const styles = [
      ['--hidden', '--glob', '!.git', ...pieces.flatMap((p) => ['--glob', p])],
      ['--glob', glob],
    ]
    const read = new Set()
    for (const style of styles) {
      const r = spawnSync(RG_PATH, ['--no-config', '--files', ...style, '.'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
      // 0 = files listed, 1 = none. 2 with a glob parse error = ripgrep refused
      // the glob and read nothing. Anything else is a broken oracle, not "none".
      if (r.status === 2 && /glob|brace|character class/i.test(String(r.stderr))) continue
      assert.ok(r.status === 0 || r.status === 1, `rg failed for ${JSON.stringify(glob)}: status=${r.status} ${String(r.stderr).slice(0, 200)}`)
      for (const line of r.stdout.split('\n')) if (line) read.add(line.replace(/^\.\//, ''))
    }
    return read
  }

  // Glob variants of `name`, each of which keeps at least one character of the
  // name as a literal, `?` or class (no variant is pure `*`).
  function variants(name) {
    const out = new Set([name, name.toUpperCase(), `**/${name}`, `*${name}`, `${name}*`, `{zz.ts,${name}}`])
    const base = name.slice(name.lastIndexOf('/') + 1)
    const dir = name.slice(0, name.length - base.length)
    for (let i = 0; i < base.length; i++) {
      const ch = base[i]
      if (ch === '.' || ch === '/') continue
      const at = (s) => dir + base.slice(0, i) + s + base.slice(i + 1)
      out.add(at('?'))
      out.add(at(`[${ch}]`))
      out.add(at(`[${ch.toUpperCase()}]`))
      out.add(at('[!/]'))
      out.add(at('*'))
    }
    return [...out]
  }

  it('sound against the exact secrets, over the issue rows, measured shapes and generated variants', (t) => {
    if (!root) return t.skip('no ripgrep')
    t.diagnostic(`oracle: ${rgVersion} at ${RG_PATH}`)
    const globs = new Set([
      '.env', '*.env', '**/.env*', '.e?v', '.[e]nv', '*', '**', '**/*', '*.*', 'sub/*',
      '*env*', '*.json', '.claude/*', '*.local', 'privkey*', '*.pem', 'id_*',
    ])
    for (const secret of EXACT_SECRETS) for (const v of variants(secret)) globs.add(v)
    const unsound = []
    let secretReads = 0
    for (const glob of globs) {
      const read = rgReads(glob)
      if (!EXACT_SECRETS.some((s) => read.has(s))) continue
      secretReads += 1
      if (!grepFloored(glob)) unsound.push(glob)
    }
    assert.ok(secretReads >= 100, `non-vacuity: ripgrep must actually read a secret for many globs (got ${secretReads})`)
    assert.deepEqual(unsound, [])
  })

  it('sound against family members wherever the glob spells the family\'s defining part', (t) => {
    if (!root) return t.skip('no ripgrep')
    // For `.env.zz9` keep one of `.env` literal; for `q.pem` keep one of `.pem`.
    const spelled = [
      '.env.*', '.[e]nv.*', '.e?v.zz9', '.en[v].z?9', '*v.zz9', '.env*', '*.env.zz?',
      'q.p?m', '?.pem', '*.[p]em', 'q.pe[m]', '*m', 'q*.pem',
    ]
    const unsound = []
    let secretReads = 0
    for (const glob of spelled) {
      const read = rgReads(glob)
      if (!FAMILY_SECRETS.some((s) => read.has(s))) continue
      secretReads += 1
      if (!grepFloored(glob)) unsound.push(glob)
    }
    assert.ok(secretReads >= 10, `non-vacuity (got ${secretReads})`)
    assert.deepEqual(unsound, [])
  })

  it('the controls read no secret, and are not floored', (t) => {
    if (!root) return t.skip('no ripgrep')
    for (const glob of ['*.ts', '*.{ts,tsx}', '**/*.js', 'src/**/*.py', '*.md', 'README*', '!.env']) {
      const read = [...rgReads(glob)]
      assert.equal(read.some((f) => EXACT_SECRETS.includes(f) || FAMILY_SECRETS.includes(f)), false, `oracle: ${glob} reads no secret`)
      assert.equal(grepFloored(glob), false, `floor: ${glob}`)
    }
    // And the oracle can see a benign read at all.
    assert.ok(rgReads('*.ts').has('a.ts'), 'oracle sanity: *.ts reads a.ts')
  })

  it('the accepted residual is exactly what the floor documents: an extension filter hitting an unusual gitignored .env.<ext>', (t) => {
    if (!root) return t.skip('no ripgrep')
    writeFileSync(join(root, '.env.ts'), 'KEY=1\n')
    writeFileSync(join(root, '.gitignore'), '.env.ts\n', { flag: 'a' })
    try {
      assert.ok(rgReads('*.ts').has('.env.ts'), 'ripgrep does read it')
      assert.equal(grepFloored('*.ts'), false, 'and the floor lets it through, by design')
    } finally {
      rmSync(join(root, '.env.ts'))
    }
  })

  it('the same residual through a DIRECTORY: `{*.d,*.conf}` re-includes a gitignored .env.d/', (t) => {
    if (!root) return t.skip('no ripgrep')
    mkdirSync(join(root, '.env.d'))
    writeFileSync(join(root, '.env.d', 'app.conf'), 'KEY=1\n')
    writeFileSync(join(root, '.gitignore'), '.env.d/\n', { flag: 'a' })
    try {
      assert.ok(rgReads('{*.d,*.conf}').has('.env.d/app.conf'), 'ripgrep does read it')
      assert.equal(grepFloored('{*.d,*.conf}'), false, 'documented residual: `*` swallowed the `.env`')
    } finally {
      rmSync(join(root, '.env.d'), { recursive: true, force: true })
    }
  })

  // PR #7980 review: the hand-built variants never produced the shapes that
  // actually got through (single braces, classes matching `/`, `\` in a class,
  // trailing U+0085). A seeded differential fuzz against ripgrep generates them
  // without anyone having to think of them first.
  it('seeded fuzz: no generated glob that makes ripgrep read an exact secret is left unfloored', (t) => {
    if (!root) return t.skip('no ripgrep')
    let seed = 0x7978
    const rand = () => {
      seed = (seed + 0x6D2B79F5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
    const pick = (list) => list[Math.floor(rand() * list.length)]
    const META = ['*', '**', '?', '{', '}', ',', '[', ']', '[!x]', '[/]', '\\', '\u0085', '/', '!', '{,}', '{x}']
    const mutate = (name) => {
      let g = name
      const ops = 1 + Math.floor(rand() * 3)
      for (let k = 0; k < ops; k++) {
        const i = Math.floor(rand() * (g.length + 1))
        switch (Math.floor(rand() * 7)) {
          case 0: g = g.slice(0, i) + pick(META) + g.slice(i + 1); break
          case 1: g = g.slice(0, i) + pick(META) + g.slice(i); break
          case 2: g = `{${g}}`; break
          case 3: g = `{${g},${pick(['*.ts', '', 'x'])}}`; break
          case 4: g = g.slice(0, i) + `[${g[i] ?? 'x'}]` + g.slice(i + 1); break
          case 5: g = g + pick(['\u0085', '{}', '*', ' ']); break
          default: g = pick(['*.ts ', '**/', '*/', '']) + g
        }
      }
      return g
    }
    const globs = new Set()
    while (globs.size < 300) globs.add(mutate(pick(EXACT_SECRETS)))
    for (let n = 0; n < 60; n++) {
      let g = ''
      const len = 1 + Math.floor(rand() * 5)
      for (let k = 0; k < len; k++) g += pick([...META, '.', 'e', 'n', 'v', 'env'])
      globs.add(g)
    }
    const unsound = []
    let secretReads = 0
    for (const glob of globs) {
      if (!EXACT_SECRETS.some((s) => rgReads(glob).has(s))) continue
      secretReads += 1
      if (!grepFloored(glob)) unsound.push(JSON.stringify(glob))
    }
    t.diagnostic(`fuzz: ${globs.size} globs, ${secretReads} read an exact secret`)
    assert.ok(secretReads >= 60, `non-vacuity: the fuzz must hit many secret reads (got ${secretReads})`)
    assert.deepEqual(unsound.slice(0, 20), [], `${unsound.length} unsound`)
  })
})
