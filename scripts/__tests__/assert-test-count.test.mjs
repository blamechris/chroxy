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
import { dirname, resolve, join } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const script = resolve(__dirname, '..', 'lib', 'assert-test-count.mjs')

// Every case below must run. Without this, a harness whose cases stop executing
// reports "0 passed, 0 failed" and exits 0 — "all cases passed" and "no case
// executed" are the same observable outcome, the second recurring cause in
// docs/false-safety-guards.md (#7653). Asserted EQUAL, not >=, so removing a
// case is as loud as skipping one: a shell/node harness enumerates its cases
// literally, so the exact count is knowable here in a way it is not for a
// runner that DISCOVERS tests (scripts/lib/assert-test-count.mjs is a lower
// bound for exactly that reason).
const EXPECTED_CASES = 17

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

/** Like `run`, but returns the wrapper's own combined output as well as its code. */
const runCapture = (args, env = {}) => new Promise((done) => {
  execFile(process.execPath, [script, ...args], {
    env: { ...insulatedEnv, ...env },
  }, (err, stdout, stderr) => done({ code: err ? err.code ?? 1 : 0, out: `${stdout}${stderr}` }))
})

/** A child that prints the given TAP summary lines and exits 0. */
const tap = (tests, failed) =>
  [process.execPath, '-e', `console.log('# tests ${tests}'); console.log('# fail ${failed}')`]

/** The same, plus a `# cancelled` line — the shape a thrown `before()` produces. */
const tapWith = (tests, failed, cancelled) =>
  [process.execPath, '-e',
    `console.log('# tests ${tests}'); console.log('# fail ${failed}'); console.log('# cancelled ${cancelled}')`]

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
await test('CANCELLED tests fail, though `# fail` is 0 and the count clears the floor (#7648)', async () => {
  // The failure mode that looks most like a healthy run. When a `before()` hook
  // throws, `node --test` marks the tests it guarded CANCELLED, counts them in
  // `# tests` as though they ran, and leaves `# fail 0` — so neither the failure
  // check nor the count floor can see them. Measured on node v26.8.1: a throwing
  // `before()` over three tests gives `# tests 4 / # pass 1 / # fail 0 /
  // # cancelled 3`.
  //
  // The floor cannot be the thing that catches this, and that is the sharp part:
  // cancelled tests are INCLUDED in the total, so a hook failure that cancels a
  // whole describe leaves the count unchanged.
  eq(await run(['--min', '2', ...tapWith(4, 0, 3)]), 1, 'exit')
})
await test('CONTROL: the same summary with `# cancelled 0` still passes', async () => {
  // Without this the case above would also pass on a wrapper that had simply
  // started rejecting everything — it pins that the NUMBER is what fires, not
  // the presence of the line. A healthy `node --test` run emits `# cancelled 0`.
  eq(await run(['--min', '2', ...tapWith(4, 0, 0)]), 0, 'exit')
})
await test('CONTROL: a summary with NO cancelled line at all still passes', async () => {
  // The other half, and a different claim: this pins the `cancelled !== null`
  // half of the guard. The case above was originally labelled "without the
  // cancelled line" while emitting `# cancelled 0`, so it could not tell "no
  // line" from "line saying zero" — the two shapes a runner that does not
  // report cancellations and a healthy modern one produce (Copilot, #7684).
  //
  // It matters beyond tidiness: a `null` treated as `> 0` would fail every
  // consumer on an older Node, and a `null` is exactly what the parser returns
  // when the label is absent.
  eq(await run(['--min', '2', ...tap(4, 0)]), 0, 'exit')
})
await test('a REAL throwing before() is caught end to end, not just a synthetic summary', async () => {
  // The synthetic cases above assert on a hand-written TAP summary, which pins
  // the parser but not the premise. This runs `node --test` for real over a
  // suite whose `before()` throws, so if a future Node stops counting cancelled
  // tests this way, this case notices and the two above do not.
  const suite = join(tmpdir(), `assert-test-count-cancel-${process.pid}.mjs`)
  writeFileSync(
    suite,
    "import { describe, it, before } from 'node:test'\n" +
    "describe('d', () => { before(() => { throw new Error('control fired') }); it('a', () => {}); it('b', () => {}) })\n" +
    "describe('e', () => { it('ok', () => {}) })\n",
  )
  try {
    const { code, out } = await runCapture(['--min', '1', process.execPath, '--test', suite])
    eq(code, 1, 'exit')
    // ASSERT THE WRAPPER'S OWN VERDICT, not just the exit code. The first
    // version of this case checked only `code === 1` and SURVIVED reverting the
    // cancelled check — because `node --test` exits 1 on a thrown hook anyway
    // and this wrapper propagates the child's code. It was pinning propagation,
    // not the new guard: a case written to be stronger than the synthetic ones
    // that in fact proved less.
    if (!out.includes('test(s) were CANCELLED')) {
      throw new Error(`wrapper did not report the cancellation; got:\n${out.slice(-400)}`)
    }
    if (out.includes('[assert-test-count] OK')) {
      throw new Error('wrapper printed OK for a run whose tests were cancelled')
    }
    // And the premise the synthetic cases assume: Node really does report this
    // shape. If a future version stops emitting `# cancelled`, this notices.
    if (!/^# cancelled [1-9]/m.test(out)) {
      throw new Error(`node --test did not report a cancelled count; got:\n${out.slice(-400)}`)
    }
  } finally {
    rmSync(suite, { force: true })
  }
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
// --- #7462: the four pre-existing exit paths, each mutation-demonstrated ----

await test('a signal death fails even with a clean summary above the floor', async () => {
  // Kill only after the summary write's flush callback: with piped stdout, a
  // timed kill can lose the summary under load, and the mutant would then die
  // via the missing-summary branch instead of the signal branch (Copilot
  // review on #7476) — red for the wrong reason proves nothing.
  eq(await run(['--min', '5', process.execPath, '-e',
    "process.stdout.write('# tests 9\\n# fail 0\\n',()=>setTimeout(()=>process.kill(process.pid,'SIGKILL'),20))"]), 1, 'exit')
})
await test('a non-zero child exit is preserved even when the summary is clean', async () => {
  // Same flush discipline: process.exit can truncate queued pipe writes.
  eq(await run(['--min', '5', process.execPath, '-e',
    "process.stdout.write('# tests 9\\n# fail 0\\n',()=>process.exit(3))"]), 3, 'exit')
})
await test('a spawn failure is exit 2 (the guard broke), not exit 1 (the code is dirty)', async () => {
  eq(await run(['--min', '5', 'definitely-not-a-real-binary-xyz']), 2, 'exit')
})
await test('a PARTIAL TAP summary (tests line, no fail line) fails', async () => {
  // The existing missing-summary case emits NEITHER line, so the floor branch
  // catches its mutant anyway (#7462) — this one distinguishes the null-check.
  eq(await run(['--min', '5', process.execPath, '-e', "console.log('# tests 5')"]), 1, 'exit')
})

await test('no command at all is a usage error', async () => {
  eq(await run(['--min', '5']), 2, 'exit')
})

console.log(`\n${pass} passed, ${fail} failed`)
let broken = false
if (fail > 0) {
  for (const f of failures) console.error(`  FAIL ${f}`)
  broken = true
}
const ran = pass + fail
if (ran !== EXPECTED_CASES) {
  console.log(`HARNESS BROKEN: ran ${ran} cases, expected ${EXPECTED_CASES} — a case stopped executing`)
  broken = true
}
process.exit(broken ? 1 : 0)
