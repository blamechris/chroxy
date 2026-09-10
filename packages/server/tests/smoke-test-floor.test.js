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

  it('the harness actually USES the floor — not just exports it', () => {
    // The wiring, which the four cases above cannot see: they exercise the pure
    // function, and a harness that imported it and then exited on `failed > 0`
    // anyway would leave every one of them green. That is the
    // guard-wired-to-none-of-its-callers shape.
    const src = readFileSync(new URL('./smoke-test.mjs', import.meta.url), 'utf8')
    assert.ok(src.includes('harnessVerdict(results, SMOKE_MIN_CASES)'), 'it must compute the verdict')
    assert.ok(src.includes('process.exit(verdict.exitCode)'), 'and exit on it')
    assert.ok(!/process\.exit\(failed > 0/.test(src), 'the old failure-only exit must be gone')
  })
})
