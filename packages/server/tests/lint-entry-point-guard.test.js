/**
 * Tests for scripts/lint-entry-point-guard.mjs (#7235).
 *
 * The lint enforces "there are only three": entry-point-ness is decided in the
 * three un-mergeable copies of the guard and nowhere else. Its companion, the
 * drift gate in scripts/__tests__/is-entry-point.test.mjs, enforces "the three
 * agree" — and iterates a hardcoded list, which is exactly why this exists.
 *
 * Strategy: build a temp fixture tree, run the lint against it as a child
 * process with `--repo-root`, and assert the EXIT CODE. Never the output — a
 * `grep -c` over stdout reports grep's status, not the lint's
 * (docs/false-safety-guards.md).
 *
 * `--repo-root` points the SAME walk at a fixture tree rather than adding a
 * second enumeration path, so what these tests exercise is what CI runs.
 *
 * Every exemption below carries a POSITIVE CONTROL — the same fixture WITHOUT
 * the thing that is supposed to exempt it, proving the case would have failed
 * and that the exemption is what saved it. "This passes" passes just as happily
 * against a lint that detects nothing.
 *
 * NOTE: this file is itself allowlisted in the lint's SANCTIONED set, because
 * the fixture sources below spell the banned shapes literally and the lint's
 * walk is repo-wide. That exemption is the one hole in the walk; it is listed
 * where a reader will see it, and the lint's stale-allowlist check fails if this
 * file ever stops containing them.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-entry-point-guard.mjs')

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

// A real guard body, used as the fixture's sanctioned copy so the allowlist is
// never stale for the wrong reason. Trimmed from scripts/lib/is-entry-point.mjs.
const SANCTIONED_GUARD = `
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function isEntryPoint (importMetaUrl) {
  if (!process.argv[1]) return false
  const self = fileURLToPath(importMetaUrl)
  const invoked = resolve(process.argv[1])
  if (self === invoked) return true
  try {
    return realpathSync(self) === realpathSync(invoked)
  } catch {
    return false
  }
}
`

/**
 * Build a fixture tree and run the lint against it.
 *
 * `lib/guard.mjs` is always written and always allowlisted, so the
 * stale-allowlist rule is satisfied unless a test deliberately breaks it.
 *
 * @param {Record<string,string>} files repo-relative path -> source
 * @param {{allow?: string[], extraArgs?: string[], withGuard?: boolean}} [opts]
 */
