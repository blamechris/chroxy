/**
 * Lightweight semver comparison utilities.
 *
 * Parses versions in the form MAJOR.MINOR.PATCH[-prerelease][+build].
 * No external dependencies — uses only string/number operations.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+[a-zA-Z0-9.]+)?$/

/**
 * Parse a version string into its components.
 * Returns null if the string is not valid semver.
 */
export function parseSemver(str) {
  const cleaned = str.replace(/^v/, '')
  const m = SEMVER_RE.exec(cleaned)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
  }
}

/**
 * Compare two pre-release strings per semver spec.
 * Returns -1 | 0 | 1.
 *
 * Rules:
 *  - No pre-release > any pre-release (1.0.0 > 1.0.0-alpha)
 *  - Numeric identifiers compared as integers
 *  - String identifiers compared lexically
 *  - Numeric < string when types differ
 *  - Longer tuple has higher precedence if all preceding ids are equal
 */
function comparePre(a, b) {
  if (a === null && b === null) return 0
  // No pre-release is higher precedence than any pre-release
  if (a === null) return 1
  if (b === null) return -1

  const partsA = a.split('.')
  const partsB = b.split('.')
  const len = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < len; i++) {
    if (i >= partsA.length) return -1
    if (i >= partsB.length) return 1

    const numA = /^\d+$/.test(partsA[i]) ? Number(partsA[i]) : null
    const numB = /^\d+$/.test(partsB[i]) ? Number(partsB[i]) : null

    if (numA !== null && numB !== null) {
      if (numA < numB) return -1
      if (numA > numB) return 1
    } else if (numA !== null) {
      return -1 // numeric < string
    } else if (numB !== null) {
      return 1
    } else {
      if (partsA[i] < partsB[i]) return -1
      if (partsA[i] > partsB[i]) return 1
    }
  }
  return 0
}

/**
 * Compare two semver version strings.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 * Throws if either string is not valid semver.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa) throw new Error(`Invalid semver: ${a}`)
  if (!pb) throw new Error(`Invalid semver: ${b}`)

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1

  return comparePre(pa.prerelease, pb.prerelease)
}

/**
 * Returns true if version `a` is newer than version `b`.
 */
export function isNewer(a, b) {
  return compareSemver(a, b) > 0
}
