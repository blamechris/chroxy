#!/usr/bin/env node
/**
 * no-test-force-exit.test.mjs — pins scripts/lib/no-test-force-exit.mjs (#7400).
 *
 * The refusal exists because `--test-force-exit` makes a run report fewer tests
 * than it ran while still exiting 0 — so the guard's own failure mode is the
 * one it is guarding against: a guard that never fires and a suite that is
 * green anyway. Two things follow, and both shape this file.
 *
 * FIRST: every detection case asserts the returned object, never a downstream
 * side effect. `findTestForceExit` returning `null` when it should have found
 * something is invisible from the outside.
 *
 * SECOND: detection is not the claim that matters. The claim is that a throw
 * from an `--import` module actually STOPS a `node --test` run — the whole
 * mechanism the guard leans on. So the last cases spawn a real runner against a
 * throwaway shim, in both directions: with the flag it must exit non-zero and
 * name the code, and WITHOUT it the very same spawn must exit 0 with its test
 * reported. Without that positive control, a shim that fails to load for some
 * unrelated reason reads as a working guard.
 *
 * The call sites in the two real `tests/_setup.mjs` files have their own
 * coverage — packages/server/tests/setup-no-force-exit.test.js and
 * packages/claude-hooks/tests/setup-no-force-exit.test.js — because this file
 * can only prove the module works, not that anything installed it.
 *
 * No external test framework. Run from repo root:
 *   node scripts/__tests__/no-test-force-exit.test.mjs
 */

import { drainStdioAndExit } from '../flush-and-exit.mjs'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  FORCE_EXIT_ALLOW_ENV,
  FORCE_EXIT_ERROR_CODE,
  FORCE_EXIT_OPTION,
  assertNoTestForceExit,
  findTestForceExit,
  normalizeNodeOptionName,
} from '../lib/no-test-force-exit.mjs'
import {
  DIRECT_RUN_EXEMPTIONS,
  EXPECTED_NODE_TEST_PACKAGES,
  countMatchSites,
  directRunNodeTestFiles,
  importsNodeTest,
  isUnscannedCodeCandidate,
  packagePatchesAssertMatch,
  nodeTestPackages,
  packageRefusesForceExit,
  suspectTestFlagPackages,
  unclassifiedNodeTestMentions,
  workflowRunsFileDirectly,
  workflowCommands,
  runProbe,
} from '../lib/node-test-roster.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
// File URLs, not bare paths: an absolute Windows path is not a valid ESM
// specifier for `--import` (or for an `import` statement), and node rejects it
// with ERR_UNSUPPORTED_ESM_URL_SCHEME on protocol "a:"/"c:".
const MODULE_URL = pathToFileURL(resolve(REPO_ROOT, 'scripts/lib/no-test-force-exit.mjs')).href
const HOOK_URL = pathToFileURL(resolve(REPO_ROOT, 'scripts/lib/no-test-force-exit-hook.mjs')).href

// A floor on the number of cases accounted for, so a run that loses cases
// (an early `return`, a bad refactor) goes red instead of printing a small
// tidy "all passed".
const MIN_CASES = 55

let pass = 0
let fail = 0
const failures = []

