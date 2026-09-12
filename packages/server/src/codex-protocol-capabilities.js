import { createLogger } from './logger.js'

const log = createLogger('codex-caps')

/**
 * #7724 (CDX-1) — what the codex app-server we are actually talking to can do.
 *
 * Two independent signals, in this order:
 *
 *   1. The version reported IN BAND by the handshake, which describes the binary
 *      serving THIS session — not whatever `codex` happens to be on PATH. We
 *      never shell out to `codex --version`: that is a second spawn and can
 *      answer for a different binary. (The author's own machine had a `codex`
 *      on PATH whose vendored executable was missing entirely, which is exactly
 *      the hazard.)
 *   2. A one-shot PROBE, for when the version is missing, unparseable, or lying
 *      — alpha builds and forks both happen.
 *
 * The floor is 0.128.0, which already has everything chroxy calls. Features are
 * gated INDIVIDUALLY; the connection never is. A version below the floor still
 * starts a session and still sends turns — it just gets a smaller picker.
 *
 * Everything here fails in the SAFE direction: "we could not determine this"
 * resolves to SUPPORTED, never to disabled. A cannot-check must not read as a
 * no — that is the defect class where success and not-checking share one
 * observable (`docs/false-safety-guards.md`). The cost of being wrong that way
 * is one failed RPC that degrades; the cost of the other way is a feature
 * silently missing on every working binary.
 */

/** Minimum version whose protocol surface chroxy relies on. */
export const CODEX_VERSION_FLOOR = '0.128.0'

/** JSON-RPC code the app-server returns for a method it does not know. */
export const RPC_INVALID_REQUEST = -32600

/**
 * Per-capability minimum version. A capability absent from this map is not
 * version-gated at all.
 *
 * Deliberately NOT a list of every method: a roster that must be kept in step
 * with a moving upstream is the hardcoded-list-beside-a-growing-set defect.
 * Only capabilities chroxy actually branches on belong here.
 */
export const CAPABILITY_FLOORS = Object.freeze({
  // Present at the floor.
  supportsModelList: CODEX_VERSION_FLOOR,
  supportsThreadResume: CODEX_VERSION_FLOOR,
  // `thread/settings/update` — mid-turn model/effort changes. Added after the floor.
  supportsMidTurnSettings: '0.154.0',
})

/**
 * Parse the codex version out of an `initialize` result's `userAgent`.
 *
 * Live shape (codex-cli 0.154.0):
 *
 *   chroxy/0.154.0 (Mac OS 26.6.2; arm64) unknown (chroxy; 1)
 *   ^^^^^^ ^^^^^^^     ^^^^^^^^
 *   OUR    codex       the OS version — also semver-shaped, which is the trap
 *   name   version
 *
 * The leading token is the CLIENT's own `clientInfo.name`, echoed back — it is
 * not a codex originator string, so a pattern anchored on `codex/` matches
 * nothing this binary ever emits. The version is the token immediately after the
 * FIRST `/`, and it must be anchored there: the OS version later in the string
 * is also `\\d+\\.\\d+\\.\\d+` and a loose search finds it first on some platforms.
 *
 * @param {string} userAgent
 * @returns {string|null} a semver core (`major.minor.patch`), or null
 */
export function parseCodexVersion(userAgent) {
  if (typeof userAgent !== 'string') return null
  // Anchored at the start: <originator>/<version>. The originator may not
  // contain a slash or whitespace, so the first `/` is unambiguous.
  //
  // The trailing `(?![\d.])` is a right-hand boundary, and it matters: without
  // it a four-component vendor build like `0.128.0.99` captures as `0.128.0` and
  // silently compares EQUAL to the floor rather than above it. Refusing to parse
  // is the fail-safe answer (an unknown version enables every gate); a truncated
  // one is a confident wrong answer.
  const m = /^[^/\s]+\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/.exec(userAgent.trim())
  return m ? m[1] : null
}

/**
 * Parse a bare semver, as `thread.cliVersion` reports it.
 *
 * Separate from `parseCodexVersion` rather than reusing it behind a synthetic
 * `x/` prefix: the prefix trick worked, but it silently demoted any value the
 * userAgent grammar rejects (a `v` prefix, surrounding spaces) from "the
 * preferred signal" to "no signal", which is a surprising reason for the
 * fallback to fire.
 */
export function parseBareVersion(version) {
  if (typeof version !== 'string') return null
  const m = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/.exec(version.trim())
  return m ? m[1] : null
}

