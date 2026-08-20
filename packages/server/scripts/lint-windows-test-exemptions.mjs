#!/usr/bin/env node
/**
 * Gate for the Windows test-exemption manifest (#7270).
 *
 * `Server Windows Tests` used to run a hardcoded list of eight files out of
 * 553. It is now inverted: `run = all - WINDOWS_EXEMPT`, so a new test file is
 * run on Windows by default and a POSIX-only one has to be classified out.
 *
 * That inversion cannot fail SILENTLY — an unclassified hostile file makes the
 * Windows job red, naming itself. So this gate does not check for "unclassified
 * files"; there is no such state. It checks the one thing that CAN rot: the
 * exempt manifest itself. Stale rows, unknown reason categories, tracked-debt
 * rows with no issue, missing measured symptoms, duplicates, an exempt ratio
 * above the ceiling, and any MUST_RUN_ON_WINDOWS suite relocated into the
 * exempt list.
 *
 * ── Why this runs on LINUX, in Server Lint ─────────────────────────────────
 *
 * `Server Windows Tests` is NOT a required status check (the 11 required
 * contexts are Server Tests, App Type Check, Server Lint, Dashboard Tests,
 * Dashboard Type Check, Protocol Tests, Store Core Type Check, App Tests,
 * Store Core Tests, Desktop Rust Tests, App Expo Doctor). A red Windows job
 * does not block a merge. If the only check on this manifest lived inside that
 * job, the whole thing would be advisory — `docs/false-safety-guards.md`'s
 * "Never reached" mode. `Server Lint` IS required, so the manifest is gated
 * there and the tests merely RUN on Windows.
 *
 * Linux is also the stricter host for the stale-row direction: NTFS is
 * case-insensitive, so a row spelled `tests/Foo.test.js` could match on Windows
 * and be stale everywhere else.
 *
 * Exit codes, matching lint-entry-point-guard.mjs:
 *   0 — clean
 *   1 — the manifest is wrong (stale reason, missing issue, over-broad, must-run violated)
 *   2 — the gate could not do its job (bad flags, a path that vanished, a broken walk)
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function usageError(message) {
  console.error(`[lint-windows-test-exemptions] ${message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
let testsRoot = null
let manifestPath = null
let minFiles = 0

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--tests-root') testsRoot = args[++i]
  else if (a === '--manifest') manifestPath = args[++i]
  else if (a === '--min-files') minFiles = Number(args[++i])
  else if (a === '--help' || a === '-h') {
    console.log('usage: lint-windows-test-exemptions.mjs [--tests-root DIR] [--manifest FILE] [--min-files N]')
    process.exit(0)
  } else {
    // A typo'd flag must not be ignored: `--tests-rooot /fixture` would
    // silently walk the REAL tree and report cleanly on something nobody asked
    // about. Fail closed.
    usageError(`unknown argument ${JSON.stringify(a)}`)
  }
}

if (minFiles !== 0 && (!Number.isInteger(minFiles) || minFiles < 0)) {
  usageError(`--min-files must be a non-negative integer, got ${JSON.stringify(args[args.indexOf('--min-files') + 1])}`)
}

testsRoot = testsRoot ? resolve(testsRoot) : resolve(HERE, '..', 'tests')

// Load the shared derivation. A manifest module that fails to load must exit 2
// ("the gate is broken"), never leak an uncaught ESM error — which exits 1 and
// would read as "the code is dirty".
let lib
try {
  lib = await import(join(HERE, 'lib', 'windows-test-set.mjs'))
} catch (err) {
  usageError(`could not load lib/windows-test-set.mjs: ${err && err.message}`)
}

let manifest = lib.WINDOWS_EXEMPT
let mustRun = lib.MUST_RUN_ON_WINDOWS
let reasons = lib.EXEMPT_REASONS
let maxRatio = lib.MAX_EXEMPT_RATIO
if (manifestPath) {
  try {
    const mod = await import(resolve(manifestPath))
    if (!Array.isArray(mod.WINDOWS_EXEMPT)) {
      usageError(`${manifestPath} does not export a WINDOWS_EXEMPT array`)
    }
    manifest = mod.WINDOWS_EXEMPT
    if (Array.isArray(mod.MUST_RUN_ON_WINDOWS)) mustRun = mod.MUST_RUN_ON_WINDOWS
    if (mod.EXEMPT_REASONS) reasons = mod.EXEMPT_REASONS
    if (typeof mod.MAX_EXEMPT_RATIO === 'number') maxRatio = mod.MAX_EXEMPT_RATIO
  } catch (err) {
    usageError(`could not load --manifest ${manifestPath}: ${err && err.message}`)
  }
}

const { all, exempt, run, problems } = lib.resolveWindowsTestSet({
  testsRoot,
  manifest,
  mustRun,
  reasons,
  maxExemptRatio: maxRatio,
  minFiles,
})

const brokenProblems = problems.filter((p) => p.severity === 'broken')
const manifestProblems = problems.filter((p) => p.severity === 'manifest')

for (const p of [...brokenProblems, ...manifestProblems]) console.error(`  ${p.message}`)

if (brokenProblems.length > 0) {
  console.error(
    `\n[lint-windows-test-exemptions] BROKEN: ${brokenProblems.length} problem(s) mean this gate could not ` +
    'do its job. That is not the same as the manifest being clean.',
  )
  process.exit(2)
}

if (manifestProblems.length > 0) {
  console.error(
    `\n[lint-windows-test-exemptions] FAIL: ${manifestProblems.length} problem(s) in the Windows exemption ` +
    'manifest (packages/server/scripts/lib/windows-test-set.mjs).',
  )
  process.exit(1)
}

const debt = exempt.filter((r) => reasons[r.reason] && reasons[r.reason].kind === 'debt').length
const pct = ((exempt.length / all.length) * 100).toFixed(1)
const ceiling = (maxRatio * 100).toFixed(1)
const reasonCount = new Set(exempt.map((r) => r.reason)).size
console.log(
  `[lint-windows-test-exemptions] OK: ${all.length} test file(s) under ${testsRoot}; ` +
  `${exempt.length} exempt across ${reasonCount} reason(s) (${debt} tracked as debt); ` +
  `${run.length} run on Windows (${pct}% exempt, ceiling ${ceiling}%).`,
)