const test = (name, fn) => {
  try {
    fn()
    pass++
    process.stdout.write(`  ok ${name}\n`)
  } catch (err) {
    fail++
    failures.push({ name, err })
    process.stdout.write(`  FAIL ${name}: ${err.message}\n`)
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed')
}

// ── normalizeNodeOptionName ─────────────────────────────────────────────────

test('normalizes underscores in an option name', () => {
  assert(normalizeNodeOptionName('--test_force_exit') === FORCE_EXIT_OPTION)
})

test('strips an =value before comparing', () => {
  assert(normalizeNodeOptionName('--test-force-exit=false') === FORCE_EXIT_OPTION)
})

test('leaves a non-option argument alone', () => {
  // A bare word must never be folded into an option name — a test file called
  // `test_force_exit.js` is not the flag.
  assert(normalizeNodeOptionName('test_force_exit') === 'test_force_exit')
})

// ── findTestForceExit ───────────────────────────────────────────────────────

const find = (execArgv, env = {}) => findTestForceExit({ execArgv, env })

test('clean execArgv reports nothing', () => {
  assert(find(['--experimental-test-module-mocks', '--test']) === null)
})

test('finds the plain flag in execArgv', () => {
  const hit = find(['--test', FORCE_EXIT_OPTION])
  assert(hit !== null, 'expected a hit')
  assert(hit.source === 'execArgv', `source was ${hit?.source}`)
  assert(hit.arg === FORCE_EXIT_OPTION, `arg was ${hit?.arg}`)
})

test('finds the underscore spelling node itself accepts', () => {
  // Measured: `node --test_force_exit` is accepted and lands in execArgv
  // spelled with underscores.
  const hit = find(['--test_force_exit'])
  assert(hit !== null, 'expected a hit')
  assert(hit.arg === '--test_force_exit', `arg was ${hit?.arg}`)
})

test('finds =true', () => {
  assert(find(['--test-force-exit=true']) !== null)
})

test('finds =false — node ignores the value and still force-exits', () => {
  // Not a hypothetical: with `--test-force-exit=false`, base-session.test.js
  // reported 164 / 155 / 159 of its 192 tests.
  assert(find(['--test-force-exit=false']) !== null)
})

test('finds the flag in NODE_OPTIONS', () => {
  const hit = find([], { NODE_OPTIONS: `--enable-source-maps ${FORCE_EXIT_OPTION}` })
  assert(hit !== null, 'expected a hit')
  assert(hit.source === 'NODE_OPTIONS', `source was ${hit?.source}`)
})

test('ignores an unrelated NODE_OPTIONS', () => {
  assert(find([], { NODE_OPTIONS: '--enable-source-maps --max-old-space-size=4096' }) === null)
})

test('ignores an absent NODE_OPTIONS', () => {
  assert(find([], {}) === null)
})

test('does not fire on a longer option that merely starts the same', () => {
  assert(find(['--test-force-exit-later']) === null)
})

test('does not fire on a shorter prefix', () => {
  assert(find(['--test-force']) === null)
})

test('does not fire on a script path that happens to contain the name', () => {
  assert(find(['/tmp/test-force-exit/setup.mjs']) === null)
})

// ── assertNoTestForceExit ───────────────────────────────────────────────────

test('returns null and warns nothing on a clean process', () => {
  let warned = 0
  const got = assertNoTestForceExit({ execArgv: ['--test'], env: {}, warn: () => { warned++ } })
  assert(got === null, 'expected null')
  assert(warned === 0, 'must not warn on a clean run')
})

test('throws with the documented code when the flag is present', () => {
  let err = null
  try {
    assertNoTestForceExit({ execArgv: [FORCE_EXIT_OPTION], env: {}, warn: () => {} })
  } catch (e) {
    err = e
  }
  assert(err !== null, 'expected a throw')
  assert(err.code === FORCE_EXIT_ERROR_CODE, `code was ${err?.code}`)
})

test('the refusal message names the flag, the escape hatch and the issue', () => {
  let err = null
  try {
    assertNoTestForceExit({ execArgv: ['--test_force_exit'], env: {}, warn: () => {} })
  } catch (e) {
    err = e
  }
  // Whoever hits this has to be able to act on it without reading the source.
  assert(err.message.includes('--test_force_exit'), 'must echo the arg as spelled')
  assert(err.message.includes(FORCE_EXIT_ALLOW_ENV), 'must name the escape hatch')
  assert(err.message.includes('#7400'), 'must name the issue')
})

test('the escape hatch waives the refusal AND warns', () => {
  const warnings = []
  const got = assertNoTestForceExit({
    execArgv: [FORCE_EXIT_OPTION],
    env: { [FORCE_EXIT_ALLOW_ENV]: '1' },
    warn: (m) => warnings.push(m),
  })
  assert(got?.allowed === true, 'expected the waiver')
  assert(warnings.length === 1, `expected one warning, got ${warnings.length}`)
  assert(warnings[0].includes('not trustworthy'), 'the warning must say what is wrong with the run')
})

for (const value of ['0', 'false', 'off', 'no', '', 'maybe']) {
  test(`${FORCE_EXIT_ALLOW_ENV}=${JSON.stringify(value)} does NOT waive the refusal`, () => {
    // Plain truthiness would waive on '0' and 'false' — values whose author
    // plainly meant "leave the guard on". The hatch takes an affirmative.
    let threw = false
    try {
      assertNoTestForceExit({ execArgv: [FORCE_EXIT_OPTION], env: { [FORCE_EXIT_ALLOW_ENV]: value }, warn: () => {} })
    } catch {
      threw = true
    }
    assert(threw, `expected a refusal for ${JSON.stringify(value)}`)
  })
}

for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
  test(`${FORCE_EXIT_ALLOW_ENV}=${JSON.stringify(value)} waives it`, () => {
    const got = assertNoTestForceExit({
      execArgv: [FORCE_EXIT_OPTION],
      env: { [FORCE_EXIT_ALLOW_ENV]: value },
      warn: () => {},
    })
    assert(got?.allowed === true, `expected the waiver for ${JSON.stringify(value)}`)
  })
}

