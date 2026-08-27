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

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const MIN_CASES = 31

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

const packagesDir = resolve(REPO_ROOT, 'packages')
const nodeTestPackages = []
for (const name of readdirSync(packagesDir)) {
  const manifest = join(packagesDir, name, 'package.json')
  if (!existsSync(manifest)) continue
  const script = JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test ?? ''
  // `node ... --test` — vitest ("vitest run") and jest ("jest --coverage")
  // never match, and `--test-force-exit` does not match `--test` because of
  // the trailing boundary.
  if (/\bnode\b/.test(script) && /--test(\s|$)/.test(script)) nodeTestPackages.push({ name, script })
}

// A floor, because an empty walk would otherwise report "all wired" — the
// silent-pass shape this file exists to prevent. Four packages run node --test
// today: server, claude-hooks, protocol, design-tokens.
test('the walk found every package that runs node --test', () => {
  assert(
    nodeTestPackages.length >= 4,
    `only ${nodeTestPackages.length} package(s) matched: ${nodeTestPackages.map((p) => p.name).join(', ') || 'none'}`,
  )
})

for (const { name, script } of nodeTestPackages) {
  test(`packages/${name} installs the refusal in its test script`, () => {
    const imports = [...script.matchAll(/--import\s+(\S+)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
    const installs = imports.some((spec) => {
      if (!spec.startsWith('.')) return false // bare specifier (tsx/esm) — not ours
      const file = resolve(packagesDir, name, spec)
      if (!existsSync(file)) return false
      return readFileSync(file, 'utf8').includes('assertNoTestForceExit(')
    })
    assert(
      installs,
      `packages/${name}'s test script --imports nothing that calls assertNoTestForceExit():\n  ${script}`,
    )
  })
}

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
    `\nERROR: only ${ACCOUNTED} case(s) accounted for, expected at least ${MIN_CASES}. ` +
    'Cases went missing rather than failing.\n',
  )
  process.exit(1)
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.exit(0)
