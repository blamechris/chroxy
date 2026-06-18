#!/usr/bin/env node
/**
 * Truncation guard for `--test-force-exit` (#5480).
 *
 * The server test command runs the Node test runner with `--test-force-exit`,
 * which `process.exit()`s the moment the runner *appears* idle. On a large
 * file this can fire while trailing suites are still queued, so the file runs
 * only a subset of its tests — yet exit code stays 0. A truncated run is then
 * indistinguishable from a green one (confirmed reproducible on current main:
 * `discord-webhook-sink.test.js` ran anywhere from 79 to 114 of its 114 tests
 * across 20 runs, always exiting 0).
 *
 * `--test-force-exit` cannot simply be removed: WITHOUT it the full suite hangs
 * past the 10-minute CI budget on leaked handles (tunnel-recovery timers and
 * friends — see follow-up issue). So instead of trading one silent failure
 * mode for a loud hang, this wrapper makes a *truncated* run go RED:
 *
 *   1. It runs the underlying test command (passed as argv), streaming all
 *      output through unchanged so coverage + TAP land on the terminal/CI log.
 *   2. From the aggregate TAP summary it reads `# tests N` and `# fail M`.
 *   3. It exits non-zero if:
 *        - the summary is missing (the runner died before reporting), OR
 *        - `M > 0` (real test failures — mirrors the runner's own exit), OR
 *        - `N < EXPECTED_MIN_TESTS` (a truncation dropped enough tests to fall
 *          below the documented floor).
 *
 * EXPECTED_MIN_TESTS is a *lower bound*, not the exact count. The full suite
 * reports ~10040 tests today; the floor sits below that with headroom so it
 * does not break every time a test is added, but high enough that a meaningful
 * truncation trips it. When the suite grows well past the floor, bump the floor
 * (the script prints the live count + a nudge when headroom gets large). When
 * tests are deliberately removed below the floor, lower it in the same PR.
 */

import { spawn } from 'node:child_process'

// --- The documented floor -----------------------------------------------------
// Set below the observed full-suite count (~10040 tests, three clean runs on
// 2026-06-18: 10040 / 10044 / 10048) with deliberate headroom for honest growth
// AND shrinkage, while still catching a truncation that drops more than a couple
// hundred tests. Override per-invocation with CHROXY_MIN_TEST_COUNT for targeted
// runs of a subset (e.g. a single large file in local repro).
const EXPECTED_MIN_TESTS = Number(process.env.CHROXY_MIN_TEST_COUNT ?? 9700)

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
  // `c8`/`node` resolve from PATH; shell:false keeps argv quoting intact.
  shell: false,
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
      '  This is the --test-force-exit truncation guard (#5480): a large test file very likely\n' +
      '  had trailing suites skipped before the forced exit. Re-run; if it persists, a file\n' +
      '  grew large enough to truncate reliably (split it, or move suites earlier). If you\n' +
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
