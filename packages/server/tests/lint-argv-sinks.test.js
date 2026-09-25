/**
 * Tests for scripts/lint-argv-sinks.mjs (#7868).
 *
 * The lint gates every child_process spawn/execFile/execFileSync/spawnSync
 * argv sink (and every `_buildArgs`/`build*Args`-shaped function) in
 * packages/server/src: a non-constant element must be provably safe (a
 * `assertSafeArgvValue`/`isSafeArgvValue` guard on the same value, a `--`
 * terminator before it, or a fused `--flag=`/`key=` token) or catalogued in
 * `AUDITED_SINKS` with a reason.
 *
 * Strategy: run the lint as a child process against a temp fixture `src/`
 * tree (`--src-dir`) and an optional temp catalogue module (`--catalogue`),
 * and assert the EXIT CODE, not just the printed text — matching
 * lint-config-dir.test.js's convention. Every positive result below carries a
 * POSITIVE CONTROL proving the case would have failed without the thing
 * that's supposed to save it, per docs/false-safety-guards.md.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-argv-sinks.mjs')
const REAL_CATALOGUE = resolve(__dirname, '..', 'src', 'utils', 'argv-safety.js')

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

/**
 * Build a fixture src/ tree (and optionally a catalogue module) and run the
 * lint against it.
 * @param {Record<string,string>} files repo-relative path -> source
 * @param {{ catalogue?: string, extraArgs?: string[] }} [opts]
 */
function runLint(files, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-argvsinks-'))
  tmpRoots.push(root)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })

  for (const [rel, source] of Object.entries(files)) {
    const full = join(srcDir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, source)
  }

  const args = [LINT_SCRIPT, '--src-dir', srcDir]
  if (opts.catalogue !== undefined) {
    const cataloguePath = join(root, 'catalogue.mjs')
    writeFileSync(cataloguePath, opts.catalogue)
    args.push('--catalogue', cataloguePath)
  } else {
    args.push('--catalogue', REAL_CATALOGUE)
  }
  args.push(...(opts.extraArgs ?? []))

  const res = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const EMPTY_CATALOGUE = 'export const AUDITED_SINKS = []\n'

// ─── Fixture sources ────────────────────────────────────────────────────────

const UNGUARDED_VARIABLE_ARGV = `
import { execFile } from 'node:child_process'
export function run(userValue) {
  execFile('/usr/bin/git', ['diff', userValue], () => {})
}
`

const GUARDED_VIA_ASSERT = `
import { execFile } from 'node:child_process'
import { assertSafeArgvValue } from './utils/argv-safety.js'
export function run(userValue) {
  assertSafeArgvValue(userValue, 'value')
  execFile('/usr/bin/git', ['diff', userValue], () => {})
}
`

const GUARDED_VIA_WRAPPER = `
import { execFile } from 'node:child_process'
import { assertSafeArgvValue } from './utils/argv-safety.js'
function assertFieldSafe(value, field) {
  assertSafeArgvValue(value, field)
}
export function run(spec) {
  assertFieldSafe(spec.branch, 'branch')
  execFile('/usr/bin/git', ['checkout', spec.branch], () => {})
}
`

const GUARDED_VIA_TERMINATOR = `
import { execFile } from 'node:child_process'
export function run(text) {
  const args = ['exec', '--json']
  args.push('--', text)
  execFile('/usr/bin/codex', args, () => {})
}
`

const UNGUARDED_NO_TERMINATOR = `
import { execFile } from 'node:child_process'
export function run(text) {
  const args = ['exec', '--json']
  args.push(text)
  execFile('/usr/bin/codex', args, () => {})
}
`

const GUARDED_VIA_FUSED_TOKEN = `
import { execFile } from 'node:child_process'
export function run(text, model) {
  const args = [\`--prompt=\${text}\`]
  if (model) args.push(\`--model=\${model}\`)
  execFile('/usr/bin/gemini', args, () => {})
}
`

