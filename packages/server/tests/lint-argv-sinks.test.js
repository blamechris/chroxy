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

// #7935 review: \`pathKeyOf\` did not recognise \`this\` as a valid path BASE at
// all, so a guard call on \`this.branch\` never registered a key and a sink
// element reading \`this.branch\` could never look one up — a class-based
// \`this.xxx\` guard was silently invisible to shape-1 matching regardless of
// an assertSafeArgvValue call sitting right next to it. Surfaced by the
// node-pty fix: claude-tui-session.js's \`_spawnPty\` guards
// \`this._sessionId\` exactly this way.
const GUARDED_VIA_THIS_PROPERTY = `
import { execFile } from 'node:child_process'
import { assertSafeArgvValue } from './utils/argv-safety.js'
class Runner {
  run() {
    assertSafeArgvValue(this.branch, 'branch')
    execFile('/usr/bin/git', ['checkout', this.branch], () => {})
  }
}
`

const UNGUARDED_THIS_PROPERTY = `
import { execFile } from 'node:child_process'
class Runner {
  run() {
    execFile('/usr/bin/git', ['checkout', this.branch], () => {})
  }
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

// #7936 — two UNRELATED sinks in different functions that both flag an
// identically-named bare-identifier element (`value`). Under the OLD
// catalogueKey (just the element's own text), both findings produced the
// IDENTICAL key `"value"`, so a catalogue entry audited for one silently
// covered the other too.
const ALIASED_BARE_IDENTIFIER_TWO_FUNCTIONS = `
import { execFile } from 'node:child_process'
export function runA(value) {
  execFile('/usr/bin/git', ['diff', value], () => {})
}
export function runB(value) {
  execFile('/usr/bin/git', ['log', value], () => {})
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

// ─── Review #7929 blind-spot probes ────────────────────────────────────────

const ALIASED_NAMED_IMPORT_UNGUARDED = `
import { spawn as run } from 'node:child_process'
export function launch(userValue) {
  run('/usr/bin/git', ['diff', userValue], () => {})
}
`

const DEFAULT_IMPORT_UNGUARDED = `
import cp from 'node:child_process'
export function launch(userValue) {
  cp.spawn('/usr/bin/git', ['diff', userValue], () => {})
}
`

const CJS_REQUIRE_DESTRUCTURE_UNGUARDED = `
const { execFile } = require('node:child_process')
export function launch(userValue) {
  execFile('/usr/bin/git', ['diff', userValue], () => {})
}
`

const FORK_UNGUARDED = `
import { fork } from 'node:child_process'
export function launch(userValue) {
  fork('./child.js', ['--value', userValue])
}
`

const ALIASED_LOCAL_VIA_FALLBACK_UNGUARDED = `
import { execFileSync } from 'node:child_process'
export function launch(userValue, deps = {}) {
  const exec = deps._exec || execFileSync
  exec('/usr/bin/git', ['diff', userValue], { encoding: 'utf8' })
}
`

const ALIASED_LOCAL_BARE_UNGUARDED = `
import { execFileSync } from 'node:child_process'
export function launch(userValue) {
  const run = execFileSync
  run('/usr/bin/git', ['diff', userValue], { encoding: 'utf8' })
}
`

const WRAPPER_FUNCTION_NOT_ARGS_NAMED_OPAQUE = `
import { spawn } from 'node:child_process'
function runGit(cwd, ...args) {
  spawn('/usr/bin/git', args, { cwd })
}
export function launch(userValue) {
  runGit('/tmp', 'diff', userValue)
}
`

// #7935 — node-pty's own `<namespace>.spawn(file, args, opts)` is now
// scanned: same (file, args, opts) shape as child_process.spawn, same argv-
// injection class. Bound here via `const ptyMod = await import('node-pty')`.
const DYNAMIC_IMPORT_PTY_SPAWN_UNGUARDED = `
export async function launch(userValue) {
  const ptyMod = await import('node-pty')
  return ptyMod.spawn('/usr/bin/claude', ['--resume', userValue], {})
}
`

const DYNAMIC_IMPORT_PTY_SPAWN_GUARDED = `
import { assertSafeArgvValue } from './utils/argv-safety.js'
export async function launch(userValue) {
  assertSafeArgvValue(userValue, 'value')
  const ptyMod = await import('node-pty')
  return ptyMod.spawn('/usr/bin/claude', ['--resume', userValue], {})
}
`

// The DOMINANT real shape (claude-tui-session.js's `_spawnPty`, user-shell-
// session.js's `start`): a `let`-declared binding REASSIGNED inside a
// try/catch (so a rejected import can be handled without an uncaught
// throw), not a `const` with the import as its own initializer — a
// different AST shape the const-declaration handling does not reach.
const DYNAMIC_IMPORT_PTY_SPAWN_VIA_REASSIGNMENT_UNGUARDED = `
export async function launch(userValue) {
  let ptyMod
  try {
    ptyMod = await import('node-pty')
  } catch (err) {
    throw new Error('node-pty unavailable: ' + err.message)
  }
  return ptyMod.spawn('/usr/bin/claude', ['--resume', userValue], {})
}
`

// user-shell-session.js's own real shape: a literal empty argv array needs
// no guard at all — zero elements to flag, even though the binding shape
// (let-reassignment) is identical to the unguarded case above.
const DYNAMIC_IMPORT_PTY_SPAWN_VIA_REASSIGNMENT_LITERAL_EMPTY_ARGS = `
export async function launch(shellPath) {
  let ptyMod
  ptyMod = await import('node-pty')
  return ptyMod.spawn(shellPath, [], {})
}
`

// A destructured \`{ spawn }\` import from node-pty is tracked the same way a
// destructured child_process import already is (review guidance: "however
// the module is bound").
const DYNAMIC_IMPORT_PTY_SPAWN_DESTRUCTURED_UNGUARDED = `
export async function launch(userValue) {
  const { spawn } = await import('node-pty')
  return spawn('/usr/bin/claude', ['--resume', userValue], {})
}
`

// Copilot review thread on this PR (packages/server/scripts/lint-argv-sinks.mjs:431):
// guard detection was FILE-WIDE, not scoped — a guard call in an unrelated
// (here, dead/never-called) function silenced a genuinely unguarded sink
// elsewhere in the file purely because both used a parameter named `value`.
const UNRELATED_DEAD_GUARD_SAME_NAME_UNGUARDED = `
import { execFile } from 'node:child_process'
import { assertSafeArgvValue } from './utils/argv-safety.js'

// Never called from anywhere. Guards its OWN 'value' parameter only.
function unrelatedDeadCode(value) {
  assertSafeArgvValue(value, 'value')
}

export function run(value) {
  execFile('/usr/bin/git', ['diff', value], () => {})
}
`

// Positive control: a guard call in an ENCLOSING scope (module-level, or an
// outer function around a closure) legitimately dominates a nested sink —
// this must still pass after scoping the guard lookup.
const GUARD_IN_ENCLOSING_SCOPE_STILL_GUARDS_NESTED_CLOSURE = `
import { execFile } from 'node:child_process'
import { assertSafeArgvValue } from './utils/argv-safety.js'

export function outer(value) {
  assertSafeArgvValue(value, 'value')
  const inner = () => {
    execFile('/usr/bin/git', ['diff', value], () => {})
  }
  inner()
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

    test('a guard call on a `this.` property is recognised (#7935 review)', () => {
      const guarded = runLint({ 'clean.js': GUARDED_VIA_THIS_PROPERTY }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(guarded.status, 0, guarded.stderr)

      // POSITIVE CONTROL: the identical `this.branch` sink with no guard call
      // anywhere — must fail, proving the pass above comes from pathKeyOf
      // resolving `this.branch`, not from the lint failing to see `this.`
      // sinks at all.
      const unguarded = runLint({ 'offender.js': UNGUARDED_THIS_PROPERTY }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(unguarded.status, 1)
      assert.match(unguarded.stderr, /argv element `this\.branch`/)
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

  // #7936 — an element-level catalogueKey must carry enough call-site
  // context that two unrelated sinks sharing an identically-named element do
  // NOT collapse onto the same key (and so the same catalogue entry).
  describe('catalogueKey specificity for element-level findings (#7936)', () => {
    test('RED: two unrelated sinks in different functions, same-named element, both fail uncatalogued', () => {
      const r = runLint({ 'offender.js': ALIASED_BARE_IDENTIFIER_TWO_FUNCTIONS }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /offender\.js:4\s+execFile\(\.\.\.\) argv element `value`/)
      assert.match(r.stderr, /offender\.js:7\s+execFile\(\.\.\.\) argv element `value`/)
    })

    test('an entry scoped to runA\'s call site silences ONLY runA\'s finding, not runB\'s (non-aliasing)', () => {
      // `match` includes the new call-site context (enclosing function +
      // sink callee) the fix adds to the key — this is text that simply did
      // not exist to write against before #7936, since both sinks' keys
      // were the bare string "value".
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'offender.js', match: 'value [[runA#execFile', reason: 'test: runA only, deliberately narrow' },
      ]\n`
      const r = runLint({ 'offender.js': ALIASED_BARE_IDENTIFIER_TWO_FUNCTIONS }, { catalogue })
      assert.equal(r.status, 1, r.stderr)
      // runA's finding (line 4) is silenced...
      assert.doesNotMatch(r.stderr, /offender\.js:4/)
      // ...but runB's identically-named finding (line 7) still fails. Under
      // the OLD catalogueKey this single entry would have silenced BOTH,
      // since the keys were identical — that is the #7936 bug.
      assert.match(r.stderr, /offender\.js:7\s+execFile\(\.\.\.\) argv element `value`/)
    })

    test('GREEN: giving EACH site its own entry silences both — proves both are independently addressable', () => {
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'offender.js', match: 'value [[runA#execFile', reason: 'test: runA' },
        { file: 'offender.js', match: 'value [[runB#execFile', reason: 'test: runB' },
      ]\n`
      const r = runLint({ 'offender.js': ALIASED_BARE_IDENTIFIER_TWO_FUNCTIONS }, { catalogue })
      assert.equal(r.status, 0, r.stderr)
    })

    test('a fully generic bare-identifier match (no call-site context) still spans both — backward compatible with pre-#7936 entries', () => {
      // The OLD element text is still a literal, unmoved substring of the
      // NEW key (the call-site context is APPENDED, never inserted before
      // or interleaved) — so none of the 58 pre-existing catalogue entries
      // written against the old bare-text key go stale from this change.
      const catalogue = `export const AUDITED_SINKS = [
        { file: 'offender.js', match: 'value', reason: 'test: intentionally broad, matches the pre-#7936 convention' },
      ]\n`
      const r = runLint({ 'offender.js': ALIASED_BARE_IDENTIFIER_TWO_FUNCTIONS }, { catalogue })
      assert.equal(r.status, 0, r.stderr)
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

  // Review #7929 — does the sink model actually cover the AST shapes a real
  // author reaches for, not just the ones the original fixtures happened to
  // exercise? Each RED case here is a proven false negative until fixed.
  describe('blind-spot probes (review #7929)', () => {
    test('GREEN (already worked): `import { spawn as run }` (aliased named import) is still tracked', () => {
      const r = runLint({ 'offender.js': ALIASED_NAMED_IMPORT_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      // The finding is reported under the CANONICAL imported name ('spawn'),
      // not the local alias ('run') — findings key off spawnApiLocals' VALUE.
      assert.match(r.stderr, /spawn\(\.\.\.\) argv element `userValue`/)
    })

    test('GREEN: `import cp from \'child_process\'; cp.spawn(...)` (default import) is tracked', () => {
      const r = runLint({ 'offender.js': DEFAULT_IMPORT_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /spawn\(\.\.\.\) argv element `userValue`/)
    })

    test('GREEN: `const { execFile } = require(...)` (CJS destructure) is tracked', () => {
      const r = runLint({ 'offender.js': CJS_REQUIRE_DESTRUCTURE_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /execFile\(\.\.\.\) argv element `userValue`/)
    })

    test('GREEN: `fork(modulePath, args)` is tracked (same argv-injection shape as spawn)', () => {
      const r = runLint({ 'offender.js': FORK_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /fork\(\.\.\.\) argv element `userValue`/)
    })

    test('GREEN: `const exec = deps._exec || execFileSync` (local alias via fallback default) is tracked', () => {
      const r = runLint({ 'offender.js': ALIASED_LOCAL_VIA_FALLBACK_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      // Reported under the resolved canonical API name, same convention as
      // the aliased-import case above.
      assert.match(r.stderr, /execFileSync\(\.\.\.\) argv element `userValue`/)
    })

    test('GREEN: `const run = execFileSync` (bare local alias) is tracked', () => {
      const r = runLint({ 'offender.js': ALIASED_LOCAL_BARE_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /execFileSync\(\.\.\.\) argv element `userValue`/)
    })

    // Positive control: a wrapper function that forwards its own args to
    // spawn() but is NOT named `_buildArgs`/`build*Args`/`*Argv` must still be
    // caught — not because the lint recognises the wrapper (it doesn't), but
    // because `args` inside runGit is a rest PARAMETER, not a local
    // `const args = [...]`, so resolveIdentifierArrayBranches cannot resolve
    // it and the whole spawn call is correctly flagged opaque.
    test('GREEN (already worked): a same-file spawn wrapper named outside the *Args/*Argv convention is still opaque-flagged', () => {
      const r = runLint({ 'offender.js': WRAPPER_FUNCTION_NOT_ARGS_NAMED_OPAQUE }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /spawn\(\.\.\.\) — argv could not be statically resolved/)
    })

    // #7935 — FIXED: a spawn-like call on a namespace bound from a dynamic,
    // non-child_process import (node-pty's own `pty.spawn(file, args)`) was
    // invisible to the whole import-tracking model, which only recognised
    // `node:child_process`/`child_process` sources. This was the exact shape
    // of the live gap fixed directly in claude-tui-session.js's `_spawnPty`
    // (the assertSafeArgvValue call added there predates this fix) — the
    // lint could not see that call site at all before this. Now scanned like
    // any other sink, across the binding shapes this codebase actually uses.
    test('RED->GREEN: a dynamically-imported non-child_process spawn (node-pty), bound via `const`, is scanned', () => {
      const red = runLint({ 'offender.js': DYNAMIC_IMPORT_PTY_SPAWN_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(red.status, 1, red.stderr)
      assert.match(red.stderr, /spawn\(\.\.\.\) argv element `userValue`/)

      const green = runLint({ 'clean.js': DYNAMIC_IMPORT_PTY_SPAWN_GUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(green.status, 0, green.stderr)
    })

    test('RED->GREEN: the dominant real shape — a `let`-declared binding REASSIGNED inside a try/catch — is also scanned', () => {
      const red = runLint({ 'offender.js': DYNAMIC_IMPORT_PTY_SPAWN_VIA_REASSIGNMENT_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(red.status, 1, red.stderr)
      assert.match(red.stderr, /spawn\(\.\.\.\) argv element `userValue`/)

      // POSITIVE CONTROL: the identical binding shape with a literal empty
      // argv array (user-shell-session.js's real shape) passes with zero
      // findings — proving the pass isn't from failing to see the call.
      const clean = runLint({ 'clean.js': DYNAMIC_IMPORT_PTY_SPAWN_VIA_REASSIGNMENT_LITERAL_EMPTY_ARGS }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(clean.status, 0, clean.stderr)
    })

    test('RED: a destructured `{ spawn }` import from node-pty is also scanned', () => {
      const r = runLint({ 'offender.js': DYNAMIC_IMPORT_PTY_SPAWN_DESTRUCTURED_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /spawn\(\.\.\.\) argv element `userValue`/)
    })
  })

  // Copilot review thread on this PR — guard detection must be scoped to the
  // sink's own function (and its lexical ancestors), never file-wide.
  describe('guard scoping is lexical, not file-wide (Copilot review finding)', () => {
    test('RED->GREEN: a guard call in an unrelated, never-called function does not silence a same-named sink elsewhere', () => {
      const r = runLint({ 'offender.js': UNRELATED_DEAD_GUARD_SAME_NAME_UNGUARDED }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /execFile\(\.\.\.\) argv element `value`/)
    })

    test('POSITIVE CONTROL: a guard call in an ENCLOSING function still guards a nested closure using the same binding', () => {
      const r = runLint({ 'clean.js': GUARD_IN_ENCLOSING_SCOPE_STILL_GUARDS_NESTED_CLOSURE }, { catalogue: EMPTY_CATALOGUE })
      assert.equal(r.status, 0, r.stderr)
    })
  })

  describe('the real repository', () => {
    test('packages/server/src passes with zero findings against the real catalogue', () => {
      const res = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8', cwd: resolve(__dirname, '..') })
      assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`)
    })
  })
})
