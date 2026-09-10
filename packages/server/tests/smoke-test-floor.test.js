import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { harnessVerdict, SMOKE_MIN_CASES } from './helpers/harness-floor.mjs'

/**
 * The red proof for `tests/smoke-test.mjs`'s case floor (#7657).
 *
 * It lives HERE, in the ordinary server suite, and that placement is the point.
 * #7654 floored sixteen hand-rolled harnesses and could not reach this one,
 * because its behavioural proof would have had to run inside
 * `Dashboard Smoke (Playwright)` — a job with a browser and a live server — while
 * the roster guard runs in `scripts-tests`, which deliberately has neither. A
 * neutered copy run there would die for a reason unrelated to its floor, which
 * is the failure mode that guard's "exactly one floor line" assertion rejects.
 *
 * Extracting the verdict into a pure function dissolves that: no Playwright, no
 * server, no filesystem, so the proof runs everywhere the server suite does.
 */
describe('smoke-test harness floor (#7657)', () => {
  const pass = n => Array.from({ length: n }, () => ({ status: 'PASS' }))

  it('a run in which NO case executed is BROKEN, not passing', () => {
    // The defect, exactly: `failed > 0` is false for an empty run, so the old
    // verdict exited 0 having tested nothing. This is catalogue entry 32.
    const v = harnessVerdict([], SMOKE_MIN_CASES)
    assert.equal(v.failed, 0, 'no case failed, which is why the old check passed')
    assert.equal(v.broken, true)
    assert.equal(v.exitCode, 1)
    assert.match(v.summary, /HARNESS BROKEN: ran 0 cases, expected at least 18/)
  })

  it('a run that SHRANK below the floor is broken even with every case passing', () => {
    const v = harnessVerdict(pass(SMOKE_MIN_CASES - 1), SMOKE_MIN_CASES)
    assert.equal(v.failed, 0)
    assert.equal(v.broken, true)
    assert.equal(v.exitCode, 1)
  })

  it('CONTROL: a healthy run at the floor passes, and the floor is BELOW what CI observes', () => {
    // Without this the two cases above would also pass on a floor set so high
    // that nothing could ever clear it — a guard that only ever says no.
    const v = harnessVerdict(pass(SMOKE_MIN_CASES), SMOKE_MIN_CASES)
    assert.equal(v.broken, false)
    assert.equal(v.exitCode, 0)
    assert.match(v.summary, /18 passed, 0 failed/)
    // Calibration, measured rather than assumed: three consecutive successful
    // `Dashboard Smoke` runs on main each recorded 22. The floor must sit below
    // that or a legitimate best-effort branch difference reds the build.
    assert.ok(SMOKE_MIN_CASES < 22, `floor ${SMOKE_MIN_CASES} must sit below the observed 22`)
    assert.ok(SMOKE_MIN_CASES > 0, 'and above zero, or it is not a floor')
  })

  it('a real failure still fails, above the floor', () => {
    // The floor must not REPLACE the failure check — both directions matter.
    const v = harnessVerdict([...pass(SMOKE_MIN_CASES), { status: 'FAIL' }], SMOKE_MIN_CASES)
    assert.equal(v.broken, false)
    assert.equal(v.exitCode, 1)
  })

  it('`run()` reaches the floored verdict on EVERY path — no exit can bypass it', () => {
    // This replaced a substring check, and the replacement is the point.
    //
    // The first version asserted that the source CONTAINED
    // `harnessVerdict(results, SMOKE_MIN_CASES)` and `process.exit(verdict.exitCode)`.
    // Review of #7681 defeated it twice, with mutants that leave both strings
    // intact as dead code: an early `process.exit(0)` inserted ABOVE the summary
    // block, and a `process.exit(0)` inserted after cleanup with the verdict exit
    // left unreachable below it. Both make a zero-case run exit 0 — the exact
    // defect this PR exists to prevent — and both passed 5/5.
    //
    // A presence check cannot see an ADDED bypass; only an enumeration can. So
    // `run()` now RETURNS its code and the invariant is that it performs no exit
    // at all: any bypass has to add one, and adding one fails here.
    const src = readFileSync(new URL('./smoke-test.mjs', import.meta.url), 'utf8')
    const runBody = src.slice(src.indexOf('async function run()'), src.lastIndexOf('\nrun()'))
    assert.ok(runBody.length > 1000, 'precondition: the run() body was actually located')
    assert.deepEqual(
      runBody.split('\n').map((l, i) => [i, l]).filter(([, l]) => /process\.exit\s*\(/.test(l) && !l.trimStart().startsWith('//')),
      [],
      '`run()` must not exit — it returns a code, so every path reaches the floored verdict'
    )
    assert.ok(/return verdict\.exitCode/.test(runBody), 'and the code it returns is the verdict')

    // Exactly one exit carries that code, at module scope, and the fatal handler
    // never exits 0 — a zero there would be the same bypass one level out.
    const tail = src.slice(src.lastIndexOf('\nrun()'))
    const exits = tail.split('\n').filter(l => /process\.exit\s*\(/.test(l) && !l.trimStart().startsWith('//'))
    assert.equal(exits.length, 2, `expected exactly two exits at module scope, found ${exits.length}`)
    assert.ok(/process\.exit\(code\)/.test(exits[0]), 'the success path exits on the returned code')
    assert.ok(/process\.exit\(1\)/.test(exits[1]), 'the fatal path exits non-zero')
  })
})
