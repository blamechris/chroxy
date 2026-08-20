#!/usr/bin/env node
/**
 * Runs the DERIVED Windows server test set (#7270).
 *
 * The Windows job used to name eight test files by hand while
 * `packages/server/tests/` grew to 553, so a new cross-platform test was never
 * run there and nobody was told. This runner walks every `*.test.js`, subtracts
 * `WINDOWS_EXEMPT`, and runs the rest — a new file is covered by default.
 *
 * ── Why it spawns `node --test` rather than using node:test's run() ─────────
 *
 * `run({ files, execArgv })` works (verified on 22.x) and would sidestep argv
 * limits for free. It is still the wrong choice here: it is a SECOND runner
 * path, and a second execution path is the same defect as a second enumeration
 * path one level up. The ubuntu job runs
 * `node --import ./tests/_setup.mjs --experimental-test-module-mocks --test <glob>`;
 * spawning that exact argv means a Windows-vs-Linux difference can never be
 * blamed on the runner. The TAP-summary parsing below mirrors
 * `assert-test-count.mjs`'s (that script exports nothing, so it cannot be
 * imported); the file reporter and the exit policy are new here, and are the
 * parts most worth reading twice — an exit policy is precisely where a
 * false-safety bug lives.
 *
 * ── Why the list never crosses a command line as text ──────────────────────
 *
 * We spawn `process.execPath` with an argv ARRAY and `shell: false`, so:
 *   * CreateProcessW's 32,767-char cap applies only to what we batch (measured
 *     20,515 chars for all 553 paths — 63% — so the ceiling is real but far),
 *     and BATCHING removes it permanently rather than deferring it;
 *   * cmd.exe's much lower 8,191 cap can never apply, because we never route
 *     through a `.cmd` shim. That rules out `npm run` / `npx` / `c8` on this
 *     job — assert-test-count.mjs sets `shell: true` on win32 precisely because
 *     `c8` IS a `.cmd`, and the 553-path argv would blow that cap 2.5x over.
 *
 * Exit codes:
 *   0 — every file in the derived set ran and passed
 *   1 — a test failed, or the run was truncated / unreportable
 *   2 — the runner could not do its job (stale manifest, broken walk, empty
 *       set, spawn failure). "The guard broke" must not read as "the guard
 *       passed", nor as "the code is dirty".
 */

import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = resolve(HERE, '..')

// Conservative against CreateProcessW's 32,767. Leaves room for the node path,
// the flags, and growth inside a single batch.
const DEFAULT_MAX_ARGV_BYTES = 24000

// The collapse floor, on the side that actually EXECUTES the tests. The Linux
// gate carries one via its .sh wrapper, but that wrapper cannot run on the
// Windows job — so without this the runner would happily report
// "OK: 3 file(s) ... 0 failed" after a broken walk, and 3 clean files would be
// indistinguishable from 480. Same value and same reasoning as the wrapper's.
const DEFAULT_MIN_FILES = 500
let minFiles = DEFAULT_MIN_FILES

function usageError(message) {
  console.error(`[run-windows-tests] ${message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
let printPlan = false
let maxArgvBytes = DEFAULT_MAX_ARGV_BYTES
let concurrency = null
let testsRoot = null

// A value-taking flag with no value must NOT fall back to the default.
// `run-windows-tests.mjs --tests-root` (flag last) makes args[++i] undefined,
// and silently running against the REAL tree is precisely the fail-open this
// script refuses everywhere else. A following flag is not a value either.
const valueFor = (flag, i) => {
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) {
    usageError(`${flag} requires a value`)
  }
  return v
}

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--print-plan') printPlan = true
  else if (a === '--max-argv-bytes') { maxArgvBytes = Number(valueFor(a, i)); i++ }
  else if (a === '--test-concurrency') { concurrency = valueFor(a, i); i++ }
  else if (a === '--tests-root') { testsRoot = valueFor(a, i); i++ }
  else if (a === '--min-files') { minFiles = Number(valueFor(a, i)); i++ }
  else usageError(`unknown argument ${JSON.stringify(a)}`)
}

if (!Number.isInteger(minFiles) || minFiles < 0) {
  usageError(`--min-files must be a non-negative integer, got ${minFiles}`)
}

if (!Number.isInteger(maxArgvBytes) || maxArgvBytes < 200) {
  usageError(`--max-argv-bytes must be an integer >= 200, got ${maxArgvBytes}`)
}

testsRoot = testsRoot ? resolve(testsRoot) : join(SERVER_ROOT, 'tests')

let lib
try {
  // pathToFileURL, not a bare path: on Windows an absolute path is 'A:\\...',
  // and the ESM loader rejects it as an unknown 'a:' protocol.
  lib = await import(pathToFileURL(join(HERE, 'lib', 'windows-test-set.mjs')).href)
} catch (err) {
  usageError(`could not load lib/windows-test-set.mjs: ${err && err.message}`)
}

const { all, exempt, run, problems } = lib.resolveWindowsTestSet({ testsRoot, minFiles })

// The runner refuses on ANY problem — including a merely-wrong manifest. The
// Server Lint gate is where a manifest defect gets its own precise verdict;
// here it means the set we are about to run is not trustworthy.
if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p.message}`)
  usageError(
    `${problems.length} problem(s) resolving the Windows test set — refusing to run. ` +
    'Fix packages/server/scripts/lib/windows-test-set.mjs (see Server Lint for the itemised verdict).',
  )
}

