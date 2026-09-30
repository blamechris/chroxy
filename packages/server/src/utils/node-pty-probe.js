/**
 * node-pty-probe.js (#8151 C3) — a cached, one-shot answer to "can node-pty's
 * native binding actually load in THIS process?", so `listProviders()` can
 * mark `claude-tui` unavailable in an environment (the official Docker image)
 * where it never will, rather than letting a client discover that only after
 * a session create fails and is immediately torn down.
 *
 * `import('node-pty')` is a real dynamic import — it rejects, it does NOT
 * throw synchronously — and a REJECTED dynamic import is not cached by Node
 * itself: re-running it repeats the full resolution attempt (stat the
 * package, fail to find/load the native addon) every time. `listProviders()`
 * is called on every dashboard/app connect (`list_providers` request +
 * every `auth_bootstrap` burst), so probing fresh each time would repeat that
 * failed resolution on every single connect. This module probes ONCE and
 * caches the boolean for the life of the process — there is no scenario
 * where node-pty's native binding appears or disappears mid-process (it is
 * either built into the image at build time, or it never will be), so a
 * process-lifetime cache cannot go stale.
 *
 * `listProviders()` itself stays synchronous (existing contract, existing
 * callers): `probeNodePtyAvailable()` is awaited ONCE at server boot
 * (server-cli.js, before the WS server starts accepting real connections),
 * and `listProviders()` reads the cached result synchronously via
 * `cachedNodePtyAvailable()`, injectable per-call for tests.
 */

let _cached = null

/**
 * Run the probe if it hasn't run yet, and cache the result. Safe to call
 * more than once — later calls return the cached value without re-probing.
 *
 * @returns {Promise<boolean>} true iff `import('node-pty')` resolves here.
 */
export async function probeNodePtyAvailable() {
  if (_cached !== null) return _cached
  try {
    await import('node-pty')
    _cached = true
  } catch {
    _cached = false
  }
  return _cached
}

/**
 * Synchronous read of the cached result.
 *
 * @returns {boolean|null} true/false once probed, `null` if
 *   `probeNodePtyAvailable()` has never been called (production always calls
 *   it once at boot; callers that might run before boot, or in a test that
 *   never probes, should treat `null` as "unknown" and decide their own
 *   fallback rather than this module guessing for them).
 */
export function cachedNodePtyAvailable() {
  return _cached
}

/**
 * Test-only: reset the cache so a probe re-runs. Never called by production
 * code — node-pty's availability cannot change mid-process (see module doc).
 */
export function resetNodePtyProbeForTest() {
  _cached = null
}
