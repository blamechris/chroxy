/**
 * The verdict a hand-rolled harness reaches from its own counters — extracted so
 * it can be TESTED WITHOUT the harness's dependencies (#7657).
 *
 * `tests/smoke-test.mjs` is the sixteen-plus-one of #7654: it counts its own
 * cases and exited on `failed > 0`, so a run in which NO case executed reported
 * success. `.github/workflows/ci.yml`'s `Dashboard Smoke (Playwright)` job
 * invokes it directly, so nothing but those counters decides the verdict.
 *
 * WHAT THIS FLOOR CAN AND CANNOT DO, stated so nobody reads it as a merge gate:
 * `Dashboard Smoke (Playwright)` is NOT a required status check. CONTRIBUTING.md
 * records that deliberately — the job "has genuine PR-unrelated flake surface;
 * it needs a measured flake baseline before it can gate a merge" — so a red run,
 * including a correctly-reported HARNESS BROKEN, is informational today. This
 * floor makes a collapsed harness VISIBLE; making it BLOCKING is #7639's
 * question, not this one's. Verified against branch protection in review of
 * #7681, because a floor whose blocking power is assumed rather than checked is
 * the same class of claim this module exists to refuse.
 *
 * #7654 could not fold it in for a reason worth preserving: its behavioural
 * proof cannot run where the roster guard runs. That guard lives in
 * `scripts-tests`, which deliberately has no `npm ci` and no browser, while
 * this harness needs Playwright and a live server — so a neutered copy would
 * die for a reason unrelated to its floor, which is exactly the failure the
 * guard's "exactly one floor line" assertion exists to reject.
 *
 * Extracting the verdict is what resolves that. The floor now lives in a pure
 * function with no Playwright, no server and no filesystem, so its red proof
 * runs in the ordinary server suite — `tests/smoke-test-floor.test.js` — rather
 * than only inside the job it guards.
 *
 * A LOWER BOUND, not an equality, and the calibration is measured rather than
 * assumed: SIXTEEN successful `Dashboard Smoke` runs sampled across 2026-09-05
 * to 2026-09-10 each recorded exactly 22 cases — 16/16, no variance. Review of
 * #7681 widened the sample from the three this comment first cited, two of
 * which were feature branches rather than main as claimed. The count is
 * not a constant the way the other sixteen are — several checks are explicitly
 * best-effort and record only on the paths they reach ("a missing cr-controls
 * is logged, not failed") — so an equality would go red on a legitimate branch
 * difference. The floor sits below the observed figure with room for that, and
 * far above the zero a broken harness produces.
 */
export const SMOKE_MIN_CASES = 18

/**
 * @param {{status: string}[]} results Whatever the harness recorded.
 * @param {number} minCases The floor this harness is held to.
 * @returns {{passed: number, failed: number, total: number, broken: boolean, exitCode: number, summary: string}}
 */
export function harnessVerdict(results, minCases) {
  const passed = results.filter(r => r.status === 'PASS').length
  const failed = results.filter(r => r.status === 'FAIL').length
  const total = results.length
  // The floor is checked BEFORE the failure count, and the order is the whole
  // point: `failed > 0` is false for an empty run, so a harness that stopped
  // executing reports success unless something asks how many cases it ran.
  const broken = total < minCases
  return {
    passed,
    failed,
    total,
    broken,
    exitCode: broken || failed > 0 ? 1 : 0,
    summary: broken
      ? `HARNESS BROKEN: ran ${total} cases, expected at least ${minCases}. A case stopped ` +
        'executing — that is a shrinking suite, not a passing one.'
      : `${passed} passed, ${failed} failed`,
  }
}
