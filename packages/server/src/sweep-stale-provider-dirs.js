/**
 * Boot-time sweep of stale per-session provider dirs (#7374).
 *
 * Extracted from `server-cli.js` so the sweep is pinned BEHAVIOURALLY. It used
 * to be an inline block in the boot path, guarded only by a test that grepped
 * `server-cli.js` for `sweepStaleSinkDirs(log)` inside an anchored `import(...)`
 * slice. Mutation testing during #7371's review showed two bypasses that kept
 * that guard green:
 *
 *   - wrapping the whole block in `if (process.env.__NEVER_SET__) { … }`
 *   - replacing the call with `.then(({CliSession}) => void CliSession)` and
 *     putting the expected string in a comment INSIDE the anchored window
 *
 * That is catalogue entry 1 ("the gate that never ran"): a source grep cannot
 * tell a call reached at boot from the same characters behind a false
 * condition. Extracting the body means the WORK is now covered by tests that
 * actually run it — see `tests/sweep-stale-provider-dirs.test.js`.
 *
 * What remains source-level is only that `server-cli.js` calls this function at
 * boot. That residual is recorded in `docs/false-safety-guards.md` rather than
 * papered over in a comment here.
 *
 * Both sweeps are safe and unconditional: only dirs whose owner pid is DEAD are
 * removed, so a live daemon's dirs — including ours — are kept. Lazily imported
 * so a boot that uses neither provider pays nothing, and every failure is
 * warned rather than thrown so a sweep can never affect startup.
 */

/**
 * The real module loaders. Injectable so a test can drive this function with
 * stubs instead of `mock.module`, which leaks across the parallel test files
 * `node --test` runs.
 */
export const DEFAULT_SWEEP_LOADERS = {
  // #5323 (WP-5.1) — claude-tui hook-sink dirs left in /tmp by prior crashed
  // processes (a leak on every crash).
  'claude-tui sink-dir': async () => {
    const { ClaudeTuiSession } = await import('./claude-tui-session.js')
    return (log) => ClaudeTuiSession.sweepStaleSinkDirs(log)
  },
  // #7337 — same sweep for claude-cli's per-session permission-mode sidecar
  // dirs, which leak on a crash for exactly the same reason.
  'claude-cli sidecar-dir': async () => {
    const { CliSession } = await import('./cli-session.js')
    return (log) => CliSession.sweepStaleSidecarDirs(log)
  },
}

/**
 * Run every provider's stale-dir sweep. Never rejects: a loader or sweep that
 * throws is warned and the others still run.
 *
 * @param {{ info: Function, warn: Function }} log
 * @param {Record<string, () => Promise<Function>>} [loaders]
 * @returns {Promise<void>}
 */
export async function sweepStaleProviderDirs(log, loaders = DEFAULT_SWEEP_LOADERS) {
  await Promise.all(
    Object.entries(loaders).map(async ([label, load]) => {
      try {
        const sweep = await load()
        await sweep(log)
      } catch (err) {
        log.warn(`${label} sweep failed: ${(err && err.message) || err}`)
      }
    }),
  )
}
