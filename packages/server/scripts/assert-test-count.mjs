#!/usr/bin/env node
/**
 * Truncation guard for the server suite (#5480, corrected in #7400).
 *
 * A test run that dies, aborts, or silently drops whole files still prints a
 * clean-looking TAP summary and exits 0. "Ran and passed" and "never ran" are
 * the same observable outcome — the defect class `docs/false-safety-guards.md`
 * exists for — so this wrapper adds the one thing the runner's own exit code
 * cannot give you: a floor on how much of the suite reported back.
 *
 * ── What this docblock used to say, and why it was wrong ───────────────────
 *
 * It said "the server test command runs the Node test runner with
 * `--test-force-exit`". It has not since #6042/#6100, and CI never did. The
 * stale claim mattered: #7400 was filed only after someone re-derived, from
 * this comment, that the flag was in use and therefore safe to type locally.
 * It is not safe — measured on `base-session.test.js` (192 tests), the flag
 * reported 154-192 of them across five runs, every run `# fail 0`, exit 0. The
 * tests all RAN; their results were dropped on the way from the child process
 * to the runner. Both `tests/_setup.mjs` files now REFUSE the flag outright
 * (`scripts/lib/no-test-force-exit.mjs`), so no run this wrapper sees can be
 * truncated that way any more.
 *
 * ── What it still catches ──────────────────────────────────────────────────
 *
 *   1. It runs the underlying test command (passed as argv), streaming all
 *      output through unchanged so coverage + TAP land on the terminal/CI log.
 *   2. From the aggregate TAP summary it reads `# tests N` and `# fail M`.
 *   3. It exits non-zero if:
 *        - the summary is missing (the runner died before reporting), OR
 *        - the run was killed by a signal, OR
 *        - `M > 0` (real test failures — mirrors the runner's own exit), OR
 *        - `N < EXPECTED_MIN_TESTS` (enough of the suite went missing to fall
 *          below the documented floor — a glob that stopped matching, a file
 *          that failed to load, a bad merge that deleted a directory).
 *
 * EXPECTED_MIN_TESTS is a *lower bound*, not the exact count. The floor sits
 * below the live count with headroom so it does not break every time a test is
 * added, but high enough that a meaningful loss trips it. When the suite grows
 * well past the floor, bump the floor (the script prints the live count + a
 * nudge when headroom gets large). When tests are deliberately removed below
 * the floor, lower it in the same PR.
 */
import { spawn } from 'node:child_process'

// --- The documented floor -----------------------------------------------------
// Set below the observed full-suite count with deliberate headroom for honest
// growth AND shrinkage, while still catching a loss of more than a few hundred
// tests. Measured 2026-08-27: 14049 on the CI Linux runner (`# tests` from the
// Server Tests job on main @ 1028ee8e3) and 14059 locally on macOS — the two
// platforms differ by ten tests, so one floor covers both. Override
// per-invocation with CHROXY_MIN_TEST_COUNT for targeted runs of a subset
// (e.g. a single large file in local repro).
const DEFAULT_MIN_TESTS = 13500
// Validate the override: an invalid value (typo, empty, non-numeric) must NOT
// silently disable the floor. `Number('abc')` is NaN and `total < NaN` is always
// false, which would quietly turn the guard off — so fall back to the default and
// warn loudly instead.
let EXPECTED_MIN_TESTS = DEFAULT_MIN_TESTS
if (process.env.CHROXY_MIN_TEST_COUNT !== undefined) {
  const parsed = Number(process.env.CHROXY_MIN_TEST_COUNT)
  if (Number.isInteger(parsed) && parsed > 0) {
    EXPECTED_MIN_TESTS = parsed
  } else {
    console.error(
      `[assert-test-count] ignoring invalid CHROXY_MIN_TEST_COUNT='${process.env.CHROXY_MIN_TEST_COUNT}' ` +
      `(must be a positive integer); using default floor ${DEFAULT_MIN_TESTS}.`,
    )
  }
}

// How far above the floor the live count must climb before we suggest bumping
// the floor. Purely advisory — never fails the run.
const HEADROOM_NUDGE = 600

const cmd = process.argv[2]
const args = process.argv.slice(3)

if (!cmd) {
  console.error('[assert-test-count] usage: assert-test-count.mjs <cmd> [...args]')
  process.exit(2)
}

// Capture stdout while still echoing it. The TAP summary the Node test runner
// emits goes to stdout; stderr is passed straight through (logs/warnings).
let captured = ''
const child = spawn(cmd, args, {
  stdio: ['inherit', 'pipe', 'inherit'],
  // `c8`/`node` resolve from PATH. On Windows, npm installs `c8` as a `c8.cmd`
  // shim and CreateProcess can't execute a .cmd without a shell, so spawn via
  // the shell there; on POSIX keep shell:false so argv quoting stays intact.
  shell: process.platform === 'win32',
})

child.stdout.on('data', (chunk) => {
  captured += chunk
  process.stdout.write(chunk)
})

child.on('error', (err) => {
  console.error(`[assert-test-count] failed to spawn '${cmd}': ${err.message}`)
  process.exit(2)
})

child.on('close', (code, signal) => {
  const fail = () => process.exit(1)

  // Parse the aggregate TAP summary. The Node test runner prints one summary
  // block at the very end; we take the LAST occurrence of each line so a
  // subtest's own `# fail 0` cannot shadow the aggregate.
  const lastNumber = (label) => {
    const re = new RegExp(`^# ${label} (\\d+)`, 'gm')
    let m
    let val = null
    while ((m = re.exec(captured)) !== null) val = Number(m[1])
    return val
  }

  const total = lastNumber('tests')
  const failed = lastNumber('fail')

  if (signal) {
    console.error(`\n[assert-test-count] FAIL: test process was killed by signal ${signal}.`)
    return fail()
  }

  if (total === null || failed === null) {
    console.error(
      '\n[assert-test-count] FAIL: no TAP summary (`# tests` / `# fail`) found in output. ' +
      'The runner likely died before reporting — treat as a truncated/aborted run.',
    )
    return fail()
  }

  if (failed > 0) {
    console.error(`\n[assert-test-count] FAIL: ${failed} test(s) failed (see TAP output above).`)
    return fail()
  }

  if (total < EXPECTED_MIN_TESTS) {
    console.error(
      `\n[assert-test-count] FAIL: only ${total} tests ran, below the floor of ${EXPECTED_MIN_TESTS}.\n` +
      '  Part of the suite did not report (#5480). Something stopped whole files from\n' +
      '  running or reporting: a glob that no longer matches, a file that threw while\n' +
      '  loading, a deleted directory. Look for a file the TAP output never mentions —\n' +
      '  the count is the only symptom, because the run still exited 0. If you\n' +
      '  intentionally removed tests below the floor, lower EXPECTED_MIN_TESTS in this script.',
    )
    return fail()
  }

  // Green. Nudge to raise the floor if it has drifted well below the live count.
  if (total - EXPECTED_MIN_TESTS > HEADROOM_NUDGE) {
    console.error(
      `\n[assert-test-count] OK: ${total} tests ran (floor ${EXPECTED_MIN_TESTS}). ` +
      `Consider raising EXPECTED_MIN_TESTS — the suite is now ${total - EXPECTED_MIN_TESTS} above the floor.`,
    )
  } else {
    console.error(`\n[assert-test-count] OK: ${total} tests ran (floor ${EXPECTED_MIN_TESTS}).`)
  }

  // Preserve the underlying exit code for any non-test failure (e.g. c8 error)
  // that still printed a clean summary.
  process.exit(code ?? 0)
})
