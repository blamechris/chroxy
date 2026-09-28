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
 * `probeBinaryVersion` runs the resolved binary with a short timeout and
 * caches the result by **stat identity** (path + dev + ino + size + mtimeMs,
 * following symlinks) so a binary replaced in place (e.g. `claude update`) is
 * re-probed on its next use, while repeated session-creates against an
 * unchanged binary hit the cache instead of re-spawning it. Every fs/exec
 * touchpoint is an injectable seam, matching verify-binary.js's style.
 *
 * The probe uses `spawnSync`, not `execFileSync`, and accepts output ONLY
 * from a run that both spawned successfully (`result.error` unset) AND
 * exited zero (`result.status === 0`) — a non-zero exit, a null status (a
 * signal or a timeout), or a spawn error are all treated as "unreadable" and
 * are never cached. `execFileSync` throws on a non-zero exit but still
 * attaches the captured stdout/stderr to the thrown error, which is exactly
 * the trap this fixes (#7986 review C1): a `claude` that crashes on
 * `--version` prints Node's own crash footer (e.g. `Node.js v22.23.2`) to
 * stderr, and the old fallback-to-stderr-on-any-throw path handed that banner
 * straight to `parseSemver`, which happily extracted `22.23.2` and let a
 * broken install satisfy the version floor. Only a clean, successful run's
 * stdout (falling back to stderr when stdout carries no version — some CLIs
 * print their banner there even on exit 0) is ever parsed.
 */

import { spawnSync } from 'child_process'
import { statSync as fsStatSync } from 'fs'
import { statIdentity } from './stat-identity.js'

// Generous enough for a slow-starting binary under load, short enough that a
// hung/misbehaving binary can't stall session creation indefinitely. Matches
// doctor.js's checkBinary probe (#7986 review N5 — was 10s, doctor uses 5s;
// no observed need for a longer window on this path).
const PROBE_TIMEOUT_MS = 5_000

// stat-identity string (`path:dev:ino:size:mtimeMs`, see statIdentity) ->
// parsed version string. Only successful reads are stored. Module-level so it
// survives across preflight calls within one daemon process. The identity
// starts with the RESOLVED path (not the binary name), since different
// providers can resolve different paths for the "same" binary name.
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
 * Resolve ANY of a provider's declared version fields on
 * `preflight.binary` — `minVersion` (the hard floor) or `recommendedVersion`
 * (the soft, advisory floor, #8031) — a version string, or a thunk returning
 * one (e.g. `() => sdkClaudeCodeVersion()`) — to a non-empty string, or null
 * when there is no usable value. Both fields share the same shape (string or
 * thunk), so both preflight and doctor resolve either one through this same
 * function rather than two independently-maintained readers.
 *
 * Preflight AND doctor read these fields, so both resolve them here: a second
 * reader that assumed a plain string handed the thunk itself to a semver
 * comparator, and `chroxy doctor` / `chroxy start` then failed every claude-sdk
 * install with "requires claude ≥ () => sdkClaudeCodeVersion()" (#7986). A
 * thunk that throws resolves to null, the same "no usable value" outcome as a
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

/**
 * Probe a binary's version by running it with `args` (typically `['--version']`)
 * and parsing the first leading semver out of its output (stdout, falling back
 * to stderr — some CLIs print version banners to stderr even on a clean exit).
 *
 * Output is accepted ONLY from a run that spawned successfully AND exited
 * zero. A non-zero exit, a null `status` (killed by a signal or by the
 * timeout), or a spawn error (`result.error` set — e.g. ENOENT) are all
 * "unreadable" and return null — they are never cached (see the C1 fix in
 * this module's docblock: the previous fallback-to-stderr-on-any-throw
 * behaviour let a crashing binary's crash output satisfy the version gate).
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
 * @param {Function} [seams.spawnSync] - injected in tests.
 * @param {Function} [seams.statSync] - injected in tests.
 * @returns {string|null} the parsed version string, or null when the probe
 *   failed to run or produced no parseable version ("unreadable").
 */
export function probeBinaryVersion(path, args = ['--version'], {
  spawnSync: spawnFn = spawnSync,
  statSync: statFn = fsStatSync,
} = {}) {
  const identity = statIdentity(path, statFn)
  if (identity && versionCache.has(identity)) {
    return versionCache.get(identity)
  }

  let result
  try {
    result = spawnFn(path, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (err) {
    // spawnSync reports most failures on `result.error`, but it can still
    // throw synchronously (e.g. an invalid argument). Same outcome: unreadable.
    result = { error: err, status: null }
  }

  // Accept output ONLY from a run that both spawned (no `result.error`, e.g.
  // no ENOENT) and exited zero. A null `status` means the process was killed
  // by a signal or by the `timeout` option above, and a non-zero status means
  // the binary itself failed — in both cases whatever landed on stdout/stderr
  // (a crash banner, a partial write) must not be treated as an authoritative
  // version string.
  // stdout first; stderr only when stdout carries no version (some CLIs print
  // their banner to stderr even on a clean exit). parseSemver returns null for
  // a missing or non-string stream.
  const version = !result.error && result.status === 0
    ? parseSemver(result.stdout) ?? parseSemver(result.stderr)
    : null
  // Only a successful read is cached. A failed probe (a timeout under load, a
  // transient exec error, a non-zero exit) would otherwise pin "unreadable" to
  // this identity and refuse every later session-create until the binary
  // changed or the daemon restarted.
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
