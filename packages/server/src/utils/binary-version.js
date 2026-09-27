/**
 * Semver parsing/comparison + a cached `--version` probe for spawned provider
 * binaries (#7986).
 *
 * `parseSemver` deliberately extracts the FIRST leading `major.minor.patch`
 * run out of arbitrary CLI banner text (e.g. `"2.1.283 (Claude Code)"`) rather
 * than requiring a strict, anchored semver string — that is the shape every
 * `--version` output in this codebase actually takes. (This repo already
 * carries stricter/different semver comparators — `semver.js` and
 * `codex-protocol-capabilities.js` — for contexts that parse a full semver
 * grammar with prerelease/build metadata; this module intentionally stays
 * narrow to the "leading version out of banner text" job preflight needs.)
 *
 * `compareSemver` fails CLOSED: an unparseable side sorts as lower, so a
 * malformed `found` or `required` can never silently satisfy a minimum-version
 * gate.
 *
 * `probeBinaryVersion` execs the resolved binary with a short timeout and
 * caches the result by **stat identity** (path + dev + ino + size + mtimeMs,
 * following symlinks) so a binary replaced in place (e.g. `claude update`) is
 * re-probed on its next use, while repeated session-creates against an
 * unchanged binary hit the cache instead of re-spawning it. Every fs/exec
 * touchpoint is an injectable seam, matching verify-binary.js's style.
 */

import { execFileSync } from 'child_process'
import { statSync as fsStatSync } from 'fs'

// Generous enough for a slow-starting binary under load, short enough that a
// hung/misbehaving binary can't stall session creation indefinitely.
const PROBE_TIMEOUT_MS = 10_000

// path -> { identity: string|null, version: string|null }. Module-level so it
// survives across preflight calls within one daemon process; keyed by the
// RESOLVED path (not the binary name) since different providers can resolve
// different paths for the "same" binary name.
const versionCache = new Map()

/**
 * Extract the first leading `major.minor.patch` run from arbitrary text.
 * Returns null when no such run is present.
 *
 * @param {string} text
 * @returns {string|null} e.g. "2.1.283"
 */
export function parseSemver(text) {
  if (typeof text !== 'string') return null
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3]}`
}

/**
 * Compare two version strings (or pre-parsed `[major,minor,patch]` triples).
 * Returns a negative number when `a` < `b`, 0 when equal, positive when
 * `a` > `b`.
 *
 * Fails CLOSED: an unparseable `a` OR `b` sorts as less-than (-1) — matching
 * `doctor.js`'s `compareSemver` (#3953) rather than inventing a third
 * convention. This is deliberately NOT a general-purpose comparator: it
 * exists to answer "does `found` satisfy `required`?" via `>= 0`, so letting
 * an unparseable side win (return positive) would let a malformed value
 * silently satisfy a minimum-version gate. Two unparseable sides are ALSO
 * less-than (-1), not equal — there is no "both sides are garbage, call it a
 * tie" case that should ever read as satisfied.
 *
 * @param {string|[number,number,number]|null} a
 * @param {string|[number,number,number]|null} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const pa = Array.isArray(a) ? a : parseSemver(a)?.split('.').map(Number) ?? null
  const pb = Array.isArray(b) ? b : parseSemver(b)?.split('.').map(Number) ?? null
  if (!pa || !pb) return -1
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/**
 * Resolve a provider's declared `preflight.binary.minVersion` — a version
 * string, or a thunk returning one (e.g. `() => sdkClaudeCodeVersion()`) — to
 * a non-empty string, or null when there is no usable floor.
 *
 * Preflight AND doctor read that one field, so both resolve it here: a second
 * reader that assumed a plain string handed the thunk itself to a semver
 * comparator, and `chroxy doctor` / `chroxy start` then failed every claude-sdk
 * install with "requires claude ≥ () => sdkClaudeCodeVersion()" (#7986). A
 * thunk that throws resolves to null, the same "no usable floor" outcome as a
 * thunk that returns null.
 *
 * @param {string|(() => string|null)|null|undefined} declared
 * @returns {string|null}
 */
export function resolveDeclaredMinVersion(declared) {
  let raw = declared
  if (typeof declared === 'function') {
    try {
      raw = declared()
    } catch {
      return null
    }
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function statIdentity(path, statFn) {
  try {
    const st = statFn(path)
    return `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * Probe a binary's version by running it with `args` (typically `['--version']`)
 * and parsing the first leading semver out of its output (stdout, falling back
 * to stderr — some CLIs print version banners to stderr).
 *
 * Cached by stat identity: an unchanged binary at an unchanged path is not
 * re-spawned on every call. When the identity can't be determined (stat
 * fails — e.g. the path vanished between preflight's verifyBinary check and
 * this probe), the result is neither read from nor written to the cache, so a
 * transient stat failure can't poison future calls. A probe that produced no
 * version is never cached either, for the same reason.
 *
 * @param {string} path - resolved absolute binary path (already verified).
 * @param {string[]} [args] - args to invoke, default `['--version']`.
 * @param {object} [seams]
 * @param {Function} [seams.execFileSync] - injected in tests.
 * @param {Function} [seams.statSync] - injected in tests.
 * @returns {string|null} the parsed version string, or null when the probe
 *   failed to run or produced no parseable version ("unreadable").
 */
export function probeBinaryVersion(path, args = ['--version'], {
  execFileSync: execFn = execFileSync,
  statSync: statFn = fsStatSync,
} = {}) {
  const identity = statIdentity(path, statFn)
  if (identity && versionCache.has(identity)) {
    return versionCache.get(identity)
  }

  let stdout = null
  try {
    stdout = execFn(path, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (err) {
    // Some CLIs write their version banner to stderr and/or exit non-zero for
    // `--version` — execFileSync still attaches captured output to the error.
    stdout = typeof err?.stdout === 'string' ? err.stdout : null
    if (!stdout && typeof err?.stderr === 'string') stdout = err.stderr
  }

  const version = stdout ? parseSemver(stdout) : null
  // Only a successful read is cached. A failed probe (a timeout under load, a
  // transient exec error) would otherwise pin "unreadable" to this identity and
  // refuse every later session-create until the binary changed or the daemon
  // restarted.
  if (identity && version) versionCache.set(identity, version)
  return version
}

/**
 * Test-only hook: clear the module-level probe cache so suites don't leak
 * identities across test files that reuse the same tmp paths.
 */
export function _resetProbeCacheForTest() {
  versionCache.clear()
}
