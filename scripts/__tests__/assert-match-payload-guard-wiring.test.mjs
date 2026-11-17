#!/usr/bin/env node
/**
 * assert-match-payload-guard-wiring.test.mjs — pins that every package
 * running `node --test` installs the `assert.match`/`assert.doesNotMatch`
 * payload guard (#7413).
 *
 * `scripts/lib/assert-match-payload-guard.mjs` was installed from
 * `packages/server/tests/_setup.mjs` ONLY when this repo had four packages
 * running `node --test` and only one of them installed it. #7413 extends the
 * install to `claude-hooks`, `protocol` and `design-tokens`, following the
 * exact precedent #7400 set for the sibling `--test-force-exit` refusal: this
 * file is the direct analogue of `no-test-force-exit.test.mjs`'s
 * package-walk section, checking `installAssertMatchPayloadGuard(` instead of
 * `assertNoTestForceExit(`.
 *
 * All four packages ALSO have their own call-site pin now, running under each
 * package's own test command:
 * `packages/server/tests/assert-match-payload-guard.test.js`,
 * `packages/claude-hooks/tests/setup-payload-guard.test.js`,
 * `packages/protocol/tests/payload-guard-installed.test.js` and
 * `packages/design-tokens/test/payload-guard-installed.test.js` — none of
 * them needs a `tests/_setup.mjs`, only to run under the package's own `test`
 * script, which all four already do. This file is a SECOND, independent line
 * of defence: it walks `packages/*` and derives the roster of `node --test`
 * packages rather than naming it, the same reason `no-test-force-exit.test.mjs`
 * does — a hardcoded list beside a set that grows is the first recurring cause
 * in `docs/false-safety-guards.md` — so a NEW package that adds a
 * `node --test` script with no guard at all fails here, by name, even before
 * anyone thinks to add it a call-site pin.
 *
 * What this file's package-walk does NOT catch on its own: a package whose
 * `--import` resolves to some OTHER file that happens to contain the text
 * `installAssertMatchPayloadGuard(` without calling it as a statement — the
 * library module itself is exactly such a file, since its own
 * `export function installAssertMatchPayloadGuard({` line contains that
 * substring and installs nothing on import. The check below is anchored to a
 * call at the start of a line for that reason (#8050 review, C1), and the
 * four call-site pins above are what actually catch that class of mistake
 * behaviourally, from inside the package whose process would go unpatched.
 *
 * The second half proves the MECHANISM: that `--import`ing the hook file on
 * its own actually patches `assert.match` in a real spawn, with a positive
 * control showing the same probe is unpatched without it. Textual wiring
 * (found above) proves nothing if the hook itself is inert.
 *
 * No external test framework. Run from repo root:
 *   node scripts/__tests__/assert-match-payload-guard-wiring.test.mjs
 */

import { drainStdioAndExit } from '../flush-and-exit.mjs'
import {
  DIRECT_RUN_EXEMPTIONS,
  EXPECTED_NODE_TEST_PACKAGES,
  directRunNodeTestFiles,
  nodeTestPackages,
  packageInstalls,
  suspectTestFlagPackages,
} from '../lib/node-test-roster.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
// A file URL, not a bare path: an absolute Windows path is not a valid ESM
// specifier for `--import`, mirroring the same fix in no-test-force-exit.test.mjs.
const HOOK_URL = pathToFileURL(resolve(REPO_ROOT, 'scripts/lib/assert-match-payload-guard-hook.mjs')).href

// A floor on the number of cases accounted for, so a run that loses cases
// (an early `return`, a bad refactor) goes red instead of printing a small
// tidy "all passed".
const MIN_CASES = 10

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

// ── Is the guard wired into every package that runs `node --test`? ─────────
//
// Same derivation as no-test-force-exit.test.mjs: walk packages/*, keep the
// ones whose `test` script runs `node ... --test`, and check every relative
// `--import` specifier for a file that calls installAssertMatchPayloadGuard().
// vitest ("vitest run") and jest ("jest --coverage") scripts never match, and
// `--test-force-exit` does not match `--test` because of the trailing
// boundary.