test('an empty escape hatch is not an escape hatch', () => {
  // `CHROXY_ALLOW_TEST_FORCE_EXIT=` (unset-by-assignment) must still refuse,
  // so a stale empty export cannot silently disarm the guard.
  let threw = false
  try {
    assertNoTestForceExit({ execArgv: [FORCE_EXIT_OPTION], env: { [FORCE_EXIT_ALLOW_ENV]: '' }, warn: () => {} })
  } catch {
    threw = true
  }
  assert(threw, 'expected a refusal')
})

// ── Is the refusal wired into every package that runs `node --test`? ────────
//
// The server and claude-hooks call sites have behavioural tests inside their
// own suites. packages/protocol and packages/design-tokens have no suite of
// their own to hold one, and their wiring is a STRING in package.json: delete
// the `--import` and every test in the repo still passes.
//
// So this walks packages/* and derives the list rather than naming it — a
// hardcoded list beside a set that grows is the first cause in
// docs/false-safety-guards.md. A NEW package that adds a `node --test` script
// without the refusal fails here, by name.
//
// The limit, stated rather than papered over: this checks the wiring is
// PRESENT, not that it fires. What it fires is covered above (the hook) and in
// each package's own call-site file (the setup modules).

const nodeTestPackagesFound = nodeTestPackages(REPO_ROOT)

// The roster is asserted EQUAL to an explicit list, both ways, not checked against a
// floor: a floor with headroom cannot notice one package leaving the roster once a fifth
// arrives (#8056 finding 2). Derivation and list live in scripts/lib/node-test-roster.mjs,
// shared with assert-match-payload-guard-wiring.test.mjs.
test('the walk found exactly the packages that run node --test', () => {
  const found = nodeTestPackagesFound.map((p) => p.name).sort()
  const missing = EXPECTED_NODE_TEST_PACKAGES.filter((n) => !found.includes(n))
  const extra = found.filter((n) => !EXPECTED_NODE_TEST_PACKAGES.includes(n))
  assert(
    missing.length === 0 && extra.length === 0,
    `roster drift. expected but not found: [${missing.join(', ')}]; found but not expected: [${extra.join(', ')}]`,
  )
})

