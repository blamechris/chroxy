/**
 * END-TO-END tests for scripts/run-windows-tests.mjs (#7270).
 *
 * Its sibling `run-windows-tests-plan.test.js` covers the DERIVATION via
 * `--print-plan`, which exits before a single test is spawned. This file covers
 * everything after that: the spawn, the TAP parsing, the file-identity check,
 * the cancellation check and the exit policy.
 *
 * That block had no test at all, and it is the block that decides whether a
 * green Windows job MEANS anything. It broke twice in review for want of one:
 * a bare absolute path used as an ESM specifier (Windows-only), and a
 * temporal-dead-zone read of `executedOriginal` that reached CI because every
 * local run had been `--print-plan`, which returns before the loop.
 *
 * The seam is `--tests-root`: the runner roots its spawn at that directory's
 * parent, so a fixture tree exercises the same code the Windows job runs. These
 * tests are platform-independent and therefore run in `Server Tests`, which is
 * a REQUIRED check — the guards move inside the merge gate.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNNER = resolve(__dirname, '..', 'scripts', 'run-windows-tests.mjs')
const LIB = resolve(__dirname, '..', 'scripts', 'lib', 'windows-test-set.mjs')

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

const PASSING = "import { test } from 'node:test'\ntest('ok', () => {})\n"
const FAILING = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('nope', () => { assert.equal(1, 2) })\n"

/** A fixture package: <root>/tests/*.test.js + a manifest module. */
function fixture({ files, exempt = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-win-exec-'))
  tmpRoots.push(root)
  for (const [name, body] of Object.entries(files)) {
    const abs = join(root, 'tests', name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  const manifestPath = join(root, 'manifest.mjs')
  writeFileSync(manifestPath, [
    `export { EXEMPT_REASONS } from ${JSON.stringify(pathToFileURL(LIB).href)}`,
    `export const WINDOWS_EXEMPT = ${JSON.stringify(exempt, null, 2)}`,
    'export const MUST_RUN_ON_WINDOWS = []',
    'export const MIN_MUST_RUN_ON_WINDOWS = 0',
  ].join('\n') + '\n')
  return { root, testsRoot: join(root, 'tests'), manifestPath }
}

// node marks its test children with NODE_TEST_CONTEXT, and a nested `--test`
// sees it and prints "run() is being called recursively … skipping running
// files" — producing no TAP summary at all. The runner is right to treat that
// as a truncated run; it just must not be how we invoke it from a test. In CI
// the runner is not a descendant of the test runner, so this is a test-harness
// concern only.
const CLEAN_ENV = (() => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k]
  return env
})()

function runRunner(f, extra = []) {
  return spawnSync(process.execPath, [
    RUNNER, '--tests-root', f.testsRoot, '--manifest', f.manifestPath, '--min-files', '1', ...extra,
  ], { encoding: 'utf8', env: CLEAN_ENV })
}

describe('run-windows-tests: the execution path (#7270)', () => {
  test('a passing fixture exits 0 and reports the derived set', () => {
    const f = fixture({ files: { 'a.test.js': PASSING, 'b.test.js': PASSING } })
    const r = runRunner(f)
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}\n${r.stderr}`)
    assert.match(r.stdout + r.stderr, /2 file\(s\) in the derived Windows set/)
  })

  test('a failing test makes the runner exit 1 and names the suite', () => {
    const f = fixture({ files: { 'a.test.js': PASSING, 'b.test.js': FAILING } })
    const r = runRunner(f)
    assert.equal(r.status, 1)
    // "cannot tell you which" must not read the same as "there were none".
    assert.match(r.stderr, /Top-level suites that did not pass/)

    // POSITIVE CONTROL: the same tree with the failure replaced -> clean.
    const good = fixture({ files: { 'a.test.js': PASSING, 'b.test.js': PASSING } })
    assert.equal(runRunner(good).status, 0, 'control failed')
  })

  test('a file that fails to LOAD is a failure, not a silent skip', () => {
    const f = fixture({ files: { 'a.test.js': PASSING, 'b.test.js': "import 'node:does-not-exist'\n" } })
    assert.equal(runRunner(f).status, 1)
  })

  test('the runner refuses a set below its collapse floor', () => {
    const f = fixture({ files: { 'a.test.js': PASSING } })
    // Its own default floor is 500; the fixture has 1.
    const r = spawnSync(process.execPath, [RUNNER, '--tests-root', f.testsRoot, '--manifest', f.manifestPath], { encoding: 'utf8', env: CLEAN_ENV })
    assert.equal(r.status, 2)
    // POSITIVE CONTROL: same tree, floor it clears.
    assert.equal(runRunner(f).status, 0, 'control failed')
  })

  test('multi-batch execution runs every file exactly once', () => {
    const files = {}
    for (let i = 0; i < 8; i++) files[`f${i}.test.js`] = PASSING
    const f = fixture({ files })
    // A tiny argv budget forces several batches through the real spawn path.
    const r = runRunner(f, ['--max-argv-bytes', '260'])
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}\n${r.stderr}`)
    assert.match(r.stdout + r.stderr, /8 file\(s\) in the derived Windows set/)
    assert.doesNotMatch(r.stderr, /does not match the derived set/)
  })

  test('a failure inside a LATER batch is not lost', () => {
    // The accumulators run across batches; a batch that fails after a green one
    // must still turn the whole run red.
    const files = { 'a.test.js': PASSING, 'b.test.js': PASSING, 'c.test.js': FAILING }
    const f = fixture({ files })
    assert.equal(runRunner(f, ['--max-argv-bytes', '220']).status, 1)
  })
})