// Batch so no single command line can approach the OS cap.
const batches = []
let current = []
let currentBytes = 0
for (const f of run) {
  const cost = f.length + 3
  if (current.length > 0 && currentBytes + cost > maxArgvBytes) {
    batches.push(current)
    current = []
    currentBytes = 0
  }
  current.push(f)
  currentBytes += cost
}
if (current.length > 0) batches.push(current)

if (printPlan) {
  // batchFiles carries the actual partition, not just its shape: a test that
  // only compares COUNTS cannot tell a correct partition from one that dropped
  // a file and duplicated another.
  console.log(JSON.stringify({
    all: all.length,
    exempt: exempt.length,
    run: run.length,
    batches: batches.map((b) => b.length),
    batchFiles: batches,
    maxArgvBytes,
  }, null, 2))
  process.exit(0)
}

const REPORTER = join(HERE, 'lib', 'windows-test-file-reporter.mjs')

// NTFS is case-insensitive, so the same file can be spelled with a different
// drive-letter or directory case by the reporter than by resolve(). Comparing
// those as strings would report every file as both "missing" and "unexpected"
// at once — a mass failure with a baffling message. Case-fold on win32 ONLY:
// POSIX paths are case-SENSITIVE and folding them there would let two genuinely
// different files collide.
const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

const lastNumber = (text, label) => {
  const re = new RegExp(`^# ${label} (\\d+)`, 'gm')
  let m
  let val = null
  while ((m = re.exec(text)) !== null) val = Number(m[1])
  return val
}

let totalTests = 0
let totalFail = 0
let totalCancelled = 0
let worstExit = 0
const filesExecuted = new Set()
// Top-level TAP entries that did not pass. node's TAP carries no file paths, so
// these suite names are the only handle on WHICH work went wrong — without them
// a cancellation says "33 tests were cancelled" and leaves you grepping 96,000
// lines of log to find out where.
const failedTopLevel = []

for (let b = 0; b < batches.length; b++) {
  const batch = batches[b]
  // A per-batch destination for the file reporter. It cannot share stdout
  // (that is TAP) and must not share stderr (that is diagnostics), so it gets
  // its own file, which we read back below.
  const manifestOut = join(tmpdir(), `chroxy-win-testfiles-${process.pid}-${b}.txt`)
  const argv = [
    '--import', './tests/_setup.mjs',
    '--experimental-test-module-mocks',
    '--test-reporter=tap', '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(REPORTER).href}`, `--test-reporter-destination=${manifestOut}`,
  ]
  if (concurrency) argv.push(`--test-concurrency=${concurrency}`)
  argv.push('--test', ...batch.map((f) => `./${f}`))

  const captured = await new Promise((res, rej) => {
    let out = ''
    const child = spawn(process.execPath, argv, {
      cwd: SERVER_ROOT,
      stdio: ['inherit', 'pipe', 'inherit'],
      shell: false,
    })
    // Decode as UTF-8 across chunk boundaries. `out += chunk` calls
    // Buffer.toString() per chunk, so a multi-byte sequence straddling a 64KB
    // boundary decodes as U+FFFD on both sides — harmless for the ASCII TAP
    // numbers, but it corrupts the suite NAMES that are the only diagnostic a
    // cancellation gives you.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      process.stdout.write(chunk)
    })
    child.on('error', (err) => rej(err))
    child.on('close', (code, signal) => res({ out, code, signal }))
  }).catch((err) => {
    usageError(`failed to spawn the test runner for batch ${b + 1}/${batches.length}: ${err && err.message}`)
  })

  if (captured.signal) {
    console.error(`\n[run-windows-tests] FAIL: batch ${b + 1} was killed by signal ${captured.signal}.`)
    process.exit(1)
  }

  const tests = lastNumber(captured.out, 'tests')
  const fail = lastNumber(captured.out, 'fail')
  // A CANCELLED test is one that never finished — node reports it separately
  // from `fail`, and a run can carry `# fail 0` alongside `# cancelled 33`.
  // Counting only `fail` would make "33 tests never ran" indistinguishable
  // from "everything passed", which is the exact mode this whole change exists
  // to remove. Measured on the real Windows host: 33 cancelledByParent while
  // `# fail` was 1.
  const cancelled = lastNumber(captured.out, 'cancelled')
  if (typeof captured.code === 'number' && captured.code !== 0) worstExit = captured.code
  if (tests === null || fail === null) {
    console.error(
      `\n[run-windows-tests] FAIL: batch ${b + 1}/${batches.length} produced no TAP summary ` +
      '(`# tests` / `# fail`). The runner died before reporting — treat as a truncated run, not a pass.',
    )
    process.exit(1)
  }

  // "Cannot tell which files ran" is not "all the files ran".
  let reported
  try {
    reported = readFileSync(manifestOut, 'utf8')
  } catch (err) {
    console.error(
      `\n[run-windows-tests] FAIL: batch ${b + 1} produced no file manifest at ${manifestOut} ` +
      `(${err && err.message}). Cannot verify which files ran, so this run cannot be called green.`,
    )
    process.exit(1)
  }
  for (const line of reported.split('\n')) {
    const t = line.trim()
    if (t) {
      const k = pathKey(t)
      filesExecuted.add(k)
      if (!executedOriginal.has(k)) executedOriginal.set(k, relative(SERVER_ROOT, t).split(sep).join('/'))
    }
  }
  try { rmSync(manifestOut, { force: true }) } catch { /* best effort */ }

  for (const m of captured.out.matchAll(/^not ok \d+ - (.+)$/gm)) failedTopLevel.push(m[1].trim())

  totalTests += tests
  totalFail += fail
  totalCancelled += cancelled ?? 0
}