test('no package carries a --test flag the roster regex does not accept', () => {
  const suspects = suspectTestFlagPackages(REPO_ROOT)
  assert(
    suspects.length === 0,
    `these test scripts use --test but are outside the walk (their hooks go unchecked): ${suspects.map((p) => `${p.name}: ${p.script}`).join(' | ')}`,
  )
})

// Behavioural, not textual: each package's relative `--import`s are SPAWNED with
// `--test --test-force-exit` and must die with the refusal's error code. A text match
// credits a call in a block comment, a template string or dead code, and importing the
// LIBRARY instead of the hook installs nothing on import (#8056 finding 1, review S1).
for (const pkg of nodeTestPackagesFound) {
  test(`packages/${pkg.name} installs the refusal in its test script`, () => {
    assert(
      packageRefusesForceExit({ repoRoot: REPO_ROOT, pkg }),
      `a \`--test --test-force-exit\` run under packages/${pkg.name}'s relative --imports was NOT refused ` +
        `(importing the library instead of the hook, or a commented-out/dead call, installs nothing):\n  ${pkg.script}`,
    )
  })
}

// ── node:test suites outside the roster packages ────────────────────────────
//
// CI runs these as `node <file>`; the refusal cannot be --imported there, so each is
// exempted with a stated reason. Discovered set and exemption list are asserted EQUAL.
const directRun = directRunNodeTestFiles(REPO_ROOT, nodeTestPackagesFound.map((p) => p.name))

test('the direct-run node:test suites are exactly the exempted ones', () => {
  const found = directRun.map((f) => f.file)
  const exempt = Object.keys(DIRECT_RUN_EXEMPTIONS)
  const unlisted = found.filter((f) => !exempt.includes(f))
  const stale = exempt.filter((f) => !found.includes(f))
  assert(
    unlisted.length === 0 && stale.length === 0,
    `direct-run drift. suites with no exemption (guard or exempt them in scripts/lib/node-test-roster.mjs): [${unlisted.join(', ')}]; exemptions with no suite: [${stale.join(', ')}]`,
  )
})

test('every direct-run exemption states a reason and its exact assert.match count', () => {
  for (const { file, matchSites } of directRun) {
    const ex = DIRECT_RUN_EXEMPTIONS[file]
    if (!ex) continue // reported by the equality test above
    assert(typeof ex.reason === 'string' && ex.reason.length > 20, `${file}: exemption has no real reason`)
    assert(ex.matchSites === matchSites, `${file}: exemption says ${ex.matchSites} assert.match site(s), file has ${matchSites} — re-judge the exemption`)
  }
})

const CI_YML = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')

test('every exempt suite is invoked as `node <file>` by a ci.yml step', () => {
  const stale = Object.keys(DIRECT_RUN_EXEMPTIONS).filter((f) => !workflowRunsFileDirectly(REPO_ROOT, CI_YML, f))
  assert(
    stale.length === 0,
    `exempted but not run as \`node <file>\` in .github/workflows/ci.yml (its exemption reason no longer holds): [${stale.join(', ')}]`,
  )
})