const UNGUARDED_BARE_DASH_PREFIX = `
import { execFile } from 'node:child_process'
export function run(text) {
  const args = [\`-\${text}\`]
  execFile('/usr/bin/gemini', args, () => {})
}
`

const CONSTANT_ONLY_ARGV = `
import { execFile } from 'node:child_process'
const FLAG = '--json'
export function run() {
  execFile('/usr/bin/git', ['status', FLAG], () => {})
}
`

const TERNARY_BOTH_BRANCHES_GUARDED = `
import { execFile } from 'node:child_process'
export function run(text, resume) {
  const args = resume
    ? ['exec', 'resume', '--json']
    : ['exec', '--json']
  args.push('--', text)
  execFile('/usr/bin/codex', args, () => {})
}
`

const TERNARY_ONE_BRANCH_UNGUARDED = `
import { execFile } from 'node:child_process'
export function run(text, resume) {
  const args = resume
    ? ['exec', 'resume', text]
    : ['exec', '--json']
  args.push('--', text)
  execFile('/usr/bin/codex', args, () => {})
}
`

const TEMPLATE_MULTI_IDENTIFIER_UNGUARDED = `
import { execFile } from 'node:child_process'
export function run(base, head) {
  execFile('/usr/bin/git', ['diff', \`\${base}..\${head}\`, '--'], () => {})
}
`

const TEMPLATE_MULTI_IDENTIFIER_GUARDED = `
import { execFile } from 'node:child_process'
import { assertSafeArgvValue } from './utils/argv-safety.js'
export function run(base, head) {
  assertSafeArgvValue(base, 'base')
  assertSafeArgvValue(head, 'head')
  execFile('/usr/bin/git', ['diff', \`\${base}..\${head}\`, '--'], () => {})
}
`

const BUILD_ARGS_SHAPED_FUNCTION = `
export function buildFooArgs(text) {
  const args = ['exec', '--json']
  args.push('--', text)
  return args
}
`

const BUILD_ARGS_SHAPED_FUNCTION_UNGUARDED = `
export function buildFooArgs(text) {
  const args = ['exec', '--json']
  args.push(text)
  return args
}
`

const DELEGATES_TO_BUILD_ARGS = `
import { spawn } from 'node:child_process'
import { buildFooArgs } from './build-foo-args.js'
export function run(text) {
  const args = buildFooArgs(text)
  spawn('/usr/bin/foo', args, {})
}
`

const IGNORE_MARKER_ABOVE = `
import { execFile } from 'node:child_process'
export function run(userValue) {
  // argv-safety-ignore: userValue is a fixed internal constant, not client text
  execFile('/usr/bin/git', ['diff', userValue], () => {})
}
`

const OPAQUE_SPREAD_ARGV = `
import { execFile } from 'node:child_process'
export function run(extra) {
  const args = ['diff', ...extra]
  execFile('/usr/bin/git', args, () => {})
}
`

const EXEC_STRING_FORM_NOT_SCANNED = `
import { exec } from 'node:child_process'
export function run(userValue) {
  exec('git diff ' + userValue, () => {})
}
`

