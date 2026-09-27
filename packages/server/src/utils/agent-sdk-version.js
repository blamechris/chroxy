/**
 * Read the installed `@anthropic-ai/claude-agent-sdk` package's own
 * `claudeCodeVersion` field (#7986) — the minimum `claude` CLI version that
 * SDK build was built/tested against (e.g. SDK `0.2.141` carries
 * `claudeCodeVersion: "2.1.141"`). This gives the SdkSession provider a
 * derivable minimum-version floor with no hand-kept constant to fall out of
 * sync on an SDK bump.
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
 * @returns {string|null} the SDK's `claudeCodeVersion` field, or null when it
 *   can't be resolved/read/parsed (fails open to "no minimum" — the preflight
 *   gate treats a null minimum as "skip the check, log a warning").
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
