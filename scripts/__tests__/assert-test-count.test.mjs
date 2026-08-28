#!/usr/bin/env node
/**
 * assert-test-count.test.mjs — harness for scripts/lib/assert-test-count.mjs
 * (#7447: hoisted from packages/server and shared by server, design-tokens and
 * claude-hooks).
 *
 * No external test framework, matching its siblings. Each case spawns the real
 * script around a `node -e` child that emits a synthetic TAP summary, and
 * asserts on the EXIT CODE — the one observable the guard exists to produce.
 * A guard proven only by its output string would pass with the exit wiring
 * broken, which is the false-safety shape docs/false-safety-guards.md tracks.
 *
 * Run from repo root:
 *   node scripts/__tests__/assert-test-count.test.mjs
 */

import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const script = resolve(__dirname, '..', 'lib', 'assert-test-count.mjs')

let pass = 0
let fail = 0
const failures = []

// Ambient-env insulation: OMIT the key rather than passing undefined. Node
// does drop undefined env values on every supported version, but an explicit
// omission cannot be re-litigated (review thread on #7461) and cannot regress.
const { CHROXY_MIN_TEST_COUNT: _ambient, ...insulatedEnv } = process.env
const run = (args, env = {}) => new Promise((done) => {
  execFile(process.execPath, [script, ...args], {
    env: { ...insulatedEnv, ...env },
  }, (err) => done(err ? err.code ?? 1 : 0))
})

/** A child that prints the given TAP summary lines and exits 0. */
const tap = (tests, failed) =>
  [process.execPath, '-e', `console.log('# tests ${tests}'); console.log('# fail ${failed}')`]

const test = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`ok - ${name}`)
  } catch (e) {
    fail += 1
    failures.push(`${name}: ${e.message}`)
    console.log(`not ok - ${name}`)
  }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: got ${a}, want ${b}`) }

await test('zero discovered tests fails the floor (#7447: the zero-test green)', async () => {
  eq(await run(['--min', '5', ...tap(0, 0)]), 1, 'exit')
})
await test('an at-floor run passes', async () => {
  eq(await run(['--min', '5', ...tap(5, 0)]), 0, 'exit')
})
await test('real test failures fail even above the floor', async () => {
  eq(await run(['--min', '2', ...tap(10, 2)]), 1, 'exit')
})
await test('a missing TAP summary fails (runner died before reporting)', async () => {
  eq(await run(['--min', '2', process.execPath, '-e', "console.log('no summary here')"]), 1, 'exit')
})
await test('an invalid --min is fail-closed: exit 2, never a disabled floor', async () => {
  eq(await run(['--min', 'abc', ...tap(9999, 0)]), 2, 'exit')
})
await test('a VALID env override outranks --min (the targeted-run escape hatch)', async () => {
  eq(await run(['--min', '100', ...tap(5, 0)], { CHROXY_MIN_TEST_COUNT: '3' }), 0, 'exit')
})
await test('a valid env override EQUAL to the server default still outranks --min', async () => {
  // The distinguishing input for validity-tracking (#7461 review, C1): the
  // naive value-comparison (EXPECTED === DEFAULT) reads env=13500 as "no
  // override" and lets --min 1 win, exiting 0 here. Validity tracking keeps
  // the env floor, so 5 < 13500 exits 1.
  eq(await run(['--min', '1', ...tap(5, 0)], { CHROXY_MIN_TEST_COUNT: '13500' }), 1, 'exit')
})
await test('an INVALID env override falls back to --min, not to the server default', async () => {
  // 5 >= 3 passes ONLY if the fallback floor is --min's 3; the server default
  // (13500) would fail it — so exit 0 pins the fallback target.
  eq(await run(['--min', '3', ...tap(5, 0)], { CHROXY_MIN_TEST_COUNT: 'abc' }), 0, 'exit')
})
await test('no command at all is a usage error', async () => {
  eq(await run(['--min', '5']), 2, 'exit')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of failures) console.error(`  FAIL ${f}`)
  process.exit(1)
}