const throwsMatching = (fn, re, what) => {
  let err = null
  try { fn() } catch (e) { err = e }
  assert(err !== null, `${what}: expected a throw, got a return`)
  assert(re.test(err.message), `${what}: message did not match ${re}: ${err.message}`)
}
const cmds = (yml) => workflowCommands(yml).map((c) => `${c.cwd || '<root>'}: ${c.argv.join(' ')}`)
const sameList = (got, want, what) => assert(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

test('the ci.yml reader tells `node <file>` from `node --test <file>` and from other scripts', () => {
  const yml = [
    'jobs:', '  j:', '    steps:',
    '      - name: direct', '        working-directory: packages/desktop',
    '        run: |', '          set -o pipefail', '          node scripts/a.test.mjs | tee /tmp/x',
    '      - name: runner', '        run: node --test packages/b/b.test.mjs',
    '      - name: other', '        run: node packages/c/helper.mjs packages/c/c.test.mjs',
  ].join('\n')
  assert(workflowRunsFileDirectly(REPO_ROOT, yml, 'packages/desktop/scripts/a.test.mjs'), 'direct run in a working directory')
  assert(!workflowRunsFileDirectly(REPO_ROOT, yml, 'packages/b/b.test.mjs'), '--test runner is not a direct run')
  assert(!workflowRunsFileDirectly(REPO_ROOT, yml, 'packages/c/c.test.mjs'), 'an argument of another script is not a direct run')
  sameList(cmds(yml), [
    'packages/desktop: set -o pipefail',
    'packages/desktop: node scripts/a.test.mjs',
    'packages/desktop: tee /tmp/x',
    '<root>: node --test packages/b/b.test.mjs',
    '<root>: node packages/c/helper.mjs packages/c/c.test.mjs',
  ], 'reader output')
})

// #9214 item 1: defaults.run.working-directory belongs to ONE job.
const TWO_JOBS = [
  'jobs:',
  '  a:', '    defaults:', '      run:', '        working-directory: packages/a',
  '    steps:', '      - run: node scripts/t.mjs',
  '  b:', '    defaults:', '      run:', '        working-directory: packages/b',
  '    steps:', '      - run: node scripts/t.mjs',
  '      - working-directory: .', '        run: node scripts/root.mjs',
  '  c:', '    steps:', '      - run: node scripts/none.mjs',
].join('\n')

test('defaults.run.working-directory is read per job, not pooled across jobs', () => {
  sameList(cmds(TWO_JOBS), [
    'packages/a: node scripts/t.mjs',
    'packages/b: node scripts/t.mjs',
    '.: node scripts/root.mjs',
    '<root>: node scripts/none.mjs',
  ], 'per-job cwd')
  assert(workflowRunsFileDirectly(REPO_ROOT, TWO_JOBS, 'packages/a/scripts/t.mjs'), 'job a resolves against its own default')
  assert(workflowRunsFileDirectly(REPO_ROOT, TWO_JOBS, 'packages/b/scripts/t.mjs'), 'job b resolves against its own default')
  assert(!workflowRunsFileDirectly(REPO_ROOT, TWO_JOBS, 'packages/c/scripts/t.mjs'), 'no job runs it in packages/c')
  assert(!workflowRunsFileDirectly(REPO_ROOT, TWO_JOBS, 'scripts/t.mjs'), 'the repo root is not job a or b default')
  assert(workflowRunsFileDirectly(REPO_ROOT, TWO_JOBS, 'scripts/root.mjs'), 'a step working-directory overrides the job default')
  assert(!workflowRunsFileDirectly(REPO_ROOT, TWO_JOBS, 'packages/b/scripts/root.mjs'), 'the step override replaces, not adds to, the default')
  assert(workflowRunsFileDirectly(REPO_ROOT, TWO_JOBS, 'scripts/none.mjs'), 'a job with no default runs at the root')
})

// #9214 item 2: the INVOKED command is `node`, and disabled steps run nothing.
test('only an invoked `node` counts; echo, wrappers-by-name and disabled steps do not', () => {
  const yml = [
    'jobs:',
    '  j:', '    steps:',
    '      - run: echo node scripts/echoed.mjs',
    '      - run: cat node scripts/catted.mjs',
    '      - if: false', '        run: node scripts/off1.mjs',
    '      - name: off2', '        if: ${{ false }}', '        run: node scripts/off2.mjs',
    "      - name: off3", "        if: 'false'", '        run: node scripts/off3.mjs',
    '      - name: on', "        if: github.ref == 'refs/heads/main'", '        run: node scripts/on.mjs',
    '      - run: NODE_OPTIONS=--no-warnings node scripts/envprefix.mjs',
    '      - run: node scripts/real.mjs',
    '  off:', '    if: false', '    steps:', '      - run: node scripts/offjob.mjs',
  ].join('\n')
  for (const f of ['echoed', 'catted', 'off1', 'off2', 'off3', 'offjob']) {
    assert(!workflowRunsFileDirectly(REPO_ROOT, yml, `scripts/${f}.mjs`), `${f} must not count as run`)
  }
  for (const f of ['on', 'envprefix', 'real']) {
    assert(workflowRunsFileDirectly(REPO_ROOT, yml, `scripts/${f}.mjs`), `${f} must count as run`)
  }
  sameList(cmds(yml), [
    '<root>: echo node scripts/echoed.mjs',
    '<root>: cat node scripts/catted.mjs',
    '<root>: node scripts/on.mjs',
    '<root>: NODE_OPTIONS=--no-warnings node scripts/envprefix.mjs',
    '<root>: node scripts/real.mjs',
  ], 'live commands: disabled steps and the disabled job are dropped, nothing else')
})

// #9214 item 3: a probe that could not run, or was killed, is a failure with its cause.
test('a spawn error or signal kill fails loudly with the cause, never as a refusal or a pass', () => {
  const pkg = nodeTestPackagesFound.find((p) => p.name === 'claude-hooks')
  assert(pkg !== undefined, 'claude-hooks must be in the roster for this fixture')
  const stub = (r) => (...call) => { stub.calls.push(call); return r }
  stub.calls = []
  const cases = [
    ['ENOENT', { error: Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }), status: null, signal: null, stdout: '', stderr: '' }, /ENOENT/],
    ['timeout', { error: Object.assign(new Error('spawnSync x ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, /ETIMEDOUT/],
    ['signal', { status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }, /killed by SIGSEGV/],
  ]
  for (const [name, result, re] of cases) {
    throwsMatching(() => packageRefusesForceExit({ repoRoot: REPO_ROOT, pkg, spawn: stub(result) }), re, `refuses/${name}`)
    throwsMatching(() => packagePatchesAssertMatch({ repoRoot: REPO_ROOT, pkg, spawn: stub(result) }), re, `patches/${name}`)
  }
  assert(stub.calls.length === 6 && stub.calls.every((c) => c[2].killSignal === 'SIGKILL'), 'probes must be spawned with killSignal SIGKILL')
  // Positive controls: a child that DID exit is still read normally.
  const exited = (stdout, stderr = '', status = 1) => stub({ status, signal: null, stdout, stderr })
  assert(packageRefusesForceExit({ repoRoot: REPO_ROOT, pkg, spawn: exited('', FORCE_EXIT_ERROR_CODE) }) === true, 'a real refusal reads as true')
  assert(packageRefusesForceExit({ repoRoot: REPO_ROOT, pkg, spawn: exited('', 'boom') }) === false, 'a non-refusing exit reads as false')
  assert(packagePatchesAssertMatch({ repoRoot: REPO_ROOT, pkg, spawn: exited('chroxyGuardedAssert\n', '', 0) }) === true, 'a guarded assert.match reads as true')
  assert(packagePatchesAssertMatch({ repoRoot: REPO_ROOT, pkg, spawn: exited('match\n', '', 0) }) === false, 'an unguarded assert.match reads as false')
})

test('a missing interpreter surfaces as a real ENOENT failure', () => {
  const pkg = nodeTestPackagesFound.find((p) => p.name === 'claude-hooks')
  const missing = join(tmpdir(), 'chroxy-no-such-node-binary')
  throwsMatching(() => packageRefusesForceExit({ repoRoot: REPO_ROOT, pkg, execPath: missing }), /ENOENT/, 'real ENOENT')
  throwsMatching(() => runProbe(['-e', ''], { cwd: REPO_ROOT, execPath: missing, label: 'direct' }), /direct: probe could not run/, 'runProbe label')
})

// #9214 item 4: exact counts, not `>= 1`.
test('the node:test scanners recognise every import and match form', () => {
  for (const src of [
    "import test from 'node:test'", "import { test } from \"node:test\"", "const t = require('node:test')",
    "const t = await import('node:test')", "import 'node:test'",
  ]) assert(importsNodeTest(src), `missed import form: ${src}`)
  assert(!importsNodeTest("import test from 'vitest'"), 'false import match')
  for (const [src, want] of [
    ['assert.match(a, /x/)', 1], ['assert.doesNotMatch(a, /x/)', 1], ['t.assert.match(a, /x/)', 1],
    ['strict.match(a, /x/)', 1], ['const { match } = assert', 1], ['const { match: m } = assert', 1],
    ["import { doesNotMatch } from 'node:assert'", 1], ['const m = assert.match', 1],
    ['s.match(/x/)', 1], // over-counts String.prototype.match: the documented safe direction
    ['assert.match(a, /x/)\nassert.doesNotMatch(b, /y/)\nconst { match } = assert', 3],
    ['assert.equal(a, b)', 0], ['', 0],
  ]) assert(countMatchSites(src) === want, `countMatchSites(${JSON.stringify(src)}) = ${countMatchSites(src)}, want ${want}`)
})

// #9214 items 4 and 5: the unclassified-mention path, positive and negative, end to end on a
// throwaway git repo (git is already required by trackedPackageFiles).
test('unclassified node:test mentions: exactly the unreadable file types that quote it', () => {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-unclassified-'))
  try {
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    const quoted = "import t from 'node:test'\n"
    put('packages/x/a.sh', quoted)                // shell: scanned, reported (#9214 item 5)
    put('packages/x/b.html', quoted)              // html: scanned, reported
    put('packages/x/c.weird', quoted)             // unknown type: reported
    put('packages/x/d.sh', 'echo hello\n')        // NEGATIVE: unknown type, no mention
    put('packages/x/e.md', quoted)                // known non-code: not reported
    put('packages/x/f.mjs', quoted)               // scanned type: handled elsewhere
    put('packages/roster/g.sh', quoted)           // roster package: guarded via its script
    const g = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' })
    assert(g.status === 0, `git init failed: ${g.stderr}`)
    const add = spawnSync('git', ['add', '-A', '--', 'packages'], { cwd: root, encoding: 'utf8' })
    assert(add.status === 0, `git add failed: ${add.stderr}`)
    const got = unclassifiedNodeTestMentions(root, ['roster'])
    sameList(got, ['packages/x/a.sh', 'packages/x/b.html', 'packages/x/c.weird'], 'unclassified mentions')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('.sh and .html are scanned, not silently skipped; known non-code types still are', () => {
  for (const rel of ['a.sh', 'a.html', 'a.weird']) assert(isUnscannedCodeCandidate(rel), `${rel} must be scanned`)
  for (const rel of ['a.md', 'a.json', 'a.css', 'a.mjs', 'a.tsx']) assert(!isUnscannedCodeCandidate(rel), `${rel} must not be reported as unscanned`)
})

test('no node:test mention hides in a file type the scanners cannot read', () => {
  const hidden = unclassifiedNodeTestMentions(REPO_ROOT, nodeTestPackagesFound.map((p) => p.name))
  assert(hidden.length === 0, `quote 'node:test' in unscanned file type(s) (extend SCANNED_EXTENSIONS): [${hidden.join(', ')}]`)
})

// ── The mechanism: does a throw from --import stop a real `node --test` run? ─

const dir = mkdtempSync(join(tmpdir(), 'chroxy-force-exit-'))
try {
  const shim = join(dir, 'shim.mjs')
  writeFileSync(
    shim,
    `import { assertNoTestForceExit } from ${JSON.stringify(MODULE_URL)}\nassertNoTestForceExit()\n`,
  )
  const probe = join(dir, 'probe.test.js')
  writeFileSync(
    probe,
    "import { test } from 'node:test'\ntest('probe ran', () => {})\n",
  )

  const run = (extraArgs, env) => spawnSync(
    process.execPath,
    ['--import', pathToFileURL(shim).href, '--test', ...extraArgs, probe],
    { encoding: 'utf8', env: { ...process.env, ...env }, cwd: dir },
  )

  test('every --import specifier is a file:// URL, not a bare path (Windows)', () => {
    // Pins the shape that broke the Windows job: an absolute path is not a valid
    // ESM specifier there. This runs on every platform, so the regression is
    // caught on Linux/macOS too rather than only where it hurts.
    for (const [name, url] of [['module', MODULE_URL], ['hook', HOOK_URL], ['shim', pathToFileURL(shim).href]]) {
      assert(url.startsWith('file://'), `${name} specifier must be a file URL, got: ${url}`)
    }
  })

  test('POSITIVE CONTROL: the same spawn is green without the flag', () => {
    const r = run([], {})
    assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`)
    assert(r.stdout.includes('# pass 1'), `expected the probe to be reported:\n${r.stdout}`)
  })

  test('a real `node --test` run refuses when the flag is passed', () => {
    const r = run([FORCE_EXIT_OPTION], {})
    assert(r.status !== 0, `expected a non-zero exit, got ${r.status}\n${r.stdout}`)
    const all = r.stdout + r.stderr
    assert(all.includes(FORCE_EXIT_ERROR_CODE), `expected ${FORCE_EXIT_ERROR_CODE} in the output:\n${all.slice(0, 2000)}`)
  })

  test('the refusal reaches the runner BEFORE any test runs', () => {
    // The point of refusing at `--import` time rather than reporting afterwards:
    // nothing in the file executes, so no half-run is left to interpret.
    const r = run([FORCE_EXIT_OPTION], {})
    assert(!r.stdout.includes('# pass 1'), `no test should have passed:\n${r.stdout}`)
  })

  // The hook is what packages/protocol and packages/design-tokens --import;
  // they have no setup module, so nothing else would prove it fires.
  test('the --import hook refuses on its own', () => {
    const r = spawnSync(process.execPath, ['--import', HOOK_URL, '--test-force-exit', '-e', "console.log('RAN')"], { encoding: 'utf8' })
    assert(r.status !== 0, `expected a non-zero exit, got ${r.status}`)
    assert(!`${r.stdout}`.includes('RAN'), 'the program must not have run')
    assert(`${r.stderr}`.includes(FORCE_EXIT_ERROR_CODE), `expected the refusal:\n${r.stderr.slice(0, 1000)}`)
  })

  test('POSITIVE CONTROL: the hook is inert without the flag', () => {
    const r = spawnSync(process.execPath, ['--import', HOOK_URL, '-e', "console.log('RAN')"], { encoding: 'utf8' })
    assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stderr}`)
    assert(`${r.stdout}`.includes('RAN'), 'the program must have run')
  })

  test('the escape hatch lets the same spawn through', () => {
    const r = run([FORCE_EXIT_OPTION], { [FORCE_EXIT_ALLOW_ENV]: '1' })
    assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`)
    // stdout, not stderr: under process isolation the child's stderr is folded
    // into the runner's TAP diagnostics, so the operator sees it on stdout.
    const all = r.stdout + r.stderr
    assert(all.includes('WARNING'), `expected the warning in the output:\n${all.slice(0, 2000)}`)
    assert(all.includes('# pass 1'), `the probe must still run:\n${r.stdout}`)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const ACCOUNTED = pass + fail
if (ACCOUNTED < MIN_CASES) {
  process.stderr.write(
    `\nHARNESS BROKEN: ran ${ACCOUNTED} cases, expected at least ${MIN_CASES}. ` +
    'Cases went missing rather than failing.\n',
  )
  await drainStdioAndExit(1)
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  await drainStdioAndExit(1)
}
await drainStdioAndExit(0)