// Naming what went wrong is not optional: "cannot tell you which" and "there
// were none" must not read the same.
const nameTopLevel = () => {
  if (failedTopLevel.length === 0) {
    return '  (could not identify which suites from the TAP output — see the full log above)'
  }
  const shown = failedTopLevel.slice(0, 25).map((n) => `    ${n}`).join('\n')
  const more = failedTopLevel.length > 25 ? `\n    … and ${failedTopLevel.length - 25} more` : ''
  return `  Top-level suites that did not pass:\n${shown}${more}`
}

if (totalTests === 0) {
  console.error('\n[run-windows-tests] FAIL: 0 tests ran across the whole derived set — refusing to report a pass.')
  process.exit(1)
}

// The self-maintaining check: compare the IDENTITY of what ran against what was
// asked for, not a count and not a magic number. Nothing here drifts as the
// suite grows.
const expected = new Map(run.map((f) => [pathKey(join(SERVER_ROOT, f)), f]))
// Keep the ORIGINAL spelling for every key so a diagnostic never prints the
// case-folded, backslash-separated form — that is a third spelling, matching
// neither the on-disk name nor the manifest's, and pasting it into
// WINDOWS_EXEMPT produces an unrelated-looking exit 2.
const executedOriginal = new Map()
const missing = [...expected.keys()].filter((k) => !filesExecuted.has(k))
const unexpected = [...filesExecuted].filter((k) => !expected.has(k))
if (missing.length > 0 || unexpected.length > 0) {
  console.error(`\n[run-windows-tests] FAIL: the set of files that RAN does not match the derived set.`)
  if (missing.length > 0) {
    console.error(`  ${missing.length} file(s) were in the derived set but never reported running:`)
    for (const k of missing.slice(0, 20)) console.error(`    ${expected.get(k)}`)
    if (missing.length > 20) console.error(`    … and ${missing.length - 20} more`)
  }
  if (unexpected.length > 0) {
    console.error(`  ${unexpected.length} file(s) ran that were NOT in the derived set:`)
    for (const k of unexpected.slice(0, 20)) console.error(`    ${executedOriginal.get(k) ?? k}`)
  }
  console.error('\n  A run that skipped files must not report success.')
  process.exit(1)
}

if (totalCancelled > 0) {
  console.error(
    `\n[run-windows-tests] FAIL: ${totalCancelled} test(s) were CANCELLED and never completed ` +
    '(node reports these separately from failures — look for cancelledByParent above).\n' +
    '  A cancelled test produced no result. It is not a pass.\n' +
    nameTopLevel(),
  )
  process.exit(1)
}

// Last line of defence: the child said something went wrong and none of the
// checks above accounted for it. "The runner exited non-zero for a reason I
// cannot name" must not be reported as green.
if (worstExit !== 0 && totalFail === 0) {
  console.error(
    `\n[run-windows-tests] FAIL: the test runner exited ${worstExit} but the TAP summary reported ` +
    'no failures and no cancellations. Something failed in a way this script does not model — ' +
    'refusing to call the run green.',
  )
  process.exit(1)
}

if (totalFail > 0) {
  console.error(
    `\n[run-windows-tests] FAIL: ${totalFail} test(s) failed on Windows (see the TAP output above).\n` +
    nameTopLevel(),
  )
  console.error(
    '\nFix it, or — if the file depends on POSIX semantics with no Windows analogue — add a row to\n' +
    'WINDOWS_EXEMPT in packages/server/scripts/lib/windows-test-set.mjs with a reason category, the\n' +
    'measured symptom, and (for windows-defect / windows-slow) an issue number.',
  )
  process.exit(1)
}

console.log(
  `\n[run-windows-tests] OK: ${run.length} file(s) in the derived Windows set ` +
  `(${all.length} total, ${exempt.length} exempt), ${batches.length} batch(es), ${totalTests} tests, ` +
  '0 failed, 0 cancelled.',
)
