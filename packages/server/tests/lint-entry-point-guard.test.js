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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
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
    test('the wrapper\'s --min-files floor is not stale', () => {
      const res = spawnSync(
        process.execPath,
        [LINT_SCRIPT, '--min-files', '1500'],
        { encoding: 'utf8' },
      )
      assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`)
    })
  })
})
