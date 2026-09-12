/**
 * #7724 (CDX-1) — codex app-server protocol capability gate.
 *
 * The `initialize` handshake is the ONLY in-band version signal the app-server
 * gives us, and it reports the binary actually serving THIS session rather than
 * whatever `codex` happens to be on PATH (which is why nothing here ever shells
 * out to `codex --version`, and why the npm dist-tag is not consulted either).
 * `InitializeResponse.userAgent` is formatted:
 *
 *   <originator>/<version> (<os> <osversion>; <arch>) <rest>
 *
 * e.g. `chroxy-probe/0.154.0 (Mac OS 26.6.2; arm64) unknown (chroxy-probe; 0)`.
 *
 * Three rules hold this module's shape, and each one is a test:
 *
 *   1. GATE FEATURES, NEVER THE CONNECTION. Nothing here can refuse to start a
 *      session. A version below the floor degrades the picker; it still starts
 *      a thread and still sends turns.
 *   2. FAIL IN THE SAFE DIRECTION. An unparseable / absent userAgent yields
 *      UNKNOWN for every gate — never `false`. A cannot-check must not read as
 *      a no (#7195/#7210): the caller falls through to `probeMethod`, which
 *      asks the binary itself.
 *   3. SWITCH ON THE ERROR SHAPE, NEVER ON MESSAGE TEXT (#7503/#7540). The live
 *      0.154.0 binary answers an unknown method with JSON-RPC `-32600`
 *      ("Invalid request: unknown variant `x`, expected one of ..."), NOT the
 *      `-32601` the spec would suggest. A probe that keyed off either the code
 *      or the wording would therefore read "unsupported" as "supported" against
 *      a real binary — so `probeMethod` treats ANY error response as a degrade.
 */

// The protocol floor: every method Chroxy calls today exists at this version
// (verified against codex-rs/app-server-protocol at tag rust-v0.128.0).
export const CODEX_PROTOCOL_FLOOR = '0.128.0'

// Sentinel for "the handshake could not tell us" — distinct from `false`, which
// means "this binary is known NOT to have it". Callers probe on UNKNOWN.
export const UNKNOWN = 'unknown'

/**
 * The ONE table. Capability name → the lowest version known to serve it.
 * `capabilitiesForVersion` derives every returned flag from this map, and the
 * tests iterate it rather than restating the names, so adding a row here adds
 * the flag AND its coverage (no hardcoded list beside a growing set).
 */
export const CAPABILITY_MIN_VERSIONS = Object.freeze({
  supportsModelList: CODEX_PROTOCOL_FLOOR,
  supportsThreadResume: CODEX_PROTOCOL_FLOOR,
  supportsTurnEffort: CODEX_PROTOCOL_FLOOR,
  supportsTurnInterrupt: CODEX_PROTOCOL_FLOOR,
  supportsTokenUsage: CODEX_PROTOCOL_FLOOR,
  supportsReasoningDeltas: CODEX_PROTOCOL_FLOOR,
  supportsThreadCompacted: CODEX_PROTOCOL_FLOOR,
  supportsMcpServerStatusList: CODEX_PROTOCOL_FLOOR,
  supportsServerRequestResolved: CODEX_PROTOCOL_FLOOR,
  // Per-turn model/effort overrides that take effect mid-thread.
  supportsMidTurnSettings: '0.154.0',
})

/** Every gate name, derived from the table above — never restated by hand. */
export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITY_MIN_VERSIONS))

// Anchored at the START of the string on purpose. The userAgent carries a SECOND
// dotted-numeric run inside its platform parens ("Mac OS 26.6.2"), so an
// unanchored scan happily reports the OS version as the codex version for any
// userAgent whose leading token has none.
const USER_AGENT_RE = /^\s*(\S+?)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse an app-server `initialize` userAgent.
 * @returns {{version: string|null, originator: string|null, raw: string|null}}
 *   `version` is null for anything that does not lead with `<name>/<semver>`.
 */
export function parseCodexUserAgent(userAgent) {
  const raw = typeof userAgent === 'string' ? userAgent : null
  if (raw === null) return { version: null, originator: null, raw: null }
  const m = USER_AGENT_RE.exec(raw)
  if (!m) return { version: null, originator: null, raw }
  return { version: m[2], originator: m[1], raw }
}

/** Parse a semver string into its parts, or null when it is not one. */
export function parseSemver(version) {
  if (typeof version !== 'string') return null
  const m = SEMVER_RE.exec(version.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? null : m[4],
  }
}

function comparePrerelease(a, b) {
  // Semver 11: a release outranks any prerelease of the same version.
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const av = a.split('.')
  const bv = b.split('.')
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const x = av[i]
    const y = bv[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** -1 / 0 / 1 for two PARSED semvers (see parseSemver). */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Does `version` meet `minimum`?
 * @returns {boolean|'unknown'} UNKNOWN when `version` is absent/unparseable.
 */
export function meetsMinimum(version, minimum) {
  const have = parseSemver(version)
  if (!have) return UNKNOWN
  const want = parseSemver(minimum)
  if (!want) throw new Error(`codex capability minimum is not a semver: ${minimum}`)
  return compareSemver(have, want) >= 0
}

/**
 * Derive every named capability gate from a version string.
 * @param {string|null} version
 * @returns {Record<string, boolean|'unknown'>} UNKNOWN for every gate when the
 *   version is absent or unparseable — the caller then probes the binary.
 */
export function capabilitiesForVersion(version) {
  const out = {}
  for (const name of CAPABILITY_NAMES) {
    out[name] = meetsMinimum(version, CAPABILITY_MIN_VERSIONS[name])
  }
  return out
}

/**
 * One-shot runtime probe for a method the handshake could not vouch for.
 *
 * ANY error response is a degrade. The live binary answers an unknown method
 * with `-32600` "unknown variant", not `-32601`, so keying off a single code —
 * or off the wording — is exactly the false-safety shape that would report an
 * unsupported method as supported. The code is passed through for LOGGING only;
 * nothing branches on it, and nothing reads `error.message`.
 *
 * @returns {Promise<{supported: true, result: any} | {supported: false, error: Error, code: number|null}>}
 */
export async function probeMethod(client, method, params) {
  try {
    const result = await client.request(method, params)
    return { supported: true, result }
  } catch (error) {
    const code = typeof error?.code === 'number' ? error.code : null
    return { supported: false, error, code }
  }
}