const nodeTestPackagesFound = nodeTestPackages(REPO_ROOT)

// Asserted EQUAL to an explicit list, both ways (#8056 finding 2), through the same
// derivation no-test-force-exit.test.mjs uses (scripts/lib/node-test-roster.mjs).
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

// Anchored to a CALL at the start of a line, not a substring match. A plain
// `.includes('installAssertMatchPayloadGuard(')` also matches the library's
// own `export function installAssertMatchPayloadGuard({` definition — which
// installs nothing on import — so a package that `--import`s the LIBRARY
// instead of the hook (a one-token slip: dropping `-hook`) would read as
// wired while its real suite ran unguarded (#8050 review, C1). The hook's own
// call site (`installAssertMatchPayloadGuard()`, unindented, no `export`)
// matches; the library's definition line and the hook's descriptive comment
// mentioning the same name do not.
const INSTALL_CALL = /^installAssertMatchPayloadGuard\(/m
const LIBRARY_FILES = ['scripts/lib/assert-match-payload-guard.mjs']

for (const pkg of nodeTestPackagesFound) {
  test(`packages/${pkg.name} installs the payload guard in its test script`, () => {
    assert(
      packageInstalls({ repoRoot: REPO_ROOT, pkg, installCall: INSTALL_CALL, libraryFiles: LIBRARY_FILES }),
      `packages/${pkg.name}'s test script --imports nothing that CALLS installAssertMatchPayloadGuard() ` +
        `at the start of a line (importing the library instead of the hook satisfies a plain substring ` +
        `check but installs nothing):\n  ${pkg.script}`,
    )
  })
}

// ── node:test suites outside the roster packages (#8056 finding 4) ──────────
// Exemptions live in scripts/lib/node-test-roster.mjs and are asserted equal, both ways,
// in no-test-force-exit.test.mjs; here the payload-relevant half: an exempt suite is only
// safe unguarded while its assert.match count is the one the exemption was judged on.
test('direct-run node:test suites keep the assert.match count their exemption was judged on', () => {
  const directRun = directRunNodeTestFiles(REPO_ROOT, nodeTestPackagesFound.map((p) => p.name))
  const bad = directRun.filter((f) => DIRECT_RUN_EXEMPTIONS[f.file]?.matchSites !== f.matchSites)
  assert(
    bad.length === 0,
    `exemption out of date (new/changed assert.match sites, or no exemption): ${bad.map((f) => `${f.file}=${f.matchSites}`).join(', ')}`,
  )
})

// ── The mechanism: does --import-ing the hook actually patch assert? ───────

const dir = mkdtempSync(join(tmpdir(), 'chroxy-payload-guard-hook-'))
try {
  const probe = join(dir, 'probe.mjs')
  writeFileSync(probe, "import assert from 'node:assert/strict'\nconsole.log(assert.match.name)\n")

  test('the --import hook patches assert.match on its own', () => {
    const r = spawnSync(process.execPath, ['--import', HOOK_URL, probe], { encoding: 'utf8' })
    assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`)
    assert(r.stdout.includes('chroxyGuardedAssert'), `expected the guard marker name:\n${r.stdout}`)
  })

  test('POSITIVE CONTROL: without the hook, assert.match is the stock function', () => {
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
    assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`)
    assert(!r.stdout.includes('chroxyGuardedAssert'), `expected the stock function, got:\n${r.stdout}`)
  })

  test('the hook never changes a verdict — a failing over-limit match still throws', () => {
    const probeFail = join(dir, 'probe-fail.mjs')
    writeFileSync(
      probeFail,
      "import assert from 'node:assert/strict'\n" +
        "try {\n" +
        "  assert.match('x'.repeat(5000), /NEEDLE/)\n" +
        "  console.log('NO_THROW')\n" +
        "} catch (err) {\n" +
        "  console.log('THREW', err.operator, String(err.actual).length < 500)\n" +
        "}\n",
    )
    const r = spawnSync(process.execPath, ['--import', HOOK_URL, probeFail], { encoding: 'utf8' })
    assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`)
    assert(r.stdout.includes('THREW match true'), `expected a bounded throw:\n${r.stdout}`)
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
