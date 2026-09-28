/**
 * Read the installed `@anthropic-ai/claude-agent-sdk` package's own
 * `claudeCodeVersion` field (#7986) — the `claude` CLI build that SDK release
 * was PUBLISHED ALONGSIDE (e.g. SDK `0.2.141` carries
 * `claudeCodeVersion: "2.1.141"`). This is a PAIRING, not a minimum: the
 * CLI's patch number is its release counter, and a user on a lagging release
 * channel (e.g. npm `stable`, which trails `latest`) can be several patches
 * behind whatever the SDK happened to ship next to without their install
 * being broken or unsupported in any way. Treating this field as a hard
 * floor (the pre-#8031 behaviour) meant every SDK bump instantly hard-
 * blocked any CLI that hadn't also updated yet. See #8031 and
 * `CLAUDE_SDK_MIN_CLI_VERSION` below for the fix: a small, hand-raised
 * constant is the hard floor, and this pairing is now only a SOFT, advisory
 * `recommendedVersion` (`sdk-session.js`'s `static get preflight()`).
 *
 * The package's `exports` map does NOT export `./package.json` (only `.`,
 * `./browser`, `./bridge`, `./assistant`, `./sdk-tools[.js]`), so this can't
 * `require('@anthropic-ai/claude-agent-sdk/package.json')` directly. Instead
 * it resolves the package's main entry point (`sdk.mjs`) via
 * `createRequire(import.meta.url).resolve(...)`, takes that file's directory
 * (the package root), and reads `package.json` from there.
 */

import { createRequire } from 'module'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'

const requireFromHere = createRequire(import.meta.url)

/**
 * The oldest `claude` CLI version verified against the Agent SDK build this
 * repo currently ships — the HARD floor `claude-sdk` enforces (#8031).
 *
 * This is raised DELIBERATELY, by hand, never automatically: unlike
 * `sdkClaudeCodeVersion()` above (the SDK's own *pairing*, which moves on
 * every SDK bump whether or not anyone reviewed the new floor), this constant
 * only changes when a maintainer has actually checked that the new SDK still
 * works against a `claude` at this version. It is initialized to the
 * pairing of the SDK version this repo locks today, and is expected to trail
 * `sdkClaudeCodeVersion()` after future SDK bumps — that gap is the whole
 * point: it gives a `claude` CLI on a lagging release channel (npm `stable`
 * trails `latest`) real time to catch up instead of being hard-blocked the
 * moment Renovate bumps the SDK.
 *
 * `CLAUDE_SDK_FLOOR_REVIEWED_AGAINST` (below) records which SDK pairing this
 * floor was last checked against, so a test can force whoever bumps the SDK
 * to consciously re-check (and, if needed, raise) this constant rather than
 * letting it silently drift further behind.
 */
export const CLAUDE_SDK_MIN_CLI_VERSION = '2.1.141'

/**
 * The Agent SDK's `claudeCodeVersion` pairing that `CLAUDE_SDK_MIN_CLI_VERSION`
 * above was last hand-reviewed against (#8031). `agent-sdk-version.test.js`
 * asserts `sdkClaudeCodeVersion() === CLAUDE_SDK_FLOOR_REVIEWED_AGAINST` as a
 * tripwire: when a dependency bump moves the installed SDK's pairing past
 * this marker, that test goes red until a maintainer re-verifies
 * `CLAUDE_SDK_MIN_CLI_VERSION` against the new SDK (raising it if the new SDK
 * build no longer works against the old floor) and then updates this marker
 * to match. The two constants are equal at the moment this was introduced;
 * they diverge whenever a review of a newer SDK concludes that the existing
 * hard floor still holds, so the marker moves and the floor does not.
 */
export const CLAUDE_SDK_FLOOR_REVIEWED_AGAINST = '2.1.141'

// Memoized: undefined = not yet computed. ONLY a non-empty string result is
// ever cached (#7986 review N4) — a transient read failure (an ENOENT racing
// a Renovate bump, a mid-reinstall race) must not memoize `null` for the rest
// of the daemon's process lifetime and silently disable the version gate
// until restart; it is retried on every call instead. Once a real version is
// read it doesn't change within a running daemon process, so that result is
// cached for good.
let cached

/**
 * @param {object} [seams]
 * @param {{ resolve: Function }} [seams.requireFn] - injected in tests.
 * @param {Function} [seams.readFileSync] - injected in tests.
 * @returns {string|null} the SDK's `claudeCodeVersion` field (its published
 *   pairing, used as `claude-sdk`'s SOFT `recommendedVersion`, #8031), or
 *   null when it can't be resolved/read/parsed (fails open to "no advisory"
 *   — preflight treats a null/unparseable `recommendedVersion` as "skip the
 *   soft check silently", same as an absent field).
 */
export function sdkClaudeCodeVersion({ requireFn = requireFromHere, readFileSync: readFileSyncFn = readFileSync } = {}) {
  if (typeof cached === 'string' && cached.length > 0) return cached
  try {
    const entry = requireFn.resolve('@anthropic-ai/claude-agent-sdk')
    const pkgPath = join(dirname(entry), 'package.json')
    const pkg = JSON.parse(readFileSyncFn(pkgPath, 'utf-8'))
    const version = typeof pkg.claudeCodeVersion === 'string' && pkg.claudeCodeVersion.length > 0
      ? pkg.claudeCodeVersion
      : null
    if (version) cached = version
    return version
  } catch {
    return null
  }
}

/**
 * Test-only hook: drop the memoized value so a test can inject seams and
 * observe their effect, or re-probe after mutating the fixture.
 */
export function _resetAgentSdkVersionCacheForTest() {
  cached = undefined
}