describe('lint-argv-sinks', () => {
  describe('required fixtures (issue #7868 acceptance)', () => {
    test('RED: an unguarded new spawn with a variable argv fails', () => {
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /offender\.js:4\s+execFile\(\.\.\.\) argv element `userValue`/)
    })

    test('GREEN: the same shape, guarded via assertSafeArgvValue, passes', () => {
      const r = runLint({ 'clean.js': GUARDED_VIA_ASSERT }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('RED: a catalogue entry that matches no real finding (stale) fails', () => {
      const staleCatalogue = `export const AUDITED_SINKS = [
        { file: 'clean.js', match: 'this text never appears in the fixture', reason: 'stale on purpose' },
      ]\n`
      const r = runLint({ 'clean.js': GUARDED_VIA_ASSERT }, { catalogue: staleCatalogue })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /matches no current finding/)
    })

    test('RED: zero files scanned refuses to report a clean tree', () => {
      const r = runLint({}, { catalogue: EMPTY_CATALOGUE })
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /scanned 0 files/)
    })
  })

  describe('shape 1 — assertSafeArgvValue / isSafeArgvValue', () => {
    test('direct guard call on the same identifier passes', () => {
      const r = runLint({ 'clean.js': GUARDED_VIA_ASSERT }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('one-hop local wrapper function is recognised', () => {
      const r = runLint({ 'clean.js': GUARDED_VIA_WRAPPER }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('a template literal joining two identifiers requires BOTH to be guarded', () => {
      const guarded = runLint({ 'clean.js': TEMPLATE_MULTI_IDENTIFIER_GUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(guarded.status, 0, guarded.stderr)

      // POSITIVE CONTROL: same shape, neither identifier guarded — must fail,
      // proving the pass above came from the guard calls, not from the lint
      // failing to see the template literal at all.
      const unguarded = runLint({ 'offender.js': TEMPLATE_MULTI_IDENTIFIER_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(unguarded.status, 1)
      assert.match(unguarded.stderr, /offender\.js:4/)
    })
  })

  describe('shape 2 — `--` terminator', () => {
    test('a literal \'--\' before the value passes', () => {
      const r = runLint({ 'clean.js': GUARDED_VIA_TERMINATOR }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the identical shape without \'--\' fails', () => {
      const r = runLint({ 'offender.js': UNGUARDED_NO_TERMINATOR }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /offender\.js:5\s+execFile\(\.\.\.\) argv element `text`/)
    })

    test('a ternary where only ONE branch omits the terminator still fails (both branches checked)', () => {
      const r = runLint({ 'offender.js': TERNARY_ONE_BRANCH_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1)
    })

    test('a ternary where BOTH branches are safe (shared push after) passes', () => {
      const r = runLint({ 'clean.js': TERNARY_BOTH_BRANCHES_GUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })
  })

  describe('shape 3 — fused flag/key token', () => {
    test('`--flag=${value}` and a second pushed `--model=` both pass', () => {
      const r = runLint({ 'clean.js': GUARDED_VIA_FUSED_TOKEN }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: a bare `-${value}` with no `=`-delimited fixed prefix still fails', () => {
      // Proves the pass above requires the `=`-anchored prefix specifically,
      // not merely "the element is a template literal".
      const r = runLint({ 'offender.js': UNGUARDED_BARE_DASH_PREFIX }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1)
    })
  })

  describe('constant elements need no gate', () => {
    test('a module-scope const string element passes with no guard at all', () => {
      const r = runLint({ 'clean.js': CONSTANT_ONLY_ARGV }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })
  })

  describe('`_buildArgs` / `build*Args`-shaped functions are audited at their own definition', () => {
    test('a safe build*Args function passes on its own', () => {
      const r = runLint({ 'build-foo-args.js': BUILD_ARGS_SHAPED_FUNCTION }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: an unguarded build*Args function fails', () => {
      const r = runLint({ 'build-foo-args.js': BUILD_ARGS_SHAPED_FUNCTION_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /buildFooArgs \(return\)/)
    })

    test('a spawn call site that delegates to it is not double-flagged as opaque', () => {
      const r = runLint({
        'build-foo-args.js': BUILD_ARGS_SHAPED_FUNCTION,
        'runner.js': DELEGATES_TO_BUILD_ARGS,
      }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: if the delegated function itself is unguarded, the tree still fails', () => {
      // Proves delegation-recognition does not silently swallow a real defect
      // in the function it defers to — it only skips the CALL SITE, and the
      // callee is still audited at its own definition (the test above).
      const r = runLint({
        'build-foo-args.js': BUILD_ARGS_SHAPED_FUNCTION_UNGUARDED,
        'runner.js': DELEGATES_TO_BUILD_ARGS,
      }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /buildFooArgs \(return\)/)
    })
  })

  describe('catalogue (AUDITED_SINKS)', () => {
    test('a matching catalogue entry silences a real finding', () => {
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'offender.js', match: 'userValue', reason: 'test: pretend this is operator-only' },
      ]\n`
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue })
      assert.equal(r.status, 0, r.stderr)
    })

    test('a catalogue entry scoped to the WRONG file does not silence it (file must match too)', () => {
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'someone-else.js', match: 'userValue', reason: 'wrong file on purpose' },
      ]\n`
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue })
      assert.equal(r.status, 1)
    })

    test('an unused catalogue entry (right file, wrong text) is reported stale', () => {
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'offender.js', match: 'totallyDifferentName', reason: 'stale on purpose' },
      ]\n`
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue })
      assert.equal(r.status, 1)
      // Both directions fail in the same run: the real sink is un-catalogued
      // AND the entry that was supposed to cover something is stale.
      assert.match(r.stderr, /argv element `userValue`/)
      assert.match(r.stderr, /matches no current finding/)
    })

    test('a catalogue entry missing `reason` is a usage error (exit 2), not silently accepted', () => {
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'offender.js', match: 'userValue' },
      ]\n`
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue })
      assert.equal(r.status, 2)
    })
  })

  describe('inline `// argv-safety-ignore:` marker', () => {
    test('a marker with a reason on the line above silences that one finding', () => {
      const r = runLint({ 'marked.js': IGNORE_MARKER_ABOVE }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the identical code without the marker fails', () => {
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1)
    })
  })

  describe('unresolvable (opaque) argv', () => {
    test('a spread element makes the array opaque and it fails without a catalogue entry', () => {
      const r = runLint({ 'offender.js': OPAQUE_SPREAD_ARGV }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /could not be statically resolved/)
    })

    test('an opaque array IS silenced by a matching catalogue entry', () => {
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'offender.js', match: "execFile('/usr/bin/git', args", reason: 'test: pretend audited' },
      ]\n`
      const r = runLint({ 'offender.js': OPAQUE_SPREAD_ARGV }, { catalogue })
      assert.equal(r.status, 0, r.stderr)
    })
  })

  describe('scope: exec()/execSync() shell-string form is not scanned', () => {
    test('a shell-string exec() call with concatenated user input is out of scope for THIS lint', () => {
      // Shell-metacharacter injection is a different class with a different
      // fix; this lint only gates the array-argv form. Not a false negative
      // for what it claims to cover — see the module doc comment.
      const r = runLint({ 'clean.js': EXEC_STRING_FORM_NOT_SCANNED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })
  })

  describe('usage / guard-broken cases exit 2, never 0 or silently pass as 1', () => {
    test('a --src-dir that does not exist is a usage error', () => {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-argvsinks-'))
      tmpRoots.push(root)
      const res = spawnSync(process.execPath, [
        LINT_SCRIPT, '--src-dir', join(root, 'does-not-exist'), '--catalogue', REAL_CATALOGUE,
      ], { encoding: 'utf8' })
      assert.equal(res.status, 2)
    })

    test('--min-files above the actual scanned count is a usage error', () => {
      const r = runLint({ 'clean.js': CONSTANT_ONLY_ARGV }, { catalogue: EMPTY_CATALOGUE, extraArgs: ['--min-files', '5'] })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /expected at least 5/)
    })

    test('an unknown flag is a usage error', () => {
      const r = runLint({ 'clean.js': CONSTANT_ONLY_ARGV }, { catalogue: EMPTY_CATALOGUE, extraArgs: ['--srcdir', '/tmp'] })
      assert.equal(r.status, 2)
    })

    test('a catalogue module that fails to load is a usage error, not a false clean', () => {
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue: 'this is not valid javascript {{{' })
      assert.equal(r.status, 2)
    })

    test('--dry-run prints offenders but exits 0', () => {
      const r = runLint({ 'offender.js': UNGUARDED_VARIABLE_ARGV }, { catalogue: EMPTY_CATALOGUE, extraArgs: ['--dry-run'] })
      assert.equal(r.status, 0)
      assert.match(r.stderr, /argv element `userValue`/)
    })
  })

  describe('the real repository', () => {
    test('packages/server/src passes with zero findings against the real catalogue', () => {
      const res = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8', cwd: resolve(__dirname, '..') })
      assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`)
    })
  })
})