/** Numeric compare of two semver cores. Pre-release tags are ignored (0.154.0-alpha ≥ 0.154.0). */
function compareVersions(a, b) {
  const nums = (v) => String(v).split(/[-+]/, 1)[0].split('.').map((n) => parseInt(n, 10) || 0)
  const [x, y] = [nums(a), nums(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1
  }
  return 0
}

/** True when `version` is at least `floor`. */
export function atLeast(version, floor) {
  return compareVersions(version, floor) >= 0
}

/**
 * Derive capability booleans from a handshake result.
 *
 * `cliVersion` (from a `thread/start` echo) is preferred when available: it is a
 * bare semver needing no string surgery, where the userAgent needs its leading
 * client name stripped. Either may be absent.
 *
 * @param {{ userAgent?: string, cliVersion?: string }} [signals]
 * @returns {{ version: string|null, belowFloor: boolean, [cap: string]: unknown }}
 */
export function deriveCapabilities(rawSignals = {}) {
  // A default parameter only fires for `undefined`, so an explicit `null` — the
  // shape a caller gets from an optional-chained handshake that came back empty
  // — would throw on property access. This function runs inside start()'s
  // try-block, so a throw here is relabelled a handshake failure and REFUSES the
  // session, which is precisely the outcome the gate must never cause.
  const signals = rawSignals ?? {}
  const version = parseBareVersion(signals.cliVersion)
    || parseCodexVersion(signals.userAgent)
    || null

  const caps = { version, belowFloor: version != null && !atLeast(version, CODEX_VERSION_FLOOR) }
  for (const [cap, floor] of Object.entries(CAPABILITY_FLOORS)) {
    // UNKNOWN VERSION => SUPPORTED. This is the fail-safe direction and the one
    // the probe exists to correct. Defaulting to false here would disable the
    // picker on every binary whose userAgent we merely failed to parse.
    caps[cap] = version == null ? true : atLeast(version, floor)
  }
  if (version == null) {
    log.debug(`codex version not determinable from the handshake (userAgent: ${JSON.stringify(signals.userAgent ?? null)}) — assuming all features supported; a probe will correct a wrong guess`)
  } else if (caps.belowFloor) {
    log.warn(`codex app-server ${version} is below the tested floor ${CODEX_VERSION_FLOOR} — the session still runs, but model listing and reasoning controls may degrade`)
  }
  return caps
}

/**
 * Does this rejected request mean "the server does not know that method"?
 *
 * The code alone is NOT sufficient, and that is worth being explicit about. The
 * app-server deserializes the method name as a tagged enum, so an unknown method
 * fails REQUEST VALIDATION (`-32600`) rather than as "method not found"
 * (`-32601`, which this server never emits). But `-32600` is the general
 * validation code, so treating any `-32600` as "unsupported" would disable a
 * feature on an unrelated malformed request.
 *
 * The discriminator is the method name we OURSELVES sent appearing in the error.
 * That is deliberately not the #7503/#7540 defect: those matched on UPSTREAM
 * PROSE, which drifts when upstream rewords and then silently stops matching.
 * The string matched here is the caller's own argument, so it cannot drift
 * without the caller changing it. Matching `unknown variant` or `Method not
 * found` would be the defect; matching the echo of your own input is not.
 *
 * @param {unknown} err an error from a rejected client request
 * @param {string} method the method that was attempted
 * @returns {boolean} true only when this is positively an unknown-method error
 */
export function isUnknownMethodError(err, method) {
  if (!err || err.code !== RPC_INVALID_REQUEST) return false
  if (typeof method !== 'string' || !method) return false
  return typeof err.message === 'string' && err.message.includes(method)
}

/**
 * Confirm a capability by asking the server, when the version signal could not.
 *
 * Only ever called for a gate whose version answer is unknown or suspect, and
 * only once per session. A probe that ERRORS for any reason other than a
 * positive unknown-method verdict resolves to SUPPORTED — same fail-safe
 * direction as the version path.
 *
 * @param {(method: string, params?: object) => Promise<unknown>} request
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<boolean>}
 */
export async function probeMethodSupported(request, method, params = {}) {
  try {
    await request(method, params)
    return true
  } catch (err) {
    if (isUnknownMethodError(err, method)) {
      log.debug(`codex app-server does not support ${method} (code ${RPC_INVALID_REQUEST}) — gating the feature off`)
      return false
    }
    // Any other failure — a transport error, a params rejection, a timeout — is
    // NOT evidence of absence.
    log.debug(`probe of ${method} failed without an unknown-method verdict (${err?.message || err}) — assuming supported`)
    return true
  }
}
