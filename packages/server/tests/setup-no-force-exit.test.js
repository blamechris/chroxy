/**
 * CALL-SITE coverage for the `--test-force-exit` refusal (#7400).
 *
 * `scripts/__tests__/no-test-force-exit.test.mjs` proves the MODULE works.
 * This file proves this package's `tests/_setup.mjs` actually installs it —
 * the asymmetry #7236 is about, and the reason a shared guard needs a test per
 * entry point rather than one test for the library.
 *
 * Every case spawns a real `node --import ./tests/_setup.mjs --test` at the
 * exact shape a developer types. Nothing here imports `_setup.mjs`: this
 * process was already started by it, so an in-process assertion would be
 * testing a module that has ALREADY run, and would keep passing if the call
 * were deleted from the file.
 *
 * The control case matters as much as the refusal. A spawn that fails to load
 * for an unrelated reason (a bad path, a missing flag) exits non-zero and
 * prints something — which reads exactly like a working guard. So the same
 * command, minus the flag, must go green with the probe reported.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
// A file URL, never a bare Windows path: `--import` takes a module SPECIFIER,
// so `A:\\runners\\...\\_setup.mjs` parses as protocol "a:" and node refuses it
// with ERR_UNSUPPORTED_ESM_URL_SCHEME. Measured on the Windows runner — and the
// refusal cases still "passed" there, because a child that dies before loading
// anything satisfies "no test ran" perfectly. The control is what went red.
const SETUP = pathToFileURL(resolve(HERE, '_setup.mjs')).href

const dir = mkdtempSync(join(tmpdir(), 'chroxy-force-exit-callsite-'))
const probe = join(dir, 'probe.test.js')
writeFileSync(probe, "import { test } from 'node:test'\ntest('probe ran', () => {})\n")

after(() => { rmSync(dir, { recursive: true, force: true }) })

// This file is itself running under `node --test`, which sets NODE_TEST_CONTEXT
// in the environment. A child that inherits it refuses to run files at all
// ("run() is being called recursively"), exits 0, and reports nothing — which
// would make the refusal cases pass for entirely the wrong reason and the
// control case fail. Strip it.
const childEnv = (extra) => {
  const env = { ...process.env, ...extra }
  delete env.NODE_TEST_CONTEXT
  return env
}

const run = (extraArgs = [], env = {}) => {
  const r = spawnSync(
    process.execPath,
    ['--import', SETUP, '--experimental-test-module-mocks', '--test', ...extraArgs, probe],
    { encoding: 'utf8', env: childEnv(env), cwd: dir },
  )
  return { ...r, all: (r.stdout || '') + (r.stderr || '') }
}

describe('tests/_setup.mjs refuses --test-force-exit (#7400)', () => {
  it('passes --import a file:// URL, not a bare path (Windows)', () => {
    // Pins the shape that broke the Windows job: an absolute path is not a valid
    // ESM specifier there. This runs on every platform, so the regression is
    // caught on Linux/macOS too rather than only where it hurts.
    assert.ok(SETUP.startsWith('file://'), `--import specifier must be a file URL, got: ${SETUP}`)
  })

  it('CONTROL: the same command without the flag is green and reports the probe', () => {
    const r = run()
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.all.slice(0, 2000)}`)
    assert.ok(r.stdout.includes('# pass 1'), `probe should have run:\n${r.stdout.slice(0, 2000)}`)
  })

  it('refuses, non-zero, naming the code', () => {
    const r = run(['--test-force-exit'])
    assert.notEqual(r.status, 0, `expected a non-zero exit:\n${r.all.slice(0, 2000)}`)
    assert.ok(
      r.all.includes('CHROXY_TEST_FORCE_EXIT'),
      `expected the refusal code in the output:\n${r.all.slice(0, 2000)}`,
    )
  })

  it('refuses before the probe runs — no half-run to interpret', () => {
    const r = run(['--test-force-exit'])
    assert.ok(!r.stdout.includes('# pass 1'), `no test should have passed:\n${r.stdout.slice(0, 2000)}`)
  })

  it('catches the underscore spelling node also accepts', () => {
    const r = run(['--test_force_exit'])
    assert.notEqual(r.status, 0, `expected a non-zero exit:\n${r.all.slice(0, 2000)}`)
    assert.ok(r.all.includes('CHROXY_TEST_FORCE_EXIT'), `expected the refusal:\n${r.all.slice(0, 2000)}`)
  })

  it('CHROXY_ALLOW_TEST_FORCE_EXIT waives it, loudly', () => {
    const r = run(['--test-force-exit'], { CHROXY_ALLOW_TEST_FORCE_EXIT: '1' })
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.all.slice(0, 2000)}`)
    assert.ok(r.all.includes('WARNING'), `expected a warning:\n${r.all.slice(0, 2000)}`)
    assert.ok(r.stdout.includes('# pass 1'), `probe should still run:\n${r.stdout.slice(0, 2000)}`)
  })
})
