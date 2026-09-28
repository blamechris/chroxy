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

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const MIN_CASES = 6

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

const packagesDir = resolve(REPO_ROOT, 'packages')
const nodeTestPackages = []
for (const name of readdirSync(packagesDir)) {
  const manifest = join(packagesDir, name, 'package.json')
  if (!existsSync(manifest)) continue
  const script = JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test ?? ''
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

for (const { name, script } of nodeTestPackages) {
  test(`packages/${name} installs the payload guard in its test script`, () => {
    const imports = [...script.matchAll(/--import\s+(\S+)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
    const installs = imports.some((spec) => {
      if (!spec.startsWith('.')) return false // bare specifier (tsx/esm) — not ours
      const file = resolve(packagesDir, name, spec)
      if (!existsSync(file)) return false
      return INSTALL_CALL.test(readFileSync(file, 'utf8'))
    })
    assert(
      installs,
      `packages/${name}'s test script --imports nothing that CALLS installAssertMatchPayloadGuard() ` +
        `at the start of a line (importing the library instead of the hook satisfies a plain substring ` +
        `check but installs nothing):\n  ${script}`,
    )
  })
}

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