function runLint(files, opts = {}) {
  const { allow = ['lib/guard.mjs'], extraArgs = [], withGuard = true } = opts
  const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-entrypoint-'))
  tmpRoots.push(root)

  const all = withGuard ? { 'lib/guard.mjs': SANCTIONED_GUARD, ...files } : { ...files }
  for (const [rel, source] of Object.entries(all)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, source)
  }

  const args = ['--repo-root', root]
  for (const a of allow) args.push('--allow', a)
  args.push(...extraArgs)

  const res = spawnSync(process.execPath, [LINT_SCRIPT, ...args], { encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', root }
}

describe('lint-entry-point-guard', () => {
  describe('the banned shapes', () => {
    // The shape all four #7198 copies had, and the one a fourth copy is most
    // likely to be pasted from.
    test('catches the index read', () => {
      const { status } = runLint({
        'src/thing.js': `
          import { pathToFileURL } from 'node:url'
          if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
        `,
      })
      assert.equal(status, 1)
    })

    test('catches the .at(1) spelling', () => {
      const { status } = runLint({
        'src/thing.js': `
          import { fileURLToPath } from 'node:url'
          if (fileURLToPath(import.meta.url) === process.argv.at(1)) main()
        `,
      })
      assert.equal(status, 1)
    })

    // Binds the script slot without ever naming an index, so index-matching
    // alone would walk straight past it.
    test('catches positional destructuring of the script slot', () => {
      const { status } = runLint({
        'src/thing.js': `
          const [, invokedScript] = process.argv
          if (invokedScript === __filename) main()
        `,
      })
      assert.equal(status, 1)
    })

    test('catches import.meta.main', () => {
      const { status } = runLint({
        'src/thing.js': 'if (import.meta.main) main()\n',
      })
      assert.equal(status, 1)
    })

    // `\\s*` spans newlines in every rule, so a prettier-wrapped or hand-broken
    // guard is not a hole. A line-oriented lint would miss all three of these.
    test('catches shapes broken across lines', () => {
      for (const source of [
        'if (process.argv\n  [1] === __filename) main()\n',
        'if (process\n  .argv\n  .at(1) === __filename) main()\n',
        'const [\n  ,\n  script,\n] = process.argv\n',
      ]) {
        const { status } = runLint({ 'src/thing.js': source })
        assert.equal(status, 1, `not caught: ${JSON.stringify(source)}`)
      }
    })

    // The fourth copy would not necessarily be in packages/server. Two of the
    // three sanctioned copies already are not.
    test('catches a guard anywhere in the tree, not just under src/', () => {
      for (const rel of [
        'scripts/tool.mjs',
        'packages/dashboard/scripts/build.js',
        'packages/store-core/src/cli.ts',
        'packages/app/.maestro/mock-server.mjs',
      ]) {
        const { status } = runLint({ [rel]: 'if (process.argv[1]) main()\n' })
        assert.equal(status, 1, `not caught at ${rel}`)
      }
    })

    // The case that killed the raw-text prefilter. A comment INSIDE the
    // expression leaves the raw source without the substring the prefilter
    // looked for, while the stripped source still matches — so the file was
    // skipped and the tree reported clean. Contrived as a hand-written shape,
    // but "skipped an input" is a false-safety mode this repo has shipped
    // three times, and the prefilter only bought 260ms.
    test('catches a shape whose raw text is broken up by an inline comment', () => {
      for (const source of [
        'if (process./* which */argv[1] === __filename) main()\n',
        'if (import./* native */meta.main) main()\n',
      ]) {
        const { status } = runLint({ 'src/thing.js': source })
        assert.equal(status, 1, `not caught: ${JSON.stringify(source)}`)
      }
    })

    test('reports the offending file and line', () => {
      const { status, stderr } = runLint({
        'src/thing.js': '\n\nif (process.argv[1] === __filename) main()\n',
      })
      assert.equal(status, 1)
      assert.match(stderr, /src\/thing\.js:3\s+\[argv1-index]/)
    })
  })

  describe('what it deliberately leaves alone', () => {
    // Each of these needs its negative asserted AND a positive control, or the
    // assertion passes identically against a lint that detects nothing.
    test('a clean tree passes', () => {
      const { status } = runLint({
        'src/thing.js': "import { isEntryPoint } from './guard.mjs'\nif (isEntryPoint(import.meta.url)) main()\n",
      })
      assert.equal(status, 0)
    })

    test('require.main === module is fine (CJS compares module objects)', () => {
      const { status } = runLint({
        'src/thing.cjs': 'if (require.main === module) main()\n',
      })
      assert.equal(status, 0)
    })

    test('positive control: the same file reading the script slot DOES fail', () => {
      const { status } = runLint({
        'src/thing.cjs': 'if (require.main === module) main()\nconst me = process.argv[1]\n',
      })
      assert.equal(status, 1)
    })

    test('ordinary argument parsing is fine', () => {
      const { status } = runLint({
        'src/thing.js': 'const args = process.argv.slice(2)\nconst [,, cmd] = process.argv\n',
      })
      assert.equal(status, 0)
    })

    test('positive control: moving the binding to position 1 DOES fail', () => {
      const { status } = runLint({
        'src/thing.js': 'const args = process.argv.slice(2)\nconst [, cmd] = process.argv\n',
      })
      assert.equal(status, 1)
    })

    test('a rest element at position 1 is out of scope (documented boundary)', () => {
      const { status } = runLint({
        'src/thing.js': 'const [, ...rest] = process.argv\n',
      })
      assert.equal(status, 0)
    })

    // Every copy of the guard, and the lint itself, discuss the banned shapes
    // in prose. Without this the lint would be unusable on its own repo.
    test('prose in comments is not code', () => {
      const { status } = runLint({
        'src/thing.js': `
          // Never compare import.meta.url against process.argv[1] by hand.
          /* The old code did: if (process.argv[1] === __filename) main() */
          export const x = 1
        `,
      })
      assert.equal(status, 0)
    })

    test('positive control: the same text UNCOMMENTED does fail', () => {
      const { status } = runLint({
        'src/thing.js': 'if (process.argv[1] === __filename) main()\nexport const x = 1\n',
      })
      assert.equal(status, 1)
    })

    // .sh is not walked: docker-entrypoint.sh passes a config path as the first
    // argument to `node -e`, where the slot means something else entirely.
    test('shell sources are not walked', () => {
      const { status } = runLint({
        'scripts/entry.sh': 'node -e "console.log(process.argv[1])" "$CONFIG"\n',
      })
      assert.equal(status, 0)
    })

    test('positive control: the same content in a .mjs IS walked', () => {
      const { status } = runLint({
        'scripts/entry.mjs': 'console.log(process.argv[1])\n',
      })
      assert.equal(status, 1)
    })
  })

  describe('exemptions', () => {
    test('a sanctioned copy is exempt', () => {
      const { status } = runLint(
        { 'src/utils/is-entry-point.js': SANCTIONED_GUARD },
        { allow: ['lib/guard.mjs', 'src/utils/is-entry-point.js'] },
      )
      assert.equal(status, 0)
    })

    test('positive control: the same file un-allowlisted fails', () => {
      const { status } = runLint({ 'src/utils/is-entry-point.js': SANCTIONED_GUARD })
      assert.equal(status, 1)
    })

    test('the ignore marker exempts one site', () => {
      const { status } = runLint({
        'src/thing.js': '// lint-ignore-entry-point-guard: prints its own usage line\nconsole.log(process.argv[1])\n',
      })
      assert.equal(status, 0)
    })

    test('positive control: the same line without the marker fails', () => {
      const { status } = runLint({
        'src/thing.js': '// prints its own usage line\nconsole.log(process.argv[1])\n',
      })
      assert.equal(status, 1)
    })

    // The marker must be a DIRECTIVE, not a mention. lint-config-dir.mjs shipped
    // with the substring bug and its own docstring silently exempted whatever
    // followed it.
    test('the marker merely MENTIONED in prose does not exempt', () => {
      const { status } = runLint({
        'src/thing.js': '// You could add lint-ignore-entry-point-guard here, but do not.\nconsole.log(process.argv[1])\n',
      })
      assert.equal(status, 1)
    })

    test('the marker only covers the line below it, not the whole file', () => {
      const { status } = runLint({
        'src/thing.js': [
          '// lint-ignore-entry-point-guard: usage line',
          'console.log(process.argv[1])',
          'if (process.argv[1] === __filename) main()',
        ].join('\n') + '\n',
      })
      assert.equal(status, 1)
    })
  })

  describe('the allowlist ratchet', () => {
    // An exemption nothing needs is an exemption the next regression hides
    // behind — the same rule lint-config-dir.mjs applies to its baseline.
    test('an allowlisted file with no guard left in it is stale, and fails', () => {
      const { status, stderr } = runLint(
        { 'src/former-guard.js': 'export const x = 1\n' },
        { allow: ['lib/guard.mjs', 'src/former-guard.js'] },
      )
      assert.equal(status, 1)
      assert.match(stderr, /former-guard\.js: allowlisted .* but contains none/)
    })

    test('an allowlisted path that does not exist is a broken guard, not dirty code', () => {
      const { status } = runLint({}, { allow: ['lib/guard.mjs', 'src/gone.js'] })
      assert.equal(status, 2)
    })
  })

  describe('failing closed', () => {
    // "The guard broke" must never be shown as "the guard passed", and must not
    // be shown as "the code is dirty" either — hence 2, distinct from 1.
    test('an unknown flag exits 2 rather than silently walking the real repo', () => {
      const { status } = runLint({}, { extraArgs: ['--reporoot', '/tmp/typo'] })
      assert.equal(status, 2)
    })

    test('a flag missing its value exits 2', () => {
      const { status } = runLint({}, { extraArgs: ['--min-files'] })
      assert.equal(status, 2)
    })

    test('a non-integer --min-files exits 2', () => {
      const { status } = runLint({}, { extraArgs: ['--min-files', 'lots'] })
      assert.equal(status, 2)
    })

    test('a --repo-root that does not exist exits 2', () => {
      const res = spawnSync(
        process.execPath,
        [LINT_SCRIPT, '--repo-root', join(tmpdir(), 'chroxy-no-such-root-7235')],
        { encoding: 'utf8' },
      )
      assert.equal(res.status, 2)
    })

    // Walking zero files and walking a clean tree used to be the same
    // observable outcome in this repo's lints, three separate times.
    test('walking zero files exits 2 rather than reporting a clean tree', () => {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-entrypoint-empty-'))
      tmpRoots.push(root)
      const res = spawnSync(
        process.execPath,
        [LINT_SCRIPT, '--repo-root', root, '--allow', 'nothing.js'],
        { encoding: 'utf8' },
      )
      assert.equal(res.status, 2)
    })

    test('a --min-files floor above the walk exits 2', () => {
      const { status } = runLint(
        { 'src/thing.js': 'export const x = 1\n' },
        { extraArgs: ['--min-files', '500'] },
      )
      assert.equal(status, 2)
    })

    test('positive control: a floor the walk clears does not', () => {
      const { status } = runLint(
        { 'src/thing.js': 'export const x = 1\n' },
        { extraArgs: ['--min-files', '2'] },
      )
      assert.equal(status, 0)
    })
  })

  describe('--dry-run', () => {
    test('reports offenders without failing', () => {
      const { status, stderr } = runLint(
        { 'src/thing.js': 'if (process.argv[1] === __filename) main()\n' },
        { extraArgs: ['--dry-run'] },
      )
      assert.equal(status, 0)
      assert.match(stderr, /argv1-index/)
    })
  })

  describe('against the real repository', () => {
    // The end-to-end case: default flags, default allowlist, the actual tree.
    // If SANCTIONED drifts from reality — a guard copy renamed, a fourth one
    // landed — this is what says so.
    test('the repo is clean under the shipped defaults', () => {
      const res = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8' })
      assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`)
      assert.match(res.stdout, /^OK: \d+ file\(s\) walked/)
    })

    // The floor the CI wrapper passes must actually be clearable, or Server Lint
    // fails on exit 2 for a reason that has nothing to do with the code.
    //
    // The floor is PARSED OUT of the wrapper rather than repeated here. The
    // first version hardcoded '1500', and mutation proved it blind: setting the
    // wrapper to `--min-files 99999` made the real CI step exit 2 while this
    // test stayed green. Two hardcoded copies of one value is this file's own
    // subject matter, one level down.
    test("the wrapper's --min-files floor is clearable by the real walk", () => {
      const wrapper = readFileSync(resolve(__dirname, '..', 'scripts', 'lint-entry-point-guard.sh'), 'utf8')
      const m = /--min-files\s+(\d+)/.exec(wrapper)
      assert.ok(m, 'could not find --min-files in the wrapper — this test is checking nothing')
      const res = spawnSync(process.execPath, [LINT_SCRIPT, '--min-files', m[1]], { encoding: 'utf8' })
      assert.equal(res.status, 0, `floor ${m[1]} from the wrapper is not clearable:\n${res.stdout}\n${res.stderr}`)
    })
  })

  // --- #7247 review: the identifier, not the `process.` prefix ---------------
  //
  // The first version of every rule required the literal `process` before
  // `.argv`. Review proved that hole live: `import { argv } from 'node:process'`
  // is Node's own documented idiom and TWO scripts in this repo already use it
  // (scripts/merge-updater-feeds.mjs,
  // packages/server/scripts/spike-mcp-elicitation-shim.mjs), both executable and
  // guard-less. The next guard written in either would have been spelled
  // `argv[1]` and been invisible.
  describe('spellings that never name `process`', () => {
    const CAUGHT = {
      'bare argv from node:process': "import { argv } from 'node:process'\nif (argv[1] === __filename) main()\n",
      'destructured from process': 'const { argv } = process\nif (argv[1] === __filename) main()\n',
      'aliased holder': 'const a = process.argv\nif (a[1] === __filename) main()\n',
      'renamed import': "import { argv as av } from 'node:process'\nif (av[1] === __filename) main()\n",
      'optional chain on the index': 'if (process.argv?.[1] === __filename) main()\n',
      'optional chain on process': 'if (process?.argv[1] === __filename) main()\n',
      'globalThis reach': 'if (globalThis.process.argv[1] === __filename) main()\n',
      'bare argv .at(1)': "import { argv } from 'node:process'\nif (argv.at(1) === __filename) main()\n",
      'optional import.meta?.main': 'if (import.meta?.main) main()\n',
    }
    for (const [name, source] of Object.entries(CAUGHT)) {
      test(`catches ${name}`, () => {
        assert.equal(runLint({ 'src/thing.js': source }).status, 1)
      })
    }

    // The boundary: `argv` is only banned when index 1 is actually read. A yargs
    // -style parsed object called `argv` is ordinary code, and flagging it would
    // put a false positive in a required check.
    test('leaves a parsed `argv` object alone when index 1 is never read', () => {
      const { status } = runLint({
        'src/thing.js': 'const argv = parse(process.argv.slice(2))\nconsole.log(argv.verbose, argv[0], argv.at(2))\n',
      })
      assert.equal(status, 0)
    })

    test('positive control: the same file reading index 1 does fail', () => {
      const { status } = runLint({
        'src/thing.js': 'const argv = parse(process.argv.slice(2))\nconsole.log(argv[1])\n',
      })
      assert.equal(status, 1)
    })
  })

  // --- #7247 review: the stripper must not be fooled by a regex literal ------
  //
  // The hand-written stripper this lint shipped with could not tell a regex
  // literal from a comment delimiter, and was unsound in BOTH directions on real
  // files. Measured over the 1903 files this lint walks: 83 differed from the
  // truth, 40 hiding real code and 51 leaking comment text. These two tests are
  // one of each; either regresses the moment the stripper stops using a parser.
  describe('regex literals do not desync the comment stripper', () => {
    // `\/` leaves a `/`, the next char is `*`, and a character scanner reads
    // `/*` as a BLOCK COMMENT OPEN — blanking the guard below it into silence.
    test('a guard below a trailing-slash regex is still found', () => {
      const { status } = runLint({
        'src/thing.js': "export function n (u) { return u.replace(/\\/*$/, '') }\n"
          + 'if (import.meta.url === p(process.argv[1]).href) main()\n',
      })
      assert.equal(status, 1)
    })

    // The mirror image: a quote inside a character class put the scanner into a
    // phantom STRING state, so it stopped blanking comments and ordinary prose
    // read as code — a spurious red in a required check.
    test('prose below a quote-bearing regex is still a comment', () => {
      const { status } = runLint({
        'src/thing.js': 'const M = /(["])/g\n'
          + '// prose mentioning process.argv[1] in an ordinary comment\n'
          + 'export const x = 1\n',
      })
      assert.equal(status, 0)
    })

    test('positive control: the same prose as CODE still fails', () => {
      const { status } = runLint({
        'src/thing.js': 'const M = /(["])/g\nconst me = process.argv[1]\n',
      })
      assert.equal(status, 1)
    })
  })

  describe('the sanctioned files are exempt, but not unconditionally', () => {
    // The whole-file exemption is a hole: sidecar/agent.js is 1339 lines of
    // in-pod application that merely CONTAINS the guard, so a SECOND hand-rolled
    // guard anywhere else in it would be exempt here and invisible to the drift
    // gate, which only extracts the one body. The three copies are therefore
    // held to the same site COUNT — no hardcoded number, because the drift gate
    // already proves the bodies identical.
    test('a second guard inside a sanctioned copy breaks the count', () => {
      const extra = SANCTIONED_GUARD + '\nif (process.argv[1] === __filename) diagnostics()\n'
      const { status, stderr } = runLint(
        { 'lib/a.mjs': SANCTIONED_GUARD, 'lib/b.mjs': extra },
        {
          withGuard: false,
          allow: ['lib/a.mjs', 'lib/b.mjs'],
          extraArgs: ['--guard-copy', 'lib/a.mjs', '--guard-copy', 'lib/b.mjs'],
        },
      )
      assert.equal(status, 1)
      assert.match(stderr, /disagree on how many sites/)
    })

    test('positive control: identical copies pass the count check', () => {
      const { status } = runLint(
        { 'lib/a.mjs': SANCTIONED_GUARD, 'lib/b.mjs': SANCTIONED_GUARD },
        {
          withGuard: false,
          allow: ['lib/a.mjs', 'lib/b.mjs'],
          extraArgs: ['--guard-copy', 'lib/a.mjs', '--guard-copy', 'lib/b.mjs'],
        },
      )
      assert.equal(status, 0)
    })

    test('a --guard-copy outside the sanctioned set exits 2', () => {
      const { status } = runLint({}, { extraArgs: ['--guard-copy', 'lib/nope.mjs'] })
      assert.equal(status, 2)
    })
  })

  describe('more ways to fail closed', () => {
    // The marker must be a real comment, not text that merely looks like one.
    // Written inside a template literal it satisfies the raw-line regex while
    // being a string, so the stripper has to confirm the line was blanked.
    test('a marker faked inside a template literal does not exempt', () => {
      const { status } = runLint({
        'src/thing.js': 'const s = `\n// lint-ignore-entry-point-guard\n${process.argv[1]}`\n',
      })
      assert.equal(status, 1)
    })

    // An unreadable file is "could not check", never "nothing to check". Before
    // this the EACCES escaped uncaught, node exited 1, and the CI step reported
    // a hand-rolled guard that did not exist.
    test('an unreadable file exits 2, not 1', { skip: process.getuid?.() === 0 && 'running as root' }, () => {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-entrypoint-eacces-'))
      tmpRoots.push(root)
      mkdirSync(join(root, 'lib'), { recursive: true })
      writeFileSync(join(root, 'lib', 'guard.mjs'), SANCTIONED_GUARD)
      const locked = join(root, 'src', 'locked.js')
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(locked, 'export const x = 1\n')
      chmodSync(locked, 0o000)
      try {
        const res = spawnSync(
          process.execPath,
          [LINT_SCRIPT, '--repo-root', root, '--allow', 'lib/guard.mjs'],
          { encoding: 'utf8' },
        )
        assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`)
      } finally {
        chmodSync(locked, 0o644)
      }
    })

    test('.mts and .cts are walked', () => {
      for (const rel of ['src/tool.mts', 'src/tool.cts']) {
        const { status } = runLint({ [rel]: 'if (process.argv[1]) main()\n' })
        assert.equal(status, 1, `not walked: ${rel}`)
      }
    })
  })


  // --- #7247 post-merge: generated output is not the repository ------------
  //
  // The first version walked the filesystem, which is not the same set as "the
  // repository". `packages/desktop/src-tauri/server-bundle/` is GENERATED and
  // gitignored, and it holds a stale pre-#7217 copy of the whole server — two of
  // the original buggy guards included. A fresh CI checkout has no bundle, so CI
  // stayed green while anyone who had built the desktop app got a red Server
  // Lint from files they never wrote.
  //
  // A name in SKIP_DIRS would have fixed that one directory and left the next
  // generated tree to rediscover it, which is the hardcoded-list failure this
  // lint exists to prevent. Asking git is the actual rule.
  describe('gitignored output is not walked', () => {
    /** A fixture tree that is a real git repo, so the ignore rules are real. */
    function gitFixture(files, gitignore) {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-entrypoint-git-'))
      tmpRoots.push(root)
      const run = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' })
      run('init', '-q')
      // Auto-gc racing the teardown is a known source of ENOTEMPTY flakes here.
      run('config', 'gc.auto', '0')
      writeFileSync(join(root, '.gitignore'), gitignore)
      mkdirSync(join(root, 'lib'), { recursive: true })
      writeFileSync(join(root, 'lib', 'guard.mjs'), SANCTIONED_GUARD)
      for (const [rel, source] of Object.entries(files)) {
        const full = join(root, rel)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, source)
      }
      const res = spawnSync(
        process.execPath,
        [LINT_SCRIPT, '--repo-root', root, '--allow', 'lib/guard.mjs'],
        { encoding: 'utf8' },
      )
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' }
    }

    const GUARD = 'if (process.argv[1] === __filename) main()\n'

    test('a guard inside gitignored output is not reported', () => {
      const { status } = gitFixture({ 'generated/bundle/thing.js': GUARD }, 'generated/\n')
      assert.equal(status, 0)
    })

    // Positive control, and the one that matters: the exemption must come from
    // the ignore rule, not from the path being generated-looking or the walk
    // quietly missing it.
    test('positive control: the same file NOT ignored is reported', () => {
      const { status, stderr } = gitFixture({ 'generated/bundle/thing.js': GUARD }, 'something-else/\n')
      assert.equal(status, 1)
      assert.match(stderr, /generated\/bundle\/thing\.js/)
    })

    // A committed file always counts, even if a broad ignore rule would match
    // it — `git ls-files --cached` lists it regardless.
    test('a TRACKED file matching an ignore rule is still reported', () => {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-entrypoint-tracked-'))
      tmpRoots.push(root)
      const run = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' })
      run('init', '-q')
      run('config', 'gc.auto', '0')
      mkdirSync(join(root, 'lib'), { recursive: true })
      writeFileSync(join(root, 'lib', 'guard.mjs'), SANCTIONED_GUARD)
      mkdirSync(join(root, 'generated'), { recursive: true })
      writeFileSync(join(root, 'generated', 'thing.js'), GUARD)
      writeFileSync(join(root, '.gitignore'), 'generated/\n')
      run('add', '-f', 'generated/thing.js')
      const res = spawnSync(
        process.execPath,
        [LINT_SCRIPT, '--repo-root', root, '--allow', 'lib/guard.mjs'],
        { encoding: 'utf8' },
      )
      assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`)
    })

    // Every other test in this file points --repo-root at a plain temp dir that
    // is NOT a repo. They all pass, which is this assertion's real proof: when
    // git cannot answer, nothing is filtered and coverage only widens. Stated
    // explicitly so the fallback is not mistaken for an accident.
    test('a non-repo root filters nothing rather than dropping everything', () => {
      const { status } = runLint({ 'src/thing.js': GUARD })
      assert.equal(status, 1)
    })
  })

})
