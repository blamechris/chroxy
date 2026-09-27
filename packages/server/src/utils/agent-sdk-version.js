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

// Memoized: undefined = not yet computed. The result (a version string or
// null) is cached after the first call — the installed SDK's version doesn't
// change within a running daemon process.
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
  if (cached !== undefined) return cached
  try {
    const entry = requireFn.resolve('@anthropic-ai/claude-agent-sdk')
    const pkgPath = join(dirname(entry), 'package.json')
    const pkg = JSON.parse(readFileSyncFn(pkgPath, 'utf-8'))
    cached = typeof pkg.claudeCodeVersion === 'string' && pkg.claudeCodeVersion.length > 0
      ? pkg.claudeCodeVersion
      : null
  } catch {
    cached = null
  }
  return cached
}

/**
 * Test-only hook: drop the memoized value so a test can inject seams and
 * observe their effect, or re-probe after mutating the fixture.
 */
export function _resetAgentSdkVersionCacheForTest() {
  cached = undefined
}
