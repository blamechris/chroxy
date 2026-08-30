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
 * The manifest gate lives HERE — in `Server Lint`, on Linux — so that its
 * blocking power never depends on which contexts happen to be in the
 * required-status roster. (That roster changes: `Server Windows Tests` IS a
 * required check today — see CONTRIBUTING.md's guarded list, #7448/#7502 —
 * after this comment spent a while claiming otherwise with a hand-copied
 * 11-name list that had drifted. The placement stands on its own reason: if
 * the only check on this manifest lived inside the Windows job, un-requiring
 * that job — one API call — would silently demote the whole thing to
 * advisory, `docs/false-safety-guards.md`'s "Never reached" mode.)
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
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function usageError(message) {
  console.error(`[lint-windows-test-exemptions] ${message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
let testsRoot = null
let manifestPath = null
let minFiles = 0

// A value-taking flag with no value must NOT fall back to the default.
// `lint-windows-test-exemptions.mjs --tests-root` (flag last) makes args[++i]
// undefined and would silently lint the REAL tree — the same fail-open the
// unknown-flag check below exists to prevent. A following flag is not a value.
const valueFor = (flag, i) => {
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) usageError(`${flag} requires a value`)
  return v
}

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--tests-root') { testsRoot = valueFor(a, i); i++ }
  else if (a === '--manifest') { manifestPath = valueFor(a, i); i++ }
  else if (a === '--min-files') { minFiles = Number(valueFor(a, i)); i++ }
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

if (!Number.isInteger(minFiles) || minFiles < 0) {
  usageError(`--min-files must be a non-negative integer, got ${JSON.stringify(args[args.indexOf('--min-files') + 1])}`)
}

testsRoot = testsRoot ? resolve(testsRoot) : resolve(HERE, '..', 'tests')

// Load the shared derivation. A manifest module that fails to load must exit 2
// ("the gate is broken"), never leak an uncaught ESM error — which exits 1 and
// would read as "the code is dirty".
let lib
try {
  // pathToFileURL, not a bare path: on Windows an absolute path is 'A:\\...',
  // and the ESM loader rejects it as an unknown 'a:' protocol.
  lib = await import(pathToFileURL(join(HERE, 'lib', 'windows-test-set.mjs')).href)
} catch (err) {
  usageError(`could not load lib/windows-test-set.mjs: ${err && err.message}`)
}

let manifest = lib.WINDOWS_EXEMPT
let mustRun = lib.MUST_RUN_ON_WINDOWS
let reasons = lib.EXEMPT_REASONS
let maxRatio = lib.MAX_EXEMPT_RATIO
let minMustRun = lib.MIN_MUST_RUN_ON_WINDOWS
if (manifestPath) {
  try {
    const mod = await import(pathToFileURL(resolve(manifestPath)).href)
    if (!Array.isArray(mod.WINDOWS_EXEMPT)) {
      usageError(`${manifestPath} does not export a WINDOWS_EXEMPT array`)
    }
    manifest = mod.WINDOWS_EXEMPT
    if (Array.isArray(mod.MUST_RUN_ON_WINDOWS)) mustRun = mod.MUST_RUN_ON_WINDOWS
    if (mod.EXEMPT_REASONS) reasons = mod.EXEMPT_REASONS
    if (typeof mod.MAX_EXEMPT_RATIO === 'number') maxRatio = mod.MAX_EXEMPT_RATIO
    if (typeof mod.MIN_MUST_RUN_ON_WINDOWS === 'number') minMustRun = mod.MIN_MUST_RUN_ON_WINDOWS
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
  minMustRun,
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
