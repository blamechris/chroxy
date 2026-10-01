/**
 * node-pty-probe.js (#8151 C3) — a cached, one-shot answer to "can node-pty's
 * native binding actually load in THIS process?", so `listProviders()` can
 * mark `claude-tui` unavailable in an environment (the official Docker image)
 * where it never will, rather than letting a client discover that only after
 * a session create fails and is immediately torn down.
 *
 * `import('node-pty')` is a real dynamic import — it rejects, it does NOT
 * throw synchronously. `listProviders()` is called on every dashboard/app
 * connect (`list_providers` request + every `auth_bootstrap` burst), and
 * awaiting a promise on every one of those calls doesn't fit
 * `listProviders()`'s existing synchronous contract (see below) — so this
 * module probes ONCE, at boot, and caches a plain boolean `listProviders()`
 * can read without awaiting anything.
 *
 * #8151 round-2 review (S4): an earlier version of this comment justified
 * the cache by claiming Node does NOT cache a rejected dynamic import, so a
 * second `import('node-pty')` would repeat the full resolution/load attempt.
 * That claim is wrong, and the correction matters because it was the stated
 * REASON for caching, not just a background detail: Node's module graph
 * records an evaluation failure against the resolved module record, and
 * replays the SAME cached rejection on every subsequent `import()` of the
 * same specifier — measured directly (a throwing stand-in module's body
 * executes exactly once across four repeated `import()` calls in the same
 * process, evaluation-failure or not). node-pty's real failure mode is
 * exactly this shape: its JS entry module is found and starts evaluating,
 * and a `require()`/native-binding load INSIDE that evaluation throws — so
 * Node's own cache already makes a second `import('node-pty')` cheap. The
 * reason this module still probes once and caches a boolean is simply that
 * `listProviders()` is synchronous and cannot `await` a promise on every
 * call — not a missing Node-level cache. node-pty's native binding also
 * cannot appear or disappear mid-process either way (it is either built into
 * the image at build time, or it never will be), so a process-lifetime
 * cache — Node's or this module's — cannot go stale.
 *
 * `listProviders()` itself stays synchronous (existing contract, existing
 * callers): `probeNodePtyAvailable()` is awaited ONCE at server boot
 * (server-cli.js, before the WS server starts accepting real connections),
 * and `listProviders()` reads the cached result synchronously via
 * `cachedNodePtyAvailable()`, injectable per-call for tests.
 *
 * #8151 round-2 review (S5, nit): on win32, node-pty ships a prebuilt
 * native addon for every supported Node ABI, so `import('node-pty')`
 * resolving here proves only that the JS wrapper module loads — it does
 * NOT prove the native binding underneath it actually works (a corrupt
 * install, an ABI mismatch Windows doesn't surface at require() time, etc.
 * could still fail later, at spawn time). The probe's "available" result is
 * therefore a necessary, not sufficient, signal on win32; it remains both on
 * Linux/macOS, where there IS no prebuild to fall back to and a successful
 * import means the real native addon actually loaded.
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
